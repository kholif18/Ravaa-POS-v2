// E2E #5d — HPP rata-rata (moving average cost).
// Jalankan: node e2e-hpp.mjs   (API :3001 + vite :5656 hidup)
//
// Sifat test: RELATIF terhadap stok/avg awal (tidak hard-code angka), supaya
// run berikutnya tidak bergantung pada sisa run sebelumnya. Stok dikembalikan
// ke nilai awal lewat opname di akhir.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path0 from 'node:path';
const ARTIFAK = path0.join(path0.dirname(fileURLToPath(import.meta.url)), 'artifacts');

let lolos = 0, gagal = 0;
const ok = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const API = 'http://localhost:3001';
const jget = async (p) => (await fetch(API + p)).json();
const jpost = async (p, b, m = 'POST') => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;
let S = 0;   // stok awal, diisi saat try — dipakai finally untuk mengembalikan

const SKU = 'PRD00001';
const ambil = async () => (await jget(`/api/products?status=semua&q=${SKU}`)).data[0];
// Rumus yang sama dengan server — sengaja diduplikasi supaya selisih ketahuan.
const avgBaru = (stok, avg, qty, harga) => Math.round((stok * avg + qty * harga) / (stok + qty));

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

/** Stok & opname pindah dari menu⋮ halaman Produk ke halaman Stok (#/stock),
 *  tempat tombol barisnya [data-stock]. Selalu navigasi dulu supaya urutan test
 *  tidak bergantung pada halaman mana yang sedang terbuka. */
const bukaDialogStok = async (sku) => {
  await page.goto('http://localhost:5656/#/stock', { waitUntil: 'load' });
  await page.waitForSelector('#page tbody tr', { timeout: 20000 });
  await page.fill('#st-q', sku);
  await page.waitForTimeout(500);
  await page.click('#page tbody tr [data-stock]');
  await page.waitForSelector('#r-qty', { timeout: 8000 });
};

