// E2E OUTBOX TULIS OFFLINE (butir ROADMAP 1.8, ACC pemilik 2026-10-25).
//
// Latar: dulu (2026-10-25 pagi) POST gagal jaringan = POS menolak dengan toast
// "BELUM terkonfirmasi" dan tombol bayar mati — jujur tapi toko berhenti saat
// server maintenance. ACC pemilik: "Antrean tulis offline (outbox) boleh di
// terapkan alih-alih jika server sedang maintenance". Kontrak yang diuji:
//   A. online: POS normal, tanpa banner;
//   B. server mati + Bayar pas F12 -> toast "DIANTREKAN" + banner amber +
//      keranjang KOSONG (transaksi pindah ke outbox localStorage) + chip
//      "n transaksi antre offline" hidup; tombol bayar TIDAK mati;
//   C. "Coba lagi" saat server tetap mati = banner tetap (tidak bohong);
//   D. server pulih -> flush otomatis (tick 5 detik): outbox kosong, nota
//      BENAR-BENAR ada di DB (sales + sale_items), chip notif hilang;
//   D2. hutang offline: nota dengan uang kurang + pelanggan valid ->
//      job terkirim lalu charge ledger /api/customer-debts muncul otomatis
//      (chaining EVENT_OUTBOX_DONE — butuh invoice_no dari balasan flush);
//   E. buka POS saat server mati -> gate "Server tidak terjangkau" (BUKAN
//      form buka shift) — shift tetap butuh server (jujur).
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

const NAMA_PEL = 'UjiOffline Pelanggan';

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

/** Self-heal: buang pelanggan uji + ledger-nya (nama EKSAK, bukan prefix —
 *  pelajaran AGENTS §5 cleanup bertipe prefix menjaring data durable). */
function bersihkanPelangganUji() {
  sql(`DELETE FROM customer_debts WHERE customer_id IN (SELECT id FROM customers WHERE name = '${NAMA_PEL}');
       DELETE FROM customers WHERE name = '${NAMA_PEL}';`);
}

