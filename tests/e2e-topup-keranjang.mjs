// E2E "2 mode dalam 1 transaksi" — Opsi B hybrid (permintaan pemilik
// 2026-10-07: "PR bisa 2 mode dalam 1 transaksi", contoh fotokopi + isi
// pulsa). Baris topup masuk keranjang Penjualan lewat dialog "Topup";
// saat Bayar: POST /api/topups per baris DULU, lalu POST /api/sales —
// record tetap terpisah (nominal topup bukan omzet, admin = jasa; AGENTS §1),
// satu struk gabungan + satu barrier uang atas total gabungan.
// Jalankan: node e2e-topup-keranjang.mjs  (butuh API :3001 + vite :5656 hidup)
//
// Suite INI MENULIS database (1 penjualan + 2 topup tiap run, pola sama
// dengan e2e-struk) — stok produk yang dijual dikembalikan persis di finally.
import { chromium } from 'playwright-core';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const jpost = async (p, b) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const cari = async (q) => (await (await fetch(`${API}/api/products?q=${encodeURIComponent(q)}`)).json()).data?.[0];
const hariIni = new Date().toISOString().slice(0, 10);
const nSalesHariIni = async () => (await (await fetch(`${API}/api/sales?date=${hariIni}`)).json()).total;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// printpause='0': bawaan aplikasi JEDA cetak (pemilik 2026-10-06) — suite ini
// memverifikasi payload struk gabungan, jadi izin kirim harus nyala. Request
// /print tetap DISELA supaya tidak menembak printer sungguhan.
await page.context().addInitScript(() => {
  window.print = () => {};
  try { localStorage.setItem('ravaa.printpause', '0'); } catch { /* private mode */ }
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
const tercetak = []; // base64 struk (kick laci terpisah)
const kick = [];
await page.route('**/print', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  const b = Buffer.from(body.data_base64 || '', 'base64');
  if (b.equals(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))) kick.push(1);
  else tercetak.push(b.toString('latin1'));
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});

// Stok produk dipulihkan persis di akhir (pola e2e-struk) supaya run
// berikutnya tidak mewarisi pemakaian suite ini.
const dikelola = [];
const jaminStok = async (sku, minimal = 20) => {
  const p = await cari(sku);
  if (!p) throw new Error(`produk ${sku} tidak ditemukan`);
  dikelola.push({ id: p.id, awal: p.stock });
  if (p.stock < minimal) await jpost('/api/restock', { product_id: p.id, qty: minimal, cashier: 'kasir' });
};
const tungguTercetak = async (n, ms = 15000) => {
  const t0 = Date.now();
  while (tercetak.length < n && Date.now() - t0 < ms) await page.waitForTimeout(100);
};
const toastIsi = async () => norm(await page.innerText('#toast-root').catch(() => ''));
const tungguToast = (frag) =>
  page.waitForFunction((f) => document.querySelector('#toast-root')?.textContent?.includes(f), frag, { timeout: 15000 });
const LS = (k) => page.evaluate((key) => localStorage.getItem(key), k);

