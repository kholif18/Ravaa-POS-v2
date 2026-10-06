// E2E produk harga khusus (products.price_dynamic) — permintaan pemilik 2026-10-06:
//   "karena harga bisa di ubah inline, modal dynamic harga tidak usah" —
//   dialog harga saat scan DIHAPUS; SEMUA produk masuk satu jalur:
//   A. Scan -> TANPA dialog, baris langsung masuk dengan harga DEFAULT master.
//   B. Harga sama saat scan ulang -> qty baris bertambah.
//   C. Kolom Harga baris = INPUT (produk dinamis) -> edit lewat `setHarga()`:
//      re-key baris; harga BERBEDA = baris BARU (scan setelah edit pun
//      menghasilkan baris terpisah); menabrak baris berharga sama -> DIGABUNG.
//   D. Produk non-dinamis: kolom Harga tetap TEKS terkunci (tanpa input).
//   E. Pembayaran F12 tetap lolos dan server menyimpan harga hasil edit di
//      sale_items.price (dynamic = harga dari client; non-dinamis dikunci server).
// Jalankan: node tests/harga-dinamis-test.mjs   (API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const API = 'http://localhost:3001';
const SKU = 'UJIDYN';
const NAMA = 'Produk Harga Khusus';
const HARGA_DEFAULT = 2000;

// Setup idempoten (upsert by SKU): harga 2000 + switch harga khusus NYALA.
// Stok besar supaya tidak bergantung pada riwayat test lain.
let produkId = null;
{
  const r = await fetch(`${API}/api/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sku: SKU, name: NAMA, category_slug: 'atk', unit: 'pcs',
      price: HARGA_DEFAULT, price_dynamic: 1, stock: 500, min_stock: 0, is_active: 1,
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('setup produk gagal:', JSON.stringify(j)); process.exit(1); }
  produkId = j.data?.id ?? j.id ?? null;
}

// Shift terbuka untuk kasir default ('kasir') — POS tidak bisa tanpa shift.
{
  const buka = await (await fetch(`${API}/api/shifts/open?cashier=kasir`)).json();
  if (!buka.data) {
    await fetch(`${API}/api/shifts/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modal_awal: 100000, cashier: 'kasir' }),
    });
  }
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

/** Isi per baris keranjang (baris `note` dilewati — colspan=3 di bawah baris
 *  produk, bukan baris produk). Harus self-contained: fungsi ini dievaluasi
 *  DI HALAMAN. */
const baris = () => page.evaluate(() => [...document.querySelectorAll('#pos-cart tbody tr[data-key]:not(.note-row)')].map((tr) => ({
  key: tr.dataset.key ?? '',
  qty: Number(tr.querySelector('[data-act="qty"]')?.value ?? '0'),
  dyn: !!tr.querySelector('[data-act="price"]'),
  harga: (tr.querySelector('[data-act="price"]')?.value ?? String(tr.children[3]?.textContent ?? '')).replace(/\s+/g, ' ').trim(),
})));
const nBaris = () => page.evaluate(() => document.querySelectorAll('#pos-cart tbody tr[data-key]:not(.note-row)').length);
const nModal = () => page.locator('.modal-overlay').count();

/** Scan SKU: Enter kadang datang sebelum master selesai sinkron (konteks
 *  browser baru = cache IndexedDB kosong) — ulang sampai jumlah baris `n`. */
const scanSampaiBaris = async (q, n) => {
  for (let i = 0; i < 8; i++) {
    await page.fill('#pos-q', q);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    if ((await nBaris()) >= n) return true;
  }
  return (await nBaris()) >= n;
};
const tungguJumlah = async (n) => {
  await page.waitForFunction((x) =>
    document.querySelectorAll('#pos-cart tbody tr[data-key]:not(.note-row)').length === x,
    n, { timeout: 5000 },
  ).catch(() => {});
};

