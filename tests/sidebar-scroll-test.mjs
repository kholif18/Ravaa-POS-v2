// Posisi gulir menu sidebar diingat antar-navigasi (per device) — permintaan
// pemilik 2026-10-19: *"sidebar tambahkan localstorage agar menyimpan lokasi
// menu yang di pilih agar tidak perlu scroll ke bawah lagi jika menu itu di
// bawah … karena menu bawah yang di pilih akan reload kembali ke posisi atas"*.
// Kontrak yang dijaga:
//   - gulir `.nav-scroll` -> posisi ditulis ke localStorage `ravaa.nav-scroll`;
//   - navigasi (shell render ulang) -> posisi DIPULIHKAN, menu aktif dari
//     bawah tetap terlihat tanpa perlu scroll lagi;
//   - tanpa simpanan -> mulai dari atas (tanpa lompatan).
// Jalankan: node tests/sidebar-scroll-test.mjs (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

const WEB = 'http://localhost:5656';
let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};

// Viewport rendah SENGAJA (720) supaya daftar menu owner pasti lebih tinggi
// dari ruang `.nav-scroll` — tanpa overflow, uji posisi gulir tak bermakna.
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 720 } });
const p = await ctx.newPage();
await pasangToken(p);
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

try {
  // ——— A. fresh (tanpa simpanan) -> mulai dari atas ———
  await p.goto(`${WEB}/#/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.nav-scroll .nav-link', { timeout: 15000 });
  const awal = await p.evaluate(() => document.querySelector('.nav-scroll').scrollTop);
  chk('tanpa simpanan: sidebar mulai dari atas', awal === 0, String(awal));

  // ——— B. gulir mentok bawah -> posisi tersimpan ———
  const simpan = await p.evaluate(async () => {
    const el = document.querySelector('.nav-scroll');
    el.scrollTop = el.scrollHeight; // mentok bawah
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { pos: el.scrollTop, ls: Number(localStorage.getItem('ravaa.nav-scroll') || 0) };
  });
  chk('gulir ke bawah: posisi > 0', simpan.pos > 0, JSON.stringify(simpan));
  chk('posisi tersimpan di localStorage', simpan.ls === simpan.pos, JSON.stringify(simpan));

  // ——— C. klik menu TERBAWAH -> shell render ulang -> posisi dipulihkan ———
  const menuBawah = await p.locator('.nav-scroll .nav-link').last().getAttribute('href');
  await p.locator('.nav-scroll .nav-link').last().click();
  await p.waitForSelector(`.nav-link.is-active[href="${menuBawah}"]`, { timeout: 8000 });
  await p.waitForTimeout(250);
  const sesudah = await p.evaluate(() => {
    const el = document.querySelector('.nav-scroll');
    const aktif = document.querySelector('.nav-scroll .nav-link.is-active');
    const r = aktif.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    return { pos: el.scrollTop, tampak: r.top >= s.top - 1 && r.bottom <= s.bottom + 1 };
  });
  chk('setelah navigasi: posisi gulir dipulihkan', sesudah.pos === simpan.pos, JSON.stringify(sesudah));
  chk(`menu terbawah (${menuBawah}) tetap terlihat`, sesudah.tampak, JSON.stringify(sesudah));
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

console.log(`pageerror: ${errs.length ? errs.join(' || ') : 'TANPA'}`);
if (errs.length) gagal++;
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
