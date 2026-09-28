#!/usr/bin/env node
/* Test fitur: HAPUS PRODUK (soft delete + tombstone).
 *
 * Menguji 4 hal sekaligus:
 *   A. tombol Hapus ada di tiap baris + dialog menjelaskan guard
 *   B. hapus sukses -> hilang dari tabel, dari list biasa, MUNCUL di delta sbg tombstone
 *   C. cache kasir (POS) benar-benar MEMBUANG produk tsb setelah sync
 *   D. guard: produk yang pernah terjual -> 400, produk tetap utuh
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';

const DB = '/home/seira/Projects/ravaaposv2/apps/api/data/data.db';
/** Hapus keras artefak uji lewat sqlite3 langsung (test-only, bukan jalur API). */
const cleanupDB = () => {
  try {
    execFileSync('sqlite3', [DB,
      "DELETE FROM sale_items; DELETE FROM sales; " +
      "DELETE FROM stock_moves WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'UJI-%'); " +
      "DELETE FROM products WHERE sku LIKE 'UJI-%';"]);
    const n = execFileSync('sqlite3', [DB,
      // Invarian suite ini: sisa produk UJI-% harus 0, sales 0, tombstone 0.
      // BUKAN total produk — suite lain (impor) boleh meninggalkan artefaknya
      // sendiri, dan menghitung total membuat suite ini gagal karena urutan run.
      "SELECT (SELECT COUNT(*) FROM products WHERE sku LIKE 'UJI-%')||'|'||(SELECT COUNT(*) FROM sales)||'|'||(SELECT COUNT(*) FROM products WHERE deleted_at IS NOT NULL)"],
      { encoding: 'utf8' }).trim();
    return n;
  } catch (e) { return 'gagal: ' + String(e).slice(0, 120); }
};

const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
let lolos = 0, gagal = 0;
const chk = (n, ok, d = '') => {
  if (ok) lolos++; else gagal++;
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'} ${n}${d ? ' | ' + String(d).slice(0, 150) : ''}`);
};
const jget = async (p) => { const r = await fetch(API + p); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const jpost = async (p, b, m = 'POST') => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};

// ---------- setup ----------
const mk = async (sku, name, extra = {}) =>
  (await jpost('/api/products', { sku, name, category_slug: 'atk', unit: 'pcs', price: 1000, cost: 500, markup: 100, stock: 0, is_active: 1, ...extra })).j.data;

const p1 = await mk('UJI-HAPUS-1', 'Uji Hapus Satu');   // belum pernah terjual -> boleh dihapus
const p2 = await mk('UJI-HAPUS-2', 'Uji Hapus Dua', { stock: 5 }); // akan dijual -> harus ditolak
const p3 = await mk('UJI-HAPUS-POS', 'Uji Hapus Via POS');        // untuk uji purge cache kasir
console.log(`setup: id1=${p1.id} id2=${p2.id} id3=${p3.id}`);
const v0 = (await jget('/api/products?since=0')).j.maxVersion;
const shift = (await jget('/api/shifts/open')).j?.data;

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));

