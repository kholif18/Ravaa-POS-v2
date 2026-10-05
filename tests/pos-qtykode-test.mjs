// E2E POS: sintaks scan `Qty*Kode`, navigasi baris keranjang ↑↓, pintasan F7 =
// Tahan. Hasil gap analysis KulaPOS 2026-10-04 (kula-02-transaksi-pos.png:
// "Jumlah Beli * Kode [F1/Cmd+K]" + "↑↓ Navigasi Baris" + tombol "TAHAN [F3]").
// Jalankan: node pos-qtykode-test.mjs   (butuh API :3001 + vite :5656 hidup)
//
// Data yang dipakai = SKU seed: PRD00013 Aqua (4000, use_note), PRD00002 Buku
// Tulis (6000), PRD00001 Pulpen Hitam (3000). Tanpa penjualan — keranjang hanya
// diisi di klien lalu dibersihkan, jadi suite ini TIDAK menulis database.
import { chromium } from 'playwright-core';

const WEB = 'http://localhost:5656';
const OK = 'ok', GAGAL = 'gagal';
let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};
/** Pakai untuk langkah yang bisa tidak tersedia (mis. kolom catatan bila
 *  produk seed tidak lagi `use_note`) — asersi tetap dihitung 1 supaya jumlah
 *  asersi suite ini stabil bagi tests/run.mjs.
 *  WAJIB `async` + `await fn()`: callback-nya berisi langkah Playwright
 *  (klik + panah). Versi lama memanggil `fn()` tanpa await, jadi langkah itu
 *  berjalan PARALEL dengan langkah berikutnya — `p.fill('#pos-q','a')` membuka
 *  dropdown hasil cari lalu MENANGGUNG klik input catatan
 *  ("PRD00006 · tanpa stok" dari query 'a' mengintersepsi pointer →
 *  element detached → gagal). Diurutkan dulu baru lanjut. */
const skipable = async (n, ada, fn, info = '') => {
  if (ada) await fn();
  else { lolos++; console.log(`  OK   ${n} (kondisi tidak ada — dilewati)`); }
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
});
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
const dialogs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
p.on('dialog', (d) => { dialogs.push(d.message().slice(0, 80)); d.dismiss().catch(() => {}); });

const toastIsi = async () => (await p.innerText('#toast-root').catch(() => '')).trim();
const nBaris = () => p.locator('#pos-rows tr[data-key]:not(.note-row)').count();
const qtyInputs = () => p.$$eval('#pos-rows tr[data-key]:not(.note-row) input[data-act="qty"]', (els) => els.map((e) => e.value));
const fokusDesc = () => p.evaluate(() => {
  const a = document.activeElement;
  if (!a) return 'none';
  const rows = [...document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)')];
  const tr = a.closest('tr');
  return `${a.tagName.toLowerCase()}${a.getAttribute('data-act') ? ':' + a.getAttribute('data-act') : ''} baris=${tr ? rows.indexOf(tr) : -1}`;
});
const ketik = async (teks) => {
  await p.fill('#pos-q', teks);
  await p.press('#pos-q', 'Enter');
};

