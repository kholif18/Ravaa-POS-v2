// E2E Duplikat produk + halaman Stok — playwright-core + Chrome sistem.
// Jalankan: node e2e-duplikat.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
const ARTIFAK = path0.join(path0.dirname(fileURLToPath(import.meta.url)), 'artifacts');
import { execFileSync } from 'node:child_process';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
const SKU1 = 'E2E-DUP-1';

/** Bersihkan lewat sqlite3 (test-only, jalur API sengaja tidak dipakai):
 *  DELETE API hanya SOFT delete -> baris tombstone nempel dan menggagalkan
 *  product-delete-test (yang mensyaratkan tombstone = 0). */
// Pola keduanya: produk SUMBER memakai SKU eksplisit `E2E-DUP%`, tapi HASIL
// duplikat disimpan TANPA SKU -> server menomori `PRD#####`. Kalau hanya pola
// SKU yang dipakai, salinan PRD bocor permanen dan pada run berikutnya barcode
// yang sama membuat UNIQUE constraint menolak simpan (modal tidak pernah tertutup).
const WHERE = "(sku LIKE 'E2E-DUP%' OR name LIKE 'E2e Duplikat%')";
const cleanup = () => {
  try {
    execFileSync('sqlite3', [DB,
      `DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE ${WHERE}); ` +
      `DELETE FROM products WHERE ${WHERE};`]);
    return Number(execFileSync('sqlite3', [DB,
      `SELECT COUNT(*) FROM products WHERE ${WHERE}`], { encoding: 'utf8' }).trim());
  } catch (e) {
    console.log('  (cleanup gagal:', String(e).slice(0, 120), ')');
    return -1;
  }
};
console.log('cleanup awal: sisa =', cleanup());

const post = (u, body) =>
  fetch(API + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};

const CHROME = '/usr/bin/google-chrome-stable';
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const toastTerakhir = async () =>
  (await page.locator('#toast-root .toast').allInnerTexts()).join(' | ');

