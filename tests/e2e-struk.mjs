// E2E cetak struk: POS -> escpos.struk() -> print-agent.
// Request /print DISELA di Playwright supaya TIDAK menembak printer sungguhan
// (/dev/usb/lp0 ada dan user tergabung di grup lp — menulisnya akan membuang
// kertas nyata). Yang diuji adalah bytes yang benar-benar dikirim browser.
import { chromium } from 'playwright-core';

let lolos = 0, gagal = 0;
const ok = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const COLS = 32;

/** Buang urutan perintah ESC/POS supaya argumennya tak terbaca sebagai isi struk. */
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
const jmlGaris = (b) => (teksDari(b).match(/-{32}/g) || []).length;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // 500 dari rute /print adalah KEgagalan yang SENGAJA dipicu skenario D —
  // itu bukti fitur, bukan kerusakan. Sisanya dianggap error asli.
  if (gagalCetak && /500 \(Internal Server Error\)/.test(t)) return;
  errs.push(`console: ${t}`);
});

const tercetak = [];   // { base64 }
let gagalCetak = false;
await page.route('**/print', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  tercetak.push(body.data_base64 || '');
  if (gagalCetak) {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'PRINTER_PATH tidak ada' }) });
  } else {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, via: 'file', file: '/tmp/e2e.bin' }) });
  }
});

const API = 'http://localhost:3001';
const jpost = async (p, b) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const cari = async (q) => (await (await fetch(`${API}/api/products?q=${encodeURIComponent(q)}`)).json()).data?.[0];

// SEMUA produk yang dijual suite ini dicatat lalu DIJAMIN cukup, dan
// dikembalikan persis di finally. Tanpa ini suite ini perlahan memakan stok
// seed (Aqua, Chitato) sampai habis lalu gagal dengan "stok kurang ... (sisa 0)".
// Restock TANPA harga_beli supaya avg_cost tidak berubah.
const dikelola = [];
const jaminStok = async (sku, minimal = 20) => {
  const p = await cari(sku);
  if (!p) throw new Error(`produk ${sku} tidak ditemukan`);
  dikelola.push({ id: p.id, awal: p.stock });
  if (p.stock < minimal) await jpost('/api/restock', { product_id: p.id, qty: minimal, cashier: 'kasir' });
};
await jaminStok('MINUM-AQUA-600');
await jaminStok('SNK-CHITATO-SAPI');

const jual = async (paket) => {
  await page.fill('#pos-q', paket.q);
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  if (paket.tunai) await page.fill('#pos-cash', String(paket.tunai));
  await page.click('#pos-pay');
  await page.waitForFunction(
    () => document.querySelector('#toast-root')?.textContent?.includes('Terjual'),
    { timeout: 15000 },
  );
};