try {
  // ---------- A. tombol hapus + dialog ----------
  console.log('=== A. Tombol hapus & dialog konfirmasi ===');
  await pg.goto(`${WEB}/#/products`, { waitUntil: 'networkidle' });
  await pg.waitForSelector('#rows tr[data-row]', { timeout: 15000 });
  await pg.waitForTimeout(900);
  const tombol = await pg.evaluate(() => {
    const rows = [...document.querySelectorAll('#rows tr[data-row]')];
    return { total: rows.length, denganTombol: rows.filter((r) => r.querySelector('[data-del]')).length,
      judul: rows[0]?.querySelector('[data-del]')?.getAttribute('title'),
      aria: rows[0]?.querySelector('[data-del]')?.getAttribute('aria-label') };
  });
  chk('tiap baris punya tombol Hapus', tombol.total > 0 && tombol.total === tombol.denganTombol, `${tombol.denganTombol}/${tombol.total}`);
  chk('tombol punya judul + aria-label', tombol.judul === 'Hapus produk' && /^Hapus /.test(tombol.aria ?? ''), JSON.stringify(tombol));

  await pg.click(`#rows tr[data-row="${p1.id}"] [data-del]`);
  await pg.waitForSelector('.swal2-popup', { timeout: 8000 });
  await pg.waitForTimeout(600);
  const dlg = await pg.evaluate(() => ({
    judul: document.querySelector('.swal2-title')?.textContent?.trim(),
    isi: document.querySelector('.swal2-html-container')?.textContent?.replace(/\s+/g, ' ').trim(),
    ok: !!document.querySelector('.swal2-confirm'),
    okLabel: document.querySelector('.swal2-confirm')?.textContent?.trim(),
    cancel: document.querySelector('.swal2-cancel')?.textContent?.trim(),
  }));
  chk('dialog menampilkan nama produk', (dlg.judul ?? '').includes('Uji Hapus Satu'), dlg.judul);
  chk('dialog menjelaskan guard "pernah terjual"', (dlg.isi ?? '').includes('pernah terjual'), (dlg.isi ?? '').slice(0, 90));
  chk('tombol OK berlabel "Hapus permanen"', dlg.okLabel === 'Hapus permanen', dlg.okLabel);
  chk('ada tombol batal berlabel jelas', dlg.cancel === 'Batal', dlg.cancel);

  await pg.click('.swal2-cancel');   // batalkan
  await pg.waitForTimeout(700);
  chk('batal -> dialog tertutup', (await pg.locator('.swal2-popup').count()) === 0);
  chk('batal -> produk MASIH ada di tabel', (await pg.locator(`#rows tr[data-row="${p1.id}"]`).count()) === 1);
  chk('batal -> MASIH ada di API', (await jget('/api/products?since=0')).j.data.some((x) => x.id === p1.id));

  // ---------- B. hapus sukses + tombstone ----------
  console.log('=== B. Hapus sukses + tombstone di delta ===');
  await pg.click(`#rows tr[data-row="${p1.id}"] [data-del]`);
  await pg.waitForSelector('.swal2-popup');
  await pg.waitForTimeout(500);
  await pg.click('.swal2-confirm');
  await pg.locator(`#rows tr[data-row="${p1.id}"]`).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await pg.waitForTimeout(600);
  chk('hilang dari tabel', (await pg.locator(`#rows tr[data-row="${p1.id}"]`).count()) === 0);
  chk('hilang dari list biasa', !(await jget('/api/products?since=0')).j.data.some((x) => x.id === p1.id));
  chk('hilang dari filter Nonaktif juga', !(await jget('/api/products?status=nonaktif')).j.data.some((x) => x.id === p1.id));
  const del = await pg.evaluate(() => document.querySelector('.toast-root .toast')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  chk('toast sukses muncul', del.includes('dihapus'), del);

  const delta = (await jget(`/api/products?since=${v0}`)).j.data;
  const t = delta.find((x) => x.id === p1.id);
  chk('tombstone terkirim lewat ?since=', !!t, t ? `deleted_at=${t.deleted_at} version=${t.version}` : 'tidak ada di delta');
  chk('tombstone membawa deleted_at terisi', !!t && !!t.deleted_at, t?.deleted_at);
  chk('version naik (bisa ditarik client)', !!t && t.version > v0, t && `${v0} -> ${t.version}`);

  // ---------- C. cache kasir (POS) benar2 dibuang ----------
  console.log('=== C. Cache kasir (POS) membuang produk terhapus ===');
  await pg.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
  await pg.waitForSelector('#pos-q', { timeout: 15000 });
  await pg.waitForTimeout(2500);                       // beri waktu syncMaster()
  await pg.fill('#pos-q', 'Uji Hapus Via POS');
  await pg.waitForTimeout(700);
  const adaSebelum = await pg.evaluate(() =>
    /Uji Hapus Via POS/.test(document.querySelector('#pos-results')?.textContent ?? ''));
  chk('sebelum hapus: produk TERLIHAT di pencarian POS', adaSebelum);

  const hp = await jdelete(p3.id);
  chk('API hapus OK', hp.s === 200 && hp.j.data?.deleted === true, `HTTP ${hp.s} ${JSON.stringify(hp.j)}`);
  await pg.reload({ waitUntil: 'networkidle' });        // reload -> syncMaster() lagi
  await pg.waitForSelector('#pos-q', { timeout: 15000 });
  await pg.waitForTimeout(2500);
  await pg.fill('#pos-q', 'Uji Hapus Via POS');
  await pg.waitForTimeout(700);
  const adaSesudah = await pg.evaluate(() =>
    /Uji Hapus Via POS/.test(document.querySelector('#pos-results')?.textContent ?? ''));
  chk('setelah hapus: produk DIBUANG dari cache POS', !adaSesudah, adaSesudah ? 'MASIH TAMPIL — tombstone tidak diproses' : 'hilang (syncMaster membuang tombstone)');

  // ---------- D. guard produk pernah terjual ----------
  console.log('=== D. Guard: produk pernah terjual ===');
  const sale = await jpost('/api/sales', {
    id: 'uuid-uji-hapus-dua', shift_id: shift?.id ?? 1,
    items: [{ product_id: p2.id, qty: 1, price: 1000 }], pay_method: 'tunai',
  });
  // POST /api/sales membalas 201 (dibuat) — 200 dipakai saat idempotent hit.
  const saleOk = (sale.s === 201 || sale.s === 200) && sale.j.data?.sale?.id === 'uuid-uji-hapus-dua';
  chk('penjualan tercatat (syarat guard)', saleOk, `HTTP ${sale.s} ${JSON.stringify(sale.j.data?.sale?.id ?? sale.j.error ?? '')}`);

  await pg.goto(`${WEB}/#/products`, { waitUntil: 'networkidle' });
  await pg.waitForSelector('#rows tr[data-row]', { timeout: 15000 });
  await pg.waitForTimeout(900);
  await pg.click(`#rows tr[data-row="${p2.id}"] [data-del]`);
  await pg.waitForSelector('.swal2-popup');
  await pg.waitForTimeout(500);
  await pg.click('.swal2-confirm');
  await pg.waitForTimeout(1200);
  const err = await pg.evaluate(() =>
    [...document.querySelectorAll('.toast-root .toast')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' || '));
  const p2sekarang = (await jget('/api/products?since=0')).j.data.find((x) => x.id === p2.id);
  chk('toast error menjelaskan guard', /sudah pernah terjual/.test(err), err.slice(0, 130));
  chk('produk TETAP di API (deleted_at null)', !!p2sekarang && p2sekarang.deleted_at === null, JSON.stringify({ ada: !!p2sekarang, deleted: p2sekarang?.deleted_at }));
  chk('produk TETAP di tabel (tidak hilang)', (await pg.locator(`#rows tr[data-row="${p2.id}"]`).count()) === 1);

  chk('tanpa pageerror browser', errs.length === 0, errs.join(' || '));
} finally {
  await b.close();
}

async function jdelete(id) { return jpost(`/api/products/${id}`, undefined, 'DELETE'); }

// ---------- cleanup: DB dev harus kembali bersih ----------
const akhir = cleanupDB();
const [nProd, nSales, nTomb] = akhir.split('|').map(Number);
console.log(`\ncleanup DB: sisa UJI-% = ${nProd}, sales = ${nSales}, tombstone = ${nTomb} (harus 0|0|0)`);
chk('cleanup DB: 0 sisa UJI-% / 0 sales / 0 tombstone', nProd === 0 && nSales === 0 && nTomb === 0, akhir);
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
