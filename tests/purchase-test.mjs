// Pembelian / kulakan Tahap 3: PO order -> receive (stok+avg) -> pay/cancel.
// Bawaan tunai penuh; sisa hutang didukung; kas keluar = terbayar di shift PO.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const post = (path, body) => p.evaluate(
  ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  [path, body],
);
async function w(sel, v) { await p.fill(sel, v); await p.waitForTimeout(150); }

await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

// Setup: supplier tetap (pakai ulang antar-run, tak menumpuk) + produk unik.
const supAda = await api('/api/suppliers?q=' + encodeURIComponent('UjiPO Sup Tetap'));
const supId = supAda.data.length
  ? supAda.data[0].id
  : (await post('/api/suppliers', { name: 'UjiPO Sup Tetap' })).json.data.id;
const TS = Date.now();
const NF = `UjiPO Fisik ${TS}`;
const QF = encodeURIComponent(NF);
const prod = await post('/api/products', { name: NF, category_slug: 'atk', price: 5000, stock: 10 });
const prodId = prod.json.data.id;
const prodSku = prod.json.data.sku;
const jasa = await post('/api/products', { name: `UjiPO Jasa ${TS}`, category_slug: 'jasa', price: 20000 });
const jasaSku = jasa.json.data.sku;
const shift = await api('/api/shifts/open?cashier=kasir');

console.log('=== A. Buat PO ===');
const o1 = await post('/api/purchases', {
  supplier_id: supId, items: [{ product_id: prodId, qty: 2, harga_beli: 1000 }], note: 'UjiPO', cashier: 'kasir',
});
chk('POST PO -> 201 order terbayar 0 + snapshot supplier', o1.status === 201 && o1.json.data.purchase.status === 'order'
  && o1.json.data.purchase.total === 2000 && o1.json.data.purchase.terbayar === 0
  && o1.json.data.purchase.supplier_name === 'UjiPO Sup Tetap', JSON.stringify(o1.json.data?.purchase));
chk('PO tanpa supplier -> 201 nama kosong', (await post('/api/purchases', { items: [{ product_id: prodId, qty: 1, harga_beli: 500 }] })).json.data.purchase.supplier_name === '');
chk('supplier ngawur -> 404', (await post('/api/purchases', { supplier_id: 999999, items: [{ product_id: prodId, qty: 1, harga_beli: 1 }] })).status === 404);
chk('jasa ditolak (bukan fisik) -> 400', (await post('/api/purchases', { items: [{ product_id: jasa.json.data.id, qty: 1, harga_beli: 1 }] })).status === 400);
chk('items kosong -> 400', (await post('/api/purchases', { items: [] })).status === 400);
chk('harga negatif -> 400', (await post('/api/purchases', { items: [{ product_id: prodId, qty: 1, harga_beli: -1 }] })).status === 400);
const stokAwal = (await api(`/api/products?q=${QF}`)).data[0]?.stock;
chk('order TANPA sentuh stok', stokAwal === 10, `stok=${stokAwal}`);

console.log('=== B. Receive: stok + avg rumus restock ===');
const v1 = await post(`/api/purchases/${o1.json.data.purchase.id}/receive`, { shift_id: shift.data.id });
chk('receive default lunas (terbayar=total)', v1.status === 200 && v1.json.data.status === 'received'
  && v1.json.data.terbayar === 2000 && !!v1.json.data.received_at, JSON.stringify(v1.json.data));
const pr1 = (await api(`/api/products?q=${QF}`)).data[0];
chk('stok 10+2=12 & avg=(0+2000)/12=167', pr1?.stock === 12 && pr1?.avg_cost === 167, `stok=${pr1?.stock} avg=${pr1?.avg_cost}`);
chk("moves reason=beli ref PO", sql(`SELECT COUNT(*) FROM stock_moves WHERE reason='beli' AND ref_id='PO-${o1.json.data.purchase.id}' AND product_id=${prodId} AND qty=2;`) === '1');
chk('receive 2x -> 400', (await post(`/api/purchases/${o1.json.data.purchase.id}/receive`, {})).status === 400);
chk('receive PO ngawur -> 404', (await post('/api/purchases/999999/receive', {})).status === 404);
const oH = await post('/api/purchases', { items: [{ product_id: prodId, qty: 4, harga_beli: 2000 }] });
chk('dibayar > total -> 400', (await post(`/api/purchases/${oH.json.data.purchase.id}/receive`, { dibayar: 99999 })).status === 400);
chk('dibayar negatif -> 400', (await post(`/api/purchases/${oH.json.data.purchase.id}/receive`, { dibayar: -1 })).status === 400);
chk('shift ngawur -> 400', (await post(`/api/purchases/${oH.json.data.purchase.id}/receive`, { shift_id: 999999 })).status === 400);