try {
  await jaminStok('PRD00001');
  await page.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#pos-q', { timeout: 15000 });

  // ——— A. keranjang produk + dialog topup ———
  await page.fill('#pos-q', 'PRD00001');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  chk('produk masuk keranjang (grand Rp3.000)', norm(await page.innerText('#pos-grand')) === 'Rp3.000',
    await page.innerText('#pos-grand'));

  await page.click('#pos-qa-topup');
  await page.waitForSelector('#ptk-nominal', { timeout: 8000 });
  chk('dialog "Tambah topup ke keranjang" terbuka',
    norm(await page.locator('.modal-header h3').innerText()) === 'Tambah topup ke keranjang');
  const tersembunyi = (sel) => page.locator(sel).evaluate((el) => el.classList.contains('hidden'));
  chk('default E-wallet = tanpa kolom nomor (butuhNomor:false)',
    await tersembunyi('#ptk-nomor-wrap'));
  await page.click('[data-ptk-jenis="pln-token"]');
  chk('pilih Token PLN -> kolom nomor tampil', !(await tersembunyi('#ptk-nomor-wrap')));
  chk('pilih Token PLN -> kolom Nomor Token tampil', !(await tersembunyi('#ptk-token-wrap')));
  chk('label nomor ikut jenis (Nomor meter)',
    norm(await page.innerText('#ptk-nomor-label')) === 'Nomor meter');
  await page.fill('#ptk-nomor', '12345678');
  await page.fill('#ptk-token', '98765432109876');
  await page.fill('#ptk-nominal', '10000');
  chk('admin terisi otomatis tier suggestAdmin (10rb -> Rp3.000)',
    (await page.inputValue('#ptk-admin')) === '3000', await page.inputValue('#ptk-admin'));
  await page.fill('#ptk-admin', '2000');
  await page.fill('#ptk-nominal', '12000');
  chk('admin yang sudah diedit TIDAK ditimpa saat nominal berubah',
    (await page.inputValue('#ptk-admin')) === '2000', await page.inputValue('#ptk-admin'));
  await page.fill('#ptk-nominal', '10000');
  chk('admin tetap 2000 setelah nominal kembali 10000',
    (await page.inputValue('#ptk-admin')) === '2000');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#pos-rows .topup-row', { timeout: 8000 });
  const snap1 = JSON.parse((await LS('ravaa.keranjang')) ?? '{}');
  const t1 = snap1?.topups?.[0] ?? {};
  chk('baris topup tersimpan di snapshot localStorage (id+jenis+nominal+admin)',
    t1.jenis === 'pln-token' && t1.nominal === 10000 && t1.admin === 2000 && typeof t1.id === 'string',
    JSON.stringify({ jenis: t1.jenis, nominal: t1.nominal, admin: t1.admin, id: t1.id }));
  chk('TOTAL BELANJA = gabungan (3.000 + 10.000 + 2.000 = Rp15.000)',
    norm(await page.innerText('#pos-grand')) === 'Rp15.000', await page.innerText('#pos-grand'));
  chk('owncount menghitung baris produk + topup (2 item)',
    norm(await page.innerText('#pos-owncount')) === '2 item (1 Qty)', await page.innerText('#pos-owncount'));
  chk('tabel keranjang = 2 baris (produk + topup)',
    (await page.locator('#pos-rows tr[data-key]').count()) === 2);

  // ——— B. persist keranjang ikut baris topup ———
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#pos-rows .topup-row', { timeout: 15000 });
  chk('reload -> baris topup ikut dipulihkan',
    (await page.locator('#pos-rows tr[data-key]').count()) === 2);
  chk('reload -> TOTAL BELANJA tetap Rp15.000',
    norm(await page.innerText('#pos-grand')) === 'Rp15.000', await page.innerText('#pos-grand'));
  chk('reload -> toast menyebut 2 baris dipulihkan',
    (await toastIsi()).includes('Keranjang dipulihkan — 2 baris'), await toastIsi());

  // ——— C. barrier: topup TIDAK BISA jadi hutang ———
  const nAwal = await nSalesHariIni();
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  await page.fill('#pos-cash', '5000');
  await page.click('#pos-pay');
  await tungguToast('baris topup tidak bisa jadi hutang');
  chk('uang kurang + ada topup -> tolak "tidak bisa jadi hutang"',
    (await toastIsi()).includes('Uang diterima kurang dari total Rp15.000'));
  chk('barrier tidak membuka swal / tidak memproses penjualan',
    (await page.locator('.swal2-popup').count()) === 0);
  chk('jumlah penjualan hari ini tidak bertambah setelah barrier', (await nSalesHariIni()) === nAwal,
    `${nAwal} -> ${await nSalesHariIni()}`);

  // ——— D. bayar sekali: sale + topup + resume + struk gabungan ———
  const nCetak0 = tercetak.length;
  await page.fill('#pos-cash', '20000');
  await page.click('#pos-pay');
  await page.waitForSelector('.swal2-popup', { timeout: 15000 });
  const resume = await page.evaluate(() => ({
    judul: document.querySelector('.swal2-title')?.textContent?.trim() ?? '',
    isi: document.querySelector('.swal2-popup')?.innerText?.replace(/\s+/g, ' ').trim() ?? '',
  }));
  chk('resume hero = kembalian gabungan Rp5.000', resume.judul.includes('Kembalian Rp5.000'), resume.judul);
  chk('resume memuat baris topup (nominal)', resume.isi.includes('Topup Token PLN Rp10.000'), resume.isi);
  chk('resume memuat admin terpisah', resume.isi.includes('admin Rp2.000'), resume.isi);
  chk('resume Total = gabungan Rp15.000', resume.isi.includes('Total Rp15.000'), resume.isi);
  chk('pilihan A4 disembunyikan saat ada topup (invoice server ≠ gabungan)',
    !(await page.locator('.swal2-deny').isVisible()));
  await page.click('.swal2-confirm'); // Thermal
  await page.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });
  await tungguTercetak(nCetak0 + 1);
  const struk1 = tercetak.join('\n');
  chk('struk Thermal terkirim', tercetak.length >= nCetak0 + 1, `tercetak=${tercetak.length}`);
  chk('struk gabungan memuat baris topup', struk1.includes('Topup Token PLN'), '');
  chk('struk gabungan memuat biaya admin terpisah', struk1.includes('Biaya admin'), '');
  chk('struk gabungan TOTAL = Rp15.000', struk1.includes('TOTAL Rp15.000'), '');
  chk('struk gabungan memuat kembalian Rp5.000', struk1.includes('Kembalian Rp5.000'), '');
  chk('penjualan tunai = kick laci terkirim', kick.length >= 1, `kick=${kick.length}`);
  chk('keranjang dikosongkan setelah bayar',
    (await page.locator('#pos-rows tr[data-key]').count()) === 0);
  const snap2 = JSON.parse((await LS('ravaa.keranjang')) ?? '{}');
  chk('snapshot keranjang kosong (items & topups)',
    (snap2.items?.length ?? 0) === 0 && (snap2.topups?.length ?? 0) === 0, JSON.stringify(snap2));

  // ——— E. record server: DUA record terpisah dengan angka yang benar ———
  const topupHariIni = (await (await fetch(`${API}/api/topups?date=${hariIni}`)).json()).data ?? [];
  const top1 = topupHariIni.find((r) => r.id === t1.id);
  chk('POST /api/topups baris 1 (PLN-TOKEN, nominal 10.000, admin 2.000)',
    !!top1 && top1.provider === 'PLN-TOKEN' && top1.nominal === 10000 && top1.admin === 2000 &&
      top1.pay_method === 'tunai' && top1.nomor === '12345678' && top1.token === '98765432109876',
    JSON.stringify(top1));
  const saleId = await LS('ravaa.nota-terakhir');
  const nota = (await (await fetch(`${API}/api/sales/${saleId}`)).json()).data ?? {};
  chk('nota penjualan total = produk saja (Rp3.000) — topup bukan omzet',
    nota.sale?.total === 3000, JSON.stringify(nota.sale));
  chk('nota cash_in = total + kembalian (Rp8.000) — invarian server change',
    nota.sale?.cash_in === 8000, String(nota.sale?.cash_in));
  chk('nota change = Rp5.000 (kembalian gabungan)', nota.sale?.change === 5000);
  chk('nota BUKAN berhutang (sisa_hutang 0)', nota.sale?.sisa_hutang === 0);

  // ——— F. keranjang topup-SAJA (tanpa produk) ———
  const nCetak1 = tercetak.length;
  await page.click('#pos-qa-topup');
  await page.waitForSelector('#ptk-nominal', { timeout: 8000 });
  await page.fill('#ptk-nominal', '20000');
  chk('topup-saja default E-wallet: nomor tetap tersembunyi',
    await tersembunyi('#ptk-nomor-wrap'));
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#pos-rows .topup-row', { timeout: 8000 });
  chk('keranjang topup-saja: label #pos-count menyebut topup (bukan "0 item")',
    norm(await page.innerText('#pos-count')) === '1 topup', await page.innerText('#pos-count'));
  // Tong sampah baris topup (data-act="topup-del") — baris topup BUKAN baris
  // `cart`, jadi ini menguji cabang hapus khusus di delegasi klik #pos-rows.
  await page.click('#pos-rows .topup-row [data-act="topup-del"]');
  await page.waitForFunction(() => !document.querySelector('#pos-rows .topup-row'), { timeout: 8000 });
  const snapHapus = JSON.parse((await LS('ravaa.keranjang')) ?? '{}');
  chk('tombol hapus baris topup mengosongkan keranjang + snapshot',
    (await page.locator('#pos-rows tr[data-key]').count()) === 0 && (snapHapus.topups?.length ?? 0) === 0,
    JSON.stringify(snapHapus));
  // Tambah lagi untuk menguji jalur topup-saja (tanpa produk) sampai bayar.
  await page.click('#pos-qa-topup');
  await page.waitForSelector('#ptk-nominal', { timeout: 8000 });
  await page.fill('#ptk-nominal', '20000');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('#pos-rows .topup-row', { timeout: 8000 });
  await page.keyboard.press('F12'); // Bayar pas = persis nominal+admin
  await tungguToast('Topup tercatat');
  chk('F12 topup-saja -> toast "Topup tercatat"', (await toastIsi()).includes('Topup tercatat · Rp23.000'));
  chk('topup-saja TANPA modal resume (bukan penjualan)',
    (await page.locator('.swal2-popup').count()) === 0);
  chk('keranjang kosong setelah topup-saja',
    (await page.locator('#pos-rows tr[data-key]').count()) === 0);
  await tungguTercetak(nCetak1 + 1);
  const struk2 = tercetak[tercetak.length - 1] ?? '';
  chk('struk topup-saja memuat baris E-wallet + total', struk2.includes('Topup E-wallet Rp20.000') && struk2.includes('TOTAL Rp23.000'), '');
  const top2 = ((await (await fetch(`${API}/api/topups?date=${hariIni}`)).json()).data ?? [])
    .find((r) => r.provider === 'E-WALLET' && r.nominal === 20000 && r.admin === 3000);
  chk('POST /api/topups topup-saja (E-WALLET, 20.000 + admin 3.000)', !!top2, JSON.stringify(top2));

  chk('tanpa pageerror', errs.length === 0, errs.slice(0, 3));
} catch (e) {
  gagal++;
  console.log('  GAGAL (exception) |', String(e).slice(0, 300));
  try { console.log('  toast:', await toastIsi()); } catch { /* */ }
} finally {
  await browser.close();
  for (const k of dikelola) {
    await jpost('/api/stock-opname', { product_id: k.id, qty_fisik: k.awal, cashier: 'kasir' }).catch(() => {});
  }
}
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
