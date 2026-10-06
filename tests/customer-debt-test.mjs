// Pelanggan & hutang (piutang): #/customers + #/debts.
// Master kontak, ledger charge/payment, saldo berjalan, guard hapus.
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

// Bersihkan sisa run sebelumnya (urutan: ledger dulu, baru pelanggan — FK ON).
sql(`DELETE FROM customer_debts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'UjiHutang%');`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiHutang%';`);

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
async function w(sel, v) { await p.fill(sel, v); await p.waitForTimeout(150); }

console.log('=== 1. Halaman Pelanggan terbuka & terisi ===');
await p.goto('http://localhost:5656/#/customers', { waitUntil: 'networkidle' });
await p.waitForSelector('#cust-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('nav "Pelanggan" aktif', await p.locator('a[href="#/customers"].is-active').count() === 1);
chk('judul halaman benar', (await p.textContent('h2')).includes('Pelanggan'), await p.textContent('h2'));
const list0 = await api('/api/customers');
chk('baris tabel = total server', (await p.locator('#cust-body tbody tr').count()) === list0.total,
  `${await p.locator('#cust-body tbody tr').count()} vs ${list0.total}`);

console.log('=== 2. Tambah pelanggan via modal ===');
await p.click('#cust-new'); await p.waitForSelector('.modal');
await w('#c-name', 'UjiHutang Papa');
await w('#c-phone', '0811111111');
await w('#c-note', 'langganan uji');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
chk('modal tertutup', (await p.locator('.modal').count()) === 0);
const afterAdd = await api('/api/customers');
const papa = afterAdd.data.find((c) => c.name === 'UjiHutang Papa');
chk('tersimpan di server', !!papa, JSON.stringify(papa));
chk('HP & catatan tersimpan utuh', papa?.phone === '0811111111' && papa?.note === 'langganan uji');
chk('baris muncul di tabel', (await p.textContent('#cust-body')).includes('UjiHutang Papa'));

console.log('=== 3. Cari multi-kata (debounce + Enter) ===');
await w('#cust-q', 'ujihutang papa');
await p.waitForTimeout(700);
chk('2 kata cocok di nama', (await p.locator('#cust-body tbody tr').count()) === 1,
  `${await p.locator('#cust-body tbody tr').count()} baris`);

console.log('=== 4. Ubah pelanggan ===');
await p.click('[data-cust-edit]'); await p.waitForSelector('.modal');
chk('form terisi data lama', (await p.inputValue('#c-name')) === 'UjiHutang Papa', await p.inputValue('#c-name'));
await w('#c-name', 'UjiHutang Papa Baru');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const afterEdit = (await api('/api/customers')).data.find((c) => c.id === papa.id);
chk('nama berubah di server', afterEdit?.name === 'UjiHutang Papa Baru', afterEdit?.name);

console.log('=== 5. Pelanggan kedua (untuk uji hapus bersih) ===');
await p.click('#cust-new'); await p.waitForSelector('.modal');
await w('#c-name', 'UjiHutang Bersih');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const bersih = (await api('/api/customers')).data.find((c) => c.name === 'UjiHutang Bersih');
chk('pelanggan bersih tersimpan', !!bersih, JSON.stringify(bersih));

console.log('=== 6. Halaman Hutang: catat hutang (charge) ===');
await p.goto('http://localhost:5656/#/debts', { waitUntil: 'networkidle' });
await p.waitForSelector('#hutang-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('nav "Hutang" aktif', await p.locator('a[href="#/debts"].is-active').count() === 1);
chk('judul halaman benar', (await p.textContent('h2')).includes('Hutang'), await p.textContent('h2'));
await p.click('#hutang-charge'); await p.waitForSelector('.modal');
const opts = await p.locator('#h-cust').evaluate((e) => [...e.options].map((o) => o.textContent));
chk('select pelanggan terisi master', opts.some((t) => t.includes('UjiHutang Papa Baru')), JSON.stringify(opts));
await p.selectOption('#h-cust', { label: 'UjiHutang Papa Baru — 0811111111' });
await w('#h-amount', '50000');
await w('#h-note', 'beli ATK uji');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
chk('modal tertutup setelah sukses', (await p.locator('.modal').count()) === 0);
const led0 = await api(`/api/customer-debts/${papa.id}`);
chk('ledger berisi charge 50000', led0.data.rows.length === 1 && led0.data.rows[0].type === 'charge' && led0.data.rows[0].amount === 50000,
  JSON.stringify(led0.data.rows));
chk('sisa = 50000', led0.data.sisa === 50000, String(led0.data.sisa));
const ring0 = await api('/api/customer-debts?status=open');
const baris0 = ring0.data.find((r) => r.customer_id === papa.id);
chk('ringkasan menampilkan Papa sisa 50000', baris0?.sisa === 50000, JSON.stringify(baris0));
chk('kartu total = jumlah sisa semua baris',
  ring0.total === ring0.data.reduce((s, r) => s + r.sisa, 0), `${ring0.total}`);

console.log('=== 7. Catat bayar sah, lalu bayar MELEBIHI sisa -> 400 ===');
// 2026-10-04: tombol global "Catat bayar" dihapus — pembayaran kini lewat
// tombol per baris (prefill, tanpa dropdown `#h-cust`).
chk('tombol global "Catat bayar" sudah dihapus', await p.locator('#hutang-bayar').count() === 0);
await p.click(`[data-bayar="${papa.id}"]`); await p.waitForSelector('.modal');
await w('#h-amount', '20000');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const led1 = await api(`/api/customer-debts/${papa.id}`);
chk('sisa turun jadi 30000', led1.data.sisa === 30000, String(led1.data.sisa));
await p.click(`[data-bayar="${papa.id}"]`); await p.waitForSelector('.modal');
await w('#h-amount', '999999');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const toastTeks = (await p.textContent('.toast-root').catch(() => '')).replace(/\s+/g, ' ');
chk('toast menolak pembayaran berlebih', /melebihi sisa hutang/.test(toastTeks), toastTeks.slice(0, 110));
chk('modal MASIH terbuka (bisa koreksi)', (await p.locator('.modal').count()) === 1);
const led2 = await api(`/api/customer-debts/${papa.id}`);
chk('sisa TIDAK berubah oleh percobaan gagal', led2.data.sisa === 30000, String(led2.data.sisa));
await p.click('.modal [data-x]'); await p.waitForTimeout(300);

console.log('=== 8. Rincian ledger: sisa berjalan + hapus baris salah ketik ===');
await p.click(`[data-rincian="${papa.id}"]`); await p.waitForSelector('#rincian-body');
await p.waitForTimeout(800);
const rowsR = await p.locator('#rincian-body tbody tr').count();
chk('rincian berisi 2 mutasi', rowsR === 2, `${rowsR} baris`);
// Urutan tampil terbaru di atas: baris teratas = payment, sisa berjalan 30000.
const barisAtas = await p.locator('#rincian-body tbody tr').first().evaluate((tr) =>
  [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
chk('baris teratas = bayar dengan sisa 30000', /Bayar/.test(barisAtas[1]) && /30[.,]?000/.test(barisAtas[4]),
  JSON.stringify(barisAtas));
await p.click('#rincian-body [data-del-baris]'); // baris atas = payment
await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1500);
const led3 = await api(`/api/customer-debts/${papa.id}`);
chk('hapus payment -> sisa kembali 50000', led3.data.sisa === 50000, String(led3.data.sisa));
const rowsR2 = await p.locator('#rincian-body tbody tr').count();
chk('baris hilang dari rincian', rowsR2 === 1, `${rowsR2} baris`);
await p.click('.modal [data-x]'); await p.waitForTimeout(300);

console.log('=== 9. Guard: pelanggan ber-hutang tidak bisa dihapus ===');
await p.goto('http://localhost:5656/#/customers', { waitUntil: 'networkidle' });
await p.waitForSelector('#cust-body tbody tr', { timeout: 15000 });
await w('#cust-q', 'UjiHutang Papa Baru'); await p.waitForTimeout(700);
await p.click('[data-cust-del]'); await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1200);
const toast2 = (await p.textContent('.toast-root').catch(() => '')).replace(/\s+/g, ' ');
chk('server menolak + pesan menunjuk halaman Hutang', /catatan hutang/.test(toast2), toast2.slice(0, 110));
chk('pelanggan MASIH ada', (await api('/api/customers')).data.some((c) => c.id === papa.id));

console.log('=== 10. Lunas: hilang dari filter open, muncul di "semua" ===');
await p.goto('http://localhost:5656/#/debts', { waitUntil: 'networkidle' });
await p.waitForSelector('#hutang-body', { timeout: 15000 });
await p.waitForTimeout(600);
// Bayar sisa 50000 -> lunas (lewat API biar cepat; alur UI sudah diuji di §7).
await p.evaluate((id) => fetch('/api/customer-debts', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ customer_id: id, type: 'payment', amount: 50000 }),
}), papa.id);
// Ganti filter bolak-balik supaya tabel ikut dimuat ulang (klik filter yang
// sudah aktif sengaja tidak reload — itu perilaku UI, bukan bug).
await p.click('[data-status="semua"]'); await p.waitForTimeout(900);
await p.click('[data-status="open"]'); await p.waitForTimeout(900);
const tOpen = await p.textContent('#hutang-body');
chk('baris lunas hilang dari filter "Masih berhutang"', !tOpen.includes('UjiHutang Papa Baru'), tOpen.replace(/\s+/g, ' ').slice(0, 90));
await p.click('[data-status="semua"]'); await p.waitForTimeout(900);
const tSemua = await p.textContent('#hutang-body');
chk('muncul lagi di "Semua riwayat" dengan status Lunas', tSemua.includes('UjiHutang Papa Baru') && tSemua.includes('Lunas'),
  tSemua.replace(/\s+/g, ' ').slice(0, 90));

