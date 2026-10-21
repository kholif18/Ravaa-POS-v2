// E2E split payment — dua metode dalam satu nota (ROADMAP 1.6.5, ACC pemilik
// 2026-10-19, pola KulaPOS "PR bisa 2 mode dalam 1 transaksi" versi bayar).
//
// Kontrak yang diuji (keputusan implementasi 2026-10-19, lihat AGENTS §3):
//   - `POST /api/sales` menerima `payments[]` = uang DISERAHKAN per metode
//     (tunai = uang fisik; server: cash_in = Σ, change = Σ − total);
//   - baris `sale_payments` = ATRIBUSI — Σ per nota SELALU = sales.total
//     (tunai tersimpan = uang diserahkan − kembalian); `pay_method` =
//     'campuran' bila > 1 baris; nota lama/satu metode TIDAK berubah
//     (fallback (pay_method,total), absen `payments` = perilaku lama persis);
//   - `GET /api/sales/:id` mengembalikan `payments`; `GET /api/sales`
//     menambah `pay_methods` (CSV "tunai,qris" untuk linimasa Riwayat);
//   - klien POS: toggle split (2 metode; kolom "Nominal" = sisi NON-TUNAI,
//     sisi tunai = sisa di `#pos-cash`); split TIDAK bisa jadi hutang
//     (barrier minta uang >= porsi tunai); baris topup/tarik mematikan split;
//   - tampilan split: struk/resume/Riwayat/invoice memuat baris per metode
//     (Tunai = uang diserahkan + Kembalian bila > 0; non-tunai = atribusi).
// Jalankan: node tests/e2e-split.mjs   (API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken } from './bantuan-uji.mjs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
const SKU = 'UJISPLIT';
const NAMA = 'Uji Split Barang';
const PRICE = 10000;

