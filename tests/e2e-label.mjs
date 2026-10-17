// E2E halaman Label harga -> LEMBAR A4/Folio via CETAK BROWSER (refactor
// 2026-10-17, disetujui pemilik). Jalankan: node e2e-label.mjs
//   (API :3001 + vite :5656 hidup; runner menyiapkan token + shift)
//
// Beda dari suite lama: TIDAK ADA print-agent di sini. Label tidak lagi lewat
// ESC/POS :9100 (itu jalur struk) — `cetakLabel()` membuka TAB BARU berisi
// dokumen @page mm lalu window.print(). Karena itu alur cetak diuji lewat
// waitForEvent('popup') + isi dokumennya, bukan byte file printer.
//
// Produk uji `UJI-LABEL-BC` (EAN-13 CHECKSUM VALID 5901234123457 — barcode
// invalid SENGAJA tidak digambar, aturan itu diuji labelsheet-test.ts) dan
// `UJILBLSK` (TANPA barcode — menguji fallback SKU jadi Code 128, aturan
// pemilik 2026-10-17 "barcode pilihan pertama, SKU bagi produk yang tidak
// memiliki barcode"). Dibuat lewat API, dibuang KERAS lewat sqlite3 di akhir
// (pola product-delete-test.mjs; bukan soft delete agar DB pemilik bersih).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
import fs from 'node:fs';
import { pasangToken } from './bantuan-uji.mjs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFAK = path0.join(REPO, 'tests/artifacts');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const SKU = 'UJI-LABEL-BC';
const SKU2 = 'UJILBLSK'; // 8 char — muat Code 128 di label 62 mm

/** Bersih-bersih artefak suite ini SAJA (nama eksak, bukan prefix). */
const cleanupDB = () => {
  try {
    execFileSync('sqlite3', [DB,
      `DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE sku IN ('${SKU}', '${SKU2}')); ` +
      `DELETE FROM products WHERE sku IN ('${SKU}', '${SKU2}');`]);
  } catch { /* DB terkunci sesaat: run berikutnya menimpa via upsert SKU */ }
};

let lolos = 0, gagal = 0;
const ok = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const API = 'http://localhost:3001';
const jpost = async (p, b, m = 'POST') => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};

