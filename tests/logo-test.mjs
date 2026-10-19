// Logo struk thermal (butir ROADMAP 1.6.4, ACC pemilik 19 Okt 2026).
//
// Unggah logo di halaman Sistem (file di img/ sebelah DB, pola avatar — BUKAN
// localStorage: logo milik toko, semua device cetak sama). Raster ESC/POS
// `GS v 0` dikonversi di KLIEN (apps/web/src/logo-struk.ts) dan disisipkan di
// AWAL struk thermal semua jalur cetak. Jalur cetak yang diuji di sini:
// rekap X tutup shift (#/shifts -> [data-rekap="thermal"]) — satu-satunya jalur
// yang bisa dicetak tanpa menjual barang.
//
// PNG uji 24x8 dengan separuh kiri HITAM dipilih supaya raster bisa
// diverifikasi byte-per-byte: baris pertama = 0xFF 0xF0 0x00 (12 piksel hitam
// dari kiri pada baris 3 byte).
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

const WEB = 'http://localhost:5656';
let lolos = 0, gagal = 0;
const ok = (name, cond, info = '') => {
  if (cond) { lolos++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { gagal++; console.log('  GAGAL', name, '|', info); }
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await pasangToken(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
  const get = (path) => page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, path);
  const post = (path, body) => page.evaluate(async ([u, bd]) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [path, body]);
  // Jeda cetak MATI (pola recap-test): suite memverifikasi payload kirim —
  // route **/print di-mock, nol risiko kertas.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ravaa.printpause', '0');
      window.print = () => {};
    } catch { /* */ }
  });
  const tercetak = [];
  await page.route('**/print', async (route) => {
    try { tercetak.push(route.request().postDataJSON()?.data_base64 ?? ''); } catch { /* */ }
    await route.fulfill({ json: { ok: true, via: 'mock' } });
  });
  // fetch() butuh origin (CORS) — buka app dulu sebelum semua evaluate.
  await page.goto(`${WEB}/#/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  console.log('=== A. API logo (unggah/ambil/hapus) ===');
  // Self-heal: sisa run yang crash dibersihkan dulu — logo yang tertinggal
  // akan muncul di payload struk suite cetak lain.
  await post('/api/settings/logo', { image: '' });
  ok('self-heal: tanpa logo sebelum uji (204 tanpa body)', (await get('/api/settings/logo')).status === 204);
  ok('GET /api/settings memuat store_logo kosong',
    (await get('/api/settings')).body.data?.store_logo === '');
  ok('unggah non-dataURL ditolak 400', (await post('/api/settings/logo', { image: 'halo' })).status === 400);
  // PNG uji deterministik: 24x8, separuh kiri hitam.
  const png = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = 24;
    cv.height = 8;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 24, 8);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 12, 8);
    return cv.toDataURL('image/png');
  });
  const up = await post('/api/settings/logo', { image: png });
  const namaLogo = up.body.data?.store_logo ?? '';
  ok('unggah PNG -> nama file pola logo-*.png',
    up.status === 200 && /^logo-\d+\.png$/.test(namaLogo), `${up.status} ${namaLogo}`);
  ok('store_logo tersimpan di settings',
    (await get('/api/settings')).body.data?.store_logo === namaLogo, namaLogo);
  const unduh = await page.evaluate(async () => {
    const r = await fetch('/api/settings/logo');
    const buf = new Uint8Array(await r.arrayBuffer());
    const r304 = await fetch('/api/settings/logo', { headers: { 'if-none-match': r.headers.get('etag') ?? '' } });
    return { status: r.status, ct: r.headers.get('content-type'), etag: r.headers.get('etag'), len: buf.length, s304: r304.status };
  });
  ok('unduh publik: 200 image/png + ETag = nama file',
    unduh.status === 200 && unduh.ct === 'image/png' && unduh.etag === `"${namaLogo}"` && unduh.len > 0,
    JSON.stringify(unduh));
  ok('revalidasi If-None-Match -> 304', unduh.s304 === 304);

  console.log('=== B. UI Sistem: pratinjau + ganti + hapus ===');
  await page.goto(`${WEB}/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#set-logo-wadah', { timeout: 15000 });
  await page.waitForTimeout(600);
  ok('pratinjau logo tampil di kartu toko',
    await page.locator('#set-logo-img').count() === 1
    && await page.locator('#set-logo-hapus:not(.hidden)').count() === 1);
  const png2 = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 4;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 16, 4);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 8, 4);
    return cv.toDataURL('image/png');
  });
  await page.setInputFiles('#set-logo-file', {
    name: 'logo-baru.png', mimeType: 'image/png', buffer: Buffer.from(png2.split(',')[1], 'base64'),
  });
  await page.waitForTimeout(1400);
  const set2 = await get('/api/settings');
  ok('unggah lewat UI (input file) -> store_logo BERGANTI',
    !!set2.body.data?.store_logo && set2.body.data.store_logo !== namaLogo,
    `${namaLogo} -> ${set2.body.data?.store_logo}`);
  await page.click('#set-logo-hapus');
  await page.waitForTimeout(1100);
  ok('hapus lewat UI -> placeholder "Belum ada logo" + tombol hapus hilang',
    await page.locator('#set-logo-img').count() === 0
    && ((await page.textContent('#set-logo-wadah')) ?? '').includes('Belum ada logo')
    && await page.locator('#set-logo-hapus.hidden').count() === 1);
  ok('setelah hapus: GET /api/settings/logo -> 204', (await get('/api/settings/logo')).status === 204);

  console.log('=== C. Cetak: raster di AWAL struk thermal (rekap X) ===');
  // Shift uji SENDIRI (pola recap-test) — tidak menyentuh shift milik runner,
  // dan ditutup lagi di section D supaya run berikutnya bersih.
  const KASIR = `logo-uji-${Date.now().toString(36)}`;
  const sh = await post('/api/shifts/open', { modal_awal: 50000, cashier: KASIR });
  const shiftId = sh.body.data?.id;
  ok('shift uji terbuka', Number.isInteger(shiftId), String(shiftId));
  // Rekam STATUS respons endpoint logo: saat belum ada logo endpoint WAJIB
  // menjawab 204 (bukan 404) — entri "Failed to load resource" di console
  // diam-diam memerahkan suite e2e yang menjaga "tanpa error console" (nyata:
  // 4 suite crash pada percobaan pertama sebelum kontrak 204 diterapkan).
  const logoStatus = [];
  page.on('response', (r) => { if (r.url().includes('/api/settings/logo')) logoStatus.push(r.status()); });
  const bukaRekap = async () => {
    await page.waitForSelector('#sh-body', { timeout: 15000 });
    await page.waitForTimeout(700);
    await page.locator(`#sh-body tbody tr[data-shift="${shiftId}"] [data-tutup]`).click();
    await page.waitForTimeout(500);
    await page.click('[data-rekap="thermal"]');
    await page.waitForTimeout(1500);
  };
  await page.goto(`${WEB}/#/shifts`, { waitUntil: 'networkidle' });
  logoStatus.length = 0; // B sempat memuat pratinjau <img> — hitung dari sini
  await bukaRekap();
  ok('tanpa logo: endpoint logo menjawab 204 (bukan 404) — console bersih',
    logoStatus.length === 1 && logoStatus[0] === 204, `status=${logoStatus.join(',')}`);
  const bytes0 = [...Buffer.from(tercetak[0] ?? '', 'base64')];
  const raster0 = bytes0.findIndex((_, i) =>
    bytes0[i] === 0x1d && bytes0[i + 1] === 0x76 && bytes0[i + 2] === 0x30 && bytes0[i + 3] === 0x00);
  ok('tanpa logo: payload tetap struk lama (tanpa raster)', tercetak.length === 1 && raster0 === -1, `idx=${raster0}`);
  // Unggah logo, lalu RELOAD (cache raster per sesi halaman — pola device yang
  // membuka POS setelah owner mengunggah logo).
  const up2 = await post('/api/settings/logo', { image: png });
  ok('logo uji terpasang kembali (untuk uji cetak)', up2.status === 200, up2.body.data?.store_logo);
  await page.reload({ waitUntil: 'networkidle' });
  await bukaRekap();
  const bytes = [...Buffer.from(tercetak[1] ?? '', 'base64')];
  const awal = bytes.findIndex((_, i) =>
    bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30 && bytes[i + 3] === 0x00);
  ok('raster GS v 0 disisipkan di awal struk (byte ke-5)',
    tercetak.length === 2 && awal === 5, `req=${tercetak.length} idx=${awal}`);
  // Header: 1d 76 30 00 | xL=24 xH=0 | yL=8 yH=0; data 8 baris x 3 byte,
  // tiap baris 12 piksel hitam dari kiri = 0xFF 0xF0 0x00.
  const head = bytes.slice(5, 13).join(',');
  const dataHarap = [...Array(8)].flatMap(() => [0xff, 0xf0, 0x00]).join(',');
  ok('dimensi 24x8 + data baris 0xFF 0xF0 0x00 (12 piksel hitam kiri)',
    head === '29,118,48,0,24,0,8,0' && bytes.slice(13, 13 + 24).join(',') === dataHarap,
    `${head} | ${bytes.slice(13, 19).join(',')}`);
  const teks = Buffer.from(tercetak[1] ?? '', 'base64').toString('binary')
    .split('').filter((ch) => { const c = ch.charCodeAt(0); return c === 10 || (c >= 32 && c < 127); }).join('');
  ok('teks rekap tetap utuh setelah raster',
    teks.includes('REKAP SEMENTARA') && teks.includes('Kas seharusnya'), teks.replace(/\s+/g, ' ').slice(0, 70));

  console.log('=== D. Bersih-bersih ===');
  const tutup = await post(`/api/shifts/${shiftId}/close`, { modal_akhir: 50000 });
  ok('shift uji ditutup lagi (tidak mengganggu suite lain)', tutup.status === 200, String(tutup.status));
  await post('/api/settings/logo', { image: '' });
  ok('logo dihapus lagi (sisa suite bersih)',
    (await get('/api/settings/logo')).status === 204);
  ok('tidak ada pageerror', errs.length === 0, errs.join(' ~ '));

  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} === (lolos: ${lolos}, gagal: ${gagal})`);
  if (gagal > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
