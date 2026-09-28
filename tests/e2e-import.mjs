// E2E dialog Impor Produk — playwright-core + Chrome sistem (di /tmp, repo tetap bebas dep).
// Jalankan: node e2e-import.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
const ARTIFAK = path0.join(path0.dirname(fileURLToPath(import.meta.url)), 'artifacts');
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');

/** Bersihkan artefak suite ini lewat sqlite3 (test-only, bukan jalur API).
 *  Dipanggil di AWAL supaya run sebelumnya yang gagal di tengah tidak membuat
 *  run berikutnya membaca sisa data sebagai "sudah ada" (0 baru / 2 menimpa),
 *  dan di AKHIR supaya DB dev kembali bersih. Pola yang sama dipakai
 *  product-delete-test.mjs. */
const cleanup = () => {
  try {
    execFileSync('sqlite3', [DB,
      "DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'E2E-IMP-%'); " +
      "DELETE FROM products WHERE sku LIKE 'E2E-IMP-%';"]);
    return Number(execFileSync('sqlite3', [DB,
      "SELECT COUNT(*) FROM products WHERE sku LIKE 'E2E-IMP-%'"], { encoding: 'utf8' }).trim());
  } catch (e) {
    console.log('  (cleanup gagal:', String(e).slice(0, 120), ')');
    return -1;
  }
};
console.log('cleanup awal: sisa E2E-IMP-% =', cleanup());

const CHROME = '/usr/bin/google-chrome-stable';
const WEB = 'http://localhost:5656';

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};

const CSV = [
  'sku,nama,kategori,satuan,harga,modal,stok',
  'E2E-IMP-1,E2e Impor Satu,atk,pcs,4444,3000,5',
  'E2E-IMP-2,E2e Impor Dua,snack,pcs,2222,,8',
  'E2E-IMP-BAD,E2e Salah Kategori,Tidak Ada,pcs,1000,,1',
].join('\n');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

