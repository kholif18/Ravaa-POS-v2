// Kategori punya saklar "Gunakan tanggal kadaluarsa" (`categories.use_expiry`)
// yang mengatur apakah form produk menampilkan kolom "Tanggal kadaluarsa".
// Dulu aturan ini hardcode snack/eskrim di klien — sekarang data di server, jadi
// diuji end-to-end: centang di form Kategori -> API -> form produk.
// Jalankan: node kategori-expiry-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
// Slug yang sengaja disentuh: seed menyalakannya 0 (ATK) dan 1 (Snack), jadi
// kedua arah perubahan teruji, dan di akhir dikembalikan persis seperti seed.
const KAT_0 = 'atk';
const KAT_1 = 'snack';
const KAT_MATI = 'cetak';

const get = (u) => fetch(API + u).then((r) => r.json());
const post = (u, body) =>
  fetch(API + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

const useExpiry = async (slug) => {
  const d = (await get('/api/categories')).data;
  return d.find((c) => c.slug === slug)?.use_expiry;
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

// Pengaman: kalau run sebelumnya tertahan di tengah, jangan mewarisi nilai liar.
await post('/api/categories', { slug: KAT_0, name: 'ATK', track_stock: 1, use_expiry: 0, sort: 10 });

try {
  console.log('=== A. Form Kategori memuat centang "Gunakan tanggal kadaluarsa" ===');
  await page.goto(`${WEB}/#/products`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.click(`[data-cat-edit="${KAT_0}"]`);
  await page.waitForSelector('.modal #c-exp', { timeout: 8000 });
  ok('ada checkbox "Gunakan tanggal kadaluarsa"', await page.isVisible('.modal #c-exp'));
  const teks = norm(await page.innerText('.modal'));
  ok('jelaskan efeknya untuk form produk', /Tanggal kadaluarsa/.test(teks)
    && /form produk/.test(teks), teks.slice(0, 200));
  ok(`awal sesuai seed (${KAT_0} = mati)`, !(await page.isChecked('.modal #c-exp')));
  ok('checkbox pelacakan stok tetap ada', await page.isVisible('.modal #c-track'));

  console.log('=== B. Centang -> tersimpan ke server ===');
  await page.check('.modal #c-exp');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  await page.waitForTimeout(800);
  const toast = norm(await page.innerText('#toast-root').catch(() => ''));
  ok('toast simpan kategori', /Kategori diperbarui|ditambahkan/.test(toast), toast);
  ok('API: use_expiry kini 1', (await useExpiry(KAT_0)) === 1, `=${await useExpiry(KAT_0)}`);

  console.log('=== C. Form produk mengikuti pengaturan kategori ===');
  await page.click('#prod-new');
  await page.waitForSelector('.modal #f-name', { timeout: 8000 });
  await page.waitForTimeout(400);
  // Kategori pertama di dropdown = KAT_0 (urutan `sort`).
  ok(`kategori awal ${KAT_0} (sudah dinyalakan) -> kolom Tanggal kadaluarsa TAMPIL`,
    await page.isVisible('.modal #f-exp-wrap'));
  ok('hint kolom kadaluarsa terisi', norm(await page.innerText('.modal #f-exp-hint')).length > 10,
    norm(await page.innerText('.modal #f-exp-hint')));

  await page.selectOption('.modal #f-cat', KAT_MATI);
  await page.waitForTimeout(300);
  ok(`pindah ke ${KAT_MATI} (mati) -> kolom DISEMBUNYIKAN`, !(await page.isVisible('.modal #f-exp-wrap')));

  await page.selectOption('.modal #f-cat', KAT_1);
  await page.waitForTimeout(300);
  ok(`pindah ke ${KAT_1} (seed nyala) -> kolom TAMPIL lagi`, await page.isVisible('.modal #f-exp-wrap'),
    'bukti aturan datang dari server, bukan hardcode');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });

  console.log('=== D. Matikan lagi lewat UI -> form produk ikut ===');
  await page.click(`[data-cat-edit="${KAT_0}"]`);
  await page.waitForSelector('.modal #c-exp', { timeout: 8000 });
  ok('centang terbuka kembali TERCENTANG (nilai dari server)', await page.isChecked('.modal #c-exp'));
  await page.uncheck('.modal #c-exp');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  await page.waitForTimeout(800);
  ok('API kembali 0', (await useExpiry(KAT_0)) === 0, `=${await useExpiry(KAT_0)}`);
  await page.click('#prod-new');
  await page.waitForSelector('.modal #f-name', { timeout: 8000 });
  await page.waitForTimeout(400);
  ok(`kategori ${KAT_0} (mati) -> kolom DISEMBUNYIKAN`, !(await page.isVisible('.modal #f-exp-wrap')));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });

  ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  // Rapikan: nilai kedua kategori persis seperti seed (ATK mati, Snack nyala).
  await post('/api/categories', { slug: KAT_0, name: 'ATK', track_stock: 1, use_expiry: 0, sort: 10 });
  await post('/api/categories', { slug: KAT_1, name: 'Snack', track_stock: 1, use_expiry: 1, sort: 70 });
  await browser.close();
  const nama = fileURLToPath(import.meta.url).split('/').pop();
  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [${nama}]`);
  if (gagal) process.exit(1);
}
