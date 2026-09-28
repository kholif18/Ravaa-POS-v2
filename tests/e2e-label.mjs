// E2E cetak label harga -> print-agent (mode file, tanpa printer).
// Jalankan: node e2e-label.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
const ARTIFAK = path0.join(path0.dirname(fileURLToPath(import.meta.url)), 'artifacts');
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = '/home/seira/Projects/ravaaposv2';
// Print-agent dijalankan TERPISAH pada :9101 dengan PRINTER_PATH ke file tiruan.
// Agent bawaan (:9100) memilih /dev/usb/lp0 begitu perangkat USB terpasang —
// kalau test ini memakainya, tiap run akan MEMBUANG KERTAS NYATA. Dengan agent
// khusus, alurnya tetap utuh (browser -> agent -> tulis file) tapi aman.
const AGENT_PORT = 9101;
const FAKE = `${ARTIFAK}/fake-printer.bin`;
fs.writeFileSync(FAKE, '');
const agent = spawn('node', [path.join(REPO, 'apps/print-agent/server.js')], {
  env: { ...process.env, AGENT_PORT: String(AGENT_PORT), PRINTER_PATH: FAKE },
  stdio: 'ignore',
});
for (let i = 0; i < 50; i++) {
  try {
    const h = await fetch(`http://localhost:${AGENT_PORT}/health`);
    if (h.ok) break;
  } catch { /* agent belum siap */ }
  await new Promise((r) => setTimeout(r, 100));
}

let lolos = 0, gagal = 0;
const ok = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();


const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Harus sebelum skrip aplikasi jalan: urlAgent() membaca kunci ini saat mencetak.
await page.addInitScript((url) => localStorage.setItem('ravaa.printagent', url),
  `http://localhost:${AGENT_PORT}`);
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

try {
  await page.goto('http://localhost:5656/#/products', { waitUntil: 'load' });
  await page.waitForSelector('#rows tr', { timeout: 20000 });

  console.log('=== A. Dialog label ===');
  ok('tombol Label ada', await page.isVisible('#prod-label'));
  await page.click('#prod-label');
  await page.waitForSelector('#lbl-agent', { timeout: 5000 });
  await page.waitForTimeout(600);
  const agent = await page.innerText('#lbl-agent');
  ok('status print-agent terbaca', /print-agent siap/.test(norm(agent)), agent);
  ok('memberi tahu mode file bila tanpa printer', /printer belum ketemu|printer /.test(norm(agent)), agent);
  ok('tombol cetak aktif (agent terjangkau)', !(await page.locator('.modal [data-ok]').isDisabled()));

  const label = norm(await page.innerText('.modal [data-ok]'));
  ok('label tombol memuat jumlah', /^Cetak \d+ label$/.test(label), label);
  const jumlah = Number((label.match(/\d+/) || [0])[0]);
  ok('ada produk yang layak label', jumlah > 0, label);

  console.log('=== B. Pratinjau label ===');
  const pre = await page.innerText('.modal pre');
  const baris = pre.split('\n');
  ok('pratinjau ada isinya', baris.length >= 4, JSON.stringify(baris.slice(0, 6)));
  const maxLen = Math.max(...baris.map((b) => b.length));
  ok(`semua baris <= 32 kolom (max ${maxLen})`, maxLen <= 32, baris.filter((b) => b.length > 32).join(' | '));
  ok('baris harga ditandai ukuran 2x', baris.some((b) => b.includes('<2x>')), JSON.stringify(baris));
  ok('memuat potongan', baris.some((b) => b.includes('potong')));
  ok('memuat nama produk contoh', /Sampoerna|Pulpen|Aqua|Kopi/i.test(pre), baris.slice(0, 3).join(' / '));

  console.log('=== C. Cetak -> file keluaran ===');
  fs.writeFileSync(FAKE, '');   // kosongkan dulu supaya isi berikutnya pasti baru
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  const toast = norm(await page.innerText('#toast-root'));
  ok('toast sukses memuat jumlah', new RegExp(`${jumlah} label dikirim`).test(toast), toast);
  await page.waitForTimeout(500);
  const buf = fs.readFileSync(FAKE);
  ok('print-agent menulis stream ke tujuan cetak', buf.length > 0, `${buf.length} byte`);

  if (buf.length > 0) {
    ok('diawali ESC @ (INIT)', buf[0] === 0x1b && buf[1] === 0x40, `b0=${buf[0]} b1=${buf[1]}`);
    ok('diakhiri GS V 0 (CUT)', buf[buf.length - 3] === 0x1d && buf[buf.length - 2] === 0x56 && buf[buf.length - 1] === 0x00);
    const isi = buf.toString('latin1').replace(/[^\x20-\x7E]/g, '');
    // satu label = satu perintah potong (GS V 0) -> ini yang menghitung label
    let nPotong = 0;
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] === 0x1d && buf[i + 1] === 0x56 && buf[i + 2] === 0x00) nPotong++;
    }
    ok(`ada ${jumlah} label (dihitung dari perintah potong)`, nPotong === jumlah, `dapat ${nPotong}`);
    ok('memuat harga', /Rp\d/.test(isi));
    // label pendek (nama satu baris, tanpa barcode) ~70-100 byte
    ok('ukuran file masuk akal', buf.length > 50 * jumlah, `${buf.length} byte utk ${jumlah} label`);
  }

  console.log('=== D. Filter = pemilih ===');
  // Cari pakai SKU seed yang UNIK, bukan kata "Aqua". Pencarian memang sengaja
  // memecah jadi kata dan SEMUA kata harus cocok di nama/SKU/barcode — jadi
  // begitu toko menambah produk ber-"Aqua" kedua, harapan "1 label" jadi basi
  // lalu menyalahkan aplikasi padahal perilakunya benar (jumlah = jumlah produk
  // yang lolos filter). SKU seed tidak boleh diganti tanpa konfirmasi, jadi
  // angkanya di sini dijamin.
  await page.fill('#q', 'PRD00013');
  await page.waitForTimeout(400);
  await page.click('#prod-label');
  await page.waitForSelector('.modal [data-ok]');
  const t2 = norm(await page.innerText('.modal [data-ok]'));
  ok('jumlah mengikuti pencarian (SKU unik -> tepat 1)', /^Cetak 1 label$/.test(t2), t2);
  await page.click('.modal [data-x]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });

  console.log('=== E. Tanpa error runtime ===');
  ok('tidak ada pageerror/console error', errs.length === 0, errs.join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL eksekusi:', e.message);
} finally {
  await page.screenshot({ path: `${ARTIFAK}/e2e-label.png` }).catch(() => {});
  await browser.close();
  agent.kill();
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
