// E2E POS: chip notif baris saklar cetak (`#pos-notif`) — permintaan pemilik
// 2026-10-08 *"buat agar lebih informatif, dan buat notif lain bukan hanya
// stok habis"*. Dua sifat yang diuji:
//   (1) notif LAIN selain stok: chip "Cetak dijeda" (ravaa.printpause=1) dan
//       chip "n transaksi antre offline" (ravaa.outbox.v1 terisi);
//   (2) INFORMATIF + SEGAR: setelah penjualan, chip stok habis menyebut
//       jumlah sesuai server DAN judulnya memuat nama produk + "sisa 0" —
//       TANPA reload halaman (regresi: products POS dulu hanya dimuat ulang
//       saat mount; lihat segarkanStokPos()/segNotifPos()).
// Jalankan: node pos-notif-test.mjs   (butuh API :3001 + vite :5656 hidup)
//
// DB: memakai opname SEMENTARA pada satu produk track_stock (stok -> 1, dijual
// 1 -> 0) lalu DIPULIHKAN ke angka semula di finally — stok akhir suite ini
// sama dengan stok awal.
import { chromium } from 'playwright-core';

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// SEBELUM aplikasi boot:
//  - ravaa.printpause = '1'  -> chip "Cetak dijeda" wajib tampil (default asli
//    memang PAUSED, tapi suite lain menyetel '0' — setel eksplisit supaya
//    deterministik). Efek samping positif: kirimPrint melempar sebelum fetch,
//    jadi suite ini TIDAK pernah menyentuh print-agent / printer asli.
//  - outbox berisi 1 job palsu -> chip "1 transaksi antre offline" tampil.
//  - navigator.onLine = false -> flushOutbox() (tiap 5 dtk) langsung return,
//    job tidak sempat dibuang/diposting ulang sebelum asersi dijalankan.
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('ravaa.printpause', '1');
    localStorage.setItem('ravaa.outbox.v1', JSON.stringify([
      { key: 'notif-test', path: '/api/sales', data: { id: 'notif-test' }, ts: Date.now() },
    ]));
  } catch { /* private mode */ }
  Object.defineProperty(navigator, 'onLine', { get: () => false });
});
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

const opname = async (product_id, qty_fisik) => {
  const r = await fetch(`${API}/api/stock-opname`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product_id, qty_fisik, cashier: 'kasir' }),
  });
  if (!r.ok) throw new Error(`opname ${product_id} -> ${r.status} ${await r.text()}`);
  return r.json();
};

let produk = null;   // dipulihkan di finally
let stokAsal = 0;
try {
  // ——— A. chip notif LAIN selain stok habis ———
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#pos-q', { timeout: 15000 });

  const jeda = p.locator('#pos-notif a', { hasText: 'Cetak dijeda' }).first();
  chk('chip "Cetak dijeda" tampil + mengarah ke #/settings (notif selain stok)',
    await jeda.isVisible() && (await jeda.getAttribute('href')) === '#/settings',
    await p.locator('#pos-notif').innerText().catch(() => '(tanpa #pos-notif)'));

  const antre = p.locator('a[data-notif-outbox]').first();
  chk('chip "1 transaksi antre offline" tampil + mengarah ke #/dashboard',
    await antre.isVisible()
      && (await antre.innerText()).includes('1 transaksi antre offline')
      && (await antre.getAttribute('href')) === '#/dashboard',
    await antre.innerText().catch(() => '(hilang)'));

  // ——— B. siapkan 1 produk track_stock jadi stok 1 ———
  const semua = (await (await fetch(`${API}/api/products`)).json()).data ?? [];
  produk = semua.find((x) => x.sku === 'PRD00001')
    ?? semua.find((x) => x.track_stock && x.stock > 0)
    ?? semua.find((x) => x.track_stock);
  if (!produk) throw new Error('tidak ada produk track_stock untuk diuji');
  stokAsal = produk.stock;
  await opname(produk.id, 1);
  // Reload supaya cache POS menyegar (stok 1) sebelum penjualan.
  await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#pos-q', { timeout: 15000 });

  // Sebelum dijual: chip habis (kalau sudah ada dari produk lain) BELUM boleh
  // menyebut produk uji — bukti angka chip berasal dari stok nyata.
  const habisSel = '#pos-notif a[title^="Stok habis"]';
  const nHabisAwal = await p.locator(habisSel).count();
  const judulAwal = nHabisAwal ? await p.locator(habisSel).first().getAttribute('title') : null;
  chk(`sebelum jual (stok 1): chip habis belum menyebut "${produk.name}"`,
    !judulAwal || !judulAwal.includes(produk.name), String(judulAwal));

  // ——— C. jual 1 pcs -> stok 0 — kartu notif wajib menyegar TANPA reload ———
  await p.fill('#pos-q', produk.sku);
  await p.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await p.press('#pos-q', 'Enter');
  await p.waitForFunction(
    () => document.querySelectorAll('#pos-rows tr[data-key]').length >= 1,
    { timeout: 8000 },
  );
  await p.keyboard.press('F12'); // bayar pas -> resume
  await p.waitForSelector('.swal2-popup', { timeout: 15000 });
  await p.keyboard.press('Escape'); // tutup resume tanpa cetak (printpause=1)
  await p.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });

  const toast = (await p.innerText('#toast-root').catch(() => '')).trim();
  chk('penjualan tersimpan (toast Terjual)', toast.includes('Terjual'), toast.slice(0, 160));

  const aktif = (await (await fetch(`${API}/api/products`)).json()).data ?? [];
  const nHabis = aktif.filter((x) => x.track_stock && x.stock <= 0).length;
  const isiNotif = await p.locator('#pos-notif').innerText();
  chk(`chip habis menyebut JUMLAH sesuai server (${nHabis}) setelah jual, tanpa reload`,
    isiNotif.includes(`${nHabis} stok habis`), isiNotif.replace(/\n/g, ' | ').slice(0, 200));

  await p.waitForSelector(habisSel, { timeout: 8000 });
  const judulBaru = await p.locator(habisSel).first().getAttribute('title');
  chk('judul chip habis kini memuat nama produk uji + "sisa 0" (informatif)',
    !!judulBaru && judulBaru.includes(produk.name) && judulBaru.includes('sisa 0'),
    String(judulBaru).slice(0, 240));
} catch (e) {
  gagal++;
  console.log(`  GAGAL crash: ${String(e).slice(0, 300)}`);
}

// ——— bersih-bersih: stok dikembalikan seperti semula ———
try {
  if (produk) await opname(produk.id, stokAsal);
} catch (e) {
  gagal++;
  console.log(`  GAGAL restore stok: ${String(e).slice(0, 200)}`);
}

console.log(`pageerror: ${errs.length ? errs.join(' || ') : 'TANPA'}`);
if (errs.length) gagal++;
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