let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const post = async (p, body) => {
  const r = await fetch(API + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(API + p)).json();

// Self-heal: produk uji bisa tertinggal tombstone dari run yang crash — POST
// payload LENKAP membangkitkannya kembali (AGENTS §3: tombstone di-upsert
// ulang = `deleted_at` dikosongkan + version++).
const P = {
  sku: SKU, name: NAMA, category_slug: 'atk', unit: 'pcs',
  price: PRICE, stock: 500, min_stock: 0, is_active: 1, price_dynamic: 0,
};
{
  const a = await post('/api/products', P);
  if (!String(a.s).startsWith('2')) {
    console.error('setup produk gagal:', a.s, JSON.stringify(a.j));
    process.exit(1);
  }
}
const gP = await get(`/api/products?status=semua&q=${SKU}`);
const pid = gP.data?.[0]?.id ?? null;
if (!pid) {
  console.error('produk uji tidak ditemukan setelah upsert');
  process.exit(1);
}

// Shift terbuka untuk kasir default (suite harus bisa jalan sendiri; shift
// TIDAK PERNAH ditutup di sini — dipakai suite lain).
{
  const buka = await get('/api/shifts/open?cashier=kasir');
  if (!buka?.data?.id) await post('/api/shifts/open', { modal_awal: 100000, cashier: 'kasir' });
}
const shiftId = (await get('/api/shifts/open?cashier=kasir'))?.data?.id ?? null;

// Satu unit produk uji = Rp10.000 (harga produk non-dinamis DIKUNCI server).
const saleBody = (id, extra = {}) => ({
  id, shift_id: shiftId, pay_method: 'tunai', cash_in: 0, cashier: 'kasir',
  items: [{ product_id: pid, name: NAMA, qty: 1, price: PRICE }],
  ...extra,
});
const nota = async (id) => (await get(`/api/sales/${encodeURIComponent(id)}`)).data;
const nilaiMetode = (rows, m) =>
  (rows ?? []).filter((r) => r.method === m).reduce((a, r) => a + r.amount, 0);
const csvMetode = (s) => String(s ?? '').split(',').filter(Boolean).sort().join(',');

console.log('=== A. API: kontrak payments (sale_payments) ===');
const idA = randomUUID();
const a1 = await post('/api/sales', saleBody(idA, {
  payments: [{ method: 'tunai', amount: 6000 }, { method: 'qris', amount: 4000 }],
}));
chk('A1 split 2 metode -> tersimpan (201)', a1.s === 201, `${a1.s} ${JSON.stringify(a1.j).slice(0, 140)}`);
const nA = a1.s === 201 ? await nota(idA) : null;
chk('A2 pay_method campuran + cash_in Σ + kembalian 0',
  nA?.sale?.pay_method === 'campuran' && nA?.sale?.cash_in === 10000 && nA?.sale?.change === 0,
  JSON.stringify({ m: nA?.sale?.pay_method, ci: nA?.sale?.cash_in, ch: nA?.sale?.change }));
chk('A3 baris atribusi per metode + Σ = total',
  nA?.payments?.length === 2 && nilaiMetode(nA.payments, 'tunai') === 6000
    && nilaiMetode(nA.payments, 'qris') === 4000
    && nA.payments.reduce((a, r) => a + r.amount, 0) === nA.sale.total,
  JSON.stringify(nA?.payments));

const idB = randomUUID();
const a2 = await post('/api/sales', saleBody(idB, {
  payments: [{ method: 'tunai', amount: 12000 }, { method: 'qris', amount: 4000 }],
}));
const nB = a2.s === 201 ? await nota(idB) : null;
chk('A4 uang tunai lebih -> cash_in 16.000 + kembalian 6.000',
  nB?.sale?.cash_in === 16000 && nB?.sale?.change === 6000,
  JSON.stringify({ ci: nB?.sale?.cash_in, ch: nB?.sale?.change }));
chk('A5 baris tunai tersimpan = atribusi (12.000 − 6.000 = 6.000)',
  nilaiMetode(nB?.payments, 'tunai') === 6000 && nilaiMetode(nB?.payments, 'qris') === 4000,
  JSON.stringify(nB?.payments));

const list = await get('/api/sales?limit=200');
const barisA = list.data?.find((x) => x.id === idA);
chk('A6 daftar Riwayat memuat pay_methods CSV (tunai,qris)',
  barisA?.pay_method === 'campuran' && csvMetode(barisA?.pay_methods) === 'qris,tunai',
  JSON.stringify({ pm: barisA?.pay_method, pms: barisA?.pay_methods }));

const tolak = async (label, payments, pola) => {
  const r = await post('/api/sales', saleBody(randomUUID(), { payments }));
  chk(label, r.s === 400 && pola.test(String(r.j?.error ?? '')), `${r.s} ${JSON.stringify(r.j).slice(0, 150)}`);
};
await tolak('A7 payments bukan array -> 400', {},
  /payments harus array/);
await tolak('A8 metode tidak dikenal -> 400',
  [{ method: 'gopay', amount: 4000 }, { method: 'tunai', amount: 6000 }],
  /metode pembayaran tidak dikenal/);
await tolak('A9 metode duplikat -> 400',
  [{ method: 'tunai', amount: 4000 }, { method: 'tunai', amount: 6000 }],
  /metode pembayaran duplikat/);
await tolak('A10 nominal tidak valid -> 400',
  [{ method: 'tunai', amount: -1 }, { method: 'qris', amount: 10000 }],
  /nominal pembayaran tidak valid/);
await tolak('A11 non-tunai melebihi total -> 400',
  [{ method: 'tunai', amount: 1000 }, { method: 'qris', amount: 12000 }],
  /non-tunai melebihi total nota/);
await tolak('A12 split tidak menutup total -> 400',
  [{ method: 'tunai', amount: 5000 }, { method: 'qris', amount: 3000 }],
  /tidak menutup total/);

const idC = randomUUID(); // legacy: TANPA payments — perilaku lama persis
const a3 = await post('/api/sales', saleBody(idC, { cash_in: 20000 }));
const nC = a3.s === 201 ? await nota(idC) : null;
chk('A13 absen payments = perilaku lama (pay_method tunai + kembalian 10.000)',
  nC?.sale?.pay_method === 'tunai' && nC?.sale?.cash_in === 20000 && nC?.sale?.change === 10000,
  JSON.stringify({ m: nC?.sale?.pay_method, ci: nC?.sale?.cash_in, ch: nC?.sale?.change }));
chk('A14 nota satu metode tetap 1 baris atribusi penuh (tunai = total)',
  nC?.payments?.length === 1 && nilaiMetode(nC.payments, 'tunai') === 10000,
  JSON.stringify(nC?.payments));

const a1ulang = await post('/api/sales', saleBody(idA, {
  payments: [{ method: 'tunai', amount: 6000 }, { method: 'qris', amount: 4000 }],
}));
const nAulang = await nota(idA);
chk('A15 POST ulang id sama = idempotent (baris payments tidak digandakan)',
  a1ulang.s < 300 && nAulang?.payments?.length === 2,
  `${a1ulang.s} rows=${nAulang?.payments?.length}`);

const idD = randomUUID(); // satu metode lewat `payments` (tunai lebih)
const a4 = await post('/api/sales', saleBody(idD, { payments: [{ method: 'tunai', amount: 12000 }] }));
const nD = a4.s === 201 ? await nota(idD) : null;
chk('A16 payments satu metode = nota biasa (tunai, kembalian 2.000)',
  nD?.sale?.pay_method === 'tunai' && nD?.sale?.change === 2000
    && nD?.payments?.length === 1 && nilaiMetode(nD.payments, 'tunai') === 10000,
  JSON.stringify({ m: nD?.sale?.pay_method, ch: nD?.sale?.change, p: nD?.payments }));

// ---------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
// Preferensi cetak: PAUSE default menyala (jeda semua cetak) — suite ini
// memverifikasi payload reprint, jadi jeda dimatikan + rute /print disela
// supaya TIDAK menembak printer sungguhan (pola e2e-struk).
await p.addInitScript(() => localStorage.setItem('ravaa.printpause', '0'));
await p.context().addInitScript(() => { window.print = () => {}; });
const tercetak = []; // { base64 } struk (kick laci difilter)
const kickLaci = [];
await p.route('**/print', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  const b64 = body.data_base64 || '';
  if (Buffer.from(b64, 'base64').equals(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))) {
    kickLaci.push(b64);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, via: 'test' }) });
    return;
  }
  tercetak.push(b64);
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, via: 'test' }) });
});
const errs = [];
p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const baris = () => p.locator('#pos-rows tr[data-key]:not(.note-row)');
const nBaris = () => baris().count();
const grand = () => p.textContent('#pos-grand');
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
const toastIsi = async () => norm(await p.locator('#toast-root').innerText().catch(() => ''));
const totalSales = async () => (await get('/api/sales?limit=1')).total ?? 0;

