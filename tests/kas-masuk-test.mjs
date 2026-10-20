// Kas masuk non-penjualan (butir ROADMAP 1.6.2, 2026-10-19) — PASANGAN
// pengeluaran: CRUD + validasi API, agregat shift (menambah kasSeharusnya),
// rekap laporan harian, halaman #/kas-masuk (Alt+N), blok dialog tutup
// shift, dan jejak audit. Jalankan: node kas-masuk-test.mjs
// (butuh API :3001 + vite :5656 hidup; runner membuka shift kasir).
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();
const TODAY = new Date().toISOString().slice(0, 10);

// Bersihkan sisa run sebelumnya (nama EKSAK milik suite ini — AGENTS §5).
sql(`DELETE FROM kas_masuk WHERE kategori LIKE 'UjiKM%' OR note LIKE 'UjiKM%';`);

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const post = (path, body) => p.evaluate(
  ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  [path, body],
);
async function w(sel, v) { await p.fill(sel, v); await p.waitForTimeout(150); }

// fetch() relatif butuh origin — buka app dulu sebelum semua evaluate.
await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

console.log('=== A. API kas masuk: CRUD + validasi ===');
const e1 = await post('/api/kas-masuk', { kategori: 'UjiKM Modal', jumlah: 45000, note: 'UjiKM nota' });
chk('POST valid -> 201 + shift null', e1.status === 201 && e1.json.data.shift_id === null, JSON.stringify(e1.json.data));
chk('kategori kosong -> 400', (await post('/api/kas-masuk', { kategori: '  ', jumlah: 1000 })).status === 400);
chk('jumlah 0 -> 400', (await post('/api/kas-masuk', { kategori: 'UjiKM X', jumlah: 0 })).status === 400);
chk('jumlah negatif -> 400', (await post('/api/kas-masuk', { kategori: 'UjiKM X', jumlah: -5000 })).status === 400);
chk('jumlah desimal -> 400', (await post('/api/kas-masuk', { kategori: 'UjiKM X', jumlah: 1500.5 })).status === 400);
chk('note > 200 -> 400', (await post('/api/kas-masuk', { kategori: 'UjiKM X', jumlah: 1000, note: 'x'.repeat(201) })).status === 400);
chk('shift_id tak ada -> 400', (await post('/api/kas-masuk', { kategori: 'UjiKM X', jumlah: 1000, shift_id: 999999 })).status === 400);
chk('shift_id bukan integer -> 400', (await post('/api/kas-masuk', { kategori: 'UjiKM X', jumlah: 1000, shift_id: 'abc' })).status === 400);
const g1 = await api(`/api/kas-masuk?date=${TODAY}`);
chk('GET hari ini memuat baris + jumlah', g1.total === 1 && g1.jumlah === 45000 && g1.data[0].kategori === 'UjiKM Modal', JSON.stringify({ total: g1.total, jumlah: g1.jumlah }));
chk('date rusak -> 400', (await p.evaluate(() => fetch('/api/kas-masuk?date=2026-02-31').then((r) => r.status))) === 400);
chk('DELETE -> hilang', (await p.evaluate((id) => fetch(`/api/kas-masuk/${id}`, { method: 'DELETE' }).then((r) => r.json()), e1.json.data.id)).data?.deleted === true);

console.log('=== B. Agregat shift (kasSeharusnya NAIK) ===');
const open = await api('/api/shifts/open?cashier=kasir');
const kasirId = open.data?.id;
chk('shift kasir terbuka (prasyarat runner)', Number.isInteger(kasirId), String(kasirId));
const e2 = await post('/api/kas-masuk', { kategori: 'UjiKM Bensin', jumlah: 12345, shift_id: kasirId });
chk('POST terikat shift -> 201 + shift_id', e2.status === 201 && e2.json.data.shift_id === kasirId);
const sh = await api('/api/shifts?status=open&limit=200');
const baris = (sh.data ?? []).find((s) => s.cashier === 'kasir');
chk('GET /api/shifts: n_kas_masuk + kas_masuk_total ikut', (baris?.n_kas_masuk ?? 0) >= 1 && (baris?.kas_masuk_total ?? 0) >= 12345, JSON.stringify({ n: baris?.n_kas_masuk, total: baris?.kas_masuk_total }));

