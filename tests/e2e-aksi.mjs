// E2E aksi baris tabel Produk: hanya Ubah + Hapus yang selalu tampil langsung,
// sisanya (stok, duplikat, nonaktifkan / aktifkan) pindah ke menu ⋮ (titik tiga).
// Jalankan: node e2e-aksi.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
const ARTIFAK = path0.join(path0.dirname(fileURLToPath(import.meta.url)), 'artifacts');
import { execFileSync } from 'node:child_process';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
const SKU_STOK = 'E2E-AKSI-STOK';   // track_stock=1  -> menu berisi Stok & opname
const SKU_JASA = 'E2E-AKSI-JASA';   // track_stock=0  -> menu TANPA Stok & opname
const SKU_OFF = 'E2E-AKSI-OFF';     // is_active=0    -> menu berisi Aktifkan kembali

/** Bersihkan lewat sqlite3 (test-only): DELETE API hanya soft delete, baris
 *  tombstone nempel dan menggagalkan product-delete-test (tombstone = 0). */
const cleanup = () => {
  try {
    execFileSync('sqlite3', [DB,
      "DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'E2E-AKSI%'); " +
      "DELETE FROM products WHERE sku LIKE 'E2E-AKSI%';"]);
    return Number(execFileSync('sqlite3', [DB,
      "SELECT COUNT(*) FROM products WHERE sku LIKE 'E2E-AKSI%'"], { encoding: 'utf8' }).trim());
  } catch (e) {
    console.log('  (cleanup gagal:', String(e).slice(0, 120), ')');
    return -1;
  }
};
console.log('cleanup awal: sisa E2E-AKSI% =', cleanup());

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

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

/** Baris untuk produk bernama tertentu (setelah #q diisi). */
const baris = (nama) =>
  page.locator('#rows tr[data-row]', { hasText: nama }).first();