// Self-heal sisa run yang crash, lalu buat produk uji segar. POST SKU yang
// sama = upsert (revive tombstone sekalipun), jadi state selalu terdefinisi.
cleanupDB();
const buat = await jpost('/api/products', {
  sku: SKU, name: 'UjiLabel Barcode', category_slug: 'atk', unit: 'pcs',
  price: 4321, cost: 3000, markup: 44, stock: 0, is_active: 1, barcode: '5901234123457',
});
if (buat.s !== 200 && buat.s !== 201) {
  console.log(`GAGAL setup: POST /api/products ${buat.s} ${JSON.stringify(buat.j)}`);
  process.exit(1);
}
// Produk kedua TANPA barcode (fallback SKU -> Code 128); sengaja tanpa field
// `barcode` supaya server menyimpannya null seperti produk kebanyakan.
const buat2 = await jpost('/api/products', {
  sku: SKU2, name: 'UjiLabel SKU', category_slug: 'atk', unit: 'pcs',
  price: 4321, cost: 3000, markup: 44, stock: 0, is_active: 1,
});
if (buat2.s !== 200 && buat2.s !== 201) {
  console.log(`GAGAL setup: POST /api/products ${buat2.s} ${JSON.stringify(buat2.j)}`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await pasangToken(page);
// Catatan: `ravaa.printpause` SENGAJA tidak disetel — bagian D menguji dulu
// perilaku bawaan (JEDA), baru dinyalakan lewat localStorage di tengah test.
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
let popupCount = 0;
page.on('popup', () => { popupCount++; });

try {
  await page.goto('http://localhost:5656/#/labels', { waitUntil: 'load' });
  await page.waitForSelector('#lb-cetak', { timeout: 20000 });
  // Keranjang DEFAULT KOSONG (permintaan pemilik 2026-10-17) -> tunggu
  // empty-state keranjang + produk termuat (server/cache) supaya
  // "Pilih yang tampil (n)" sudah berhitung saat diklik nanti.
  await page.waitForSelector('#lb-dipilih p', { timeout: 20000 });
  await page.waitForFunction(
    () => /\([1-9]\d*\)/.test(document.querySelector('#lb-pilih')?.textContent ?? ''),
    { timeout: 20000 },
  );
  await page.waitForTimeout(300);

  console.log('=== A. Halaman lembar label (full-page) ===');
  ok('alat cetak terbuka (bukan dialog lama)', await page.isVisible('#lb-cetak'));
  const kmb = norm(await page.innerText('header a[href="#/products"]'));
  ok('header punya tombol kembali ke Produk', kmb.includes('Produk'), kmb);
  ok('full-page: tanpa sidebar kiri', !(await page.locator('.sidebar').count()));
  const info = norm(await page.innerText('#lb-info'));
  ok('default KOSONG saat buka — tidak memilih semua produk otomatis (permintaan pemilik)',
    info === 'Belum ada produk dicentang', info);
  ok('keranjang kosong tanpa baris terpilih',
    await page.locator('#lb-dipilih [data-hapus]').count() === 0
      && norm(await page.innerText('#lb-dipilih')).includes('Belum ada produk terpilih'));
  ok('chip "Cetak dijeda" tampil (pause bawaan menyala)', await page.isVisible('#lb-jeda'));
  const teksTombol = norm(await page.innerText('#lb-cetak'));
  ok('tombol cetak memuat jumlah', /^Cetak \d+ label$/.test(teksTombol), teksTombol);

  console.log('=== B. Setelan -> pratinjau live ===');
  // Strip `#lb-info` default kosong; info tata letak ada di `#lb-lt-info`.
  const lt0 = norm(await page.innerText('#lb-lt-info'));
  ok('A4 bawaan: 24/lembar (8 baris x 3 kolom)', lt0.includes('24/lembar'), lt0);
  await page.fill('#lb-kolom', '2');
  await page.waitForTimeout(250);
  const lt = norm(await page.innerText('#lb-lt-info'));
  ok('kolom 2 -> 16/lembar', lt.includes('16/lembar'), lt);
  ok('lebar label ikut dihitung (2 kolom -> 94.0 mm)', lt.includes('94.0 mm'), lt);
  await page.fill('#lb-kolom', '3');
  await page.waitForTimeout(250);
  ok('kembali 3 kolom -> 24/lembar',
    norm(await page.innerText('#lb-lt-info')).includes('24/lembar'));

  console.log('=== C. Produk uji + pilih (barcode valid) ===');
  // Permintaan pemilik 2026-10-17: hasil pencarian = DROPDOWN (klik opsi =
  // masuk keranjang "Produk terpilih" — teknis keranjang belanja); kotak
  // bawah = yang terpilih saja + ikon hapus. Keranjang DEFAULT KOSONG
  // (revisi 2026-10-17: jangan auto-centang semua produk saat mount).
  const chipN = Number((norm(await page.innerText('#lb-terpilih')).match(/^(\d+)/) || [0])[1]);
  const trashN = await page.locator('#lb-dipilih [data-hapus]').count();
  ok('dropdown tersembunyi sebelum mencari',
    await page.locator('#lb-hasil').isHidden()
      && await page.locator('#lb-hasil [data-pilih]').count() === 0);
  ok('keranjang tetap kosong sebelum user memilih (0 chip = 0 baris)',
    trashN === 0 && chipN === 0, `baris=${trashN} chip=${chipN}`);

  await page.fill('#lb-q', SKU);
  await page.waitForTimeout(350);
  ok('cari SKU uji -> dropdown 1 hasil + terbuka',
    await page.locator('#lb-hasil [data-pilih]').count() === 1
      && await page.locator('#lb-hasil').isVisible());
  // Ikon opsi WAJIB berukuran (icon() tanpa width/height — tanpa rule ukuran
  // di konteksnya SVG jadi 0px dan tak terlihat; bug nyata ditemukan 2026-10-17).
  const opsiSvg = await page.locator('#lb-hasil [data-pilih] svg').first().boundingBox();
  ok('ikon opsi dropdown tampil (bukan 0px)', opsiSvg !== null && opsiSvg.width >= 12,
    JSON.stringify(opsiSvg));

  await page.click('#lb-kosong');
  await page.waitForTimeout(200);
  ok('Kosongkan -> 0 dipilih + tombol mati',
    norm(await page.innerText('#lb-terpilih')) === '0 dipilih' && await page.locator('#lb-cetak').isDisabled());
  ok('ringkas ikut kosong', norm(await page.innerText('#lb-info')) === 'Belum ada produk dicentang');
  ok('keranjang kosong + petunjuk',
    (await page.innerText('#lb-dipilih')).includes('Belum ada produk terpilih'));

  await page.click('#lb-pilih');
  await page.waitForTimeout(300);
  ok('Pilih yang tampil -> 1 dipilih + tombol hidup',
    norm(await page.innerText('#lb-terpilih')) === '1 dipilih' && !(await page.locator('#lb-cetak').isDisabled()));
  ok('tombol jadi "Cetak 1 label"', norm(await page.innerText('#lb-cetak')) === 'Cetak 1 label');
  ok('keranjang terisi 1 baris', await page.locator('#lb-dipilih [data-hapus]').count() === 1);
  const infoIsi = norm(await page.innerText('#lb-info'));
  ok('strip info terisi: jumlah label · halaman · kertas · per lembar',
    /^1 label · 1 halaman · A4 \(210 × 297 mm\) · 24\/lembar$/.test(infoIsi), infoIsi);

  ok('pratinjau: 1 lembar', await page.locator('#lb-zoom .lb-lembar').count() === 1);
  const lbl = page.locator('#lb-zoom .lb-label').first();
  ok('pratinjau: 1 label', await page.locator('#lb-zoom .lb-label').count() === 1);
  const isi = norm(await lbl.innerText());
  ok('label memuat nama', isi.includes('UjiLabel Barcode'), isi);
  ok('label memuat harga', isi.includes('Rp4.321'), isi);
  ok('tanpa kaki SKU · satuan (dihapus 2026-10-17 — SKU tampil di barcode)',
    await lbl.locator('.lb-kaki').count() === 0);
  ok('barcode EAN-13 valid digambar sebagai SVG', await lbl.locator('.lb-barcode svg').count() === 1);

  console.log('=== C2. Produk TANPA barcode -> SKU jadi Code 128 ===');
  // Aturan pemilik 2026-10-17: "barcode pilihan pertama, SKU bagi produk yang
  // tidak memiliki barcode" — diuji dengan produk uji `UJILBLSK`.
  await page.fill('#lb-q', SKU2);
  await page.waitForTimeout(350);
  ok('cari SKU tanpa barcode -> dropdown 1 hasil + terbuka',
    await page.locator('#lb-hasil [data-pilih]').count() === 1
      && await page.locator('#lb-hasil').isVisible());
  await page.click('#lb-hasil [data-pilih]');
  await page.waitForTimeout(250);
  ok('klik -> keranjang jadi 2 baris',
    norm(await page.innerText('#lb-terpilih')) === '2 dipilih'
      && await page.locator('#lb-dipilih [data-hapus]').count() === 2);
  const lblSku = page.locator('#lb-zoom .lb-label').filter({ hasText: 'UjiLabel SKU' });
  ok('label tanpa barcode: SKU digambar sebagai Code 128 (SVG + angka SKU)',
    await lblSku.locator('.lb-barcode svg').count() === 1
      && norm(await lblSku.locator('.lb-barcode-num').innerText()) === SKU2);
  await page.locator('#lb-dipilih [data-dipilih]').filter({ hasText: 'UjiLabel SKU' })
    .locator('[data-hapus]').click();
  await page.waitForTimeout(250);
  ok('hapus baris kedua -> kembali 1 dipilih',
    norm(await page.innerText('#lb-terpilih')) === '1 dipilih'
      && await page.locator('#lb-dipilih [data-hapus]').count() === 1);
  await page.fill('#lb-q', SKU); // pulihkan query untuk langkah berikutnya
  await page.waitForTimeout(200);

  // Ikon hapus: 1 produk dibuang dari keranjang -> kosong, lalu ditambah
  // balik lewat dropdown (klik opsi = masuk keranjang).
  await page.click('#lb-dipilih [data-hapus]');
  await page.waitForTimeout(250);
  ok('ikon hapus -> 0 dipilih + keranjang kosong + tombol mati',
    norm(await page.innerText('#lb-terpilih')) === '0 dipilih'
      && await page.locator('#lb-cetak').isDisabled()
      && (await page.innerText('#lb-dipilih')).includes('Belum ada produk terpilih'));
  await page.click('#lb-q'); // fokus balik -> dropdown terbuka lagi
  await page.click('#lb-hasil [data-pilih]');
  await page.waitForTimeout(250);
  ok('klik hasil dropdown -> masuk keranjang + tanda terdaftar',
    norm(await page.innerText('#lb-terpilih')) === '1 dipilih'
      && await page.locator('#lb-dipilih [data-hapus]').count() === 1
      && await page.locator('#lb-hasil [data-pilih]').getAttribute('aria-selected') === 'true');
  await page.click('#lb-hasil [data-pilih]');
  await page.waitForTimeout(200);
  ok('klik ulang opsi terdaftar tidak menggandakan',
    norm(await page.innerText('#lb-terpilih')) === '1 dipilih'
      && await page.locator('#lb-dipilih [data-hapus]').count() === 1);

  // Regresi 2026-10-18 (laporan pemilik "sudah saya klik produknya kok tidak
  // terpilih"): klik LAMBAT — tombol ditahan > 150ms — dulu timer blur
  // menyembunyikan dropdown sebelum click sampai, jadi klik hilang. Kini
  // mousedown opsi preventDefault (input tidak blur) sehingga tetap terpilih.
  await page.click('#lb-kosong');
  await page.waitForTimeout(200);
  await page.fill('#lb-q', SKU);
  await page.waitForTimeout(300);
  const opsiLambat = await page.locator('#lb-hasil [data-pilih]').first().boundingBox();
  await page.mouse.move(opsiLambat.x + opsiLambat.width / 2, opsiLambat.y + opsiLambat.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300); // > 150ms: dulu dropdown keburu tersembunyi di sini
  await page.mouse.up();
  await page.waitForTimeout(250);
  ok('klik lambat (tombol ditahan >150ms) tetap masuk keranjang',
    norm(await page.innerText('#lb-terpilih')) === '1 dipilih'
      && await page.locator('#lb-dipilih [data-hapus]').count() === 1);

  console.log('=== D. Cetak: jeda dulu, lalu popup browser ===');
  await page.click('#lb-cetak');
  await page.waitForSelector('#toast-root .toast', { timeout: 8000 });
  const toast1 = norm(await page.innerText('#toast-root'));
  ok('pause bawaan: klik cetak DITOLAK toast "dijeda"', /dijeda/i.test(toast1), toast1);
  await page.waitForTimeout(900);
  ok('pause: tidak ada popup terbuka', popupCount === 0, `popup=${popupCount}`);

  await page.evaluate(() => localStorage.setItem('ravaa.printpause', '0'));
  // Promise.all WAJIB: popup `window.open` di dalam handler klik bisa terbuka
  // sebelum waitForEvent menempel kalau klik di-await duluan (event hilang).
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 8000 }),
    page.click('#lb-cetak'),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  ok('popup cetak terbuka', popupCount === 1, `popup=${popupCount}`);
  ok('judul dokumen = Label harga', (await popup.title()) === 'Label harga');
  ok('dokumen: 1 lembar', await popup.locator('.lb-lembar').count() === 1);
  ok('dokumen: 1 label', await popup.locator('.lb-label').count() === 1);
  const adaPage = await popup.evaluate(() =>
    Array.from(document.querySelectorAll('style')).some((s) => s.textContent.includes('@page')));
  ok('dokumen memuat aturan @page (ukuran kertas)', adaPage);
  ok('dokumen memuat barcode SVG', await popup.locator('.lb-barcode svg').count() === 1);
  const toast2 = norm(await page.innerText('#toast-root'));
  ok('toast sukses memuat "1 label (1 halaman)"', toast2.includes('1 label (1 halaman)'), toast2);
  await popup.close();

  console.log('=== E. Salinan N kali ===');
  await page.click('#lb-salinan-plus');
  await page.waitForTimeout(300);
  ok('salinan 2: input + tombol + pratinjau ikut',
    (await page.inputValue('#lb-salinan')) === '2'
      && norm(await page.innerText('#lb-cetak')) === 'Cetak 2 label'
      && await page.locator('#lb-zoom .lb-label').count() === 2);
  await page.click('#lb-salinan-minus');
  await page.waitForTimeout(300);
  ok('salinan kembali 1', (await page.inputValue('#lb-salinan')) === '1'
    && await page.locator('#lb-zoom .lb-label').count() === 1);

  console.log('=== F. Setelan tersimpan per device ===');
  await page.fill('#lb-kolom', '2');
  await page.waitForTimeout(250);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#lb-kolom', { timeout: 20000 });
  ok('reload -> kolom tetap 2 (localStorage ravaa.label)',
    (await page.inputValue('#lb-kolom')) === '2');

  console.log('=== G. Tanpa error runtime ===');
  ok('tidak ada pageerror/console error', errs.length === 0, errs.join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL eksekusi:', e.message);
} finally {
  fs.mkdirSync(ARTIFAK, { recursive: true });
  await page.screenshot({ path: `${ARTIFAK}/e2e-label.png`, fullPage: false }).catch(() => {});
  await browser.close();
  cleanupDB();
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
