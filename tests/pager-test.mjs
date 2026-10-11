// Paginasi daftar admin (2026-10-11): komponen ui/pager.ts + limit/offset
// server + pager UI 7 halaman + muat-bertahap Riwayat.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);

await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

console.log('=== A. limit/offset server ===');
const cAll = await api('/api/customers');
const cHal = await api('/api/customers?limit=2&offset=1');
chk('customers: limit+offset + total tetap', cHal.data.length === 2 && cHal.total === cAll.total, `2/${cHal.total} vs ${cAll.total}`);
const sAll = await api('/api/suppliers');
const sHal = await api('/api/suppliers?limit=2');
chk('suppliers: limit + total tetap', sHal.data.length === 2 && sHal.total === sAll.total, `2/${sHal.total}`);
const dAll = await api('/api/customer-debts?status=semua');
const dHal = await api('/api/customer-debts?status=semua&limit=1');
chk('debts: limit + total uang tetap + count', dHal.data.length === 1 && dHal.total === dAll.total && dHal.count === dAll.data.length, `1/${dHal.count} Rp${dHal.total}`);
const shHal = await api('/api/shifts?status=semua&limit=1');
chk('shifts: limit=1', shHal.data.length === 1 && shHal.total >= 1, `1/${shHal.total}`);
const pHal = await api('/api/purchases?status=semua&limit=1');
chk('purchases: limit=1', pHal.data.length <= 1, `${pHal.data.length}/${pHal.total}`);
const rHal = await api(`/api/returns?date=${new Date().toISOString().slice(0, 10)}&limit=1`);
chk('returns: limit=1', rHal.data.length <= 1, `${rHal.data.length}/${rHal.total}`);
chk('offset melampaui -> data kosong', (await api('/api/customers?limit=2&offset=99999')).data.length === 0);

console.log('=== B. Pager UI suppliers (22 baris uji) ===');
for (let i = 1; i <= 22; i++) {
  await p.evaluate((n) => fetch('/api/suppliers', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `UjiPg Sup ${String(n).padStart(2, '0')}` }),
  }), i);
}
await p.goto('http://localhost:5656/#/suppliers', { waitUntil: 'networkidle' });
await p.waitForSelector('#sup-body tbody tr', { timeout: 15000 });
await p.waitForTimeout(600);
chk('prev/next + nomor halaman ada', await p.locator('[data-pg="prev"]').count() === 1
  && await p.locator('[data-pg="next"]').count() === 1
  && await p.locator('[data-pg="goto"]').count() === 2);
chk('select jumlah baris ada (10/20/50/100)', await p.locator('select[data-pg-limit] option').count() === 4);
chk('pager menempel sebagai kaki tabel (dalam card-flush)', await p.locator('.card-flush > .table-foot').count() === 1);
const foot1 = await p.textContent('#sup-body');
chk('footer "Hal 1 dari 2 · 1–20 dari N"', /Hal 1 dari 2 · 1–20 dari \d+/.test(foot1), foot1.replace(/\s+/g, ' ').slice(-80));
const hal1 = await p.locator('#sup-body tbody tr').first().textContent();
await p.click('[data-pg="next"]'); await p.waitForTimeout(900);
const info2 = await p.textContent('#sup-body');
chk('next -> Hal 2 + baris beda', /Hal 2 dari/.test(info2) && (await p.locator('#sup-body tbody tr').first().textContent()) !== hal1, info2.replace(/\s+/g, ' ').slice(-80));
await p.click('[data-pg="prev"]'); await p.waitForTimeout(900);
chk('prev -> kembali Hal 1', /Hal 1 dari/.test(await p.textContent('#sup-body')) && (await p.locator('#sup-body tbody tr').first().textContent()) === hal1);
await p.selectOption('select[data-pg-limit]', '10'); await p.waitForTimeout(900);
const info3 = await p.textContent('#sup-body');
chk('pilih 10 -> Hal 1 dari 3 · 1–10', /Hal 1 dari 3 · 1–10 dari \d+/.test(info3) && (await p.locator('#sup-body tbody tr').count()) === 10, info3.replace(/\s+/g, ' ').slice(-80));
await p.click('button[data-pg="goto"][aria-label="Halaman 3"]'); await p.waitForTimeout(900);
chk('klik nomor 3 -> Hal 3', /Hal 3 dari 3/.test(await p.textContent('#sup-body')));

console.log('=== C. Halaman kecil: footer tanpa pager ===');
await p.goto('http://localhost:5656/#/customers', { waitUntil: 'networkidle' });
await p.waitForSelector('#cust-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('footer penjelasan tetap ada (tanpa kalimat redundan)', (await p.textContent('#cust-body')).includes('No. customer di-assign'));
chk('pager absen bila ≤20', await p.locator('#cust-body [data-pg]').count() === 0);

console.log('=== D. Riwayat pager bernomor ===');
await p.goto('http://localhost:5656/#/history', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
if (await p.locator('#page [data-pg]').count()) {
  // Sub-baris hybrid menempel induk — pindah halaman TAK HARUS mengganti
  // semua baris; yang wajib: nomor hal berubah + tetap ada baris.
  const hal1 = await p.locator('#page tbody tr[data-trx]').first().textContent();
  await p.click('[data-pg="next"]'); await p.waitForTimeout(800);
  const info2 = await p.textContent('#page');
  const n2 = await p.locator('#page tbody tr[data-trx]').count();
  await p.click('[data-pg="prev"]'); await p.waitForTimeout(800);
  const kembali = await p.locator('#page tbody tr[data-trx]').first().textContent();
  chk('pager riwayat: next Hal 2 + prev kembali', /Hal 2 dari/.test(info2) && n2 > 0 && kembali === hal1);
} else {
  const t = await api(`/api/sales?date=${new Date().toISOString().slice(0, 10)}&limit=1`);
  const tp = await api(`/api/topups?date=${new Date().toISOString().slice(0, 10)}&limit=1`);
  chk('tanpa pager: induk ≤20', t.total + tp.total <= 40, `sales=${t.total} topup=${tp.total}`);
}
chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan 22 supplier uji.
sql(`DELETE FROM suppliers WHERE name LIKE 'UjiPg Sup %';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
