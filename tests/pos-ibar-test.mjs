// Warna tombol kembali (⬅ chevL) di info bar BIRU POS `.pos-ibar-biru` —
// permintaan pemilik 2026-10-18: *"pada POS <svg …chevron…> biarkan tetap
// putih pada light mode"*. Sebelumnya `.icon-btn` bersama di tema terang
// berwarna gray-600 — di atas bar biru chevron nyaris tak terlihat.
// Kontrak yang dijaga:
//   - bar biru tampil SAMA di kedua tema -> chevron putih di light DAN dark;
//   - hover tidak jatuh ke gaya bawaan .icon-btn (gray-100 + gray-900 —
//     putih di atas abu terang = hilang lagi saat disentuh); tetap putih
//     dengan latar putih/15;
//   - tombol ⬅ header MOBILE (.pm-headrow, latar putih) SENGAJA tidak ikut
//     putih (akan tak terlihat) — aturan hanya menyasar `.pos-ibar-biru`.
//   - tombol "Tutup shift" (.pos-tutup, revisi pemilik 19 Okt 2026: "warna
//     merahnya buat menyala agar lebih mudah di lihat") = gradasi merah
//     SOLID + teks putih di KEDUA tema; versi lama merah transparan
//     (red-500/20) nyaris menyatu dengan bar biru. Lihat seksi D.
// Jalankan: node pos-ibar-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

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
const p = await ctx.newPage();
await pasangToken(p);
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

/** Baca warna tombol ⬅ info bar + latarnya. */
const bacaBar = () => p.evaluate(() => {
  const bar = document.querySelector('.pos-ibar-biru');
  const btn = bar?.querySelector('.icon-btn');
  const svg = btn?.querySelector('svg');
  if (!bar || !btn || !svg) return null;
  const g = getComputedStyle(btn);
  return {
    tema: document.documentElement.dataset.theme,
    bgBar: getComputedStyle(bar).backgroundImage,
    warna: g.color,
    bgTombol: g.backgroundColor,
  };
});