try {
  console.log('=== A. Buka halaman Produk & dialog Impor ===');
  await page.goto(`${WEB}/#/products`, { waitUntil: 'load' });
  await page.waitForSelector('#rows tr', { timeout: 20000 });
  ok('halaman produk termuat', await page.isVisible('#prod-import'));
  await page.click('#prod-import');
  await page.waitForSelector('#imp-text', { timeout: 5000 });
  ok('dialog terbuka', await page.isVisible('.modal #imp-text'));
  ok('tombol Impor MATI sebelum pratinjau', await page.locator('.modal [data-ok]').isDisabled());
  ok('judul dialog benar', (await page.locator('.modal-header h3').innerText()) === 'Impor produk');

  console.log('=== B. Tombol "Contoh format" DIHAPUS (digantikan Unduh template) ===');
  ok('tombol Contoh format tidak ada lagi', (await page.locator('#imp-contoh').count()) === 0);
  ok('placeholder = header template, satu baris tanpa data',
    (await page.getAttribute('#imp-text', 'placeholder') ?? '').includes('\n') === false);
  await page.fill('#imp-text', 'Nama,Kategori,SKU\n');
  ok('setelah diketik, masih MATI', await page.locator('.modal [data-ok]').isDisabled());

  console.log('=== B2. Tombol "Unduh template" (header = label form) ===');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#imp-unduh'),
  ]);
  ok('file terunduh dengan nama benar',
    dl.suggestedFilename() === 'template-produk-ravaa.csv', dl.suggestedFilename());
  const isi = fs.readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '');
  const baris = isi.split(/\r\n/);
  ok('baris 1 = 12 kolom, namanya persis label di form',
    baris[0] === 'Nama,Kategori,SKU,Barcode,Satuan,Harga beli,Markup,Harga jual,'
      + 'Boleh ubah harga saat jual,Aktif,Stok,Stok minimum',
    baris[0]);
  const kolom = baris[0].split(',');
  ok('kolom Tax/Description/IsService TIDAK ikut',
    !kolom.some((c) => ['Tax', 'IsTaxInclusivePrice', 'IsUsingDefaultQuantity',
      'IsService', 'Description'].includes(c)), kolom);
  ok('ada 2 baris contoh + header = 3 baris', baris.length === 3, baris.length);
  ok('kedua baris contoh ditandai CONTOH', baris.slice(1).every((b) => b.startsWith('CONTOH ')), baris.slice(1));
  ok('tombol unduh TIDAK menutup dialog', await page.isVisible('#imp-text'));

  console.log('=== C. Baca & tinjau ===');
  await page.fill('#imp-text', CSV);
  ok('isi berubah -> tombol tetap MATI', await page.locator('.modal [data-ok]').isDisabled());
  await page.click('#imp-read');
  const prev = await page.innerText('#imp-prev');
  ok('pratinjau menghitung 2 siap / 1 gagal',
    /2 baris siap diimpor \(2 baru, 0 menimpa\)/.test(prev.replace(/\s+/g, ' ')),
    prev.split('\n')[0]);
  ok('pratinjau menampilkan 1 gagal', /1 gagal/.test(prev));
  ok('pesan error kategori tampil di barisnya',
    /Kategori "Tidak Ada" tidak ada di master/.test(prev.replace(/\s+/g, ' ')));
  ok('lencana "baru" terender', (await page.locator('.modal .bg-emerald-100').count()) === 2);
  ok('lencana "gagal" terender', (await page.locator('.modal .bg-red-100').count()) === 1);
  ok('tombol Impor HIDUP', !(await page.locator('.modal [data-ok]').isDisabled()));
  ok('label tombol = jumlah baris',
    (await page.locator('.modal [data-ok]').innerText()).trim() === 'Impor 2 baris');

  console.log('=== D. Isi diubah SETELAH pratinjau -> pratinjau basi ===');
  await page.fill('#imp-text', CSV + '\nE2E-IMP-3,E2e Tambah,atk,pcs,100,,1');
  ok('tombol Impor kembali MATI', await page.locator('.modal [data-ok]').isDisabled());
  ok('pesan "pratinjau basi" muncul', /Isi sudah berubah/.test(await page.innerText('#imp-prev')));
  await page.click('#imp-read');
  ok('baca ulang -> 3 siap', /3 baris siap/.test(await page.innerText('#imp-prev')));

  console.log('=== E. Klik Impor ===');
  // pakai CSV asli (2 baris valid) agar angka prediksi pasti
  await page.fill('#imp-text', CSV);
  await page.click('#imp-read');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  ok('dialog tertutup setelah impor', true);
  const toast = await page.locator('#toast-root .toast').first().innerText();
  ok('toast melaporkan hasil', /Impor selesai: 2 baris \(2 baru, 0 diperbarui\)/.test(toast.replace(/\s+/g, ' ')), toast);

  console.log('=== F. Produk muncul di tabel ===');
  await page.fill('#q', 'E2e Impor');
  await page.waitForTimeout(400);
  const nama = await page.locator('#rows tr').allInnerTexts();
  ok('2 produk hasil impor tampil', nama.length === 2, JSON.stringify(nama));
  ok('SKU tampil', nama.join(' ').includes('E2E-IMP-1'));
  await page.fill('#q', 'E2e Salah Kategori');
  await page.waitForTimeout(300);
  // Hitung baris PRODUK (data-row) — #rows tetap berisi 1 baris placeholder
  // "Tidak ada produk yang cocok" saat filter kosong (products.ts:169).
  ok('baris gagal TIDAK ikut terimpor', (await page.locator('#rows tr[data-row]').count()) === 0);

  console.log('=== G. Tanpa error runtime ===');
  ok('tidak ada pageerror/console error', errs.length === 0, errs.join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL eksekusi:', e.message);
  const prev = await page.locator('#imp-prev').count();
  if (prev) console.log('  #imp-prev:', await page.innerText('#imp-prev').catch(() => '?'));
} finally {
  await page.screenshot({ path: `${ARTIFAK}/e2e-import.png` }).catch(() => {});
  await browser.close();
  const sisa = cleanup();
  console.log(`cleanup akhir: sisa E2E-IMP-% = ${sisa} (harus 0)`);
  if (sisa !== 0) gagal++;
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