let saleB = null; // nota split dari UI (section B) — dipakai section C
try {
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'load' });
  await p.waitForSelector('#pos-q', { timeout: 20000 });
  await p.waitForTimeout(1000);

  console.log('=== B. POS: toggle split, komposisi, barrier, bayar ===');
  await scan(SKU, 1);
  chk('B1 produk uji masuk keranjang (Rp10.000)', (await grand()).includes('10.000'), await grand());
  await p.click('#pos-bayar');
  await p.waitForSelector('#pos-pay', { timeout: 8000 });
  chk('B2 panel split tersembunyi saat form dibuka',
    await p.locator('#bayar-split-panel').evaluate((el) => el.hidden) === true);
  chk('B3 toggle "Bayar 2 metode" tampil',
    (await p.locator('#bayar-split-toggle').innerText()).includes('2 metode'));
  await p.click('#bayar-split-toggle');
  await p.waitForTimeout(300);
  chk('B4 panel terbuka + 2 chip metode kedua',
    await p.locator('#bayar-split-panel').evaluate((el) => el.hidden) === false
      && (await p.locator('#bayar-split-chips [data-split]').count()) === 2,
    `hidden=${await p.locator('#bayar-split-panel').evaluate((el) => el.hidden)}`);
  chk('B5 chip kedua default QRIS aktif',
    ((await p.locator('[data-split="qris"]').getAttribute('class')) ?? '').includes('!bg-primary'));
  chk('B6 label kolom Nominal = sisi non-tunai (QRIS)',
    norm(await p.locator('#bayar-split-label').innerText()) === 'Nominal QRIS',
    await p.locator('#bayar-split-label').innerText());
  const noteAwal = norm(await p.locator('#bayar-split-note').innerText());
  chk('B7 catatan komposisi awal (tunai = sisa penuh)',
    noteAwal.includes('Komposisi: Tunai Rp10.000 + QRIS Rp0') && noteAwal.includes('porsi tunai Rp10.000'),
    noteAwal);
  await p.fill('#bayar-split-nominal', '3000');
  await p.waitForTimeout(300);
  chk('B8 isi nominal 3.000 -> komposisi 7.000 + 3.000',
    norm(await p.locator('#bayar-split-note').innerText()).includes('Komposisi: Tunai Rp7.000 + QRIS Rp3.000'),
    await p.locator('#bayar-split-note').innerText());
  await p.click('[data-split="transfer"]');
  await p.waitForTimeout(300);
  chk('B9 ganti metode kedua -> label ikut (Nominal Transfer)',
    norm(await p.locator('#bayar-split-label').innerText()) === 'Nominal Transfer'
      && ((await p.locator('[data-split="transfer"]').getAttribute('class')) ?? '').includes('!bg-primary'),
    await p.locator('#bayar-split-label').innerText());
  await p.fill('#pos-cash', '7000');
  await p.waitForTimeout(300);
  chk('B10 uang pas porsi tunai -> "Uang pas. Tidak ada kembalian."',
    norm(await p.locator('#pos-change-ctx').innerText()) === 'Uang pas. Tidak ada kembalian.',
    await p.locator('#pos-change-ctx').innerText());
  await p.fill('#pos-cash', '8000');
  await p.waitForTimeout(300);
  chk('B11 uang lebih -> kembalian Rp1.000 (hijau)',
    norm(await p.locator('#pos-change').innerText()) === 'Rp1.000'
      && ((await p.locator('#pos-change').getAttribute('class')) ?? '').includes('emerald-600'),
    `${await p.locator('#pos-change').innerText()} / ${await p.locator('#pos-change').getAttribute('class')}`);

  const nAwal = await totalSales();
  await p.click('#bayar-clear'); // kosongkan uang → barrier harus menolak
  await p.waitForTimeout(200);
  await p.click('#pos-pay');
  await p.waitForTimeout(600);
  chk('B12 barrier: uang kosong -> tolak dengan porsi tunai',
    (await toastIsi()).includes('Uang diterima belum diisi — porsi tunai Rp7.000'), await toastIsi());
  chk('B13 barrier: modal bayar tetap terbuka (tanpa swal)',
    (await p.locator('#pos-pay').count()) === 1 && (await p.locator('.swal2-popup').count()) === 0);
  chk('B14 barrier: tidak ada penjualan baru', (await totalSales()) === nAwal, `${nAwal} -> ${await totalSales()}`);

  await p.fill('#pos-cash', '8000');
  await p.waitForTimeout(200);
  await p.click('#pos-pay');
  await p.waitForSelector('.swal2-popup', { timeout: 8000 });
  const resume = norm(await p.locator('.swal2-popup').innerText());
  chk('B15 resume: Tunai = uang diserahkan Rp8.000', resume.includes('Tunai Rp8.000'), resume.slice(0, 200));
  chk('B16 resume: Transfer = porsi Rp3.000', resume.includes('Transfer Rp3.000'));
  chk('B17 resume: baris Kembalian Rp1.000', resume.includes('Kembalian Rp1.000'));
  await p.click('.swal2-cancel');
  await p.waitForSelector('.swal2-popup', { state: 'hidden', timeout: 5000 }).catch(() => {});
  chk('B18 resume ditutup -> kembali ke layar kasir', (await p.locator('.swal2-popup').count()) === 0);

  // Verifikasi server: nota yang baru saja dibuat lewat UI.
  const pertama = (await get('/api/sales?limit=1')).data?.[0];
  saleB = pertama ? await nota(pertama.id) : null;
  chk('B19 server: pay_method campuran + cash_in 11.000 + kembalian 1.000',
    saleB?.sale?.pay_method === 'campuran' && saleB?.sale?.cash_in === 11000 && saleB?.sale?.change === 1000,
    JSON.stringify({ m: saleB?.sale?.pay_method, ci: saleB?.sale?.cash_in, ch: saleB?.sale?.change }));
  chk('B20 server: baris tunai 7.000 + transfer 3.000 + tanpa hutang',
    nilaiMetode(saleB?.payments, 'tunai') === 7000 && nilaiMetode(saleB?.payments, 'transfer') === 3000
      && (saleB?.sale?.sisa_hutang ?? 0) === 0,
    JSON.stringify({ p: saleB?.payments, h: saleB?.sale?.sisa_hutang }));

  console.log('=== C. TUKAR bila metode utama ditabrak (swap posisi) ===');
  await scan(SKU, 1);
  await p.click('#pos-bayar');
  await p.waitForSelector('#pos-pay', { timeout: 8000 });
  await p.click('#bayar-split-toggle');
  await p.waitForTimeout(250);
  // Metode utama tunai + kedua qris; ganti utama ke QRIS -> harus TUKAR:
  // splitMethod jadi tunai, nominal split tetap, label = sisi non-tunai (QRIS).
  await p.click('[data-pay="qris"]');
  await p.waitForTimeout(300);
  chk('C1 chip tunai jadi metode kedua setelah swap',
    ((await p.locator('[data-split="tunai"]').getAttribute('class')) ?? '').includes('!bg-primary'),
    await p.locator('#bayar-split-chips').innerText());
  chk('C2 label Nominal kembali ke QRIS (sisi non-tunai = metode utama lama)',
    norm(await p.locator('#bayar-split-label').innerText()) === 'Nominal QRIS',
    await p.locator('#bayar-split-label').innerText());
  chk('C3 sisi tunai tetap butuh uang diterima (blok terlihat)',
    await p.locator('#bayar-tunai').evaluate((el) => el.hidden) === false);
  await p.keyboard.press('Escape'); // header modal bayar disembunyikan — tutup via Esc (pola e2e-struk)
  await p.waitForTimeout(400);
  await p.click('#pos-clear').catch(() => {});
  await p.waitForTimeout(400);

  console.log('=== D. Split dimatikan saat keranjang berisi topup ===');
  await scan(SKU, 1);
  await p.click('#pos-qa-topup');
  await p.waitForSelector('#ptk-nominal', { timeout: 8000 });
  await p.fill('#ptk-nominal', '10000');
  await p.click('.modal [data-ok]');
  await p.waitForSelector('#pos-rows .topup-row', { timeout: 8000 });
  await p.click('#pos-bayar');
  await p.waitForSelector('#pos-pay', { timeout: 8000 });
  chk('D1 toggle split disabled saat ada baris topup',
    await p.locator('#bayar-split-toggle').evaluate((el) => el.disabled) === true);
  const hintD = await p.locator('.pos-bayar-splitoff').innerText().catch(() => '');
  chk('D2 hint menjelaskan kenapa (topup/tarik)', hintD.includes('topup/tarik'), hintD);
  await p.keyboard.press('Escape'); // header modal bayar disembunyikan — tutup via Esc (pola e2e-struk)
  await p.waitForTimeout(400);
  await p.click('#pos-clear');
  await p.waitForTimeout(500);
  await scan(SKU, 1);
  await p.click('#pos-bayar');
  await p.waitForSelector('#pos-pay', { timeout: 8000 });
  chk('D3 setelah Bersihkan (baris topup ikut hilang) toggle kembali aktif',
    await p.locator('#bayar-split-toggle').evaluate((el) => el.disabled) === false);
  await p.keyboard.press('Escape'); // header modal bayar disembunyikan — tutup via Esc (pola e2e-struk)
  await p.waitForTimeout(400);
  await p.click('#pos-clear').catch(() => {});
  await p.waitForTimeout(400);

  console.log('=== E. Riwayat: label, rincian, cetak ulang per metode ===');
  await p.goto(`${WEB}/#/history`, { waitUntil: 'load' });
  await p.waitForSelector('#h-body tr[data-trx]', { timeout: 20000 });
  await p.waitForTimeout(600);
  const trE = p.locator(`tr[data-trx="sale:${saleB?.sale?.id}"]`);
  chk('E1 baris linimasa memakai label gabungan "Tunai + Transfer"',
    norm(await trE.innerText()).includes('Tunai + Transfer'),
    norm(await trE.innerText()).slice(0, 200));
  await trE.click();
  await p.waitForSelector(`[data-reprint="${saleB?.sale?.id}"]`, { timeout: 15000 });
  await p.waitForTimeout(500);
  const detE = norm(await p.locator(`tr[data-trx="sale:${saleB?.sale?.id}"]`).locator('xpath=following-sibling::*[1]').innerText().catch(() => ''));
  const detTeks = detE || norm(await p.locator('#h-body').innerText());
  chk('E2 rincian: Metode Tunai + Transfer + Uang diterima Rp8.000',
    detTeks.includes('Tunai + Transfer') && detTeks.includes('Uang diterima Rp8.000'),
    detTeks.slice(0, 240));
  chk('E3 rincian: Transfer Rp3.000 + Kembali Rp1.000',
    detTeks.includes('Transfer Rp3.000') && detTeks.includes('Kembali Rp1.000'),
    detTeks.slice(0, 240));

  // Cetak ulang thermal -> payload print-agent memuat baris per metode.
  await p.click(`[data-reprint="${saleB?.sale?.id}"]`);
  await p.waitForSelector('.swal2-popup', { timeout: 8000 });
  await p.click('.swal2-confirm'); // Thermal
  for (let i = 0; i < 30 && tercetak.length === 0; i++) await p.waitForTimeout(200);
  const teksStruk = tercetak.length
    ? Buffer.from(tercetak[0], 'base64').toString('latin1').replace(/\x1b[@ELad]/g, '').replace(/\x1d[V!]/g, '')
    : '';
  chk('E4 struk ulang per metode (Tunai 8.000 + Transfer 3.000)',
    teksStruk.includes('Tunai') && teksStruk.includes('8.000')
      && teksStruk.includes('Transfer') && teksStruk.includes('3.000'),
    teksStruk.replace(/\n/g, ' ¶ ').slice(0, 300));
  chk('E5 struk ulang memuat baris Kembalian 1.000',
    teksStruk.includes('Kembalian') && teksStruk.includes('1.000'),
    teksStruk.replace(/\n/g, ' ¶ ').slice(0, 300));

  // Invoice A4 -> blok Payment per metode (popup window.print di-stub).
  await p.click(`[data-reprint="${saleB?.sale?.id}"]`);
  await p.waitForSelector('.swal2-popup', { timeout: 8000 });
  const [popup] = await Promise.all([
    p.waitForEvent('popup', { timeout: 15000 }).catch(() => null),
    p.click('.swal2-deny'), // A4
  ]);
  if (popup) await popup.waitForTimeout(800);
  const teksA4 = popup ? norm(await popup.evaluate(() => document.body.innerText).catch(() => '')) : '';
  chk('E6 invoice A4: baris TUNAI + TRANSFER per metode (uang diserahkan)',
    /TUNAI\s*Rp 8\.000/.test(teksA4) && /TRANSFER\s*Rp 3\.000/.test(teksA4),
    teksA4.slice(0, 320));
  chk('E7 invoice A4: Dibayar Rp 10.000 + Kembali Rp 1.000',
    /Dibayar\s*Rp 10\.000/.test(teksA4) && /Kembali\s*Rp 1\.000/.test(teksA4),
    teksA4.slice(0, 320));
  if (popup) await popup.close().catch(() => {});

  console.log('=== M. Mobile: lapisan bayar #pm-bayar ikut split-aware ===');
  const pm = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await pasangToken(pm);
  await pm.addInitScript(() => localStorage.setItem('ravaa.mobile-layout', '1'));
  const errsM = [];
  pm.on('pageerror', (e) => errsM.push(`pageerror: ${e.message}`));
  try {
    await pm.goto(`${WEB}/#/pos`, { waitUntil: 'load' });
    await pm.waitForSelector('#pos-q', { timeout: 20000 });
    await pm.waitForTimeout(1200);
    // Keranjang MOBILE = kartu `article.pm-card[data-key]` (BUKAN <tr> desktop);
    // hitung keduanya supaya loop tidak scan 8x (qty membengkak).
    const nBarisM = async () =>
      pm.locator('#pos-rows article[data-key], #pos-rows tr[data-key]').count();
    for (let i = 0; i < 8 && (await nBarisM()) < 1; i++) {
      await pm.fill('#pos-q', SKU);
      await pm.keyboard.press('Enter');
      await pm.waitForTimeout(400);
    }
    await pm.click('#pos-bayar');
    await pm.waitForTimeout(400);
    chk('M1 lapisan bayar mobile terbuka (#pm-bayar tidak hidden)',
      await pm.locator('#pm-bayar').evaluate((el) => el.hidden) === false);
    chk('M2 toggle split tersedia di lapisan mobile',
      (await pm.locator('#bayar-split-toggle').count()) === 1);
    await pm.click('#bayar-split-toggle');
    await pm.waitForTimeout(300);
    chk('M3 panel split terbuka + 2 chip (.pm-splitgrid)',
      await pm.locator('#bayar-split-panel').evaluate((el) => el.hidden) === false
        && (await pm.locator('#bayar-split-chips [data-split]').count()) === 2);
    await pm.fill('#bayar-split-nominal', '4000');
    await pm.waitForTimeout(300);
    chk('M4 komposisi mobile: Tunai 6.000 + QRIS 4.000',
      norm(await pm.locator('#bayar-split-note').innerText()).includes('Komposisi: Tunai Rp6.000 + QRIS Rp4.000'),
      await pm.locator('#bayar-split-note').innerText());
    await pm.click('[data-pm-bayar-tutup]');
    await pm.waitForTimeout(300);
    chk('M5 tombol tutup menyembunyikan lapisan',
      await pm.locator('#pm-bayar').evaluate((el) => el.hidden) === true);
    chk('M6 mobile tanpa pageerror', errsM.length === 0, errsM.join(' ~ '));
  } finally {
    await pm.close().catch(() => {});
  }

  chk('E8 desktop tanpa pageerror', errs.length === 0, errs.join(' ~ '));
} finally {
  // Bersihkan: produk uji sudah pernah terjual -> nonaktifkan (hapus permanen
  // ditolak server, pola e2e-borongan). Pelanggan/artefak lain tidak dibuat.
  await post('/api/products', { ...P, is_active: 0 }).catch(() => {});
  await browser.close();
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exitCode = 1;