try {
  const awal = await ambil();
  S = awal.stock;
  const A = awal.avg_cost, HARGA_JUAL = awal.price;
  console.log(`\nbaseline: stok=${S} avg_cost=${A} harga_jual=${HARGA_JUAL}`);
  const QTY = 7, HARGA = 1500;
  const EKSP = avgBaru(S, A, QTY, HARGA);

  console.log('=== A. Dialog stok: field harga beli ===');
  await bukaDialogStok(SKU);
  ok('mode default Masuk barang',
    (await page.getAttribute('.modal [data-mode="masuk"]', 'aria-pressed')) === 'true');
  ok('field "Harga beli / nota" tampil di mode masuk', await page.isVisible('#r-cost'));
  const hint0 = norm(await page.innerText('#r-hint'));
  ok(`hint memuat modal rata-rata awal (${rp(A)})`, hint0.includes(`Modal rata-rata ${rp(A)}`), hint0);
  ok('hint menyebut tanpa nota = tidak diubah', /tidak diubah/.test(hint0), hint0);

  console.log('=== B. Preview rata-rata live saat mengetik ===');
  await page.fill('#r-qty', String(QTY));
  await page.fill('#r-cost', String(HARGA));
  await page.waitForTimeout(200);
  const hint1 = norm(await page.innerText('#r-hint'));
  ok(`hint memuat "${rp(A)} -> ${rp(EKSP)}"`,
    hint1.includes(`${rp(A)} -> ${rp(EKSP)}`), `ekspektasi ${rp(EKSP)} | ${hint1}`);
  ok('hint tetap memuat stok saat ini', hint1.includes(`Stok saat ini: ${S}`), hint1);

  console.log('=== C. Mode Hitung fisik menyembunyikan field harga ===');
  await page.click('.modal [data-mode="opname"]');
  await page.waitForTimeout(150);
  ok('field harga tersembunyi di mode opname', !(await page.isVisible('#r-cost')));
  await page.click('.modal [data-mode="masuk"]');
  await page.waitForTimeout(150);
  ok('field harga muncul lagi di mode masuk', await page.isVisible('#r-cost'));
  // Ganti mode MEM Reset qty ke default (products.ts:927 — "Default ikut mode":
  // masuk = 1). Tanpa isi ulang, restock di bagian D terkirim qty=1, bukan 7,
  // dan seluruh angka di bawah (EKSP) meleset.
  await page.fill('#r-qty', String(QTY));
  await page.fill('#r-cost', String(HARGA));
  await page.waitForTimeout(150);

  console.log('=== D. Simpan restock -> avg_cost naik sesuai rumus ===');
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  const toast = norm(await page.innerText('#toast-root'));
  ok('toast menyebut modal rata-rata baru', toast.includes(`modal rata-rata ${rp(EKSP)}`), toast);
  const sesudah = await ambil();
  ok(`stok ${S} -> ${S + QTY}`, sesudah.stock === S + QTY, sesudah.stock);
  ok(`avg_cost -> ${EKSP}`, sesudah.avg_cost === EKSP,
    `dapat ${sesudah.avg_cost}, ekspektasi ${EKSP}`);

  console.log('=== E. Restock TANPA harga tidak mengubah rata-rata ===');
  await bukaDialogStok(SKU);
  await page.fill('#r-cost', '');        // kosongkan = tanpa nota
  await page.fill('#r-qty', '3');
  await page.waitForTimeout(150);
  await page.click('.modal [data-ok]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
  const tanpaNota = await ambil();
  ok('stok tetap bertambah (+3)', tanpaNota.stock === S + QTY + 3, tanpaNota.stock);
  ok('avg_cost TIDAK berubah', tanpaNota.avg_cost === EKSP,
    `dapat ${tanpaNota.avg_cost}, ekspektasi ${EKSP}`);

  console.log('=== F. Form produk menampilkan modal rata-rata ===');
  // Restock di atas membuka halaman Stok; form produk ada di halaman Produk.
  await page.goto('http://localhost:5656/#/products', { waitUntil: 'load' });
  await page.waitForSelector('#rows tr', { timeout: 20000 });
  await page.fill('#q', SKU);
  // Tunggu baris produk INI muncul — mengklik `#rows tr` pertama bisa membuka
  // modal produk lain bila filter belum ter-apply (race, bikin suite flaky).
  await page.waitForSelector(`#rows tr[data-row="${awal.id}"] [data-edit]`, { timeout: 10000 });
  await page.click(`#rows tr[data-row="${awal.id}"] [data-edit]`);
  await page.waitForSelector('#f-cost', { timeout: 8000 });
  const form = norm(await page.innerText('.modal'));
  ok('baris "Modal rata-rata" tampil', /Modal rata-rata:/.test(form), form.slice(0, 300));
  ok(`nilai baris = ${rp(EKSP)}`, form.includes(`Modal rata-rata: ${rp(EKSP)}`), form.slice(0, 300));
  ok('membedakan harga beli manual dari rata-rata', /patokan markup/.test(form));
  ok('Harga beli manual tidak tertimpa', (await page.inputValue('#f-cost')) === String(awal.cost),
    await page.inputValue('#f-cost'));
  // Stok HANYA diisi saat awal (keputusan 2026-09-28): di mode Ubah inputnya
  // tidak dirender SAMA SEKALI — bukan readonly, bukan tersembunyi CSS — jadi
  // tidak ada jalan mengubah stok lewat form ini. `Stok minimum` tetap boleh
  // diedit: itu ambang peringatan produk, bukan mutasi stok.
  ok('input Stok TIDAK dirender di mode Ubah (stok hanya diisi saat awal)',
    (await page.locator('#f-stock').count()) === 0);
  ok('Stok minimum tetap bisa diedit di mode Ubah',
    (await page.locator('#f-min').count()) === 1 && !(await page.locator('#f-min').isDisabled()));
  await page.click('.modal [data-x]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });

  console.log('=== G. Jual -> HPP disnapshot ke sale_items ===');
  const jual = await jpost('/api/sales', {
    id: `hpp-e2e-${Date.now()}`, shift_id: 1, pay_method: 'tunai', discount: 0,
    cash_in: HARGA_JUAL * 2, cashier: 'kasir',
    items: [{ product_id: awal.id, qty: 2 }],
  });
  ok('penjualan tersimpan (201)', jual.s === 201, jual.s);
  const item = jual.j?.data?.items?.[0];
  ok('sale_items ada', !!item, JSON.stringify(jual.j?.data ?? {}).slice(0, 200));
  ok(`cost baris = avg_cost (${EKSP})`, item?.cost === EKSP, `dapat ${item?.cost}`);

  console.log('=== H. Laporan harian: hpp + laba ===');
  const tgl = new Date().toISOString().slice(0, 10);
  const rep = (await jget(`/api/reports/daily?date=${tgl}`)).data;
  const hppHarap = Math.round(item.qty * item.cost);
  ok('laporan punya hpp', typeof rep.hpp === 'number', JSON.stringify(rep.hpp));
  ok(`hpp = qty*cost = ${hppHarap}`, rep.hpp >= hppHarap, `hpp=${rep.hpp} minimal=${hppHarap}`);
  ok('laporan punya laba', typeof rep.laba === 'number', JSON.stringify(rep.laba));
  ok('laba = omzet - hpp', rep.laba === rep.sales.omzet - rep.hpp,
    `laba=${rep.laba} omzet=${rep.sales.omzet} hpp=${rep.hpp}`);
  ok('laba masuk akal (omzet > laba bila ada HPP)', rep.hpp > 0 ? rep.laba < rep.sales.omzet : true,
    `hpp=${rep.hpp} omzet=${rep.sales.omzet}`);

  console.log('=== I. Tanpa error runtime ===');
  ok('tidak ada pageerror/console error', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL (exception) |', e.message);
} finally {
  // Kembalikan stok ke nilai awal (rata-rata sengaja TIDAK dikembalikan —
  // tidak ada API untuk mengaturnya, dan seluruh asersi di atas relatif).
  if (S > 0) {
    try {
      const kini = await ambil();
      if (kini.stock !== S) {
        await bukaDialogStok(SKU);
        await page.click('.modal [data-mode="opname"]');
        await page.fill('#r-qty', String(S));
        await page.click('.modal [data-ok]');
        await page.waitForSelector('.modal', { state: 'detached', timeout: 15000 });
        const setelah = await ambil();
        console.log(`  (stok dikembalikan ${kini.stock} -> ${S}; hasil ${setelah.stock})`);
      } else {
        console.log('  (stok sudah di nilai awal)');
      }
    } catch (e) {
      console.log('  (gagal mengembalikan stok:', e.message, ')');
    }
  }
  await page.screenshot({ path: `${ARTIFAK}/e2e-hpp.png` }).catch(() => {});
  await browser.close();
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