console.log('=== C. Laporan harian: kas_masuk + kartu ===');
const har = await api(`/api/reports/daily?date=${TODAY}`);
chk('daily memuat kas_masuk {n,total}', (har.data?.kas_masuk?.n ?? 0) >= 1 && (har.data?.kas_masuk?.total ?? 0) >= 12345, JSON.stringify(har.data?.kas_masuk));
await p.goto(`http://localhost:5656/#/reports?x=${Date.now()}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
chk('kartu "Kas masuk" + link #/kas-masuk di Laporan', (await p.locator('a.card[href="#/kas-masuk"]').count()) === 1
  && (await p.textContent('#page')).includes('Kas masuk'));

console.log('=== D. UI #/kas-masuk ===');
await p.goto('http://localhost:5656/#/kas-masuk', { waitUntil: 'networkidle' });
await p.waitForSelector('#km-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('nav "Kas masuk" aktif + tombol memuat hint Alt+N', (await p.locator('a[href="#/kas-masuk"].is-active').count()) === 1
  && (await p.textContent('#km-new .kbd')) === 'Alt+N');
await p.keyboard.press('Alt+n');
await p.waitForTimeout(400);
chk('Alt+N membuka modal "Catat Kas masuk"', (await p.locator('.modal').count()) === 1 && (await p.textContent('.modal')).includes('Catat Kas masuk'));
await p.click('.modal-overlay [data-x]');
await p.waitForTimeout(300);
await p.click('#km-new');
await p.waitForSelector('.modal');
await w('#km-kategori', 'UjiKM UI');
await w('#km-nominal', '25000');
await w('#km-note', 'UjiKM ui');
await p.click('.modal [data-ok]');
await p.waitForTimeout(1200);
chk('catat via modal -> modal tutup, baris + total hari ikut', (await p.locator('.modal').count()) === 0
  && (await p.textContent('#km-body')).includes('UjiKM UI')
  && (await p.textContent('#km-jumlah')).includes('37.345'));
await p.click('[data-km-del]');
await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.click('.swal2-container .sw-btn-danger');
await p.waitForTimeout(1200);
chk('hapus via konfirmasi -> baris hilang + total turun', !(await p.textContent('#km-body')).includes('UjiKM UI')
  && (await p.textContent('#km-jumlah')).includes('12.345'));

console.log('=== E. Dialog tutup shift memuat blok Kas masuk ===');
await p.goto('http://localhost:5656/#/shifts', { waitUntil: 'networkidle' });
// Pager bawaan 20 baris — shift runner bisa lebih tua dari 20 shift terakhir.
// Saring "Terbuka" dulu supaya baris shift yang masih open pasti tampil.
await p.click('[data-f="open"]');
await p.waitForSelector(`#sh-body tbody tr[data-shift="${kasirId}"]`, { timeout: 15000 });
await p.click(`#sh-body tbody tr[data-shift="${kasirId}"] [data-tutup]`);
await p.waitForTimeout(400);
const isiDialog = await p.textContent('.modal');
chk('blok "Kas masuk — menambah laci" + nominal tampil', isiDialog.includes('Kas masuk — menambah laci') && isiDialog.includes('Rp12.345'), isiDialog.slice(0, 120));
await p.click('.modal-overlay [data-x]');
await p.waitForTimeout(300);

console.log('=== F. Jejak audit ===');
const au = await api('/api/audit?entity=kas_masuk&limit=50');
const aksi = new Set((au.data ?? []).map((r) => r.action));
chk('audit kas_masuk: create + delete tercatat', aksi.has('create') && aksi.has('delete'), [...aksi].join(','));

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan data uji.
sql(`DELETE FROM kas_masuk WHERE kategori LIKE 'UjiKM%' OR note LIKE 'UjiKM%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
