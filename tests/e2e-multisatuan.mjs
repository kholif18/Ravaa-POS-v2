// E2E #3 — Multi satuan (tabel product_units).
// Jalankan: node tests/e2e-multisatuan.mjs   (API :3001 + vite :5656 hidup)
//
// Sifat: RELATIF — payload & stok produk dicatat di awal, lalu DIPULIHKAN persis
// lewat satu POST /api/products + opname di finally. Jadi suite ini aman
// dijalankan berulang dan tidak mewarisi sisa run sebelumnya.
//
// Request /print DISELA di Playwright supaya TIDAK menembak printer sungguhan
// (/dev/usb/lp0 ada dan user ada di grup lp).
import { chromium } from 'playwright-core';

let lolos = 0, gagal = 0;
const ok = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

const API = 'http://localhost:3001';
const jget = async (p) => (await fetch(API + p)).json();
const jpost = async (p, b, m = 'POST') => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};

const SKU = 'PRD00001';
const ambil = async () => (await jget(`/api/products?status=semua&q=${SKU}`)).data[0];

// Buang ESC/POS supaya argumen perintah tidak terbaca sebagai isi struk.
function buangPerintah(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x1b && b[i + 1] === 0x40) { i += 1; continue; }
    if (b[i] === 0x1b && (b[i + 1] === 0x45 || b[i + 1] === 0x61 || b[i + 1] === 0x64)) { i += 2; continue; }
    if (b[i] === 0x1d && (b[i + 1] === 0x56 || b[i + 1] === 0x21)) { i += 2; continue; }
    out.push(b[i]);
  }
  return out;
}
const teksDari = (b) => buangPerintah(b)
  .map((c) => (c === 10 ? '\n' : c >= 32 && c < 127 ? String.fromCharCode(c) : ''))
  .join('');
const barisStruk = (b) => teksDari(b).split('\n');
const COLS = 32;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const tercetak = [];
await page.route('**/print', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  tercetak.push(body.data_base64 || '');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, via: 'test' }) });
});

// Tangkap POST /api/sales supaya bisa memeriksa sale_items tanpa menebak id.
let jualRes = null;
page.on('response', async (r) => {
  if (r.request().method() !== 'POST' || !r.url().includes('/api/sales')) return;
  try { jualRes = await r.json(); } catch { /* abaikan */ }
});

