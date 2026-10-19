// Pemindai barcode lewat KAMERA (butir ROADMAP 1.6.1 — keputusan pemilik
// 2026-10-19): tombol `#pos-scan-kamera` di scan bar desktop & header mobile,
// overlay `.sk-overlay`, hasil deteksi masuk ke jalur `#pos-q` yang SAMA
// dengan scan ketik/Enter (`Qty*Kode` tetap jalan, merge qty tetap berlaku).
//
// Kamera & BarcodeDetector di-STUB lewat addInitScript: suite headless tidak
// punya kamera fisik; yang diuji di sini = perilaku alur UI + kontrak callback
// (bukan akurasi deteksi perangkat asli). Cek dukungan memakai
// `typeof BarcodeDetector === 'function'` (terverifikasi 2026-10-19: headless
// Chrome Linux TIDAK punya API itu → konteks C deterministik).
// TIDAK ada mutasi server: hanya menambah ke keranjang (localStorage).
// Jalankan: node tests/scan-kamera-test.mjs (butuh API :3001 + vite :5656)
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
});

// Fixture PRD00002 (dipakai suite lain juga) — self-heal ada di AGENTS §5.
const cekProd = await (await fetch(`${API}/api/products?q=PRD00002`)).json();
const p2 = (cekProd.data ?? []).find((x) => x.sku === 'PRD00002');
if (!p2) {
  console.log('  GAGAL prasyarat: PRD00002 tidak ada/aktif — pulihkan fixture dulu (AGENTS §5)');
  process.exit(1);
}

/** Stub kamera + BarcodeDetector. Test mengisi `window.__sk.kode` setelah
 *  overlay terbuka; detect() mengembalikannya sebagai rawValue. */
const STUB = () => {
  window.__sk = { buka: 0, formats: null, kode: '', stream: null };
  class BD {
    static getSupportedFormats() { return Promise.resolve(['ean_13', 'ean_8', 'code_128', 'code_39', 'itf']); }
    constructor(opsi) { window.__sk.formats = (opsi && opsi.formats) || null; }
    detect() {
      const k = window.__sk.kode;
      return Promise.resolve(k ? [{ rawValue: k }] : []);
    }
  }
  window.BarcodeDetector = BD;
  const md = navigator.mediaDevices ?? {};
  md.getUserMedia = async () => {
    window.__sk.buka += 1;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const s = c.captureStream(10);
    window.__sk.stream = s;
    return s;
  };
  if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: md });
};