try {
  console.log('=== A. Siapkan 3 produk uji ===');
  const stok = await post('/api/products', {
    sku: SKU_STOK, name: 'E2e Aksi Stok', category_slug: 'atk', unit: 'pcs',
    price: 1000, cost: 800, markup: 25, price_dynamic: 0, stock: 5, min_stock: 1, is_active: 1,
  });
  ok('produk track_stock dibuat', stok?.data?.sku === SKU_STOK, JSON.stringify(stok).slice(0, 200));

  const jasa = await post('/api/products', {
    sku: SKU_JASA, name: 'E2e Aksi Jasa', category_slug: 'jasa', unit: 'pcs',
    price: 5000, cost: 0, markup: 0, price_dynamic: 0, stock: 0, min_stock: 0, is_active: 1,
  });
  ok('produk non-track dibuat', jasa?.data?.sku === SKU_JASA, JSON.stringify(jasa).slice(0, 200));

  const off = await post('/api/products', {
    sku: SKU_OFF, name: 'E2e Aksi Nonaktif', category_slug: 'atk', unit: 'pcs',
    price: 2000, cost: 1500, markup: 33, price_dynamic: 0, stock: 3, min_stock: 0, is_active: 0,
  });
  ok('produk nonaktif dibuat', off?.data?.sku === SKU_OFF, JSON.stringify(off).slice(0, 200));

  console.log('=== B. Baris: hanya Ubah + Hapus yang tampil langsung ===');
  await page.goto(`${WEB}/#/products`, { waitUntil: 'load' });
  await page.waitForSelector('#rows tr[data-row]', { timeout: 20000 });
  await page.fill('#q', 'E2e Aksi Stok');
  await page.waitForTimeout(400);
  const b = baris('E2e Aksi Stok');
  ok('produk tampil', (await b.count()) > 0);
  ok('Ubah tampil langsung & terlihat', (await b.locator('[data-edit]').count()) === 1 && await b.locator('[data-edit]').isVisible());
  ok('Hapus tampil langsung & terlihat', (await b.locator('[data-del]').count()) === 1 && await b.locator('[data-del]').isVisible());
  ok('TIDAK ada lagi "Stok & opname" di baris (pindah ke halaman Stok)',
    (await b.locator('[data-restock]').count()) === 0);
  ok('Duplikat ada tapi tersembunyi',
    (await b.locator('[data-copy]').count()) === 1 && !(await b.locator('[data-copy]').isVisible()));
  ok('Nonaktifkan ada tapi tersembunyi',
    (await b.locator('[data-off]').count()) === 1 && !(await b.locator('[data-off]').isVisible()));
  ok('baris berisi tepat 3 tombol: Ubah, Hapus, ⋮',
    (await b.locator('button[data-edit], button[data-del], button[data-more]').count()) === 3);
  // Pengawas: komentar `{/* … */}` di dalam template literal bukan JSX, jadi
  // ikut tercetak jadi teks nyasar di kolom (pernah terjadi, lolos semua test).
  const teksAksi = (await b.locator('td').last().innerText()).replace(/\s+/g, ' ').trim();
  ok('kolom Aksi bersih — hanya ikon tombol, tanpa teks nyasar', teksAksi === '', JSON.stringify(teksAksi));

  console.log('=== C. ⋮ membuka menu (dan tidak keluar layar) ===');
  await b.locator('[data-more]').click();
  await page.waitForSelector('.row-more.is-open .row-dd', { timeout: 3000 });
  ok('menu ⋮ terbuka & terlihat', await b.locator('.row-dd').isVisible());
  ok('aria-expanded = true', (await b.locator('[data-more]').getAttribute('aria-expanded')) === 'true');
  ok('isi menu TANPA Stok & opname (stok urusnya di #/stock)', (await b.locator('.row-dd [data-restock]').count()) === 0);
  ok('isi menu: Duplikat (varian baru)', await b.locator('.row-dd [data-copy]').isVisible());
  ok('isi menu: Nonaktifkan', await b.locator('.row-dd [data-off]').isVisible());
  const box = await b.locator('.row-dd').boundingBox();
  ok('menu di dalam viewport (position: fixed, dijepit)',
    !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900,
    JSON.stringify(box));

  console.log('=== D. Item menu tetap hidup; menu menutup sendiri ===');
  // [data-restock] sudah dihapus dari menu (stok pindah ke halaman Stok), jadi
  // "item menu hidup" dibuktikan lewat Duplikat: klik item harus membuka modal
  // DAN menutup menu. Isi dialognya diuji tersendiri oleh e2e-duplikat.
  await b.locator('.row-dd [data-copy]').click();
  await page.waitForSelector('#f-sku', { timeout: 8000 });
  ok('"Duplikat (varian baru)" dari menu membuka dialog', await page.isVisible('#f-sku'));
  ok('menu tertutup setelah item diklik', !(await b.locator('.row-dd').isVisible()));
  await page.click('.modal [data-x]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 });
  ok('dialog ditutup tanpa merusak apapun', !(await page.isVisible('.modal')));

  console.log('=== E. Klik di luar & Escape menutup menu ===');
  await b.locator('[data-more]').click();
  ok('menu bisa dibuka lagi', await b.locator('.row-dd').isVisible());
  await page.click('#q');
  await page.waitForTimeout(250);
  ok('klik di luar menutup menu', !(await b.locator('.row-dd').isVisible()));
  await b.locator('[data-more]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok('Escape menutup menu', !(await b.locator('.row-dd').isVisible()));

  console.log('=== F. Produk jasa (track_stock=0): menu tanpa Stok ===');
  await page.fill('#q', 'E2e Aksi Jasa');
  await page.waitForTimeout(400);
  const bj = baris('E2e Aksi Jasa');
  await bj.locator('[data-more]').click();
  await page.waitForSelector('.row-more.is-open .row-dd', { timeout: 3000 });
  ok('menu jasa juga tanpa Stok & opname (tidak ada di menu siapa pun)', (await bj.locator('.row-dd [data-restock]').count()) === 0);
  ok('menu jasa tetap berisi Duplikat', await bj.locator('.row-dd [data-copy]').isVisible());
  ok('menu jasa tetap berisi Nonaktifkan', await bj.locator('.row-dd [data-off]').isVisible());
  ok('menu jasa berisi tepat 2 item', (await bj.locator('.row-dd [role="menuitem"]').count()) === 2);
  await page.keyboard.press('Escape');

  console.log('=== G. Produk nonaktif: Ubah tetap hidup, isinya Aktifkan ===');
  await page.click('[data-status="nonaktif"]');
  await page.waitForTimeout(700);
  await page.fill('#q', 'E2e Aksi Nonaktif');
  await page.waitForTimeout(400);
  const bo = baris('E2e Aksi Nonaktif');
  ok('produk nonaktif tampil di tab Nonaktif', (await bo.count()) > 0);
  ok('Ubah tetap terlihat di baris nonaktif', await bo.locator('[data-edit]').isVisible());
  await bo.locator('[data-more]').click();
  await page.waitForSelector('.row-more.is-open .row-dd', { timeout: 3000 });
  ok('menu nonaktif berisi Aktifkan kembali', await bo.locator('.row-dd [data-on]').isVisible());
  ok('menu nonaktif TANPA Nonaktifkan', (await bo.locator('.row-dd [data-off]').count()) === 0);
  await page.keyboard.press('Escape');
  // Ubah dulu hanya mencari di state.products -> tombolnya mati diam-diam.
  await bo.locator('[data-edit]').click();
  await page.waitForSelector('.modal #f-sku', { timeout: 8000 });
  ok('Ubah produk nonaktif membuka form (dulu: tidak terjadi apa-apa)', await page.isVisible('#f-name'));
  ok('switch "Aktif" menandai nonaktif (tidak diaktifkan diam-diam)',
    !(await page.locator('#f-active').isChecked()));
  await page.click('.modal [data-x]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 8000 });

  console.log('=== H. Tanpa error runtime ===');
  ok('tanpa pageerror / console error', errs.length === 0, errs.join(' | '));

  await page.screenshot({ path: `${ARTIFAK}/e2e-aksi.png`, fullPage: false });
} catch (e) {
  gagal++;
  console.log('GAGAL eksekusi:', String(e).slice(0, 400));
  await page.screenshot({ path: `${ARTIFAK}/e2e-aksi-gagal.png` }).catch(() => {});
} finally {
  await browser.close();
}

console.log('cleanup akhir: sisa E2E-AKSI% =', cleanup(), '(harus 0)');
console.log(`\n=== ${gagal ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal ? 1 : 0);
