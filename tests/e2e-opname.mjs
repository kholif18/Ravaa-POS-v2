// E2E dialog Stok: Masuk barang vs Hitung fisik (opname).
// Jalankan: node e2e-opname.mjs   (API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
const ARTIFAK = path0.join(path0.dirname(fileURLToPath(import.meta.url)), 'artifacts');

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

/** Stok & opname kini HANYA di halaman Stok (#/stock) — tombol barisnya
 *  [data-stock], tidak lagi lewat menu ⋮ halaman Produk. Halaman dibuka sekali
 *  di awal; pencarian `#st-q` disimpan di state dan bertahan antar paint, jadi
 *  tiap panggilan cukup mengklik baris pertama (sudah tersaring). */
const bukaDialogStok = async () => {
  await page.click('#page tbody tr [data-stock]');
  await page.waitForSelector('#r-qty', { timeout: 8000 });
};

const stokSelai = async () => {
  // kolom ke-3 (badge Stok) pada baris produk yang sedang dicari
  const tds = await page.locator('#page tbody tr').first().locator('td').allInnerTexts();
  return norm(tds[2] ?? '');
};

try {
  await page.goto('http://localhost:5656/#/stock', { waitUntil: 'load' });
  await page.waitForSelector('#page tbody tr', { timeout: 20000 });
  await page.fill('#st-q', 'PRD00001');
  await page.waitForTimeout(400);
  const awal = await stokSelai();
  // Baseline DIBACA dari data, bukan ditulis tetap 50: test lain (mis. E2E struk
  // yang ikut menjual produk ini) boleh mengubah stok tanpa membuat suite ini
  // gagal — yang diuji adalah PERUBAHANNYA, bukan angka absolutnya.
  const n = parseInt(awal, 10);
  ok('produk uji ketemu & stok terbaca', Number.isFinite(n), awal);
  const b = n + 7;   // stok setelah restock +7 pada bagian C

  console.log('=== A. Buka dialog: mode default Masuk barang ===');
  await bukaDialogStok();
  ok('judul menutup dua mode', /Stok:/.test(await page.innerText('.modal-header h3')));
  ok('label = Jumlah masuk', (await page.innerText('#r-label')).trim() === 'Jumlah masuk *');
  ok('tombol = Tambah stok', (await page.innerText('.modal [data-ok]')).trim() === 'Tambah stok');
  ok('hint stok saat ini', new RegExp(`Stok saat ini: ${n}\\b`).test(await page.innerText('#r-hint')), await page.innerText('#r-hint'));
  ok('input default = 1', (await page.inputValue('#r-qty')) === '1');
  ok('chip "Masuk barang" aktif',
    (await page.getAttribute('.modal [data-mode="masuk"]', 'aria-pressed')) === 'true');

  console.log('=== B. Input kosong / nol ditolak di mode masuk ===');
  await page.fill('#r-qty', '');
  await page.click('.modal [data-ok]');
  ok('input kosong -> dialog TIDAK tertutup', await page.isVisible('#r-qty'));
  ok('toast peringatan muncul', /Jumlah harus lebih dari 0/.test(await page.innerText('#toast-root')));
  await page.fill('#r-qty', '0');
  await page.click('.modal [data-ok]');
  ok('qty 0 -> tetap ditolak (restock)', await page.isVisible('#r-qty'));

  console.log('=== C. Mode Masuk barang benar-benar menambah stok ===');
  await page.fill('#r-qty', '7');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  await page.fill('#st-q', 'PRD00001');
  await page.waitForTimeout(600);
  ok(`stok ${n} -> ${b}`, (await stokSelai()) === String(b), await stokSelai());
  ok('toast restock', /Stok .+ \+7/.test(await page.innerText('#toast-root')));

  console.log('=== D. Mode Hitung fisik (opname) ===');
  await bukaDialogStok();
  await page.click('.modal [data-mode="opname"]');
  ok('label berubah', (await page.innerText('#r-label')).trim() === 'Jumlah fisik hasil hitung *');
  ok('tombol berubah', (await page.innerText('.modal [data-ok]')).trim() === 'Simpan opname');
  ok(`input disetel ke stok tercatat (${b})`, (await page.inputValue('#r-qty')) === String(b));
  ok('chip Hitung fisik aktif',
    (await page.getAttribute('.modal [data-mode="opname"]', 'aria-pressed')) === 'true');
  ok('selisih 0 = cocok', /selisih 0 \(cocok\)/.test(norm(await page.innerText('#r-hint'))),
    await page.innerText('#r-hint'));

  console.log('=== E. Selisih terhitung live saat mengetik ===');
  await page.fill('#r-qty', String(b - 5));
  await page.waitForTimeout(120);
  ok(`hint menampilkan selisih -5 & stok jadi ${b - 5}`,
    new RegExp(`selisih -5 -> stok jadi ${b - 5}`).test(norm(await page.innerText('#r-hint'))),
    await page.innerText('#r-hint'));
  await page.fill('#r-qty', String(b + 3));
  await page.waitForTimeout(120);
  ok(`selisih +3 saat melebihi stok (jadi ${b + 3})`,
    new RegExp(`selisih \\+3 -> stok jadi ${b + 3}`).test(norm(await page.innerText('#r-hint'))),
    await page.innerText('#r-hint'));

  console.log('=== F. Simpan opname (0 = sah) ===');
  await page.fill('#r-qty', '');
  await page.click('.modal [data-ok]');
  ok('input kosong ditolak (tidak dianggap 0)', await page.isVisible('#r-qty'));
  await page.fill('#r-qty', '0');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  await page.fill('#st-q', 'PRD00001');
  await page.waitForTimeout(600);
  // Badge halaman Stok menulis "habis" (bukan "0") saat stok 0, dan "N / min M"
  // saat di bawah minimum — keduanya berarti angkanya memang 0. Yang persis angka
  // diperiksa lewat toast di baris berikutnya.
  const stokNol = await stokSelai();
  ok('stok jadi 0 (opname boleh 0)',
    /^0\b/.test(stokNol) || stokNol === 'habis', stokNol);
  ok('toast opname memuat angka', new RegExp(`Opname .+: ${b} -> 0 \\(-${b}\\)`).test(norm(await page.innerText('#toast-root'))),
    norm(await page.innerText('#toast-root')));

  console.log('=== G. Tanpa error runtime ===');
  ok('tidak ada pageerror/console error', errs.length === 0, errs.join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL eksekusi:', e.message);
} finally {
  // kembalikan stok seperti semula (50) lewat UI yang sama
  try {
    await bukaDialogStok();
    await page.click('.modal [data-mode="opname"]');
    await page.fill('#r-qty', '50');
    await page.click('.modal [data-ok]');
    await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
    console.log('  (stok dikembalikan ke 50)');
  } catch (e) {
    console.log('  (gagal mengembalikan stok:', e.message, ')');
  }
  await page.screenshot({ path: `${ARTIFAK}/e2e-opname.png` }).catch(() => {});
  await browser.close();
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