console.log('=== C. Hutang + cicil + cancel ===');
const vH = await post(`/api/purchases/${oH.json.data.purchase.id}/receive`, { dibayar: 1000 });
chk('hutang 7000 tercatat (sisa)', vH.status === 200 && vH.json.data.terbayar === 1000, JSON.stringify(vH.json.data));
const gh1 = await api('/api/purchases?status=hutang');
chk('filter hutang: hanya received bersisa + PO bersisa ikut',
  gh1.data.some((o) => o.id === oH.json.data.purchase.id && o.sisa === 7000)
  && gh1.data.every((o) => o.status === 'received' && o.sisa > 0), `n=${gh1.total}`);
const y1 = await post(`/api/purchases/${oH.json.data.purchase.id}/pay`, { amount: 3000 });
chk('cicil 3000 -> sisa 4000', y1.status === 200 && y1.json.data.terbayar === 4000, JSON.stringify(y1.json.data));
chk('bayar melebihi sisa -> 400', (await post(`/api/purchases/${oH.json.data.purchase.id}/pay`, { amount: 99999 })).status === 400);
const y2 = await post(`/api/purchases/${oH.json.data.purchase.id}/pay`, { amount: 4000 });
chk('lunasi -> sisa 0', y2.status === 200 && (y2.json.data.total - y2.json.data.terbayar) === 0);
chk('lunasi -> keluar dari filter hutang', !(await api('/api/purchases?status=hutang')).data.some((o) => o.id === oH.json.data.purchase.id));
chk('bayar setelah lunas -> 400', (await post(`/api/purchases/${oH.json.data.purchase.id}/pay`, { amount: 100 })).status === 400);
const oC = await post('/api/purchases', { items: [{ product_id: prodId, qty: 1, harga_beli: 100 }] });
chk('cancel order -> cancel', (await post(`/api/purchases/${oC.json.data.purchase.id}/cancel`, {})).json.data.status === 'cancel');
chk('cancel received -> 400', (await post(`/api/purchases/${o1.json.data.purchase.id}/cancel`, {})).status === 400);

console.log('=== D. Daftar + guard supplier + agregat ===');
const gl = await api('/api/purchases?status=order');
chk('filter order hanya order', gl.data.length >= 1 && gl.data.every((o) => o.status === 'order'), `n=${gl.total}`);
chk('status ngawur -> 400', await p.evaluate(() => fetch('/api/purchases?status=rusak').then((r) => r.status)) === 400);
chk('detail memuat baris + sisa', (await api(`/api/purchases/${o1.json.data.purchase.id}`)).data.items.length === 1);
chk('supplier dipakai PO -> 400', await p.evaluate((id) => fetch(`/api/suppliers/${id}`, { method: 'DELETE' }).then((r) => r.status), supId) === 400);
const sh = await api('/api/shifts?cashier=kasir&status=open');
const bs = sh.data.find((s) => s.id === shift.data.id);
chk('agregat purchase_total = terbayar shift', bs?.n_purchase >= 1 && bs?.purchase_total >= 2000, JSON.stringify({ n: bs?.n_purchase, tot: bs?.purchase_total }));
const dl = await api(`/api/reports/daily?date=${new Date().toISOString().slice(0, 10)}`);
chk('daily purchase ikut', dl.data.purchase.n >= 2, JSON.stringify(dl.data.purchase));

console.log('=== E. UI halaman purchases (sub-halaman, bukan modal) ===');
await p.goto('http://localhost:5656/#/purchases', { waitUntil: 'networkidle' });
await p.waitForSelector('#po-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('nav "Pembelian" aktif', await p.locator('a[href="#/purchases"].is-active').count() === 1);
await p.click('#po-new');
await p.waitForSelector('#po-q', { timeout: 10000 });
chk('Buat PO = HALAMAN #/purchases/baru (bukan modal)',
  p.url().includes('#/purchases/baru') && await p.locator('.modal-overlay').count() === 0, p.url());
// Dropdown disaring barang fisik (2026-10-17): jasa/cetak ditolak server,
// jadi tidak boleh bisa diklik dari hasil cari.
await w('#po-q', `UjiPO Jasa ${TS}`); await p.waitForTimeout(900);
const jv = await p.evaluate(() => {
  const h = document.querySelector('#po-hasil');
  return { ada: !!h?.querySelector('[data-po-pilih]'), teks: (h?.textContent ?? '').trim().slice(0, 60) };
});
chk('dropdown cari = barang fisik saja (jasa tidak ditawarkan)', !jv.ada, JSON.stringify(jv));
// Pencarian = dropdown: klik hasil → baris masuk (qty 1, harga beli master),
// lalu qty/harga diedit di tabel baris.
await w('#po-q', NF); await p.waitForTimeout(900);
await p.click('[data-po-pilih]'); await p.waitForTimeout(300);
await w('[data-po-qty="0"]', '3');
await w('[data-po-hb="0"]', '1500');
await p.click('#po-simpan');
// Kembali ke daftar (hash #/purchases); poll sampai baris PO hasil simpan muncul.
let barisBaru = { ok: false, teks: '' };
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(250);
  barisBaru = await p.evaluate(() => {
    const t = (document.querySelector('#po-body')?.textContent ?? '').replace(/\s+/g, ' ');
    return { ok: t.includes('Rp4.500'), teks: t.slice(0, 120) };
  });
  if (barisBaru.ok) break;
}
chk('simpan PO via halaman -> baris muncul di daftar',
  barisBaru.ok && !p.url().includes('/baru'), barisBaru.teks);
