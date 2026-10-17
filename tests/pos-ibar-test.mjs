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
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

console.log(`pageerror: ${errs.length ? errs.join(' || ') : 'TANPA'}`);
if (errs.length) gagal++;
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
