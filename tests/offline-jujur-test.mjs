// E2E KEJUJURAN OFFLINE (2026-10-25).
//
// Latar: `enqueue()` di apps/web/src/api.ts TIDAK dipanggil jalur tulis mana
// pun — tidak ada outbox otomatis. Sebelum revisi ini POS tetap membuka form
// bayar saat server mati, kasir menunggu, lalu membaca "Gagal menyimpan"
// tanpa tahu nasib notanya. Kontrak yang diuji di sini:
//   A. online: POS normal, tanpa banner;
//   B. POST /api/sales gagal jaringan -> toast menyebut "BELUM terkonfirmasi"
//      + "Cek Riwayat", banner muncul, tombol bayar mati, keranjang UTUH
//      (memori + localStorage);
//   C. "Coba lagi" saat server tetap mati = tetap offline (tidak bohong);
//   D. server pulih + retry -> banner hilang, tombol hidup, dan nota yang
//      tertahan bisa dibayar (tidak ada data hilang);
//   E. buka POS saat server mati -> gate "Server tidak terjangkau" (BUKAN
//      form buka shift), retry setelah pulih -> shell POS tampil.
//
// Jalankan: node tests/offline-jujur-test.mjs  (butuh API :3001 + web :5656)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken } from './bantuan-uji.mjs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();

/** Nota uji "UjiOffline Jasa" WAJIB dibuang: baris manual tidak punya satuan
 *  (`unit = ''`) sehingga kalau ditinggal ia meracuni asersi laporan-test
 *  "topItems punya satuan" di hari yang sama. Nama EKSAK milik suite ini;
 *  id dikumpulkan DULU (CLI sqlite3 tidak menjalankan ON DELETE CASCADE). */
function bersihkanNotaUji() {
  const ids = sql(
    `SELECT id FROM sales s
      WHERE EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.name = 'UjiOffline Jasa')`,
  ).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return 0;
  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
  sql(`DELETE FROM sale_items WHERE sale_id IN (${list});
       DELETE FROM sale_payments WHERE sale_id IN (${list});
       DELETE FROM sales WHERE id IN (${list});`);
  return ids.length;
}
bersihkanNotaUji(); // self-heal sisa run yang crash

const WEB = 'http://localhost:5656';
let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// Pref cetak: jeda (default) supaya klik Thermal tidak pernah menyentuh
// print-agent. Suite ini tidak mengklik cetak, tapi aman.
await ctx.addInitScript(() => {
  try { localStorage.setItem('ravaa.printpause', '1'); } catch { /* private */ }
});

