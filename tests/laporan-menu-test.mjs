// Katalog laporan ala Aronium (2026-10-11): menu Harian/Laba/Kasir/Produk/Piutang/
// Stok + summary range + cashiers + products + piutang + cetak/PDF/CSV +
// dropdown rentang tanggal (2026-10-17, revisi "jadikan dropdown saja") +
// anti-regresi aside (kartu mandiri setinggi isinya + sticky utuh saat digulir).
//
// Fixture menu Stok (2026-10-18): asersi "Saran order" jangan bergantung data
// ambient — DB sehat = daftar "Perlu dikulak" kosong dan header tabelnya tidak
// dirender (test pernah CRASH begitu stok kasir dirapikan). Produk uji dibuat
// nama EKSAK + self-heal sisa run gagal + dihapus langsung seusai asersi.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken } from './bantuan-uji.mjs';

const API = 'http://localhost:3001';
const DB = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '../apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const hariIni = () => new Date().toISOString().slice(0, 10);

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const get = (path) => p.evaluate(async (u) => {
  const r = await fetch(u);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, path);

await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

console.log('=== A. API summary/cashiers/products ===');
const s = (await api(`/api/reports/summary?from=${hariIni()}&to=${hariIni()}`)).data;
const d = (await api(`/api/reports/daily?date=${hariIni()}`)).data;
const kunci = (o) => Object.keys(o).filter((k) => !['date', 'from', 'to'].includes(k)).sort().join(',');
chk('summary = daily untuk 1 hari', kunci(s) === kunci(d), kunci(s));
chk('piutang punya baru+ bayar', typeof s.piutang?.baru === 'number' && typeof s.piutang?.bayar === 'number',
  JSON.stringify(s.piutang));
const k = (await api(`/api/reports/cashiers?from=${hariIni()}&to=${hariIni()}`)).data;
chk('kasir: jumlah baris = total', k.total.n === k.rows.reduce((a, r) => a + r.n, 0)
  && k.total.omzet === k.rows.reduce((a, r) => a + r.omzet, 0), JSON.stringify(k.total));
chk('kasir: omzet = omzet summary', k.total.omzet === s.sales.omzet, `${k.total.omzet} vs ${s.sales.omzet}`);
const pr = (await api(`/api/reports/products?from=${hariIni()}&to=${hariIni()}&limit=3`)).data;
chk('produk: baris bawa hpp + laba + limit dipatuhi', pr.rows.length <= 3
  && pr.rows.every((r) => typeof r.hpp === 'number' && typeof r.laba === 'number'),
  `${pr.rows.length}/${pr.total}`);
chk('byHour: 24 ember, Σ menutup totals', Array.isArray(d.byHour) && d.byHour.length === 24
  && d.byHour.reduce((a, b) => a + b.n, 0) === d.sales.n
  && d.byHour.reduce((a, b) => a + b.omzet, 0) === d.sales.omzet,
  `len=${d.byHour?.length}`);
const pf = (await api(`/api/reports/profit?from=${hariIni()}&to=${hariIni()}`)).data;
chk('profit: days & total konsisten', pf.days.reduce((a, h) => a + h.n, 0) === pf.total.n
  && pf.days.reduce((a, h) => a + h.omzet, 0) === pf.total.omzet
  && pf.days.every((h) => h.laba === h.omzet - h.hpp)
  && pf.total.laba === pf.total.omzet - pf.total.hpp,
  JSON.stringify(pf.total));
chk('profit: trx <= 200 + field nota', pf.trx.length <= 200
  && pf.trx.every((t) => 'invoice_no' in t && typeof t.cashier === 'string' && t.laba === t.total - t.hpp),
  `trx=${pf.trx.length}`);
chk('validasi: profit from>to 400', (await get('/api/reports/profit?from=2026-10-11&to=2026-10-01')).status === 400);
chk('validasi: from>to 400', (await get('/api/reports/summary?from=2026-10-11&to=2026-10-01')).status === 400);
chk('validasi: format rusak 400', (await get('/api/reports/summary?from=rabu')).status === 400);
chk('validasi: >366 hari 400', (await get('/api/reports/summary?from=2024-01-01&to=2026-10-11')).status === 400);

// Fixture deterministik menu Stok (lihat header): produk fisik stok 1 / min 5
// => muncul di lowStock dengan saran 4. Self-heal dulu (sisa run gagal),
// nama EKSAK — dibersihkan lagi seusai asersi "Saran order" di bawah.
const FIX_LOW = 'UjiLapMenu Rendah';
sql(`DELETE FROM products WHERE name='${FIX_LOW}';`);
const rFix = await fetch(`${API}/api/products`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: FIX_LOW, category_slug: 'atk', unit: 'pcs', price: 1000, stock: 1, min_stock: 5 }),
});
if (rFix.status !== 200 && rFix.status !== 201) console.log(`  (catatan) fixture ${FIX_LOW} gagal dibuat: ${rFix.status}`);

