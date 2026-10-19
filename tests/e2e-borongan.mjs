// E2E harga borongan per qty (2026-10-19) — permintaan pemilik dari contoh
// nyata toko: cetak foto 3x4 Rp1.000 "beli 6 = Rp5.000", buku tulis Rp3.500
// "beli 10 = Rp33.000". Model "kelipatan paket": sisa di atas paket tetap
// harga normal (7 lembar = 5.000 + 1.000; 12 buku = 33.000 + 7.000).
//
// Kontrak yang diuji (keputusan pemilik 2026-10-19, semua opsi rekomendasi):
//   - opt-in per produk; aturan disimpan di `product_borongan` (API `borongan`,
//     pola `units`: absen = tidak diubah, [] = hapus, isi = replace);
//   - HANYA satuan dasar — ganti satuan ke pak/dus mematikan otomatis;
//   - potongan langsung tampil di kolom Diskon saat qty berubah (ketik qty,
//     +/- stepper, atau scan `Qty*Kode`), TANPA memecah baris;
//   - edit diskon manual MENGHENTIKAN otomatisasi baris itu (perilaku legacy
//     `discManual` — termasuk menyetel 0);
//   - grosir vs borongan = "termurah menang" (dihitung dari harga baris);
//   - nilai akhir tersimpan di `sale_items.discount` saat bayar.
// Jalankan: node tests/e2e-borongan.mjs   (API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken, tokenUji } from './bantuan-uji.mjs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
const SKU = 'UJIBOR6';   // foto: 6 -> 5.000 (harga 1.000, grosir 900)
const SKU2 = 'UJIBOR10'; // buku: 10 -> 33.000 (harga 3.500)
const SKUV = 'UJIBORV';  // produk sementara uji validasi API (tanpa penjualan)
const NAMA = 'Uji Borongan Foto 3x4';
const NAMA2 = 'Uji Borongan Buku Tulis';
const TS = Date.now();