// login owner untuk setup data via API (membuat pelanggan uji)
const login = await fetch('http://localhost:3001/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'owner', password: 'admin123' }),
}).then((r) => r.json());
const TOKEN = login?.data?.token ?? '';
if (!TOKEN) {
  console.log('GAGAL login owner — API :3001 hidup?');
  process.exit(1);
}
// CATATAN: JANGAN kirim header Authorization sendiri di fetch node sini —
// bantuan-uji.mjs menimpa `globalThis.fetch` dan menyuntikkan token uji ke
// SEMUA request localhost:3001/api; header ganda (milik sendiri + suntikan)
// tergabung "Bearer X, Bearer Y" oleh Headers dan server menolaknya 401.
const apiPost = (path, body) =>
  fetch(`http://localhost:3001${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// Bersihkan sisa run crash DULU, baru buat pelanggan uji (urutan salah =
// pelanggan yang baru dibuat ikut terhapus — bug nyata run pertama).
bersihkanNotaUji();
bersihkanPelangganUji();

// Pelanggan uji untuk skenario hutang offline (D2) — dibuat SEBELUM halaman
// POS dimuat: dropdown #pos-customer diisi saat mount, jadi kontak yang
// lahir sesudahnya tidak pernah muncul di pilihan.
const buatPel = await apiPost('/api/customers', { name: NAMA_PEL, phone: '0811' });
if (!buatPel.ok) {
  console.log('GAGAL membuat pelanggan uji:', String(buatPel.status), JSON.stringify(await buatPel.json().catch(() => ({}))).slice(0, 300));
  process.exit(1);
}

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

// Pref cetak: jeda (default) supaya tidak pernah menyentuh print-agent.
await ctx.addInitScript(() => {
  try { localStorage.setItem('ravaa.printpause', '1'); } catch { /* private */ }
});

let p = null;
const teks = async (sel) => (await p.locator(sel).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
/** Baca antrean outbox localStorage (array job {key, path, data}). */
const bacaOutbox = () => p.evaluate(() => JSON.parse(localStorage.getItem('ravaa.outbox.v1') ?? '[]'));

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
  chk('antrean outbox kosong di awal', (await bacaOutbox()).length === 0);

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

  /* ---------- B. server mati + Bayar pas = ANTREAN ---------- */
  console.log('=== B. Server mati + bayar = nota masuk antrean ===');
  await p.route('**/api/**', (r) => r.abort());
  await p.keyboard.press('F12'); // bayar pas = jalur tercepat (tanpa modal)
  await p.waitForFunction(
    () => (document.querySelector('#toast-root')?.textContent ?? '').includes('DIANTREKAN'),
    { timeout: 12000 },
  );
  chk('toast menyebut "DIANTREKAN" (bukan "BELUM tersimpan")',
    (await teks('#toast-root')).includes('DIANTREKAN'));
  // pay() memanggil cekJaringan() setelah mengantre — banner tampil segera.
  await p.waitForSelector('#pos-offline', { state: 'visible', timeout: 10000 });
  chk('banner offline muncul otomatis (event konektivitas)',
    (await teks('#pos-offline')).includes('Server tidak terjangkau'));
  const antre = await bacaOutbox();
  chk('outbox localStorage berisi 1 job /api/sales',
    antre.length === 1 && antre[0].path === '/api/sales',
    JSON.stringify(antre).slice(0, 200));
  const saleIdOffline = antre[0]?.key ?? '';
  chk('job memuat id uuid + item uji',
    saleIdOffline.length > 10 && JSON.stringify(antre[0].data).includes('UjiOffline Jasa'));
  chk('keranjang DIKOSONGKAN setelah diantrekan (transaksi pindah ke outbox)',
    (await p.locator('#pos-rows tr[data-key]').count()) === 0,
    await teks('#pos-count'));
  chk('chip notif "1 transaksi antre offline" tampil',
    (await teks('a[data-notif-outbox]')).includes('1 transaksi antre offline'),
    await teks('a[data-notif-outbox]'));

  /* ---------- C. retry saat server masih mati ---------- */
  console.log('=== C. Coba lagi saat server tetap mati ===');
  await p.click('#pos-offline-retry');
  await p.waitForTimeout(1200);
  chk('banner TETAP tampil setelah retry gagal (tidak bohong "tersambung")',
    await p.locator('#pos-offline').isVisible());
  chk('antrean tetap utuh (job tidak dibuang saat jaringan mati)',
    (await bacaOutbox()).length === 1);

  /* ---------- D. server pulih -> flush otomatis ---------- */
  console.log('=== D. Server pulih + antrean terkirim otomatis ===');
  await p.unroute('**/api/**');
  await p.click('#pos-offline-retry');
  await p.waitForSelector('#pos-offline', { state: 'hidden', timeout: 10000 });
  chk('banner hilang setelah server menjawab', !(await p.locator('#pos-offline').isVisible()));
  // flushOutbox berjalan tiap 5 detik (jantung api.ts) — tunggu antrean kosong.
  await p.waitForFunction(
    () => JSON.parse(localStorage.getItem('ravaa.outbox.v1') ?? '[]').length === 0,
    { timeout: 20000 },
  );
  chk('outbox kosong setelah flush otomatis', true);
  await p.waitForFunction(
    () => (document.querySelector('#toast-root')?.textContent ?? '').includes('Antrean terkirim'),
    { timeout: 8000 },
  );
  chk('toast "Antrean terkirim" muncul (listener EVENT_OUTBOX_DONE)', true);
  const adaNota = sql(`SELECT COUNT(*) FROM sales WHERE id = '${saleIdOffline}'`).trim();
  chk('nota antrean BENAR-BENAR tersimpan di DB (id uuid sama)', adaNota === '1', adaNota);
  const inv = sql(`SELECT invoice_no FROM sales WHERE id = '${saleIdOffline}'`).trim();
  chk('nota antrean punya invoice_no server (YYMMDD-…)', /^2\d{5}-\d{6}$/.test(inv), inv);
  chk('chip notif antrean hilang setelah flush', await p.locator('a[data-notif-outbox]').isHidden());

  /* ---------- D2. hutang offline: charge ledger di-chain ---------- */
  console.log('=== D2. Hutang offline -> ledger tercatat setelah flush ===');
  // Pilih pelanggan uji di info bar (select #pos-customer). Diisi via evaluate
  // + event change (pola input programatis) — selectOption Playwright hang
  // menunggu actionability di titik ini pada beberapa run.
  const custId = sql(`SELECT id FROM customers WHERE name = '${NAMA_PEL}'`).trim();
  chk('pelanggan uji ada di DB (id angka)', /^\d+$/.test(custId), custId);
  await p.evaluate((v) => {
    const sel = document.querySelector('#pos-customer');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, custId);
  chk('pelanggan uji terpilih di info bar', (await p.inputValue('#pos-customer')) === custId,
    await p.inputValue('#pos-customer'));
  await p.click('#pos-qa-manual');
  await p.waitForSelector('#pm-name', { timeout: 8000 });
  await p.fill('#pm-name', 'UjiOffline Jasa');
  await p.fill('#pm-price', '1500');
  await p.click('.modal [data-ok]');
  await p.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await p.route('**/api/**', (r) => r.abort());
  await p.waitForTimeout(1200);
  // Buka form bayar, uang 0 = hutang otomatis (putaran 12) — pelanggan valid
  // => pay({hutang:true}) tanpa konfirmasi; offline => antre + peta tunda.
  // PENTING: JANGAN tunggu toast "DIANTREKAN" — toast catch fase B bisa masih
  // hidup di #toast-root (durasi 9 detik) dan mencocokkan lebih awal. Sinyal
  // definitif fase ini = peta hutang tunda terisi (ditulis bersama enqueue).
  await p.keyboard.press('F10');
  await p.waitForSelector('#pos-cash', { timeout: 8000 });
  await p.fill('#pos-cash', '0');
  await p.click('#pos-pay');
  await p.waitForFunction(
    () => Object.keys(JSON.parse(localStorage.getItem('ravaa.outbox-debt') ?? '{}')).length > 0,
    { timeout: 15000 },
  );
  const antre2 = await bacaOutbox();
  chk('nota hutang masuk antrean', antre2.some((j) => j.path === '/api/sales'),
    JSON.stringify(antre2).slice(0, 200));
  const petaTunda = await p.evaluate(() => localStorage.getItem('ravaa.outbox-debt') ?? '{}');
  chk('peta hutang tunda terdaftar (ravaa.outbox-debt)', petaTunda.includes('"sisa":1500'),
    petaTunda.slice(0, 160));
  await p.unroute('**/api/**');
  await p.waitForFunction(
    () => JSON.parse(localStorage.getItem('ravaa.outbox.v1') ?? '[]').length === 0,
    { timeout: 25000 },
  );
  // Charge ledger dikirim SETELAH sale flush (listener EVENT_OUTBOX_DONE) —
  // beri waktu request kedua selesai.
  let ledger = '';
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ledger = sql(
      `SELECT COUNT(*) FROM customer_debts
        WHERE customer_id = ${custId} AND type = 'charge' AND amount = 1500
          AND note LIKE 'Nota % — sisa bayar POS'`,
    ).trim();
    if (ledger === '1') break;
  }
  chk('charge hutang otomatis tercatat di ledger setelah flush (chaining 1.8)',
    ledger === '1', `baris=${ledger}`);
  await p.waitForFunction(
    () => (document.querySelector('#toast-root')?.textContent ?? '').includes('hutang Rp1.500 dicatat'),
    { timeout: 8000 },
  ).catch(() => {});
  chk('toast "hutang Rp1.500 dicatat" muncul',
    (await teks('#toast-root')).includes('hutang Rp1.500 dicatat'));

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
bersihkanPelangganUji();
const sisaPel = sql(`SELECT COUNT(*) FROM customers WHERE name = '${NAMA_PEL}'`).trim();
chk('pelanggan uji + ledger-nya dibersihkan', sisaPel === '0', `sisa ${sisaPel}`);
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [offline-jujur-test.mjs]`);
process.exit(gagal === 0 ? 0 : 1);
