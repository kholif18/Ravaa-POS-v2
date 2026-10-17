// Pintasan Alt+N "buat baru" (2026-10-18, permintaan pemilik): tiap halaman
// daftar membuka modal/halaman buat barunya lewat registry ui/aksi-baru.ts.
//
// Kontrak yang dijaga:
// - SATU listener document (registry), bukan listener per halaman — Alt+N di
//   halaman yang tidak mendaftar (Dashboard) tidak boleh melakukan apa pun.
// - Guard dialog: Alt+N saat modal terbuka TIDAK menumpuk modal kedua.
// - Aksi halaman lama tidak bocor: setelah pindah halaman (resetAksiBaru di
//   main.ts render()), Alt+N memakai aksi halaman BARU.
// - Hint <kbd class="kbd">Alt+N</kbd> tampil di tombol buat baru.
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};

const BASE = 'http://localhost:5656';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));

const SEL_MODAL = '.modal-overlay:not(.is-closing) .modal';
const buka = async (hash) => {
  await p.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
};
const altN = async (ms = 800) => {
  await p.keyboard.press('Alt+n');
  await p.waitForTimeout(ms);
};
const jmlModal = () => p.locator(SEL_MODAL).count();
const judulModal = () => p.getAttribute(SEL_MODAL, 'aria-label');
const tutupModal = async () => {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(350);
};

console.log('=== A. Pelanggan: hint, buka, guard, Esc, halaman tanpa aksi ===');
await buka('#/customers');
chk('tombol Tambah Pelanggan memuat hint Alt+N',
  (await p.locator('#cust-new .kbd').count()) === 1
    && (await p.textContent('#cust-new .kbd')) === 'Alt+N');
await altN();
chk('Alt+N membuka modal buat pelanggan', (await jmlModal()) === 1);
chk('judul modal = Tambah Pelanggan', (await judulModal()) === 'Tambah Pelanggan',
  String(await judulModal()));
await p.keyboard.press('Alt+n');
await p.waitForTimeout(400);
chk('Alt+N saat modal terbuka tidak menumpuk modal', (await jmlModal()) === 1);
await tutupModal();
chk('Esc menutup modal (kembali siap)', (await jmlModal()) === 0);
await buka('#/dashboard');
await altN();
chk('halaman tanpa aksi: Alt+N tidak membuka apa pun & tidak pindah',
  (await jmlModal()) === 0 && (await p.evaluate(() => location.hash)) === '#/dashboard',
  await p.evaluate(() => location.hash));

console.log('=== B. Halaman modal satu per satu ===');
for (const [hash, judul, label] of [
  ['#/debts', 'Catat hutang baru', 'Hutang'],
  ['#/expenses', 'Catat Pengeluaran', 'Pengeluaran'],
  ['#/users', 'Tambah Pengguna', 'Pengguna'],
  ['#/satuan', 'Tambah Satuan', 'Satuan'],
  ['#/shifts', 'Buka shift', 'Shift'],
  ['#/products', 'Tambah Produk', 'Produk'],
  ['#/returns', 'Retur manual (tanpa nota)', 'Retur'],
  ['#/suppliers', 'Tambah Supplier', 'Supplier'],
]) {
  await buka(hash);
  await altN();
  chk(`Alt+N di ${label} membuka "${judul}"`,
    (await jmlModal()) === 1 && (await judulModal()) === judul, String(await judulModal()));
  await tutupModal();
}

console.log('=== C. Pembelian: navigasi halaman baru, bukan modal ===');
await buka('#/purchases');
await altN(500);
await p.waitForSelector('#po-simpan', { timeout: 4000 }).catch(() => {});
chk('Alt+N di Pembelian masuk halaman Buat PO',
  (await p.evaluate(() => location.hash)) === '#/purchases/baru'
    && (await p.locator('#po-simpan').count()) === 1,
  await p.evaluate(() => location.hash));
await p.keyboard.press('Alt+n');
await p.waitForTimeout(400);
chk('Alt+N di halaman form PO baru tidak menumpuk/mengulang',
  (await jmlModal()) === 0 && (await p.evaluate(() => location.hash)) === '#/purchases/baru');

chk('tidak ada pageerror selama suite', err.length === 0, err.join(' | '));

await b.close();
console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