try {
  await page.goto('http://localhost:5656/#/pos', { waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  await page.waitForTimeout(500);

  // A. Scan produk dinamis -> TANPA dialog, langsung masuk harga default.
  const masukA = await scanSampaiBaris(SKU, 1);
  ok('A1 scan langsung masuk (tanpa dialog harga)', masukA && (await nModal()) === 0,
    `masuk=${masukA} modal=${await nModal()}`);
  let r = await baris();
  ok('A2 satu baris langsung ada', r.length === 1, JSON.stringify(r));
  ok('A3 baris memakai HARGA DEFAULT + kolom jadi input', r[0]?.dyn === true && r[0]?.harga === String(HARGA_DEFAULT), JSON.stringify(r[0]));

  // B. Scan lagi dengan harga sama -> qty bertambah, 1 baris.
  await scanSampaiBaris(SKU, 1);
  await tungguJumlah(1);
  r = await baris();
  ok('B harga sama -> qty bertambah, tetap 1 baris', r.length === 1 && r[0]?.qty === 2, JSON.stringify(r));

  // C. Edit kolom Harga 2000 -> 3000: re-key, qty utuh, tetap 1 baris.
  await page.fill('tr[data-key$=":2000"] [data-act="price"]', '3000');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  r = await baris();
  ok('C edit harga -> re-key ke :3000, qty utuh', r.length === 1 && r[0].key.endsWith(':3000') && r[0].qty === 2 && r[0].harga === '3000', JSON.stringify(r));

  // D. Scan lagi (bawa default 2000) -> BEDA harga dengan baris :3000 = BARIS BARU.
  await scanSampaiBaris(SKU, 2);
  await tungguJumlah(2);
  r = await baris();
  ok('D scan setelah edit harga -> baris BARU (2 baris)', r.length === 2, JSON.stringify(r));
  const byHarga = Object.fromEntries(r.map((x) => [x.harga, x.qty]));
  ok('D2 distribusi qty per harga benar (3000:2, 2000:1)', byHarga['3000'] === 2 && byHarga['2000'] === 1, JSON.stringify(byHarga));

  // E. Edit baris @2000 -> 3000: MENABRAK baris :3000 -> DIGABUNG.
  await page.fill('tr[data-key$=":2000"] [data-act="price"]', '3000');
  await page.keyboard.press('Enter');
  await tungguJumlah(1);
  r = await baris();
  ok('E edit harga menabrak baris sama -> digabung (1 baris)', r.length === 1, JSON.stringify(r));
  ok('E2 qty gabungan 3 @Rp3.000', r[0]?.qty === 3 && r[0]?.harga === '3000', JSON.stringify(r[0]));

  // F. Input harga tidak memotong digit (regresi lebar kolom — terukur
  //    2026-10-06: w-16 lama meng-clip "2000" jadi "200"; kini w-24 !px-2).
  const ukurClip = (v) => page.evaluate((val) => {
    const el = document.querySelector('#pos-cart [data-act="price"]');
    if (!el) return null;
    const asli = el.value; el.value = val;
    const clip = el.scrollWidth > el.clientWidth;
    el.value = asli;
    return clip;
  }, v);
  ok('F1 input harga tidak memotong digit 4 (2000)', (await ukurClip('2000')) === false, 'scrollWidth > clientWidth');
  ok('F2 input harga tidak memotong digit 6 (150000)', (await ukurClip('150000')) === false, 'scrollWidth > clientWidth');

  // G. Produk NON-dinamis: tanpa dialog juga, kolom Harga = teks terkunci.
  const sebelumG = await nBaris();
  const masukG = await scanSampaiBaris('PRD00001', sebelumG + 1);
  ok('G1 scan non-dinamis masuk, tetap tanpa dialog', masukG && (await nModal()) === 0, `masuk=${masukG} modal=${await nModal()}`);
  r = await baris();
  const barisNonDyn = r.filter((x) => !x.dyn);
  ok('G2 kolom Harga non-dinamis = teks terkunci (Rp…), tanpa input',
    barisNonDyn.length === 1 && barisNonDyn[0].harga.startsWith('Rp'),
    JSON.stringify(r));

  // H. Bayar F12 (bayar pas) -> resume tampil; server simpan harga hasil edit.
  await page.keyboard.press('F12');
  const adaResume = await page.waitForSelector('.swal2-popup', { timeout: 8000 }).then(() => true).catch(() => false);
  ok('H1 F12 bayar pas -> dialog resume penjualan tampil', adaResume, 'tidak ada .swal2-popup');
  if (adaResume) {
    await page.keyboard.press('Escape');
    const tertutup = await page.waitForSelector('.swal2-popup', { state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false);
    ok('H2 Escape menutup dialog resume', tertutup, 'popup masih terbuka');
  } else ok('H2 Escape menutup dialog resume', false, 'tidak ada dialog untuk ditutup');
  const j = await (await fetch(`${API}/api/sales?limit=1`)).json();
  const saleId = j.data?.[0]?.id ?? null;
  ok('H3 penjualan tercatat di server', !!saleId, JSON.stringify(j).slice(0, 200));
  if (saleId) {
    const d = await (await fetch(`${API}/api/sales/${saleId}`)).json();
    const items = d.data?.items ?? d.items ?? []; // kontrak: {data:{sale,items}}
    const it = items.find((x) => x.name === NAMA);
    ok('H4 server simpan harga edit: qty 3 x Rp3.000', !!it && it.qty === 3 && it.price === 3000, JSON.stringify(it));
  } else ok('H4 server simpan harga edit: qty 3 x Rp3.000', false, 'tidak ada sale id');
  ok('H5 tanpa error konsol/halaman', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
} catch (e) {
  console.error('CRASH', e);
  try { await browser.close(); } catch { /* sudah tertutup */ }
  process.exit(1);
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