const errs = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(STUB);
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await pasangToken(p);
await p.goto(`${WEB}/#/pos`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#pos-q', { timeout: 15000 });

try {
  // ——— A. desktop: tombol → overlay → deteksi → keranjang ———
  chk('A1 tombol #pos-scan-kamera tampil di scan bar desktop',
    await p.locator('#pos-scan-kamera').isVisible());

  // Overlay dibuka dengan kode KOSONG dulu (belum ada deteksi) supaya asersi
  // A2–A4 tidak balapan dengan penutupan otomatis overlay.
  await p.click('#pos-scan-kamera');
  await p.waitForSelector('.sk-overlay', { timeout: 5000 });
  chk('A2 klik membuka overlay pemindai (.sk-overlay)', await p.locator('.sk-overlay').isVisible());
  chk('A3 getUserMedia dipanggil sekali', (await p.evaluate(() => window.__sk.buka)) === 1);
  const formats = await p.evaluate(() => window.__sk.formats);
  chk('A4 format diminta = irisan dukungan browser (ean_13 + code_128)',
    Array.isArray(formats) && formats.includes('ean_13') && formats.includes('code_128'), JSON.stringify(formats));

  await p.evaluate(() => { window.__sk.kode = 'PRD00002'; });
  await p.waitForSelector('.sk-overlay', { state: 'detached', timeout: 8000 });
  await p.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  chk('A5 hasil deteksi menutup overlay & baris masuk keranjang',
    (await p.textContent('#pos-rows')).includes('PRD00002'));
  chk('A6 qty baris = 1', (await p.inputValue('#pos-rows input[data-act="qty"]')) === '1');
  chk('A7 track kamera dimatikan setelah hasil',
    (await p.evaluate(() => window.__sk.stream.getTracks()[0].readyState)) === 'ended');

  // `Qty*Kode` lewat kamera — jalur bacaQtyKode() yang sama dengan Enter.
  await p.evaluate(() => { window.__sk.kode = ''; });
  await p.click('#pos-scan-kamera');
  await p.waitForSelector('.sk-overlay', { timeout: 5000 });
  await p.evaluate(() => { window.__sk.kode = '2*PRD00002'; });
  await p.waitForSelector('.sk-overlay', { state: 'detached', timeout: 8000 });
  await p.waitForFunction(
    () => document.querySelector('#pos-rows input[data-act="qty"]')?.value === '3', null, { timeout: 8000 });
  chk('A8 "2*PRD00002" dari kamera menambah qty jadi 3 (Qty*Kode jalan)',
    (await p.inputValue('#pos-rows input[data-act="qty"]')) === '3');

  // Esc = tutup tanpa menambah (kode kosong supaya tidak ada deteksi).
  await p.evaluate(() => { window.__sk.kode = ''; });
  await p.click('#pos-scan-kamera');
  await p.waitForSelector('.sk-overlay', { timeout: 5000 });
  await p.keyboard.press('Escape');
  await p.waitForSelector('.sk-overlay', { state: 'detached', timeout: 5000 });
  chk('A9 Esc menutup overlay', (await p.locator('.sk-overlay').count()) === 0);
  chk('A10 Esc tidak menambah baris (tetap 1 baris, qty 3)',
    (await p.locator('#pos-rows tr[data-key]').count()) === 1 &&
    (await p.inputValue('#pos-rows input[data-act="qty"]')) === '3');

  // ——— B. shell mobile: tombol di header + overlay bisa dibuka/ditutup × ———
  await p.evaluate(() => localStorage.setItem('ravaa.mobile-layout', '1'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.pm-shell', { timeout: 15000 });
  chk('B1 tombol kamera tampil di header mobile (.pm-head)',
    (await p.locator('.pm-head #pos-scan-kamera').count()) === 1);
  await p.click('.pm-head #pos-scan-kamera');
  await p.waitForSelector('.sk-overlay', { timeout: 5000 });
  chk('B2 overlay terbuka dari mobile', await p.locator('.sk-overlay').isVisible());
  await p.click('.sk-overlay [data-sk-tutup]');
  await p.waitForSelector('.sk-overlay', { state: 'detached', timeout: 5000 });
  chk('B3 tombol × menutup overlay', (await p.locator('.sk-overlay').count()) === 0);
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}
await ctx.close();

// ——— C. browser tanpa BarcodeDetector: toast penjelas, TANPA overlay ———
{
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Pastikan API benar-benar absen — kalau build Chrome masa depan menambahnya
  // di Linux, suite tetap deterministik (module memakai cek typeof function).
  await ctx2.addInitScript(() => {
    try { Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true }); } catch { /* */ }
  });
  const p2b = await ctx2.newPage();
  p2b.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await pasangToken(p2b);
  await p2b.goto(`${WEB}/#/pos`, { waitUntil: 'domcontentloaded' });
  await p2b.waitForSelector('#pos-q', { timeout: 15000 });
  try {
    await p2b.click('#pos-scan-kamera');
    await p2b.waitForSelector('#toast-root .toast', { timeout: 5000 });
    chk('C1 tanpa BarcodeDetector -> toast penjelas (bukan tombol diam)',
      (await p2b.textContent('#toast-root')).includes('BarcodeDetector'));
    chk('C2 overlay tidak dibuka di browser tanpa dukungan',
      (await p2b.locator('.sk-overlay').count()) === 0);
  } catch (e) {
    gagal++;
    console.log(`  GAGAL crash C: ${String(e).slice(0, 300)}`);
  }
  await ctx2.close();
}

chk('D1 tanpa pageerror', errs.length === 0, errs.join(' || '));

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
