// Sidebar antar tema (2026-10-18, permintaan pemilik: tema gelap "lebih
// menyatu dengan tema dark"): tema terang tetap gradasi biru Sandik
// (#081533 -> #0F2858 -> #0a1c45 + glow biru); tema gelap memakai gradasi
// netral senada kanvas dark (#090d17 -> #101828 -> #0a0f1b + sheen netral).
// Diuji dari computed style + PIXEL NYATA screenshot (gradient benar-benar
// dilukis gelap, bukan hanya string style) — plus kontrak lama yang tidak
// boleh berubah: pil aktif biru bg-primary & teks nav #b9c8e4.
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
// Fase A memakai default device (konteks browser baru = localStorage kosong
// -> getTheme() = 'light'). SENGAJA tanpa init script tema: init script ikut
// jalan saat reload fase B dan akan menimpa pref 'dark' yang sedang diuji.
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));

await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

const gaya = () => p.evaluate(() => {
  const sb = getComputedStyle(document.querySelector('#sidebar'));
  const aktif = getComputedStyle(document.querySelector('.nav-link.is-active'));
  return {
    tema: document.documentElement.dataset.theme,
    img: sb.backgroundImage,
    warna: sb.color,
    aktifBg: aktif.backgroundColor,
  };
});

console.log('=== A. tema terang: gradasi biru Sandik dipertahankan ===');
const terang = await gaya();
chk('terang: boot dari pref ravaa.theme=light', terang.tema === 'light');
chk('terang: stop #081533 + #0F2858 ada',
  terang.img.includes('rgb(8, 21, 51)') && terang.img.includes('rgb(15, 40, 88)'));
chk('terang: BUKAN gradasi gelap netral', !terang.img.includes('rgb(9, 13, 23)'), terang.img.slice(0, 90));
chk('terang: pil aktif biru bg-primary #1d6df0', terang.aktifBg === 'rgb(29, 109, 240)', terang.aktifBg);

console.log('=== B. tema gelap: gradasi netral senada kanvas dark ===');
await p.evaluate(() => { localStorage.setItem('ravaa.theme', 'dark'); });
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(800);
const gelap = await gaya();
chk('gelap: boot dari pref ravaa.theme=dark (applyTheme)', gelap.tema === 'dark');
chk('gelap: stop #090d17 + #101828 ada',
  gelap.img.includes('rgb(9, 13, 23)') && gelap.img.includes('rgb(16, 24, 40)'));
chk('gelap: gradasi biru hilang', !gelap.img.includes('rgb(8, 21, 51)'), gelap.img.slice(0, 90));
chk('gelap: teks nav tetap #b9c8e4 (kontras di gelap)', gelap.warna === 'rgb(185, 200, 228)', gelap.warna);
chk('gelap: pil aktif tetap biru (aksen brand)', gelap.aktifBg === 'rgb(29, 109, 240)', gelap.aktifBg);

// Pixel nyata: gradient benar-benar dilukis gelap di tepi kiri sidebar
// (atas/tengah/bawah) — white/permukaan salah lapis akan ketahuan di sini.
const buf = await p.locator('#sidebar').screenshot();
const b64 = buf.toString('base64');
const px = await p.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const s = (x, y) => { const d = g.getImageData(x, y, 1, 1).data; return d[0] + d[1] + d[2]; };
  return { atas: s(3, 3), tengah: s(3, Math.floor(c.height / 2)), bawah: s(3, c.height - 4) };
}, b64);
chk('gelap: pixel nyata gelap (Σ kanal < 150)',
  [px.atas, px.tengah, px.bawah].every((v) => v < 150), JSON.stringify(px));

console.log('=== C. kembali terang: gradasi biru pulih tanpa reload ===');
await p.evaluate(() => {
  localStorage.setItem('ravaa.theme', 'light');
  document.documentElement.dataset.theme = 'light';
});
await p.waitForTimeout(250);
const lagi = await gaya();
chk('terang lagi: stop #081533 kembali', lagi.img.includes('rgb(8, 21, 51)'), lagi.img.slice(0, 90));

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
