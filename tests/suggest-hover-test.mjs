// Warna hover/aktif dropdown hasil cari `.suggest-item` (POS) — permintaan
// pemilik 2026-10-19: *"pada hover silakan di pertajam warnanya, di LCD
// kurang terlihat"*. Sebelumnya gray-100 (#f3f4f6) / gray-700-60% nyaris tak
// terbaca di panel LCD; kini tint primer `--color-primary` (light 25%, dark 30%).
// Kontrak yang dijaga:
//   - hover DAN is-active memakai tint SAMA (satu aturan, state murni);
//   - item tanpa hover/aktif TIDAK berlatar (highlight bukan hiasan tetap);
//   - berlaku di kedua tema; nilai lama (gray) tidak boleh kembali.
// Jalankan: node tests/suggest-hover-test.mjs (butuh API :3001 + vite :5656 hidup)
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

/** Muat ulang POS (WAJIB reload — goto URL sama tak boot ulang, tema tak
 *  ikut berpindah) lalu baca tema + latar item 0..2 dropdown hasil cari 'a'. */
const muatDanBaca = async () => {
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForSelector('#pos-q', { timeout: 15000 });
  await p.fill('#pos-q', 'a');
  await p.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await p.waitForTimeout(200);
  await p.hover('#pos-results .suggest-item >> nth=1');
  await p.waitForTimeout(320); // transition .suggest-item selesai
  return p.evaluate(() => ({
    tema: document.documentElement.dataset.theme,
    bg: [...document.querySelectorAll('#pos-results .suggest-item')]
      .slice(0, 3).map((el) => getComputedStyle(el).backgroundColor),
  }));
};

try {
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' }); // navigasi awal

  // ——— A. tema terang (default device) ———
  const a = await muatDanBaca();
  chk('light: hover item -> tint primer 25% (bukan gray-100 lama)',
    a.tema === 'light' && /0?\.25\)/.test(a.bg[1]) && !a.bg[1].includes('243, 244, 246'),
    `${a.tema} / ${a.bg[1]}`);
  chk('light: item is-active -> tint 25% yang sama', /0?\.25\)/.test(a.bg[0]), a.bg[0]);
  chk('light: item tanpa hover/aktif tetap transparan',
    /rgba\(0, 0, 0, 0\)|transparent/.test(a.bg[2]), a.bg[2]);

  // ——— B. tema gelap ———
  await p.evaluate(() => localStorage.setItem('ravaa.theme', 'dark'));
  const b = await muatDanBaca();
  chk('dark: hover item -> tint primer 30% (tema gelap benar-benar aktif)',
    b.tema === 'dark' && /0?\.3(0)?\)/.test(b.bg[1]) && !b.bg[1].includes('55, 65, 81'),
    `${b.tema} / ${b.bg[1]}`);
  chk('dark: item is-active -> tint 30% yang sama', /0?\.3(0)?\)/.test(b.bg[0]), b.bg[0]);
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

console.log(`pageerror: ${errs.length ? errs.join(' || ') : 'TANPA'}`);
if (errs.length) gagal++;
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