console.log('=== 11. Cetak A4 rincian: ringkas = tabel garis-bawah, semua tabel striped ===');
// Putaran 15 (2026-10-06): "bagian bawah ... dibuat garis tabel bawah saja
// jangan box ... setiap tabel buat striped termasuk tabel yang atas".
// Stub window.print di SELURUH context sebelum popup (pola e2e-struk) —
// invoice A4 memanggil print() otomatis saat load.
await p.context().addInitScript(() => { window.print = () => {}; });
await p.click(`[data-rincian="${papa.id}"]`); await p.waitForSelector('#rincian-body');
await p.waitForTimeout(600);
const [popA4] = await Promise.all([
  p.waitForEvent('popup'),
  p.click('.modal [data-ok]'), // okLabel rincian = "Cetak A4" (modal tidak auto-close)
]);
await popA4.waitForLoadState('domcontentloaded');
const a4 = await popA4.evaluate(() => {
  const css = document.querySelector('style')?.textContent ?? '';
  const rk = document.querySelector('table.ringkas');
  return {
    ringkas: !!rk,
    baris: rk ? rk.querySelectorAll('tbody tr').length : 0,
    kotak: document.body.innerHTML.includes('kotak'),
    garis: /table\.ringkas td \{[^}]*border-bottom/.test(css),
    stripeLedger: css.includes('table.ledger tbody tr:nth-child(even)'),
    stripeRingkas: css.includes('table.ringkas tr:nth-child(even)'),
    isi: rk ? rk.innerText.replace(/\s+/g, ' ') : '',
  };
});
chk('ringkas A4 = tabel 3 baris (Total dihutang/dibayar/sisa) TANPA box',
  a4.ringkas && a4.baris === 3 && !a4.kotak
    && a4.isi.includes('Total dihutang') && a4.isi.includes('Rp50.000'),
  a4.isi);
chk('striping ledger + ringkas aktif, ringkas pakai garis bawah-saja',
  a4.stripeLedger && a4.stripeRingkas && a4.garis, JSON.stringify(a4));
await popA4.close().catch(() => {});
await p.click('.modal [data-x]'); await p.waitForTimeout(300);

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan data uji (ledger dulu — FK ON).
sql(`DELETE FROM customer_debts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'UjiHutang%');`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiHutang%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