try {
  const salesSebelum = await (await fetch('http://localhost:3001/api/reports/daily')).json();

  console.log('=== A. Saklar & penjualan ===');
  await page.goto('http://localhost:5656/#/pos', { waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  ok('saklar "Cetak struk otomatis" tampil di baris Mode', await page.isVisible('#pos-autoprint'));
  ok('saklar NYALA secara bawaan', await page.isChecked('#pos-autoprint'));

  await jual({ q: 'aqua', tunai: 20000 });
  ok('struk dikirim sekali', tercetak.length === 1, tercetak.length);
  const s1 = Buffer.from(tercetak[0], 'base64');
  ok('diawali INIT', s1[0] === 0x1b && s1[1] === 0x40);
  ok('diakhiri CUT', s1[s1.length - 3] === 0x1d && s1[s1.length - 2] === 0x56 && s1[s1.length - 1] === 0x00);
  const t1 = teksDari(s1);
  const b1 = barisStruk(s1);
  ok('membawa nama toko (default aplikasi)', t1.includes('RAVA POS'), b1.slice(0, 2));
  ok('membawa no transaksi + kasir + shift', /No\. \w{8}/.test(t1) && /Kasir:/.test(t1) && /Shift:/.test(t1), b1[1]);
  ok('membawa item terjual', /1 x Aqua 600ml/.test(t1), b1.filter((x) => x.includes('Aqua')));
  ok('membawa subtotal', t1.includes('Subtotal') && t1.includes('Rp4.000'));
  ok('membawa TOTAL', t1.includes('TOTAL') && t1.includes('Rp4.000'));
  ok('membawa tunai & kembalian', t1.includes('Tunai') && t1.includes('Rp20.000') && t1.includes('Rp16.000'),
    b1.filter((x) => /Tunai|Kembalian/.test(x)));
  ok('membawa kaki struk', t1.includes('Terima kasih sudah berbelanja'));
  const lewat1 = b1.filter((x) => x.length > COLS);
  ok(`semua baris <= 32 kolom (maks ${Math.max(...b1.map((x) => x.length))})`, lewat1.length === 0, lewat1);
  ok('3 garis pemisah (item + rincian)', jmlGaris(s1) === 3, jmlGaris(s1));
  ok('baris TOTAL dicetak tebal', (() => {
    const idx = s1.findIndex((_, i) =>
      s1[i] === 0x1b && s1[i + 1] === 0x45 && s1[i + 2] === 1 &&
      s1.slice(i + 3, i + 8).toString() === 'TOTAL');
    return idx >= 0;
  })());

  console.log('=== B. Saklar mati = tidak dicetak ===');
  // Input-nya sr-only (tersembunyi demi aksesibilitas) — user asli mengklik
  // labelnya, jadi begitu juga yang diuji.
  await page.click('label[for="pos-autoprint"]');
  ok('posisi saklar terbaca mati', !(await page.isChecked('#pos-autoprint')));
  // Chitato, bukan Pulpen Hitam: pulpen adalah fixture baseline E2E opname.
  await jual({ q: 'chitato', tunai: 20000 });
  ok('penjualan jalan walau cetak mati', await page.isVisible('#pos-rows'));
  ok('TIDAK ada permintaan cetak tambahan', tercetak.length === 1, tercetak.length);

  console.log('=== C. Topup tetap memakai saklar yang sama ===');
  await page.click('label[for="pos-autoprint"]');
  ok('saklar bisa dinyalakan lagi', await page.isChecked('#pos-autoprint'));
  await page.click('[data-mode="topup"]');
  await page.waitForSelector('#tp-submit', { timeout: 8000 });
  await page.fill('#tp-nomor', '081234567890');
  await page.fill('#tp-nominal', '50000');
  await page.waitForTimeout(400);          // suggest-admin memanggil API
  const admin = await page.inputValue('#tp-admin');
  // Kontrak: <50rb -> 3000, <200rb -> 5000. Rp50.000 bukan "<50rb" -> tier 5000.
  ok('admin terisi otomatis sesuai tier (<200rb = Rp5.000)', admin === '5000', admin);
  await page.fill('#tp-tunai', '60000');
  await page.click('#tp-submit');
  await page.waitForFunction(
    () => document.querySelector('#toast-root')?.textContent?.match(/Topup /),
    { timeout: 15000 },
  );
  ok('struk topup dikirim', tercetak.length === 2, tercetak.length);
  const s3 = Buffer.from(tercetak[1], 'base64');
  const t3 = teksDari(s3);
  const b3 = barisStruk(s3);
  ok('memuat judul layanan', /TOPUP/.test(t3), b3[0]);
  ok('memuat nomor tujuan', t3.includes('081234567890'));
  ok('memuat nominal & admin', t3.includes('Rp50.000') && t3.includes('Rp5.000'),
    b3.filter((x) => /Nominal|Admin/.test(x)));
  ok('memuat TOTAL Rp55.000', t3.includes('Rp55.000'), b3.filter((x) => x.includes('TOTAL')));
  ok('memuat kembalian Rp5.000', t3.includes('Rp5.000') && b3.some((x) => x.includes('Kembalian')),
    b3.filter((x) => /Kembalian|Tunai/.test(x)));
  ok('tanpa baris "(tanpa item)"', !t3.includes('tanpa item'));
  ok('hanya 2 garis (tanpa blok item)', jmlGaris(s3) === 2, jmlGaris(s3));
  const lewat3 = b3.filter((x) => x.length > COLS);
  ok('semua baris topup <= 32 kolom', lewat3.length === 0, lewat3);

  console.log('=== D. Gagal cetak TIDAK membatalkan penjualan ===');
  gagalCetak = true;
  await page.click('[data-mode="jual"]');
  await page.waitForSelector('#pos-q', { timeout: 8000 });
  await jual({ q: 'aqua', tunai: 20000 });
  ok('permintaan cetak tetap dikirim (dicoba)', tercetak.length === 3, tercetak.length);
  const toast = norm(await page.innerText('#toast-root'));
  ok('toast peringatan cetak muncul', /Struk tidak tercetak/.test(toast), toast);
  ok('penjualan tetap berhasil (toast Terjual)', /Terjual/.test(toast), toast);
  const laporan = await (await fetch('http://localhost:3001/api/reports/daily')).json();
  // reports/daily mengembalikan sales = {n, omzet, diskon}, bukan array.
  const n1 = salesSebelum?.data?.sales?.n ?? 0;
  const n2 = laporan?.data?.sales?.n ?? 0;
  ok(`3 penjualan tercatat di server (${n1} -> ${n2})`, n2 - n1 === 3, JSON.stringify({ n1, n2 }));

  ok('tanpa error halaman', errs.length === 0, errs.slice(0, 3));
} catch (e) {
  gagal++;
  console.log('  GAGAL (exception) |', e.message);
  try { console.log('  toast:', norm(await page.innerText('#toast-root'))); } catch { /* */ }
} finally {
  await browser.close();
  // Kembalikan stok tiap produk persis seperti awal (opname = set absolut,
  // bukan +/−), supaya run berikutnya tidak mewarisi sisa run ini.
  for (const k of dikelola) {
    await jpost('/api/stock-opname', { product_id: k.id, qty_fisik: k.awal, cashier: 'kasir' }).catch(() => {});
  }
}
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