try {
  console.log('=== A. Siapkan produk sumber ===');
  const dibuat = await post('/api/products', {
    sku: SKU1, name: 'E2e Duplikat Sumber', category_slug: 'atk', unit: 'pcs',
    barcode: '8999000000001', price: 1000, cost: 800, markup: 25,
    price_dynamic: 0, stock: 7, min_stock: 2, is_active: 1,
  });
  ok('produk sumber dibuat', dibuat?.data?.sku === SKU1, JSON.stringify(dibuat).slice(0, 200));

  console.log('=== B. Tombol Duplikat ada di tiap baris ===');
  await page.goto(`${WEB}/#/products`, { waitUntil: 'load' });
  await page.waitForSelector('#rows tr[data-row]', { timeout: 20000 });
  await page.fill('#q', 'E2e Duplikat Sumber');
  await page.waitForTimeout(400);
  const baris = page.locator('#rows tr[data-row]', { hasText: 'E2e Duplikat Sumber' }).first();
  ok('produk sumber tampil', (await baris.count()) > 0);
  ok('baris punya tombol Duplikat (di dalam menu ⋮)', (await baris.locator('[data-copy]').count()) === 1);
  ok('Ubah + Hapus tampil langsung di baris',
    (await baris.locator('[data-edit]').count()) === 1 &&
    (await baris.locator('[data-del]').count()) === 1);

  console.log('=== C. Klik Duplikat -> form terisi, SKU BARU, barcode+stok kosong ===');
  // Duplikat sekarang ada di menu ⋮ — hanya Ubah + Hapus yang tampil langsung.
  await baris.locator('[data-more]').click();
  await baris.locator('.row-dd [data-copy]').click();
  await page.waitForSelector('.modal #f-sku', { timeout: 5000 });
  const judul = (await page.locator('.modal-header h3').innerText()).trim();
  ok('judul menyebut mode duplikat', judul.startsWith('Duplikat:'), judul);
  const skuAsli = await page.inputValue('#f-sku');
  // Sejak SKU default jadi PRD#####, client tidak lagi menurunkan SKU dari nama
  // — nomor berikutnya hanya bisa dihitung server (MAX dari baris di DB).
  ok('SKU mode salinan sengaja dikosongkan', skuAsli === '', JSON.stringify(skuAsli));
  ok('SKU berbeda dari produk asal', skuAsli !== SKU1, `${skuAsli} vs ${SKU1}`);
  ok('hint menjelaskan server yang menomori PRD#####',
    /dikosongkan = diisi server \(PRD#####\)/.test(await page.innerText('#f-sku-hint')),
    await page.innerText('#f-sku-hint'));
  const semuaSku = await fetch(`${API}/api/products?status=semua`).then((r) => r.json());
  ok('SKU baru tidak bentrok dengan yang sudah ada',
    !(semuaSku.data ?? []).some((x) => x.sku === skuAsli),
    (semuaSku.data ?? []).map((x) => x.sku).join(','));  ok('nama disalin (tinggal diganti)', (await page.inputValue('#f-name')) === 'E2e Duplikat Sumber');
  ok('barcode DIKOSONGKAN (1 barcode = 1 produk)', (await page.inputValue('#f-barcode')) === '');
  ok('stok DIreset 0 (varian baru belum tentu ada barangnya)',
    (await page.inputValue('#f-stock')) === '0');
  ok('harga disalin', (await page.inputValue('#f-price')) === '1000');
  ok('kategori disalin', (await page.inputValue('#f-cat')) === 'atk');
  ok('SKU TIDAK readonly (beda dengan mode ubah)',
    !(await page.locator('#f-sku').isDisabled()));
  ok('ada catatan di atas form', /Salinan baru/.test(await page.innerText('.modal')));

  console.log('=== D. Ganti nama + barcode -> simpan ===');
  await page.fill('#f-name', 'E2e Duplikat Merah');
  await page.waitForTimeout(150);
  ok('SKU tetap kosong walau nama diganti (server yang menomori)',
    (await page.inputValue('#f-sku')) === '', await page.inputValue('#f-sku'));
  await page.fill('#f-barcode', '8999000000009');
  await page.fill('#f-stock', '4');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  const t1 = await toastTerakhir();
  const skuBaru = (t1.match(/PRD\d{5}/) ?? [''])[0];
  ok('toast menyebut diduplikat + PRD##### yang diberi server',
    /diduplikat/.test(t1) && skuBaru !== '', t1);

  await page.fill('#q', 'E2e Duplikat Merah');
  await page.waitForTimeout(400);
  const baru = await page.locator('#rows tr[data-row]', { hasText: 'E2e Duplikat Merah' }).count();
  ok('produk hasil duplikat tampil', baru === 1, String(baru));
  const isi = await page.locator('#rows tr[data-row]', { hasText: 'E2e Duplikat Merah' }).first().innerText();
  ok('SKU di tabel = PRD##### yang diberi server', isi.includes(skuBaru), isi.replace(/\n/g, ' / '));
  ok('SKU produk asal tidak berubah', isi.includes(skuBaru) && !isi.includes(SKU1), isi.replace(/\n/g, ' / '));

  console.log('=== E. Cek unik SKU: SKU lama tidak bisa dipakai lagi ===');
  await page.click('#prod-new');
  await page.waitForSelector('.modal #f-sku', { timeout: 5000 });
  await page.fill('#f-name', 'E2e Duplikat Baru');
  await page.fill('#f-sku', SKU1);
  await page.waitForTimeout(150);
  const hint = (await page.innerText('#f-sku-hint')).trim();
  ok('hint menandai SKU sudah dipakai', /sudah dipakai/.test(hint), hint);
  await page.click('.modal [data-ok]');
  await page.waitForTimeout(600);
  ok('Simpan DITOLAK (form tetap terbuka)', await page.isVisible('.modal #f-sku'));
  const t2 = await toastTerakhir();
  ok('toast menjelaskan SKU dipakai', /sudah dipakai/.test(t2), t2);

  await page.fill('#f-sku', '');
  await page.waitForTimeout(150);
  ok('SKU dikosongkan -> hint kembali normal', /dikosongkan = diisi server/.test(await page.innerText('#f-sku-hint')));
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  const tSimpan = await toastTerakhir();
  ok('tanpa SKU: disimpan, server yang menomori PRD#####',
    /Tersimpan/.test(tSimpan) && /PRD\d{5}/.test(tSimpan), tSimpan);

  console.log('=== F. Halaman Stok ===');
  await page.goto(`${WEB}/#/stock`, { waitUntil: 'load' });
  await page.waitForSelector('#st-q', { timeout: 15000 });
  // Tunggu baris terisi dulu: saat skeleton tampil belum ada tbody, dan fetch
  // server bisa kalah cepat dari hitungan di bawah saat mesin sibuk (full
  // suite) — tanpa tunggu ini `semua` terbaca 0 lalu semua perbandingan ikut
  // gagal (flake, terbukti: lolos 37/37 saat dijalankan sendiri).
  await page.waitForFunction(() => document.querySelectorAll('#page tbody tr').length > 0, {
    timeout: 15000,
  });
  ok('ringkasan terender', (await page.locator('.card', { hasText: 'Nilai persediaan' }).count()) > 0);
  const jumlahBaris = async () => page.locator('#page tbody tr').count();
  const semua = await jumlahBaris();
  ok('tabel stok terisi', semua > 0, String(semua));
  ok('produk sumber ikut terpantau', /E2e Duplikat Sumber/.test(await page.innerText('#page')));

  await page.click('[data-filter="habis"]');
  await page.waitForTimeout(200);
  const habis = await jumlahBaris();
  ok('filter "Stok habis" memperkecil daftar', habis <= semua, `${habis} <= ${semua}`);
  const angkaHabis = await page.locator('#page tbody tr .badge-low').allInnerTexts();
  ok('semua baris terender bertanda habis/menipis', angkaHabis.every((t) => /habis|\/ min/.test(t)), angkaHabis.join(' | '));

  await page.click('[data-filter="semua"]');
  await page.waitForTimeout(200);
  ok('kembali ke Semua', (await jumlahBaris()) === semua);

  await page.fill('#st-q', 'E2e Duplikat Sumber');
  await page.waitForTimeout(300);
  ok('pencarian menyaring', (await jumlahBaris()) === 1, String(await jumlahBaris()));

  console.log('=== G. Restock langsung dari halaman Stok ===');
  const stokSebelum = await page.locator('#page tbody tr .badge-ok, #page tbody tr .badge-low').first().innerText();
  await page.locator('#page [data-stock]').first().click();
  await page.waitForSelector('.modal #r-qty', { timeout: 5000 });
  ok('dialog stok terbuka', /Stok: E2e Duplikat Sumber/.test(await page.locator('.modal-header h3').innerText()));
  await page.fill('#r-qty', '3');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  const t3 = await toastTerakhir();
  ok('restock sukses', /\+3/.test(t3), `${t3} (sebelum: ${stokSebelum.replace(/\n/g, ' ')})`);
  await page.waitForTimeout(400);
  ok('tabel ter-update (7 -> 10)', /10/.test(await page.locator('#page tbody tr').first().innerText()));

  console.log('=== H. Tanpa error runtime ===');
  ok('tidak ada pageerror/console error', errs.length === 0, errs.join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL eksekusi:', e.message);
} finally {
  await page.screenshot({ path: `${ARTIFAK}/e2e-duplikat.png` }).catch(() => {});
  await browser.close();
  const sisa = cleanup();
  console.log(`cleanup akhir: sisa = ${sisa} (harus 0)`);
  if (sisa !== 0) gagal++;
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