console.log('=== B. UI menu + filter ===');
await p.goto('http://localhost:5656/#/reports', { waitUntil: 'networkidle' });
await p.waitForSelector('#rp-body', { timeout: 15000 });
await p.waitForTimeout(1200);
chk('6 menu (Harian/Laba/Kasir/Produk/Piutang/Stok), Harian aktif', await p.locator('[data-menu]').count() === 6
  && await p.locator('[data-menu="harian"]').count() === 1);
chk('harian: 24 batang jam + chip jam teramai', await p.locator('[data-jam]').count() === 24
  && (await p.textContent('#rp-body')).includes('Jam teramai'));
const tabelTop = p.locator('#rp-body table').filter({ has: p.locator('th', { hasText: /^Produk$/ }) });
const thTop = await tabelTop.locator('thead').innerText();
chk('harian: produk terlaris bawa kolom HPP + Laba', /hpp/i.test(thTop) && /laba/i.test(thTop), thTop);
await p.click('[data-menu="kasir"]'); await p.waitForTimeout(1200);
chk('menu Kasir: tabel kasir tampil', (await p.textContent('#rp-body')).includes('Penjualan per kasir'));
// Dropdown rentang tanggal (revisi pemilik 2026-10-17: "jadikan dropdown saja
// jangan seperti modal") — panel melayang menempel di bawah tombol rentang,
// preset kiri + 2 kalender kanan; nilai baru masuk state saat Terapkan.
await p.click('#rp-range');
await p.waitForSelector('#rp-pop:not(.hidden) .drp-grid', { timeout: 5000 });
chk('dropdown rentang: 8 preset + 2 kalender + bukan modal', await p.locator('[data-drp-preset]').count() === 8
  && await p.locator('#rp-pop .drp-grid').count() === 2
  && await p.locator('.modal-overlay').count() === 0);
await p.click('[data-drp-preset="kemarin"]');
await p.click('[data-drp-ok]'); await p.waitForTimeout(1200);
const kmrn = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
chk('preset Kemarin via dropdown: from=to kemarin + tertutup', (await p.locator('#rp-from').inputValue()) === kmrn
  && (await p.locator('#rp-to').inputValue()) === kmrn
  && await p.locator('#rp-pop:not(.hidden)').count() === 0, kmrn);
// Klik di luar panel = tutup tanpa mengubah rentang (perilaku dropdown); Esc juga.
await p.click('#rp-range');
await p.waitForSelector('#rp-pop:not(.hidden) .drp-grid', { timeout: 5000 });
const bb = await p.locator('#rp-body').boundingBox();
await p.mouse.click(bb.x + bb.width / 2, bb.y + 4);
await p.waitForTimeout(200);
chk('dropdown: klik di luar menutup tanpa mengubah rentang', await p.locator('#rp-pop:not(.hidden)').count() === 0
  && (await p.locator('#rp-from').inputValue()) === kmrn);
await p.click('#rp-range');
await p.waitForSelector('#rp-pop:not(.hidden) .drp-grid', { timeout: 5000 });
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
chk('dropdown: Esc menutup tanpa mengubah rentang', await p.locator('#rp-pop:not(.hidden)').count() === 0
  && (await p.locator('#rp-from').inputValue()) === kmrn);
// Klik 2 tanggal kalender = rentang Kustom (bukan salah satu preset).
await p.click('#rp-range');
await p.waitForSelector('#rp-pop:not(.hidden) .drp-grid', { timeout: 5000 });
await p.click('[data-drp-preset="bulan-ini"]');
const ymSkrg = hariIni().slice(0, 7);
await p.locator(`[data-iso="${ymSkrg}-01"]`).first().click();
await p.locator(`[data-iso="${ymSkrg}-05"]`).first().click();
await p.click('[data-drp-ok]'); await p.waitForTimeout(1200);
chk('kalender: klik 2 tanggal → rentang custom', (await p.locator('#rp-from').inputValue()) === `${ymSkrg}-01`
  && (await p.locator('#rp-to').inputValue()) === `${ymSkrg}-05`);
// Rentang 1-5 belum tentu berisi penjualan (menu Laba = tabel per hari/nota
// dari hari BERISI) — kembalikan ke 30 hari terakhir sebelum cek menu sisanya.
await p.click('#rp-range');
await p.waitForSelector('#rp-pop:not(.hidden) .drp-grid', { timeout: 5000 });
await p.click('[data-drp-preset="30-hari"]');
await p.click('[data-drp-ok]'); await p.waitForTimeout(1200);
await p.click('[data-menu="produk"]'); await p.waitForTimeout(1200);
chk('menu Produk: ada cari + tabel', await p.locator('#rp-q').count() === 1);
await p.click('[data-menu="piutang"]'); await p.waitForTimeout(1200);
chk('menu Piutang: 3 kartu', (await p.textContent('#rp-body')).includes('Sisa berjalan kini'));
await p.click('[data-menu="stok"]'); await p.waitForTimeout(1200);
const teksStok = await p.textContent('#rp-body');
chk('menu Stok: saran order + fixture low tampil',
  teksStok.includes('Saran order') && teksStok.includes(FIX_LOW));