let p = null;
const teks = async (sel) => (await p.locator(sel).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

try {
  p = await ctx.newPage();
  await pasangToken(p);
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

  /* ---------- A. baseline online ---------- */
  console.log('=== A. Baseline online ===');
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#pos-q', { timeout: 15000 });
  chk('POS terbuka normal saat server hidup', await p.locator('#pos-q').isVisible());
  chk('banner offline tidak tampil saat server hidup', !(await p.locator('#pos-offline').isVisible()));

  // Item manual (tanpa product_id) = tidak menyentuh stok, deterministik.
  await p.click('#pos-qa-manual');
  await p.waitForSelector('#pm-name', { timeout: 8000 });
  await p.fill('#pm-name', 'UjiOffline Jasa');
  await p.fill('#pm-price', '1000');
  await p.click('.modal [data-ok]');
  await p.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  chk('keranjang berisi 1 baris (total Rp1.000)',
    (await p.locator('#pos-rows tr[data-key]').count()) === 1
      && (await teks('#pos-grand')).includes('1.000'),
    await teks('#pos-grand'));

  /* ---------- B. POST gagal jaringan ---------- */
  console.log('=== B. Server mati di tengah bayar ===');
  await p.route('**/api/**', (r) => r.abort());
  await p.keyboard.press('F12'); // bayar pas = jalur tercepat (tanpa modal)
  await p.waitForFunction(
    () => (document.querySelector('#toast-root')?.textContent ?? '').includes('BELUM terkonfirmasi'),
    { timeout: 12000 },
  );
  const toastGagal = await teks('#toast-root');
  chk('toast menyebut "BELUM terkonfirmasi" (bukan klaim gagal pasti)',
    toastGagal.includes('BELUM terkonfirmasi'), toastGagal.slice(0, 220));
  chk('toast menyuruh "Cek Riwayat" sebelum mengulang',
    toastGagal.includes('Cek Riwayat'), toastGagal.slice(0, 220));

  await p.waitForSelector('#pos-offline', { state: 'visible', timeout: 8000 });
  chk('banner "Server tidak terjangkau" muncul otomatis (event konektivitas)',
    (await teks('#pos-offline')).includes('Server tidak terjangkau'));
  chk('tombol Bayar F10 mati saat server tak terjangkau',
    await p.locator('#pos-bayar').isDisabled());
  chk('tombol Bayar pas F12 ikut mati',
    await p.locator('#pos-pay-pas').isDisabled());
  chk('keranjang TIDAK dikosongkan setelah gagal jaringan',
    (await p.locator('#pos-rows tr[data-key]').count()) === 1,
    await teks('#pos-count'));
  const tersimpan = await p.evaluate(() => localStorage.getItem('ravaa.keranjang') ?? '');
  chk('snapshot keranjang di localStorage masih memuat baris uji',
    tersimpan.includes('UjiOffline'), tersimpan.slice(0, 160));

  /* ---------- C. retry saat server masih mati ---------- */
  console.log('=== C. Coba lagi saat server tetap mati ===');
  await p.click('#pos-offline-retry');
  await p.waitForTimeout(1200); // cek /api/me (abort) + event
  chk('banner TETAP tampil setelah retry gagal (tidak bohong "tersambung")',
    await p.locator('#pos-offline').isVisible());
  await p.waitForFunction(
    () => !document.querySelector('#pos-offline-retry')?.hasAttribute('disabled'),
    { timeout: 8000 },
  );
  chk('tombol Coba lagi hidup kembali setelah percobaan selesai', true);

  /* ---------- D. server pulih ---------- */
  console.log('=== D. Server pulih + nota tertahan dibayar ===');
  await p.unroute('**/api/**');
  await p.click('#pos-offline-retry');
  await p.waitForSelector('#pos-offline', { state: 'hidden', timeout: 10000 });
  chk('banner hilang setelah server menjawab', !(await p.locator('#pos-offline').isVisible()));
  chk('tombol Bayar hidup lagi setelah pulih',
    !(await p.locator('#pos-bayar').isDisabled()));

  await p.keyboard.press('F12');
  await p.waitForSelector('.swal2-popup', { timeout: 15000 });
  const toastSukses = await teks('#toast-root');
  chk('nota tertahan berhasil dibayar setelah pulih (resume tampil + toast Terjual)',
    toastSukses.includes('Terjual'), toastSukses.slice(0, 180));
  await p.keyboard.press('Escape');
  await p.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });

  chk('tanpa pageerror di alur desktop', errs.length === 0, errs.join(' | '));
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

/* ---------- E. boot saat server mati (gate, bukan form buka shift) ---------- */
try {
  console.log('=== E. Buka POS saat server mati ===');
  const p2 = await ctx.newPage();
  await pasangToken(p2);
  await p2.route('**/api/**', (r) => r.abort());
  await p2.goto(`${WEB}/#/pos`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('#pos-gate-retry', { timeout: 15000 });
  const gate = (await p2.locator('#pos-gate-retry').locator('xpath=ancestor::div[contains(@class,"card")][1]').innerText().catch(() => ''))
    .replace(/\s+/g, ' ').trim();
  chk('gate menampilkan "Server tidak terjangkau", BUKAN form buka shift',
    gate.includes('Server tidak terjangkau') && (await p2.locator('#pos-open-shift').count()) === 0,
    gate.slice(0, 200));

  await p2.unroute('**/api/**');
  await p2.click('#pos-gate-retry');
  await p2.waitForSelector('#pos-q', { timeout: 15000 });
  chk('retry setelah pulih memuat status shift & menampilkan shell POS',
    await p2.locator('#pos-q').isVisible());
  await p2.close();
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash (boot offline): ${String(e).slice(0, 300)}`);
}

await browser.close();
const dihapus = bersihkanNotaUji();
const sisa = sql(
  `SELECT COUNT(*) FROM sales s
    WHERE EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.name = 'UjiOffline Jasa')`,
);
chk('nota uji dibersihkan (laporan hari ini tidak tercemar baris tanpa satuan)',
  sisa === '0', `dihapus ${dihapus}, sisa ${sisa}`);
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [offline-jujur-test.mjs]`);
process.exit(gagal === 0 ? 0 : 1);