let awal = null;
try {
  console.log('\n=== 0. Siapkan: satuan master + payload uji ===');
  for (const u of ['pack', 'dus']) await jpost('/api/units', { name: u });   // idempotent (upsert by slug)
  awal = await ambil();
  if (!awal) throw new Error(`produk ${SKU} tidak ada`);
  const PID = awal.id;
  const StokUji = 120;
  const simpan = (stock) => jpost('/api/products', {
    sku: SKU, name: awal.name, category_slug: awal.category_slug,
    barcode: awal.barcode, unit: 'pcs', price: 3000, cost: awal.cost, markup: awal.markup,
    price_dynamic: awal.price_dynamic, stock, min_stock: awal.min_stock, is_active: awal.is_active,
    units: [
      { unit: 'pack', factor: 12 },            // harga otomatis = 12 x 3000 = 36.000
      { unit: 'dus', factor: 144, price: 450000 },  // harga grosir eksplisit (bukan 432.000)
    ],
  });
  await simpan(StokUji);
  console.log(`  payload uji siap (stok ${StokUji}, dasar pcs Rp3.000)`);

  console.log('\n=== A. Form produk menampilkan seksi Satuan jual ===');
  await page.goto('http://localhost:5656/#/products', { waitUntil: 'load' });
  await page.waitForSelector('#rows tr', { timeout: 20000 });
  await page.fill('#q', SKU);
  // JANGAN klik `#rows tr` pertama sembarangan: bila filter belum ter-apply,
  // modal terbuka untuk produk LAIN -> #f-unit-rows kosong (tinggi 0) -> Playwright
  // menganggapnya tidak terlihat dan suite crash. Tunggu baris PID ini muncul dulu.
  await page.waitForSelector(`#rows tr[data-row="${PID}"] [data-edit]`, { timeout: 10000 });
  await page.click(`#rows tr[data-row="${PID}"] [data-edit]`);
  await page.waitForSelector('#f-unit-rows', { timeout: 8000 });
  const form = norm(await page.innerText('.modal'));
  // .form-sec ber-`uppercase` (styles.css) -> innerText membalikkannya jadi huruf besar.
  ok('seksi "Satuan jual" tampil', /satuan jual/i.test(form), form.slice(0, 300));
  ok('satuan dasar tertulis pcs', (await page.innerText('#f-unit-base')).trim() === 'pcs',
    await page.innerText('#f-unit-base'));
  const baris = await page.$$('#f-unit-rows [data-u-row]');
  ok('2 baris satuan jual tersimpan', baris.length === 2, baris.length);
  ok('baris pack: faktor 12',
    (await page.inputValue('#f-unit-rows [data-u-row="0"] [data-u-factor]')) === '12',
    await page.inputValue('#f-unit-rows [data-u-row="0"] [data-u-factor]'));
  ok('baris pack: harga kosong (otomatis)',
    (await page.inputValue('#f-unit-rows [data-u-row="0"] [data-u-price]')) === '',
    await page.inputValue('#f-unit-rows [data-u-row="0"] [data-u-price]'));
  ok('baris dus: harga eksplisit 450000',
    (await page.inputValue('#f-unit-rows [data-u-row="1"] [data-u-price]')) === '450000',
    await page.inputValue('#f-unit-rows [data-u-row="1"] [data-u-price]'));
  // Tutup tanpa menyimpan — perubahan apa pun di form sengaja tidak kita tulis.
  await page.click('.modal [data-x]');
  await page.waitForTimeout(300);

  console.log('\n=== B. POS: chip satuan -> baris keranjang TERPISAH ===');
  await page.goto('http://localhost:5656/#/pos', { waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  await page.fill('#pos-q', SKU);
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  const chips = await page.$$('#pos-results .suggest-unit');
  ok('chip satuan alternatif tampil (pack & dus)', chips.length === 2, chips.length);
  // 1) ketuk baris utama -> satuan dasar
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector(`#pos-rows tr[data-key="${PID}:pcs"]`, { timeout: 8000 });
  ok('baris utama memakai satuan dasar (key :pcs)',
    (await page.$(`#pos-rows tr[data-key="${PID}:pcs"]`)) !== null, `key ${PID}:pcs`);
  const hDasar = await page.innerText(`#pos-rows tr[data-key="${PID}:pcs"]`);
  ok('harga baris dasar = Rp3.000', hDasar.includes(rp(3000)), hDasar);
  // 2) ketuk chip "pack" -> baris BARU, bukan menumpuk di baris pcs
  await page.fill('#pos-q', SKU);
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-unit[data-unit="pack"]');
  await page.waitForSelector(`#pos-rows tr[data-key="${PID}:pack"]`, { timeout: 8000 });
  const hPack = await page.innerText(`#pos-rows tr[data-key="${PID}:pack"]`);
  ok('chip pack membuat baris terpisah (key :pack)',
    (await page.$(`#pos-rows tr[data-key="${PID}:pack"]`)) !== null, `key ${PID}:pack`);
  ok('harga baris pack = 12 x Rp3.000 = Rp36.000', hPack.includes(rp(36000)), hPack);
  const semuaBaris = await page.$$('#pos-rows tr[data-key]');
  ok('2 baris — TIDAK menumpuk', semuaBaris.length === 2, semuaBaris.length);

  console.log('\n=== C. Bayar: server memakai faktor stok & HPP ===');
  // avg_cost TIDAK dikembalikan oleh opname (opname tidak menyentuhnya), jadi
  // seluruh ekspektasi HPP diukur dari nilai yang benar-benar terbaca sekarang.
  const A = awal.avg_cost;
  const costPack = Math.round(A * 12);
  const hppSebelum = (await jget('/api/reports/daily')).data;
  // qty pack jadi 2 lewat tombol + (satu ketukan, tanpa fokus input angka)
  await page.click(`#pos-rows tr[data-key="${PID}:pack"] button[data-act="inc"]`);
  await page.waitForTimeout(150);
  await page.fill('#pos-cash', '200000');
  await page.click('#pos-pay');
  await page.waitForFunction(
    () => document.querySelector('#toast-root')?.textContent?.includes('Terjual'),
    { timeout: 15000 },
  );
  ok('penjualan sukses (toast Terjual)', true);
  // Dialog pilihan cetak [Thermal] [A4] [Tidak] muncul setelah bayar (auto-print
  // bawaan nyala). Wajib diklik — struk section D baru terkirim setelah tombol
  // Thermal ditekan; tanpa ini overlay swal juga menutupi sisa alur test.
  await page.waitForSelector('.swal2-popup', { timeout: 8000 });
  await page.click('.swal2-confirm');                       // [Thermal]
  await page.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });
  // Poll struk (closure Node, tidak bisa page.waitForFunction).
  for (let t = 0; tercetak.length < 1 && t < 150; t++) await page.waitForTimeout(100);
  ok('struk thermal terkirim setelah pilihan Thermal', tercetak.length >= 1, tercetak.length);
  // BALAPAN CDP: handler page.on('response') mengambil body lewat round-trip
  // CDP (Node), sedangkan toast dirender in-page segera setelah fetch selesai —
  // di mesin yang CDP-nya kalah cepat, jualRes masih null saat dibaca di bawah
  // walau penjualan sukses (stok -25, laporan benar). Tunggu sampai terisi.
  for (let t = 0; !jualRes && t < 75; t++) await page.waitForTimeout(200);
  const saleId = jualRes?.data?.sale?.id;
  ok('respons POST /api/sales tertangkap', !!saleId, JSON.stringify(jualRes).slice(0, 120));
  const detail = saleId ? (await jget(`/api/sales/${saleId}`)).data : null;
  const itPack = detail?.items?.find((x) => x.unit === 'pack');
  const itPcs = detail?.items?.find((x) => x.unit === 'pcs');
  ok('baris pack: unit=pack qty=2 price=36000',
    !!itPack && itPack.qty === 2 && itPack.price === 36000, JSON.stringify(itPack));
  ok(`baris pack: HPP satuan = avg(${A}) x 12 = ${rp(costPack)}`,
    !!itPack && itPack.cost === costPack, `dapat ${itPack?.cost}, ekspektasi ${costPack}`);
  ok(`baris pcs: unit=pcs qty=1 price=3000 cost=${A}`,
    !!itPcs && itPcs.qty === 1 && itPcs.price === 3000 && itPcs.cost === A,
    JSON.stringify(itPcs));
  const stok = (await ambil()).stock;
  ok('stok berkurang 25 SATUAN DASAR (2x12 + 1)', stok === StokUji - 25, stok);

  console.log('\n=== D. Struk: satuan dicetak hanya bila bukan dasar ===');
  const s1 = Buffer.from(tercetak[0] || '', 'base64');
  const t1 = teksDari(s1);
  const b1 = barisStruk(s1);
  ok('struk memuat satuan non-dasar ("2 pack x ...")', t1.includes('2 pack x Pulpen'),
    b1.filter((x) => x.includes('Pulpen')));
  ok('struk satuan dasar tetap tanpa unit ("1 x Pulpen Hitam")', t1.includes('1 x Pulpen Hitam'),
    b1.filter((x) => x.includes('Pulpen')));
  ok('struk tidak mencetak "pcs x"', !t1.includes('pcs x'), b1.filter((x) => x.includes('pcs')));
  const lewat = b1.filter((x) => x.length > COLS);
  ok('semua baris struk <= 32 kolom', lewat.length === 0, lewat);

  console.log('\n=== E. Laporan: HPP lintas satuan ===');
  // Laporan harian MENUMUK semua penjualan hari itu (milik suite lain juga),
  // jadi yang diukur adalah SELISIH sebelum -> sesudah penjualan suite ini.
  const rep = (await jget('/api/reports/daily')).data;
  const dHpp = rep.hpp - hppSebelum.hpp;
  const dOmzet = rep.sales.omzet - hppSebelum.sales.omzet;
  const hppHarus = 2 * costPack + A;          // 2 pack x (avg*12) + 1 pcs x avg
  ok(`HPP selisih = 2x${costPack} + 1x${A} = ${rp(hppHarus)}`, dHpp === hppHarus,
    `selisih=${dHpp}, ekspektasi=${hppHarus}`);
  ok('omzet selisih = 72.000 (pack) + 3.000 (pcs)', dOmzet === 75000, dOmzet);
  ok('laba = omzet - HPP (konsisten)', rep.laba === rep.sales.omzet - rep.hpp,
    JSON.stringify({ omzet: rep.sales.omzet, hpp: rep.hpp, laba: rep.laba }));

  console.log('\n=== F. Guard API (resolusi satuan di server) ===');
  const tolakUnit = await jpost('/api/sales', {
    id: `ms-tolak-unit-${Date.now()}`, shift_id: 1, pay_method: 'tunai', cash_in: 999999, cashier: 'kasir',
    items: [{ product_id: PID, qty: 1, unit: 'box' }],
  });
  ok('unit yang tidak dijual ditolak 400',
    tolakUnit.s === 400 && /tidak dijual/.test(tolakUnit.j.error ?? ''), JSON.stringify(tolakUnit.j));
  const tolakFactor = await jpost('/api/products', {
    sku: SKU, name: awal.name, category_slug: awal.category_slug, unit: 'pcs', price: 3000,
    units: [{ unit: 'pack', factor: 0 }],
  });
  ok('factor <= 0 ditolak 400',
    tolakFactor.s === 400 && /factor harus angka/.test(tolakFactor.j.error ?? ''),
    JSON.stringify(tolakFactor.j));
  const stokJuga = await jpost('/api/sales', {
    id: `ms-stok-${Date.now()}`, shift_id: 1, pay_method: 'tunai', cash_in: 999999, cashier: 'kasir',
    items: [{ product_id: PID, qty: 1, unit: 'dus' }],
  });
  ok('stok kurang menyebut satuan jual & kebutuhannya',
    stokJuga.s === 400 && /butuh 144 dus/.test(stokJuga.j.error ?? ''), JSON.stringify(stokJuga.j));

  ok('tanpa error halaman', errs.length === 0, errs.slice(0, 3));
} catch (e) {
  gagal++;
  console.log(`  GAGAL (exception) | ${e?.message ?? e}`);
} finally {
  await browser.close();
  // Pulihkan payload awal (termasuk satuan jual & stok) persis seperti ditemukan.
  if (awal) {
    await jpost('/api/products', {
      sku: SKU, name: awal.name, category_slug: awal.category_slug, barcode: awal.barcode,
      unit: awal.unit, price: awal.price, cost: awal.cost, markup: awal.markup,
      price_dynamic: awal.price_dynamic, stock: awal.stock, min_stock: awal.min_stock,
      is_active: awal.is_active, units: awal.units ?? [],
    }).catch(() => {});
  }
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