await p.click('[data-pstatus="received"]');
// Poll kondisi terminal (bukan timeout buta): tabel terisi ATAU pesan
// kosong/error — diukur atomik dalam satu evaluate supaya tak kena jendela
// skeleton di antara dua pembacaan terpisah.
let hasil = { tr: 0, teks: '' };
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(250);
  hasil = await p.evaluate(() => {
    const root = document.querySelector('#po-body');
    const teks = (root?.textContent ?? '').replace(/\s+/g, ' ');
    return { tr: root ? root.querySelectorAll('tbody tr').length : 0, teks: teks.slice(0, 80) };
  });
  if (hasil.tr >= 1 || /Belum ada|Gagal/.test(hasil.teks)) break;
}
chk('filter Diterima', hasil.tr >= 1, JSON.stringify(hasil));
// Filter "Belum lunas" (baru 2026-10-17): tiap baris yang tampil wajib
// received bersisa → badge-nya selalu "Hutang Rp…" (atau daftar kosong sah).
await p.click('[data-pstatus="hutang"]');
let zh = { ok: false, n: 0, teks: '' };
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(250);
  zh = await p.evaluate(() => {
    const root = document.querySelector('#po-body');
    const rows = [...(root?.querySelectorAll('tbody tr') ?? [])];
    const teks = (root?.textContent ?? '').replace(/\s+/g, ' ');
    if (/Gagal/.test(teks)) return { ok: false, n: -1, teks: teks.slice(0, 100) };
    if (/Belum ada/.test(teks)) return { ok: true, n: 0, teks: teks.slice(0, 100) };
    if (rows.length === 0) return { ok: false, n: 0, teks: teks.slice(0, 100) };
    return { ok: rows.every((r) => (r.textContent ?? '').includes('Hutang Rp')), n: rows.length, teks: teks.slice(0, 100) };
  });
  if (zh.ok) break;
}
chk('filter Belum lunas: hanya baris bersisa hutang', zh.ok, JSON.stringify(zh));
const poUi = (await api('/api/purchases?status=order')).data[0];
await p.click('[data-pstatus="semua"]'); await p.waitForTimeout(900);
await p.click(`[data-po-buka="${poUi.id}"]`);
await p.waitForSelector('#pt-bayar', { timeout: 10000 });
chk('rincian PO = HALAMAN detail (bukan modal)',
  p.url().includes(`#/purchases/${poUi.id}`) && await p.locator('.modal-overlay').count() === 0, p.url());
await p.click('#pt-ok');
// Poll sampai receive selesai (kondisi terminal lewat API, bukan timeout buta).
let poStatus = '';
for (let i = 0; i < 40; i++) {
  await p.waitForTimeout(250);
  poStatus = (await api(`/api/purchases/${poUi.id}`)).data.purchase.status;
  if (poStatus === 'received') break;
}
chk('terima lunas via halaman -> status received', poStatus === 'received', poStatus);
await p.click('[data-po-kembali]');
await p.waitForSelector('#po-body', { timeout: 10000 });
chk('tombol Kembali -> daftar', /#\/purchases$/.test(p.url()), p.url());

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));

// Bersihkan (browser masih dibutuhkan): cancel PO order Uji, nonaktifkan
// produk uji + opname ke stok awal. PO received = arsip sah (dibiarkan,
// seperti nota uji lain); supplier tetap dipakai ulang antar-run.
for (const o of (await api('/api/purchases?status=order')).data) {
  const det = await api(`/api/purchases/${o.id}`);
  if (det.data.items.some((it) => /UjiPO/.test(it.name))) {
    await post(`/api/purchases/${o.id}/cancel`, {});
  }
}
// Upsert by SKU (kontrak POST /api/products — field `id` diabaikan server),
// sku diambil dari respons setup (bukan GET ulang yang bisa salah sasaran).
const nonF = await post('/api/products', { sku: prodSku, name: NF, category_slug: 'atk', price: 5000, is_active: 0 });
const nonJ = await post('/api/products', { sku: jasaSku, name: `UjiPO Jasa ${TS}`, category_slug: 'jasa', price: 20000, is_active: 0 });
chk('cleanup: produk uji nonaktif', nonF.json.data?.is_active === 0 && nonJ.json.data?.is_active === 0, `${nonF.status}/${nonJ.status}`);
await post('/api/stock-opname', { product_id: prodId, qty_fisik: 10 });
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