try {
  // ——— A. tema terang (default device) ———
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.pos-ibar-biru .icon-btn', { timeout: 15000 });
  await p.waitForTimeout(400);

  const terang = await bacaBar();
  chk('info bar: gradasi BIRU (latar yang menuntut chevron putih)',
    !!terang && terang.bgBar.includes('linear-gradient') && terang.bgBar.includes('rgb(15, 40, 88)'),
    terang ? terang.bgBar.slice(0, 90) : 'bar tak ditemukan');

  chk('light: chevron tombol ⬅ PUTIH',
    !!terang && terang.warna === 'rgb(255, 255, 255)', terang ? terang.warna : '');
  chk('light: tema yang diuji memang light',
    !!terang && terang.tema === 'light', terang ? terang.tema : '');

  await p.hover('.pos-ibar-biru .icon-btn');
  await p.waitForTimeout(320); // transition .icon-btn selesai
  const hoverT = await bacaBar();
  chk('light hover: tetap putih + latar putih/15 (bukan gray-100 bawaan)',
    !!hoverT && hoverT.warna === 'rgb(255, 255, 255)'
      && /\/\s*0\.15\)/.test(hoverT.bgTombol) && !hoverT.bgTombol.includes('243, 244, 246'),
    hoverT ? `${hoverT.warna} / ${hoverT.bgTombol}` : '');

  // ——— B. tema gelap (bar biru identik) ———
  await p.evaluate(() => localStorage.setItem('ravaa.theme', 'dark'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('.pos-ibar-biru .icon-btn', { timeout: 15000 });
  await p.waitForTimeout(400);

  const gelap = await bacaBar();
  chk('dark: chevron tetap PUTIH (bar sama di kedua tema)',
    !!gelap && gelap.tema === 'dark' && gelap.warna === 'rgb(255, 255, 255)',
    gelap ? `${gelap.tema} / ${gelap.warna}` : '');

  await p.hover('.pos-ibar-biru .icon-btn');
  await p.waitForTimeout(320);
  const hoverG = await bacaBar();
  chk('dark hover: tetap putih + latar putih/15 (bukan gray-700 bawaan)',
    !!hoverG && hoverG.warna === 'rgb(255, 255, 255)' && /\/\s*0\.15\)/.test(hoverG.bgTombol),
    hoverG ? `${hoverG.warna} / ${hoverG.bgTombol}` : '');

  // ——— C. guard: header MOBILE tidak ikut terdampak ———
  // Header mobile ber-latar PUTIH di tema terang; kalau aturan menimpa semua
  // .icon-btn, chevron ⬅-nya jadi putih-di-atas-putih (tak terlihat).
  await p.evaluate(() => {
    localStorage.setItem('ravaa.theme', 'light');
    localStorage.setItem('ravaa.mobile-layout', '1');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('.pm-headrow > .icon-btn', { timeout: 15000 });
  await p.waitForTimeout(300);
  const mob = await p.evaluate(() => {
    const btn = document.querySelector('.pm-headrow > .icon-btn');
    return btn ? { warna: getComputedStyle(btn).color } : null;
  });
  chk('mobile: tombol ⬅ header TIDAK ikut putih (latar putih — tetap abu .icon-btn)',
    !!mob && mob.warna !== 'rgb(255, 255, 255)', mob ? mob.warna : 'tombol tak ditemukan');

  // ——— D. tombol "Tutup shift": MERAH MENYALA ———
  // Revisi pemilik 19 Okt 2026: *"warna merahnya buat menyala agar lebih
  // mudah di lihat"* — versi lama merah transparan (red-500/20) nyaris
  // menyatu dengan bar biru. Kontrak: gradasi merah solid (.pos-tutup, pola
  // .pos-paypas) + teks PUTIH di KEDUA tema; hover menggelap. Posisi tetap di
  // kolom kiri info bar (konteks sesi Waktu/Kasir/Shift).
  await p.evaluate(() => {
    localStorage.setItem('ravaa.theme', 'light');
    localStorage.setItem('ravaa.mobile-layout', '0');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('.pos-ibar-biru #pos-shift-tutup', { timeout: 15000 });
  await p.waitForTimeout(400);
  const bacaTutup = () => p.evaluate(() => {
    const b = document.querySelector('.pos-ibar-biru #pos-shift-tutup');
    if (!b) return null;
    const g = getComputedStyle(b);
    return { warna: g.color, grad: g.backgroundImage, adaKelas: b.classList.contains('pos-tutup') };
  });
  const tutupT = await bacaTutup();
  // Warna acuan (terukur di Chrome): oklch(0.637 0.237 25.331) = red-500,
  // oklch(0.577 0.245 27.325) = red-600, oklch(0.505 0.213 27.518) = red-700
  // — format oklch itulah yang dikomputasi browser dari @apply gradient.
  chk('light: Tutup shift MERAH MENYALA (kelas .pos-tutup + gradasi red-500)',
    !!tutupT && tutupT.adaKelas && /linear-gradient/.test(tutupT.grad)
      && tutupT.grad.includes('oklch(0.637 0.237 25.331)'),
    tutupT ? `${tutupT.adaKelas} / ${tutupT.grad.slice(0, 90)}` : '');
  chk('light: teks Tutup shift PUTIH (kontras di atas merah)',
    !!tutupT && tutupT.warna === 'rgb(255, 255, 255)', tutupT ? tutupT.warna : '');
  await p.hover('.pos-ibar-biru #pos-shift-tutup');
  await p.waitForTimeout(350);
  const tutupH = await bacaTutup();
  chk('light hover: gradasi menggelap ke red-600 → red-700 (tetap menyala saat disentuh)',
    !!tutupH && tutupH.grad.includes('oklch(0.577 0.245 27.325) 0%')
      && tutupH.grad.includes('oklch(0.505 0.213 27.518)'),
    tutupH ? tutupH.grad.slice(0, 90) : '');
  await p.evaluate(() => { localStorage.setItem('ravaa.theme', 'dark'); });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('.pos-ibar-biru #pos-shift-tutup', { timeout: 15000 });
  await p.waitForTimeout(400);
  const tutupG = await bacaTutup();
  chk('dark: tetap MERAH MENYALA + teks putih (bar sama di kedua tema)',
    !!tutupG && tutupG.warna === 'rgb(255, 255, 255)' && tutupG.grad.includes('oklch(0.637 0.237 25.331)'),
    tutupG ? `${tutupG.warna} / ${tutupG.grad.slice(0, 90)}` : '');
  await p.evaluate(() => { localStorage.setItem('ravaa.theme', 'light'); });
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

console.log(`pageerror: ${errs.length ? errs.join(' || ') : 'TANPA'}`);
if (errs.length) gagal++;
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