// Bersihkan fixture SEKARANG: halaman lain (dashboard/POS) membaca lowStock
// yang sama — jangan biarkan menjalar ke suite berikutnya.
sql(`DELETE FROM products WHERE name='${FIX_LOW}';`);
await p.click('[data-menu="laba"]'); await p.waitForTimeout(1200);
chk('menu Laba: kartu + tabel per hari & per transaksi',
  (await p.textContent('#rp-body')).includes('Laba kotor')
  && (await p.textContent('#rp-body')).includes('Laba per hari')
  && (await p.textContent('#rp-body')).includes('Laba per transaksi'));
// Anti-regresi aside (revisi pemilik 2026-10-17): kartu menu JANGAN ikut
// tinggi kolom kanan (kentara "full hanya Harian/Laba") dan SELURUH kartu
// (bukan hanya teksnya) harus menempel saat digulir.
const ukurAside = () => p.evaluate(() => {
  const aside = document.querySelector('#rp-body aside');
  const card = document.querySelector('#rp-body aside > div.card');
  const kanan = document.querySelector('#rp-body .grid > div:last-child');
  const r = card.getBoundingClientRect();
  return {
    top: Math.round(r.top), tinggi: Math.round(r.height),
    kolom: Math.round(aside.getBoundingClientRect().height),
    kananTop: Math.round(kanan.getBoundingClientRect().top),
  };
});
const gulir = (y) => p.evaluate((t) => {
  (document.querySelector('.page') ?? document.scrollingElement).scrollTop = t;
}, y);
await gulir(0); await p.waitForTimeout(250);
const aAtas = await ukurAside();
chk('aside: kartu mandiri (tidak ikut tinggi kolom kanan)', aAtas.tinggi < aAtas.kolom - 100,
  `kartu=${aAtas.tinggi} kolom=${aAtas.kolom}`);
await gulir(600); await p.waitForTimeout(350);
const aGulir = await ukurAside();
chk('aside: SELURUH kartu sticky saat digulir', Math.abs(aGulir.top - aAtas.top) <= 4,
  `atas ${aAtas.top} -> ${aGulir.top}`);
await gulir(0); await p.waitForTimeout(250);
// Template aside harus IDENTIK di semua menu (permintaan pemilik 2026-10-17:
// "jadikan template untuk semua laporan, agar perilaku dan layout sama persis").
// Inset `top-4` lama membuat kartu tergeser 16px hanya bila kolom kanan punya
// ruang geser (Harian/Laba/Produk 72 vs Kasir/Piutang/Stok 56); `top-0` kini
// seragam + sejajar tepi kolom kanan.
const pola = [];
for (const m of ['harian', 'laba', 'kasir', 'produk', 'piutang', 'stok']) {
  await p.click(`[data-menu="${m}"]`);
  await p.waitForTimeout(1200);
  const u = await ukurAside();
  pola.push(`${m}=${u.top}/${u.tinggi}/${u.kananTop}`);
}
chk('aside: template identik di 6 menu (atas+tinggi kartu, sejajar kolom kanan)',
  new Set(pola.map((s) => s.split('=')[1])).size === 1,
  pola.join(' '));
// Kembali ke Stok: section C menguji popup + CSV menu Stok dulu (urutan lama).
await p.click('[data-menu="stok"]'); await p.waitForTimeout(1200);

console.log('=== C. Cetak + CSV per menu ===');
await p.context().addInitScript(() => { window.print = () => {}; });
const [pop] = await Promise.all([
  p.waitForEvent('popup'),
  p.click('#rp-print'),
]);
await pop.waitForLoadState('domcontentloaded');
chk('popup cetak: judul + tabel + kaki', (await pop.title()).includes('STOK')
  && (await pop.content()).includes('Saran order')
  && (await pop.content()).includes('Dicetak dari Ravaa POS'));
await pop.close().catch(() => {});
const [dl] = await Promise.all([
  p.waitForEvent('download'),
  p.click('#rp-csv'),
]);
chk('CSV stok: nama berkas menu', /^laporan-stok-\d{4}-\d{2}-\d{2}_sd_\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename() ?? ''),
  dl.suggestedFilename());

await p.click('[data-menu="laba"]'); await p.waitForTimeout(1200);
const [popLaba] = await Promise.all([
  p.waitForEvent('popup'),
  p.click('#rp-print'),
]);
await popLaba.waitForLoadState('domcontentloaded');
chk('popup cetak Laba: judul + ringkasan total', (await popLaba.title()).includes('LABA')
  && (await popLaba.content()).includes('Total laba'));
await popLaba.close().catch(() => {});
const [dlLaba] = await Promise.all([
  p.waitForEvent('download'),
  p.click('#rp-csv'),
]);
chk('CSV laba: nama berkas menu', /^laporan-laba-\d{4}-\d{2}-\d{2}_sd_\d{4}-\d{2}-\d{2}\.csv$/.test(dlLaba.suggestedFilename() ?? ''),
  dlLaba.suggestedFilename());

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
