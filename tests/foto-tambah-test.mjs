// E: foto di mode Tambah/Duplikat — kotak foto HIDUP, pilihan ditahan di
// memori lalu diunggah OTOMATIS setelah POST /api/products sukses; Batal =
// dibuang tanpa jejak (foto lama tidak boleh bocor ke produk berikutnya).
//
// SKU memakai namespace `UJI-FOTO-%` (bukan SKU PRD hasil nomor otomatis)
// supaya cleanup keras di akhir test tidak menyentuh rangkaian PRD — persis
// alasan yang sama dengan UJI-% di product-delete-test dan "Uji SKU Urut%" di
// sku-urut-test. Endpoint API hanya bisa SOFT delete, sedangkan suite
// product-delete-test mewajibkan dev DB kembali TANPA tombstone.
//
// Jalankan: node foto-tambah-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, unlinkSync } from 'node:fs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
// PNG 1x1 merah cukup untuk uji alur (client me-resize ke thumbnail JPEG 512px).
const FOTO = '/tmp/opencode/uji-foto-e2e.png';
writeFileSync(FOTO, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const TS = Date.now().toString(36);
const SKU = `UJI-FOTO-${TS}`;
const SKU2 = `UJI-FOTO-${TS}-TANPA`;
const NAMA = `Foto auto uji ${TS}`;
const NAMA2 = `${NAMA} tanpa foto`;

const get = async (u) => (await fetch(API + u)).json();

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} | ${info}`); }
};

try {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  let prod = null, prod2 = null;
  try {
    console.log('=== A. Form Tambah: kotak foto hidup ===');
    await page.goto(`${WEB}/#/products`, { waitUntil: 'load' });
    await page.waitForTimeout(1600);
    await page.click('#prod-new');
    await page.waitForTimeout(500);
    ok('input berkas foto ada di mode Tambah', (await page.locator('#f-photo-file').count()) === 1);
    const hint = (await page.locator('.modal .hint', { hasText: 'diunggah otomatis' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    ok('hint menjanjikan unggah otomatis setelah simpan',
      /diunggah otomatis setelah produk disimpan/i.test(hint), hint.slice(0, 160));

    console.log('=== B. Pilih foto -> pratinjau di memori (belum ada id) ===');
    await page.fill('#f-name', NAMA);
    await page.fill('#f-sku', SKU); // namespace uji — lihat kepala file
    await page.setInputFiles('#f-photo-file', FOTO);
    await page.waitForTimeout(900);
    const src = await page.locator('#f-photo').getAttribute('src');
    ok('pratinjau tampil dari dataURL hasil resize',
      typeof src === 'string' && src.startsWith('data:image/jpeg') && !(await page.locator('#f-photo').isHidden()),
      String(src).slice(0, 50));

    console.log('=== C. Simpan -> foto terunggah otomatis ===');
    await page.click('.modal-overlay [data-ok]');
    await page.waitForTimeout(2500);
    const list = await get(`/api/products?q=${encodeURIComponent(NAMA)}&status=semua`);
    prod = (list.data ?? []).find((x) => x.name === NAMA);
    ok('produk tersimpan dengan SKU uji', prod?.sku === SKU, JSON.stringify(prod ?? null));
    ok('kolom image terisi nama file (unggah otomatis sukses)',
      typeof prod?.image === 'string' && prod.image !== '', `image=${prod?.image}`);
    const r = await fetch(`${API}/api/products/${prod.id}/image`);
    const ct = r.headers.get('content-type') ?? '';
    const n = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    ok('GET /api/products/:id/image 200 + gambar tidak kosong',
      r.status === 200 && ct.startsWith('image/') && n > 0, `status=${r.status} ct=${ct} bytes=${n}`);

    console.log('=== D. Batal membuang pilihan (tidak bocor ke produk berikutnya) ===');
    await page.waitForTimeout(600);
    await page.click('#prod-new');
    await page.waitForTimeout(500);
    await page.setInputFiles('#f-photo-file', FOTO);
    await page.waitForTimeout(700);
    await page.click('.modal-overlay [data-x]'); // Batal
    await page.waitForTimeout(700);
    await page.click('#prod-new');
    await page.waitForTimeout(500);
    const srcBaru = await page.locator('#f-photo').getAttribute('src');
    ok('form baru bersih dari pilihan foto lama', !srcBaru, `src=${srcBaru}`);
    await page.fill('#f-name', NAMA2);
    await page.fill('#f-sku', SKU2);
    await page.click('.modal-overlay [data-ok]');
    await page.waitForTimeout(2200);
    const list2 = await get(`/api/products?q=${encodeURIComponent(NAMA2)}&status=semua`);
    prod2 = (list2.data ?? []).find((x) => x.name === NAMA2);
    ok('produk tanpa pilihan baru: image tetap null', Boolean(prod2) && prod2.image == null,
      `image=${prod2?.image}`);
    ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    // Cleanup keras artefak uji lewat sqlite3 langsung (test-only — pola sama
    // dengan product-delete-test): API hanya punya soft delete, dan sisa
    // tombstone akan membuat suite product-delete-test gagal. Thumbnail di
    // apps/api/data/img/ ikut dibuang supaya tidak menumpuk jadi yatim.
    const bersih = () => {
      try {
        const baris = execFileSync('sqlite3', [DB,
          `SELECT COALESCE(image,'') FROM products WHERE sku LIKE 'UJI-FOTO-%';`],
          { encoding: 'utf8' }).trim();
        for (const img of baris.split('\n').filter(Boolean)) {
          try { unlinkSync(path0.join(REPO, 'apps/api/data/img', img)); } catch { /* mungkin sudah hilang */ }
        }
        execFileSync('sqlite3', [DB, `DELETE FROM products WHERE sku LIKE 'UJI-FOTO-%';`]);
        return execFileSync('sqlite3', [DB,
          // Invarian: artefak uji 0 DAN dev DB kembali tanpa tombstone sama sekali.
          `SELECT (SELECT COUNT(*) FROM products WHERE sku LIKE 'UJI-FOTO-%')||'|'||(SELECT COUNT(*) FROM products WHERE deleted_at IS NOT NULL)`],
          { encoding: 'utf8' }).trim();
      } catch (e) { return 'gagal: ' + String(e).slice(0, 120); }
    };
    const hasil = bersih();
    ok('artefak uji dibersihkan keras: 0 UJI-FOTO / 0 tombstone', hasil === '0|0', hasil);
    unlinkSync(FOTO);
  }
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  const nama = fileURLToPath(import.meta.url).split('/').pop();
  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [${nama}]`);
  if (gagal) process.exit(1);
}