try {
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#pos-q', { timeout: 15000 });

  // ——— C1: sintaks Qty*Kode ———
  const ph = await p.getAttribute('#pos-q', 'placeholder');
  chk('placeholder mengumumkan sintaks Qty*Kode', /Qty\*Kode/.test(ph ?? ''), String(ph));

  await ketik('2*PRD00013');
  await p.waitForFunction(() => document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length >= 1, { timeout: 8000 });
  chk('2*PRD00013 -> 1 baris dengan qty 2', (await nBaris()) === 1 && (await qtyInputs())[0] === '2',
    JSON.stringify(await qtyInputs()));
  // Total memastikan qty benar-benar dipakai, bukan cuma angka kolom.
  chk('grand total ikut qty (2 x Rp4.000 = Rp8.000)', (await p.innerText('#pos-grand')).includes('8.000'),
    await p.innerText('#pos-grand'));

  await ketik('1*PRD00002');
  await p.waitForFunction(() => document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length === 2, { timeout: 8000 });
  chk('1*PRD00002 -> baris kedua qty 1', JSON.stringify(await qtyInputs()) === '["2","1"]',
    JSON.stringify(await qtyInputs()));

  await ketik('3*PRD00002');
  await p.waitForTimeout(300);
  chk('SKU sama diulang menumpuk qty (1+3=4), baris tetap 2',
    (await nBaris()) === 2 && (await qtyInputs())[1] === '4', JSON.stringify(await qtyInputs()));

  await ketik('0*PRD00001');
  await p.waitForTimeout(300);
  chk('qty 0 ditolak "Qty minimal 1" (tidak diam-diam jadi 1)',
    (await toastIsi()).includes('Qty minimal 1') && (await nBaris()) === 2,
    `${await toastIsi().then((t) => t.replace(/\n/g, ' / '))} | baris=${await nBaris()}`);

  await ketik('2*ZZZZZ');
  await p.waitForTimeout(300);
  chk('kode tak dikenal -> toast "tidak ditemukan", keranjang tak berubah',
    (await toastIsi()).includes('tidak ditemukan') && (await nBaris()) === 2,
    `baris=${await nBaris()}`);

  await ketik('PRD00001');
  await p.waitForFunction(() => document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length === 3, { timeout: 8000 });
  chk('regresi: scan tanpa qty tetap jalan (qty 1)', JSON.stringify(await qtyInputs()) === '["2","4","1"]',
    JSON.stringify(await qtyInputs()));
  chk('fokus kembali ke kolom scan setelah menambah',
    await p.evaluate(() => document.activeElement?.id === 'pos-q'));

  // ——— C2: navigasi ↑↓ baris ———
  await p.click('#pos-rows tr[data-key]:not(.note-row) input[data-act="qty"] >> nth=0');
  chk('awal: fokus qty baris 0', (await fokusDesc()) === 'input:qty baris=0', await fokusDesc());
  await p.keyboard.press('ArrowDown');
  chk('ArrowDown -> baris 1 (baris catatan dilewati)', (await fokusDesc()) === 'input:qty baris=1', await fokusDesc());
  await p.keyboard.press('ArrowDown');
  chk('ArrowDown -> baris 2', (await fokusDesc()) === 'input:qty baris=2', await fokusDesc());
  await p.keyboard.press('ArrowDown');
  chk('di ujung bawah arah di-clamp (tetap baris 2)', (await fokusDesc()) === 'input:qty baris=2', await fokusDesc());
  await p.keyboard.press('ArrowUp');
  chk('ArrowUp -> baris 1', (await fokusDesc()) === 'input:qty baris=1', await fokusDesc());

  const adaCatatan = (await p.locator('#pos-rows tr.note-row input[data-act="note"]').count()) > 0;
  await skipable('input catatan: panah = kursor, bukan pindah baris', adaCatatan, async () => {
    await p.click('#pos-rows tr.note-row input[data-act="note"]');
    const sebelum = await fokusDesc();
    await p.keyboard.press('ArrowDown');
    chk('input catatan: panah TIDAK memindahkan baris', (await fokusDesc()) === sebelum, await fokusDesc());
  });

  await p.fill('#pos-q', 'a');
  await p.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  const idx0 = await p.$eval('#pos-results .suggest-item.is-active', (e) => e.dataset.idx).catch(() => null);
  await p.keyboard.press('ArrowDown');
  const idx1 = await p.$eval('#pos-results .suggest-item.is-active', (e) => e.dataset.idx).catch(() => null);
  chk('regresi: ArrowDown di kolom scan tetap memindahkan dropdown',
    idx0 === '0' && idx1 === '1', `${idx0} -> ${idx1}`);
  await p.keyboard.press('Escape');
  await p.fill('#pos-q', '');

  // ——— C3: F7 = Tahan ———
  chk('label tombol Tahan memuat pintasan F7',
    (await p.innerText('#pos-hold')).includes('F7'), (await p.innerText('#pos-hold')).replace(/\n/g, ' '));
  await p.keyboard.press('F7');
  await p.waitForTimeout(800);
  chk('F7 -> toast "Transaksi ditahan"', (await toastIsi()).includes('Transaksi ditahan'),
    await toastIsi().then((t) => t.replace(/\n/g, ' / ')));
  chk('F7 -> keranjang kosong', (await nBaris()) === 0, `baris=${await nBaris()}`);
  chk('F7 -> badge Pending (1)', (await p.innerText('#pos-hold-open')).includes('Pending (1)'),
    await p.innerText('#pos-hold-open'));

  await p.click('#pos-hold-open');
  await p.waitForSelector('#hold-list li[data-hold-row]', { timeout: 8000 });
  const isiHold = await p.locator('#hold-list li').first().innerText();
  chk('hold berisi 3 baris (7 Qty)', /3 baris \(7 Qty\)/.test(isiHold), isiHold.replace(/\n/g, ' | ').slice(0, 120));

  // ——— Modal split ala Ravaa POS v1 (putaran 9b, 2026-10-05): kiri antrian
  // (split-header "DAFTAR ANTRIAN"), kanan detail struktur showHoldDetail() ——
  const isiPreview = await p.locator('#hold-preview').innerText();
  const isiBody = await p.locator('.modal-body').innerText();
  chk('preview kanan memuat barang hold + split-header antrian (v1)',
    /PRD00013/.test(isiPreview) && /daftar antrian/i.test(isiBody),
    isiPreview.replace(/\n/g, ' | ').slice(0, 140));
  // offsetHeight (bukan getBoundingClientRect) — rect ikut skala animasi
  // modal-in (back-out scale ≠ 1 saat pertama kali diukur).
  const cekTinggi = await p.evaluate(() => {
    const el = document.querySelector('#hold-preview');
    if (!el) return { selisih: 999, ov: '' };
    return {
      selisih: Math.abs(el.offsetHeight - 0.6 * window.innerHeight),
      ov: getComputedStyle(el).overflowY,
    };
  });
  chk('preview tinggi fix 60% layar + scrollable',
    cekTinggi.selisih < 2 && cekTinggi.ov === 'auto', JSON.stringify(cekTinggi));
  await p.click('[data-hold-act="lanjut"]');
  await p.waitForFunction(() => document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length === 3, { timeout: 8000 });
  chk('Lanjutkan memulihkan qty 2/4/1 persis', JSON.stringify(await qtyInputs()) === '["2","4","1"]',
    JSON.stringify(await qtyInputs()));

  await p.click('#pos-clear');
  await p.waitForTimeout(400);
  await p.keyboard.press('F7');
  await p.waitForTimeout(400);
  chk('F7 saat keranjang kosong diam (Pending tetap 0)',
    (await p.innerText('#pos-hold-open')).includes('Pending (0)'), await p.innerText('#pos-hold-open'));

  // Klik baris hasil dropdown ATURAN YANG SAMA dengan Enter: `2*SKU` tetap qty 2.
  await p.fill('#pos-q', '2*PRD00001');
  await p.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await p.click('#pos-results .suggest-item');
  await p.waitForFunction(() => document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length === 1, { timeout: 8000 });
  chk('klik baris dropdown sambil mengetik 2*SKU -> qty 2 (sama dengan Enter)',
    JSON.stringify(await qtyInputs()) === '["2"]', JSON.stringify(await qtyInputs()));
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

console.log(`pageerror: ${errs.length ? errs.join(' || ') : 'TANPA'}`);
console.log(`dialog browser: ${dialogs.length ? dialogs.join(' || ') : 'TANPA'}`);
if (errs.length) gagal++;
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