let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};
const post = async (p, body) => {
  const r = await fetch(API + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(API + p)).json();

// Self-heal artefak run yang crash (AGENTS §5: nama/sku EKSAK milik suite ini;
// pelanggan dibatasi yang TIDAK direferensikan penjualan/hutang).
sql(`DELETE FROM product_borongan WHERE product_id IN (SELECT id FROM products WHERE sku='${SKUV}');`);
sql(`DELETE FROM products WHERE sku='${SKUV}';`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiBorongan Warung %'
       AND id NOT IN (SELECT customer_id FROM sales WHERE customer_id IS NOT NULL)
       AND id NOT IN (SELECT customer_id FROM customer_debts);`);

// --- Setup produk (upsert by SKU, idempoten antar-run) ----------------------
const P1 = {
  sku: SKU, name: NAMA, category_slug: 'atk', unit: 'pcs',
  price: 1000, price_grosir: 900, stock: 500, min_stock: 0, is_active: 1,
  price_dynamic: 0, borongan: [{ qty: 6, price: 5000 }],
  units: [{ unit: 'pack', factor: 6 }],
};
const P2 = {
  sku: SKU2, name: NAMA2, category_slug: 'atk', unit: 'pcs',
  price: 3500, stock: 500, min_stock: 0, is_active: 1,
  price_dynamic: 0, borongan: [{ qty: 10, price: 33000 }],
};
{
  const a = await post('/api/products', P1);
  const b = await post('/api/products', P2);
  if (!a.s.toString().startsWith('2') || !b.s.toString().startsWith('2')) {
    console.error('setup produk gagal:', a.s, JSON.stringify(a.j), b.s, JSON.stringify(b.j));
    process.exit(1);
  }
}
// Shift terbuka untuk kasir default (suite harus bisa jalan sendiri).
{
  const buka = await get('/api/shifts/open?cashier=kasir');
  if (!buka?.data?.id) await post('/api/shifts/open', { modal_awal: 100000, cashier: 'kasir' });
}
const cust = await post('/api/customers', { name: `UjiBorongan Warung ${TS}`, tier: 'grosir' });
const custId = cust.j?.data?.id ?? null;

console.log('=== A. API: simpan/baca/validasi aturan borongan ===');
const g1 = await get(`/api/products?status=semua&q=${SKU}`);
const g2 = await get(`/api/products?status=semua&q=${SKU2}`);
chk('A1 aturan foto tersimpan + terbaca', JSON.stringify(g1.data?.[0]?.borongan) === JSON.stringify([{ qty: 6, price: 5000 }]), JSON.stringify(g1.data?.[0]?.borongan));
chk('A2 aturan buku tersimpan + terbaca', JSON.stringify(g2.data?.[0]?.borongan) === JSON.stringify([{ qty: 10, price: 33000 }]), JSON.stringify(g2.data?.[0]?.borongan));
const temp = await post('/api/products', { sku: SKUV, name: 'Uji Borongan Temp', category_slug: 'atk', unit: 'pcs', price: 1000, stock: 10, borongan: [{ qty: 6, price: 5000 }] });
chk('A3 paket tidak lebih murah -> 400', (await post('/api/products', { sku: SKUV, name: 'Uji Borongan Temp', category_slug: 'atk', unit: 'pcs', price: 1000, stock: 10, borongan: [{ qty: 6, price: 6000 }] })).s === 400);
chk('A4 qty < 2 -> 400', (await post('/api/products', { sku: SKUV, name: 'Uji Borongan Temp', category_slug: 'atk', unit: 'pcs', price: 1000, stock: 10, borongan: [{ qty: 1, price: 500 }] })).s === 400);
await post('/api/products', { sku: SKUV, name: 'Uji Borongan Temp', category_slug: 'atk', unit: 'pcs', price: 1000, stock: 10 });
const gTemp1 = await get(`/api/products?status=semua&q=${SKUV}`);
chk('A5 tanpa field borongan = aturan dipertahankan', JSON.stringify(gTemp1.data?.[0]?.borongan) === JSON.stringify([{ qty: 6, price: 5000 }]), JSON.stringify(gTemp1.data?.[0]?.borongan));
await post('/api/products', { sku: SKUV, name: 'Uji Borongan Temp', category_slug: 'atk', unit: 'pcs', price: 1000, stock: 10, borongan: [] });
const gTemp2 = await get(`/api/products?status=semua&q=${SKUV}`);
chk('A6 borongan [] = hapus aturan', JSON.stringify(gTemp2.data?.[0]?.borongan) === '[]', JSON.stringify(gTemp2.data?.[0]?.borongan));

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true });
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

const baris = () => p.locator('#pos-rows tr[data-key]:not(.note-row)');
const nBaris = () => baris().count();
const qtyInp = (i = 0) => baris().nth(i).locator('input[data-act="qty"]');
const discInp = (i = 0) => baris().nth(i).locator('input[data-act="disc"]');
const discVal = async (i = 0) => (await discInp(i).inputValue()).trim();
const borAttr = (i = 0) => baris().nth(i).locator('input[data-act="disc"][data-borongan="1"]').count();
const grand = () => p.textContent('#pos-grand');
const setQty = async (v, i = 0) => { await qtyInp(i).fill(String(v)); await qtyInp(i).press('Enter'); await p.waitForTimeout(500); };
const setDisc = async (v, i = 0) => { await discInp(i).fill(String(v)); await discInp(i).press('Enter'); await p.waitForTimeout(500); };
/** Scan SKU: cache IndexedDB konteks baru bisa belum siap saat Enter pertama. */
const scan = async (q, n) => {
  for (let i = 0; i < 8; i++) {
    await p.fill('#pos-q', q);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(400);
    if ((await nBaris()) >= n) return true;
  }
  return (await nBaris()) >= n;
};
// Tombol Bersihkan disabled saat keranjang kosong (mis. sesudah `pay()`
// mengosongkan keranjang) — klik hanya bila memang bisa diklik.
const bersihkan = async () => {
  const b = p.locator('#pos-clear');
  if (await b.isEnabled().catch(() => false)) await b.click();
  await p.waitForTimeout(400);
};

try {
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'load' });
  await p.waitForSelector('#pos-q', { timeout: 20000 });
  await p.waitForTimeout(1000);

  console.log('=== B. POS ecer: foto 1.000, 6 -> 5.000 ===');
  await scan(SKU, 1);
  chk('B1 qty 1 belum capai paket: total tetap 1.000', (await grand()).includes('1.000'), await grand());
  await setQty(6);
  chk('B2 qty 6 -> potongan otomatis 1.000', (await discVal()) === '1000', await discVal());
  chk('B3 penanda data-borongan aktif', (await borAttr()) === 1);
  chk('B4 total jadi 5.000', (await grand()).includes('5.000'), await grand());
  await setQty(7);
  chk('B5 qty 7 -> potongan tetap 1.000 (sisa harga normal)', (await discVal()) === '1000', await discVal());
  chk('B6 total 5.000 + 1.000 = 6.000', (await grand()).includes('6.000'), await grand());
  await setQty(12);
  chk('B7 qty 12 -> potongan 2.000 (2 paket)', (await discVal()) === '2000', await discVal());
  chk('B8 total 2 x 5.000 = 10.000', (await grand()).includes('10.000'), await grand());
  chk('B9 baris TIDAK dipecah saat qty berubah', (await nBaris()) === 1, `baris=${await nBaris()}`);
  chk('B10 tooltip diskon menyebut harga borongan', /borongan/i.test(await discInp().getAttribute('title') ?? ''), await discInp().getAttribute('title'));

  console.log('=== C. POS ecer: buku 3.500, 10 -> 33.000 ===');
  await scan(SKU2, 2);
  await setQty(10, 1);
  chk('C1 qty 10 -> potongan 2.000', (await discVal(1)) === '2000', await discVal(1));
  chk('C2 total 10.000 + 33.000 = 43.000', (await grand()).includes('43.000'), await grand());
  await setQty(12, 1);
  chk('C3 qty 12 -> potongan tetap 2.000 (2 buku normal)', (await discVal(1)) === '2000', await discVal(1));
  chk('C4 total 10.000 + 40.000 = 50.000', (await grand()).includes('50.000'), await grand());
  await setQty(20, 1);
  chk('C5 qty 20 -> potongan 4.000 (2 paket)', (await discVal(1)) === '4000', await discVal(1));
  chk('C6 total 10.000 + 66.000 = 76.000', (await grand()).includes('76.000'), await grand());
  await bersihkan();

  console.log('=== D. sintaks scan Qty*Kode ikut otomatis ===');
  await scan(`6*${SKU}`, 1);
  chk('D1 6*SKU -> qty 6', (await qtyInp().inputValue()) === '6', await qtyInp().inputValue());
  chk('D2 diskon otomatis 1.000 + penanda aktif', (await discVal()) === '1000' && (await borAttr()) === 1, `${await discVal()} / attr=${await borAttr()}`);
  chk('D3 total 5.000', (await grand()).includes('5.000'), await grand());

  console.log('=== E. edit manual menghentikan otomatisasi ===');
  await setDisc(500);
  chk('E1 kasir isi 500 -> otomatisasi berhenti', (await borAttr()) === 0 && (await discVal()) === '500', `attr=${await borAttr()} disc=${await discVal()}`);
  await setQty(7);
  chk('E2 qty berubah -> diskon manual TIDAK ditimpa', (await discVal()) === '500', await discVal());
  chk('E3 penanda borongan tetap mati', (await borAttr()) === 0);
  await setDisc(0);
  chk('E4 kasir kosongkan ke 0 -> tetap 0 (batal sengaja)', (await discVal()) === '' && (await borAttr()) === 0, `"${await discVal()}" / attr=${await borAttr()}`);
  await setQty(8);
  chk('E5 qty 8 -> tetap 0, tidak hidup sendiri', (await discVal()) === '', `"${await discVal()}"`);
  await bersihkan();

  console.log('=== F. hanya satuan dasar: pindah ke pak mematikan borongan ===');
  await scan(SKU, 1);
  await setQty(6);
  chk('F1 prasyarat: qty 6 pcs berpotongan 1.000', (await discVal()) === '1000', await discVal());
  await baris().nth(0).locator('select[data-act="unit"]').selectOption('pack');
  await p.waitForTimeout(600);
  chk('F2 pindah pak -> diskon reset 0', (await discVal()) === '', `"${await discVal()}"`);
  chk('F3 penanda borongan mati di baris pak', (await borAttr()) === 0);
  chk('F4 6 pack x 6.000 = 36.000 (tanpa campur borongan)', (await grand()).includes('36.000'), await grand());
  await bersihkan();

  console.log('=== G. grosir vs borongan: termurah menang ===');
  const opsiUmum = await p.$$eval('#pos-customer option', (os) => os.find((o) => o.textContent.includes('Pelanggan Umum'))?.value ?? '');
  await p.selectOption('#pos-customer', String(custId));
  await p.waitForTimeout(500);
  await scan(SKU, 1);
  chk('G1 harga grosir 900 dipakai', /900/.test(await baris().nth(0).innerText()), (await baris().nth(0).innerText()).replace(/\s+/g, ' ').slice(0, 120));
  await setQty(7);
  chk('G2 potongan 400 = 7 x 900 - (5.000 + 900)', (await discVal()) === '400', await discVal());
  chk('G3 total 5.900 (borongan, bukan grosir penuh 6.300)', (await grand()).includes('5.900'), await grand());
  chk('G4 penanda borongan tetap aktif untuk grosir', (await borAttr()) === 1);
  await p.selectOption('#pos-customer', opsiUmum);
  await p.waitForTimeout(400);
  await bersihkan();

  console.log('=== H. keranjang dipulihkan + tersimpan saat bayar ===');
  await scan(SKU, 1);
  await setQty(6);
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('#pos-q', { timeout: 20000 });
  await p.waitForTimeout(1800);
  chk('H1 reload -> qty 6 pulih', (await nBaris()) === 1 && (await qtyInp().inputValue()) === '6', `baris=${await nBaris()} qty=${await qtyInp().inputValue().catch(() => '?')}`);
  chk('H2 diskon otomatis 1.000 ikut pulih', (await discVal()) === '1000', await discVal());
  chk('H3 penanda borongan ikut pulih', (await borAttr()) === 1);
  await p.keyboard.press('F12');
  const adaResume = await p.waitForSelector('.swal2-popup', { timeout: 8000 }).then(() => true).catch(() => false);
  chk('H4 bayar pas (F12) -> resume penjualan tampil', adaResume, 'tidak ada .swal2-popup');
  if (adaResume) await p.keyboard.press('Escape');
  chk('H5 Escape menutup resume', await p.waitForSelector('.swal2-popup', { state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false));
  const jual = await get('/api/sales?limit=1');
  const saleId = jual.data?.[0]?.id ?? null;
  chk('H6 nota tercatat di server', !!saleId, JSON.stringify(jual).slice(0, 160));
  if (saleId) {
    const isi = await get(`/api/sales/${saleId}`);
    const it = (isi.data?.items ?? []).find((x) => x.name === NAMA);
    chk('H7 server simpan qty 6, harga 1.000, diskon 1.000', !!it && it.qty === 6 && it.price === 1000 && it.discount === 1000, JSON.stringify(it));
    chk('H8 total nota = 5.000', isi.data?.sale?.total === 5000, JSON.stringify(isi.data?.sale?.total));
  } else {
    chk('H7 server simpan qty 6, harga 1.000, diskon 1.000', false, 'tidak ada sale id');
    chk('H8 total nota = 5.000', false, 'tidak ada sale id');
  }
  await bersihkan();

  console.log('=== J. form produk: blok Harga borongan (qty) ===');
  await p.goto(`${WEB}/#/products`, { waitUntil: 'load' });
  await p.waitForSelector('#rows tr[data-row]', { timeout: 20000 });
  await p.fill('#q', NAMA2);
  await p.waitForTimeout(500);
  await p.locator('#rows tr[data-row]', { hasText: NAMA2 }).first().locator('[data-edit]').click();
  await p.waitForSelector('.modal [data-b-row]', { timeout: 8000 });
  const bQty = () => p.$$eval('.modal [data-b-row] [data-b-qty]', (els) => els.map((e) => e.value));
  const bPrice = () => p.$$eval('.modal [data-b-row] [data-b-price]', (els) => els.map((e) => e.value));
  chk('J1 blok menampilkan aturan tersimpan (10 -> 33.000)', JSON.stringify(await bQty()) === '["10"]' && JSON.stringify(await bPrice()) === '["33000"]', `${JSON.stringify(await bQty())} ${JSON.stringify(await bPrice())}`);
  await p.click('#f-bor-add');
  await p.locator('.modal [data-b-row]').nth(1).locator('[data-b-qty]').fill('5');
  await p.locator('.modal [data-b-row]').nth(1).locator('[data-b-price]').fill('17000');
  await p.click('.modal [data-ok]');
  await p.waitForTimeout(1000);
  const gJ = await get(`/api/products?status=semua&q=${SKU2}`);
  chk('J2 simpan menambah tingkatan (5 -> 17.000 + 10 -> 33.000)', JSON.stringify(gJ.data?.[0]?.borongan) === JSON.stringify([{ qty: 5, price: 17000 }, { qty: 10, price: 33000 }]), JSON.stringify(gJ.data?.[0]?.borongan));
  await p.locator('#rows tr[data-row]', { hasText: NAMA2 }).first().locator('[data-edit]').click();
  await p.waitForSelector('.modal [data-b-row]', { timeout: 8000 });
  chk('J3 buka ulang menampilkan kedua tingkatan', JSON.stringify(await bQty()) === '["5","10"]', JSON.stringify(await bQty()));
  await p.click('#f-bor-add');
  await p.locator('.modal [data-b-row]').nth(2).locator('[data-b-qty]').fill('3');
  await p.locator('.modal [data-b-row]').nth(2).locator('[data-b-price]').fill('12000');
  await p.click('.modal [data-ok]');
  await p.waitForTimeout(600);
  const toastJ = (await p.locator('#toast-root').innerText().catch(() => '')).replace(/\s+/g, ' ');
  chk('J4 klien menolak paket yang tidak lebih murah (modal tetap terbuka)', /lebih murah/i.test(toastJ) && (await p.locator('.modal [data-b-row]').count()) === 3, `toast="${toastJ.slice(0, 110)}" baris=${await p.locator('.modal [data-b-row]').count()}`);
  await p.click('.modal [data-x]');
  await p.waitForTimeout(500);
  const gJ2 = await get(`/api/products?status=semua&q=${SKU2}`);
  chk('J5 batal menyimpan tidak mengubah aturan', JSON.stringify(gJ2.data?.[0]?.borongan) === JSON.stringify([{ qty: 5, price: 17000 }, { qty: 10, price: 33000 }]), JSON.stringify(gJ2.data?.[0]?.borongan));

  chk('I1 tanpa pageerror', errs.length === 0, errs.join(' ~ '));

  // --- Bersihkan: pelanggan uji dihapus; produk uji dinonaktifkan (sudah
  // pernah terjual -> hapus permanen ditolak server, pola tier-harga-test).
  execSync(`curl -s -m 10 -X DELETE ${API}/api/customers/${custId} -H "Authorization: Bearer ${tokenUji()}" >/dev/null`);
  await post('/api/products', { ...P1, is_active: 0 });
  await post('/api/products', { ...P2, is_active: 0 });
  sql(`DELETE FROM product_borongan WHERE product_id IN (SELECT id FROM products WHERE sku='${SKUV}');`);
  sql(`DELETE FROM products WHERE sku='${SKUV}';`);
  await browser.close();
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
  try { await browser.close(); } catch { /* sudah tertutup */ }
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
