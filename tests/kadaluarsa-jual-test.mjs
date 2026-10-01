// Pengaturan baru `tolak_jual_kadaluarsa` (O1) — server MENOLAK penjualan yang
// memuat barang lewat `expiry_date`, default MATI, saklar di halaman #/settings.
// Yang diuji di sini:
//   A. Kontrak GET/POST /api/settings kini dua kunci + update PARSIAL
//      (kunci yang tidak dikirim TIDAK direset — aturan lama "tidak dikirim =
//      reset" berlaku per payload produk, bukan per settings).
//   B. Dengan aturan AKTIF: expired (< hari UTC) -> 400 "barang kadaluarsa",
//      hari kadaluarsa == hari ini -> MASIH SAH (201), item manual -> bebas.
//   C. Dengan aturan MATI: expired -> 201 (perilaku lama kembali).
//   D. UI #/settings: dua kartu saklar, toggle kadaluarsa lewat konfirmasi swal
//      benar-benar mengubah setting server.
//   E. finally: restore nilai asli + cleanup keras sqlite (pola shift-test /
//      foto-tambah) — artefak uji harus 0 di akhir suite.
// Jalankan: node kadaluarsa-jual-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');

const jget = async (u) => {
  const r = await fetch(API + u);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const jpost = async (u, payload) => {
  const r = await fetch(API + u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};

// Artefak uji memakai namespace unik + dibersihkan keras di finally, supaya
// suite lain (product-delete-test: global UJI-%=0) tidak pernah melihat sisa.
const TS = Date.now().toString(36);
const KASIR = `uji-kadalu-${TS}`;
const SKU_A = `UJI-KADAL-${TS}`;             // kedaluarsa H-2
const SKU_B = `UJI-KADAL-HARIINI-${TS}`;     // expiry = hari ini (masih sah)
const KEDALU = /barang kadaluarsa/;

/** Baca nilai asli dulu — supaya akhir suite mengembalikan kondisi awal. */
async function bacaAsli() {
  const g = await jget('/api/settings');
  return {
    minus: g.body?.data?.allow_negative_stock === true,
    tolak: g.body?.data?.tolak_jual_kadaluarsa === true,
  };
}

/** Cleanup keras artefak uji lewat sqlite3 (test-only, pola shift-test /
 *  foto-tambah). Kembalikan "produk=sisa|sales=sisa" untuk asersi invarian. */
function bersih(asli) {
  try {
    execFileSync('sqlite3', [DB,
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE cashier = '${KASIR}');`]);
    execFileSync('sqlite3', [DB, `DELETE FROM sales WHERE cashier = '${KASIR}';`]);
    execFileSync('sqlite3', [DB,
      `DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'UJI-KADAL-%');`]);
    execFileSync('sqlite3', [DB, `DELETE FROM products WHERE sku LIKE 'UJI-KADAL-%';`]);
    // Restore dua kunci ke nilai asli lewat API (bukan sqlite) — menguji jalur
    // normal sekaligus menjamin aturan tidak bocor ke suite berikutnya.
    return jpost('/api/settings', {
      allow_negative_stock: asli.minus,
      tolak_jual_kadaluarsa: asli.tolak,
    }).then(async () => {
      const p = execFileSync('sqlite3', [DB,
        `SELECT (SELECT COUNT(*) FROM products WHERE sku LIKE 'UJI-KADAL-%') || '|' || (SELECT COUNT(*) FROM sales WHERE cashier = '${KASIR}');`],
        { encoding: 'utf8' }).trim();
      return p;
    });
  } catch (e) {
    return Promise.resolve(`ERR:${String(e.message || e).slice(0, 120)}`);
  }
}

let asli = { minus: false, tolak: false };
let asliDibaca = false;

try {
  console.log('=== A. Kontrak GET/POST /api/settings (dua kunci, parsial) ===');
  const g0 = await jget('/api/settings');
  ok('GET /api/settings 200 + kedua kunci boolean',
    g0.status === 200
      && typeof g0.body?.data?.allow_negative_stock === 'boolean'
      && typeof g0.body?.data?.tolak_jual_kadaluarsa === 'boolean',
    JSON.stringify(g0.body));
  asli = { minus: g0.body.data.allow_negative_stock === true, tolak: g0.body.data.tolak_jual_kadaluarsa === true };
  asliDibaca = true;

  const tipe = await jpost('/api/settings', { tolak_jual_kadaluarsa: 'ya' });
  ok('nilai non-boolean "ya" -> 400 (angka 0/1 juga ditolak kontrak)',
    tipe.status === 400 && /boolean/.test(tipe.body?.error ?? ''),
    JSON.stringify(tipe.body));

  const kosong = await jpost('/api/settings', {});
  ok('payload kosong -> 400 (minimal satu kunci)',
    kosong.status === 400 && /pengaturan/.test(kosong.body?.error ?? ''),
    JSON.stringify(kosong.body));

  const nyalakan = await jpost('/api/settings', { tolak_jual_kadaluarsa: true });
  ok('POST parsial {tolak: true} -> 200 data.tolak=true',
    nyalakan.status === 200 && nyalakan.body?.data?.tolak_jual_kadaluarsa === true,
    JSON.stringify(nyalakan.body));

  ok('kunci lain TIDAK ikut ter-reset (allow_negative_stock tetap nilai asli)',
    nyalakan.body?.data?.allow_negative_stock === asli.minus,
    `dapat=${JSON.stringify(nyalakan.body?.data?.allow_negative_stock)} asli=${asli.minus}`);

  console.log('=== B. Aturan AKTIF: server menolak barang lewat kadaluarsa ===');
  const d2 = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  const hariIni = new Date().toISOString().slice(0, 10);
  const pa = await jpost('/api/products', {
    sku: SKU_A, name: 'Uji kadaluarsa H-2', category_slug: 'snack',
    unit: 'pcs', price: 1000, stock: 5, expiry_date: d2,
  });
  const idA = pa.body?.data?.id;
  ok('produk expired H-2 tersimpan (id + expiry_date)', pa.status === 201 && Number(idA) > 0
    && pa.body?.data?.expiry_date === d2, JSON.stringify(pa.body).slice(0, 200));

  const jualA = await jpost('/api/sales', {
    shift_id: null, items: [{ product_id: idA, qty: 1 }],
    pay_method: 'tunai', cashier: KASIR,
  });
  ok('sale produk expired -> 400 "barang kadaluarsa: ... (berakhir ...)"',
    jualA.status === 400 && KEDALU.test(jualA.body?.error ?? '')
      && /berakhir/.test(jualA.body?.error ?? ''),
    JSON.stringify(jualA.body));

  const pb = await jpost('/api/products', {
    sku: SKU_B, name: 'Uji kadaluarsa hari ini', category_slug: 'snack',
    unit: 'pcs', price: 1000, stock: 5, expiry_date: hariIni,
  });
  const idB = pb.body?.data?.id;
  ok('produk expiry = hari ini tersimpan', pb.status === 201 && Number(idB) > 0
    && pb.body?.data?.expiry_date === hariIni, JSON.stringify(pb.body).slice(0, 200));

  const jualB = await jpost('/api/sales', {
    shift_id: null, items: [{ product_id: idB, qty: 1 }],
    pay_method: 'tunai', cashier: KASIR,
  });
  ok('sale expiry hari-ini -> 201 (hari kadaluarsa masih sah)',
    jualB.status === 201, JSON.stringify(jualB.body).slice(0, 200));

  const manual = await jpost('/api/sales', {
    shift_id: null, items: [{ name: 'Jasa uji kadaluarsa', qty: 1, price: 500 }],
    pay_method: 'tunai', cashier: KASIR,
  });
  ok('item manual tanpa produk -> 201 (tanpa tanggal, bebas cek)',
    manual.status === 201, JSON.stringify(manual.body).slice(0, 200));

  console.log('=== C. Aturan MATI: perilaku lama kembali (expired boleh) ===');
  const matikan = await jpost('/api/settings', { tolak_jual_kadaluarsa: false });
  ok('POST {tolak: false} -> 200 data.tolak=false',
    matikan.status === 200 && matikan.body?.data?.tolak_jual_kadaluarsa === false,
    JSON.stringify(matikan.body));

  const lolosA = await jpost('/api/sales', {
    shift_id: null, items: [{ product_id: idA, qty: 1 }],
    pay_method: 'tunai', cashier: KASIR,
  });
  ok('sale expired saat aturan MATI -> 201 (default bawaan)',
    lolosA.status === 201, JSON.stringify(lolosA.body).slice(0, 200));

  console.log('=== D. UI #/settings — dua kartu + toggle kadaluarsa ===');
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${WEB}/#/settings`, { waitUntil: 'load' });
    await page.waitForSelector('#set-kadaluarsa', { timeout: 10000 });
    const judul = await page.locator('#set-body h3').allInnerTexts();
    ok('dua kartu pengaturan: "Stok boleh minus" + "Tolak jual kadaluarsa"',
      judul.includes('Stok boleh minus') && judul.includes('Tolak jual kadaluarsa'),
      JSON.stringify(judul));

    // Saklar sr-only: klik LABEL-nya (for= memicu change), lalu konfirmasi swal.
    await page.locator('label[for="set-kadaluarsa"]').click();
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await page.locator('.swal2-confirm').click();
    await page.waitForTimeout(800); // POST + paint ulang
    const nyala = await jget('/api/settings');
    ok('toggle ON -> confirm swal -> setting server berubah true',
      nyala.body?.data?.tolak_jual_kadaluarsa === true, JSON.stringify(nyala.body));

    await page.locator('label[for="set-kadaluarsa"]').click();
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await page.locator('.swal2-confirm').click();
    await page.waitForTimeout(800);
    const mati = await jget('/api/settings');
    ok('toggle OFF -> confirm swal -> setting server kembali false',
      mati.body?.data?.tolak_jual_kadaluarsa === false, JSON.stringify(mati.body));

    ok('tanpa error console saat membuka & toggle Pengaturan',
      errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  // Bila A.1 gagal sebelum nilai asli sempat dibaca, baca dulu — restore tidak
  // boleh memaksa false ke sebuah install yang sengaja menyalakan aturan.
  if (!asliDibaca) asli = await bacaAsli();
  const sisa = await bersih(asli);
  const bersih2 = sisa === '0|0';
  if (bersih2) { lolos++; console.log('  OK   E. cleanup: 0 sisa produk & 0 sisa sales uji + setting asli dipulihkan'); }
  else { gagal++; console.log(`  GAGAL E. cleanup artefak uji | sisa=${sisa}`); }

  const nama = fileURLToPath(import.meta.url).split('/').pop();
  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [${nama}]`);
  if (gagal) process.exit(1);
}
