// Retur ke supplier (butir ROADMAP 1.9, ACC pemilik 2026-10-25) — kontrak yang
// dijaga suite ini:
//   - `POST /:id/returns` {items:[{purchase_item_id,qty}],note,client_id}:
//     qty ≤ diterima − sudah_diretur per baris; PO cancel / tanpa kedatangan
//     ditolak; baris duplikat ditolak.
//   - Stok KELUAR: stock_moves reason='retur-beli' qty NEGATIF, unit_cost =
//     harga_beli baris PO, products.version naik (aturan mutasi products).
//   - `sisa` hutang = max(0, diterima − retur_total − terbayar) (computed di
//     SQL_PO_HIT); `diterima` tetap GROSS; retur_total/n_retur ikut
//     list/detail/POST. Retur TIDAK menggerakkan laci (uang kembali dicatat
//     manual di Kas masuk — desain ROADMAP §1.9).
//   - `client_id` idempoten (retry = duplicate:true tanpa efek ganda).
//   - cancel PO ditolak bila n_retur > 0 (guard eksplisit).
//   - detail GET mengirim returns[] (mirror receives[]); laporan harian
//     `purchase_retur:{n,total}` per tanggal retur.
// UI: form retur per baris (bawaan 0), nilai live #pr-total, kirim = toast +
// riwayat retur + re-render; form HILANG saat semua yang datang sudah
// diretur; PO tanpa kedatangan tidak punya form retur.
// Data uji note EKSAK 'UjiPO Retur' + self-heal + cleanup ber-scope id
// (stok dikembalikan NET = kedatangan − retur; jangan DELETE tanpa WHERE).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
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
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
const WEB = 'http://localhost:5656';
const NOTE = 'UjiPO Retur';

/** Hapus SEMUA PO milik suite (note eksak) + kembalikan stok NET-nya.
 *  Self-heal di awal (sisa run crash) + cleanup di akhir. CLI sqlite3 TIDAK
 *  menegakkan ON DELETE CASCADE — anak dihapus eksplisit (retur → receive →
 *  items → purchases; stock_moves per ref_id sebelum induknya hilang). */
function bersihkanPo() {
  const ids = sql(`SELECT id FROM purchases WHERE note = '${NOTE}'`).split('\n').filter(Boolean).map(Number);
  for (const id of ids) {
    const recv = sql(
      `SELECT pi.product_id, SUM(ri.qty)
         FROM purchase_receive_items ri
         JOIN purchase_receives r ON r.id = ri.receive_id
         JOIN purchase_items pi ON pi.id = ri.purchase_item_id
        WHERE r.purchase_id = ${id} GROUP BY pi.product_id`,
    ).split('\n').filter(Boolean);
    const ret = sql(
      `SELECT pi.product_id, SUM(pri.qty)
         FROM purchase_return_items pri
         JOIN purchase_returns pr ON pr.id = pri.retur_id
         JOIN purchase_items pi ON pi.id = pri.purchase_item_id
        WHERE pr.purchase_id = ${id} GROUP BY pi.product_id`,
    ).split('\n').filter(Boolean);
    const net = new Map();
    for (const row of recv) { const [pid, q] = row.split('|').map(Number); net.set(pid, (net.get(pid) ?? 0) + q); }
    for (const row of ret) { const [pid, q] = row.split('|').map(Number); net.set(pid, (net.get(pid) ?? 0) - q); }
    for (const [pid, q] of net) {
      if (pid && q > 0) sql(`UPDATE products SET stock = stock - ${q}, version = (SELECT COALESCE(MAX(version),0)+1 FROM products) WHERE id = ${pid};`);
    }
    const returIds = sql(`SELECT id FROM purchase_returns WHERE purchase_id = ${id}`).split('\n').filter(Boolean);
    if (returIds.length) {
      sql(`DELETE FROM stock_moves WHERE ref_id IN (${returIds.map((r) => `'PR-${r}'`).join(',')});`);
      sql(`DELETE FROM purchase_return_items WHERE retur_id IN (${returIds.join(',')});`);
      sql(`DELETE FROM purchase_returns WHERE id IN (${returIds.join(',')});`);
    }
    sql(`DELETE FROM stock_moves WHERE ref_id = 'PO-${id}';`);
    sql(`DELETE FROM purchase_receive_items WHERE receive_id IN (SELECT id FROM purchase_receives WHERE purchase_id = ${id});`);
    sql(`DELETE FROM purchase_receives WHERE purchase_id = ${id};`);
    sql(`DELETE FROM purchase_items WHERE purchase_id = ${id};`);
    sql(`DELETE FROM purchases WHERE id = ${id};`);
  }
  sql(`DELETE FROM suppliers WHERE name = '${NOTE} Sup';`);
  sql(`DELETE FROM users WHERE username LIKE 'ujipo-retur%';`);
}

bersihkanPo();

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
let produkIds = [];

try {
  await pasangToken(p);
  const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
  const post = (path, body) => p.evaluate(
    ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
    [path, body],
  );
  const TS = Date.now();
  const NA = `${NOTE} A ${TS}`;
  const NB = `${NOTE} B ${TS}`;

  await p.goto(`${WEB}/#/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  // Setup: supplier + dua produk fisik unik (nama ber-TS; note PO EKSAK untuk
  // self-heal). Shift dibuka runner pola suite lain.
  const supAda = await api('/api/suppliers?q=' + encodeURIComponent(`${NOTE} Sup`));
  const supId = supAda.data.length ? supAda.data[0].id : (await post('/api/suppliers', { name: `${NOTE} Sup` })).json.data.id;
  const prodA = await post('/api/products', { name: NA, category_slug: 'atk', price: 5000, stock: 0 });
  const prodB = await post('/api/products', { name: NB, category_slug: 'atk', price: 3000, stock: 0 });
  const paId = prodA.json.data.id;
  const pbId = prodB.json.data.id;
  produkIds = [paId, pbId];
  await api('/api/shifts/open?cashier=kasir');
  const hari = new Date().toISOString().slice(0, 10);
  const returHarianAwal = (await api(`/api/reports/daily?date=${hari}`)).data.purchase_retur ?? { n: 0, total: 0 };
  const stokAwal = (await api(`/api/products?q=${encodeURIComponent(NA)}`)).data.find((x) => x.name === NA).stock;
  const versionAwal = Number(sql(`SELECT version FROM products WHERE id = ${paId}`));

  console.log('=== A. PO + terima penuh TANPA bayar (hutang penuh) ===');
  const o = await post('/api/purchases', {
    supplier_id: supId,
    note: NOTE,
    items: [{ product_id: paId, qty: 6, harga_beli: 1000 }],
  });
  const poId = o.json.data.purchase.id;
  const itemId = o.json.data.items[0].id;
  chk('PO dibuat (order, tanpa stok)', o.status === 201 && o.json.data.purchase.status_tampil === 'order');
  const recv = await post(`/api/purchases/${poId}/receive`, { dibayar: 0, client_id: `uji-retur-recv-${TS}` });
  chk('terima semua: status received + diterima 6000',
    recv.json.data.status_tampil === 'received' && recv.json.data.diterima === 6000);
  chk('sisa hutang 6000 (dibayar 0)', recv.json.data.sisa === 6000);
  const stokSetelahTerima = (await api(`/api/products?q=${encodeURIComponent(NA)}`)).data.find((x) => x.name === NA).stock;
  chk('stok naik 6', stokSetelahTerima === stokAwal + 6, `${stokAwal} -> ${stokSetelahTerima}`);

  console.log('=== B. Retur 2 dari 6 (API) ===');
  const versiSebelumRetur = Number(sql(`SELECT version FROM products WHERE id = ${paId}`));
  const r1 = await post(`/api/purchases/${poId}/returns`, {
    items: [{ purchase_item_id: itemId, qty: 2 }],
    note: 'kemasan rusak',
    client_id: `uji-retur-1-${TS}`,
  });
  chk('retur dicatat (n_retur 1)', r1.status === 200 && r1.json.data.n_retur === 1);
  chk('retur_total 2000', r1.json.data.retur_total === 2000);
  chk('sisa hutang turun 6000 -> 4000', r1.json.data.sisa === 4000);
  const stokSetelahRetur = (await api(`/api/products?q=${encodeURIComponent(NA)}`)).data.find((x) => x.name === NA).stock;
  chk('stok turun 2', stokSetelahRetur === stokSetelahTerima - 2, `${stokSetelahTerima} -> ${stokSetelahRetur}`);
  const move = sql(`SELECT qty, reason, unit_cost FROM stock_moves WHERE ref_id LIKE 'PR-%' AND product_id = ${paId} ORDER BY id DESC LIMIT 1`);
  chk('stock_moves retur-beli qty NEGATIF + unit_cost harga PO',
    /^-2(\.0)?\|retur-beli\|1000$/.test(move), move);
  const versiSetelahRetur = Number(sql(`SELECT version FROM products WHERE id = ${paId}`));
  chk('products.version naik (delta sync)', versiSetelahRetur > versiSebelumRetur, `${versiSebelumRetur} -> ${versiSetelahRetur}`);

  console.log('=== C. Idempotensi client_id ===');
  const r2 = await post(`/api/purchases/${poId}/returns`, {
    items: [{ purchase_item_id: itemId, qty: 2 }],
    note: 'kemasan rusak',
    client_id: `uji-retur-1-${TS}`,
  });
  chk('retry = duplicate:true', r2.json.data.duplicate === true);
  chk('n_retur TETAP 1 (tidak dobel)', r2.json.data.n_retur === 1);
  const stokSetelahRetry = (await api(`/api/products?q=${encodeURIComponent(NA)}`)).data.find((x) => x.name === NA).stock;
  chk('stok TETAP (tidak berkurang dua kali)', stokSetelahRetry === stokSetelahRetur);

  console.log('=== D. Guard retur ===');
  const lebih = await post(`/api/purchases/${poId}/returns`, { items: [{ purchase_item_id: itemId, qty: 5 }] });
  chk('qty melebihi sisa retur -> 400', lebih.status === 400 && /melebihi sisa retur/.test(lebih.json.error), lebih.json.error);
  const o2 = await post('/api/purchases', {
    supplier_id: supId, note: NOTE,
    items: [{ product_id: pbId, qty: 2, harga_beli: 2500 }],
  });
  const poId2 = o2.json.data.purchase.id;
  const kosong = await post(`/api/purchases/${poId2}/returns`, { items: [{ purchase_item_id: o2.json.data.items[0].id, qty: 1 }] });
  chk('PO tanpa kedatangan -> 400', kosong.status === 400 && /belum ada barang/.test(kosong.json.error), kosong.json.error);
  await post(`/api/purchases/${poId2}/cancel`, {});
  const batal = await post(`/api/purchases/${poId2}/returns`, { items: [{ purchase_item_id: o2.json.data.items[0].id, qty: 1 }] });
  chk('PO cancel -> 400', batal.status === 400 && /dibatalkan/.test(batal.json.error), batal.json.error);
  const cobaCancel = await post(`/api/purchases/${poId}/cancel`, {});
  chk('PO ber-retur/kedatangan tidak bisa dibatalkan', cobaCancel.status === 400, cobaCancel.json.error);

  console.log('=== E. UI: form retur (bisa 4) + kirim sisa ===');
  await p.goto(`${WEB}/#/purchases/${poId}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  const inp = p.locator('[data-pr-qty]').first();
  chk('form retur tampil + bisa diretur 4', (await inp.count()) === 1 && (await inp.getAttribute('data-bisa')) === '4');
  chk('sub baris: diterima 6 · bisa 4', (await p.locator('.card', { hasText: 'Retur ke supplier' }).first().textContent()).includes('diterima 6'));
  await p.fill('[data-pr-qty]', '4');
  await p.waitForTimeout(250);
  chk('#pr-total live = Rp4.000', (await p.textContent('#pr-total')) === 'Rp4.000');
  chk('hint Kas masuk (tidak menggerakkan laci)', (await p.locator('#pr-ok').locator('xpath=ancestor::div[contains(@class,"card")]').first().textContent()).includes('Kas masuk'));
  await p.click('#pr-ok');
  await p.waitForTimeout(1200);
  chk('riwayat retur tampil setelah kirim', (await p.locator('h3', { hasText: 'Riwayat retur ke supplier' }).count()) === 1);
  // Sisa 0 = baris tfoot "Sisa hutang" hilang dari tabel barang (Rp4.000 dari
  // riwayat retur TETAP tampil di tabel lain — jangan pakai body text).
  chk('tanpa baris Sisa hutang (sisa 0)', (await p.locator('td', { hasText: 'Sisa hutang' }).count()) === 0);
  const det1 = await api(`/api/purchases/${poId}`);
  chk('n_retur 2 setelah kirim UI', det1.data.purchase.n_retur === 2);
  const stokAkhir = (await api(`/api/products?q=${encodeURIComponent(NA)}`)).data.find((x) => x.name === NA).stock;
  chk('stok kembali ke stokAwal (6 masuk, 6 keluar)', stokAkhir === stokAwal, `${stokAkhir} vs ${stokAwal}`);
  chk('sisa 0 (lunas oleh retur)', det1.data.purchase.sisa === 0);
  chk('form retur HILANG (semua yang datang sudah diretur)', (await p.locator('[data-pr-qty]').count()) === 0);

  console.log('=== F. Detail returns[] + PO tanpa kedatangan tanpa form ===');
  chk('detail mengirim returns[] 2 event', det1.data.returns.length === 2);
  chk('items retur memuat snapshot nama + qty_po',
    det1.data.returns.every((r) => r.items.every((x) => x.name.includes(NA) && x.qty_po === 6)));
  await p.goto(`${WEB}/#/purchases/${poId2}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  chk('PO cancel: tanpa form retur + badge Batal', (await p.locator('[data-pr-qty]').count()) === 0);

  console.log('=== G. Laporan harian purchase_retur ===');
  const hari2 = (await api(`/api/reports/daily?date=${hari}`)).data.purchase_retur;
  chk('purchase_retur.n bertambah 2', hari2.n === returHarianAwal.n + 2, `${returHarianAwal.n} -> ${hari2.n}`);
  chk('purchase_retur.total bertambah 6000', hari2.total === returHarianAwal.total + 6000, `${returHarianAwal.total} -> ${hari2.total}`);
  chk('purchase (kedatangan) TIDAK ikut berubah oleh retur',
    (await api(`/api/reports/daily?date=${hari}`)).data.purchase.total >= 6000);

  chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
} catch (e) {
  fail++;
  console.log('  GAGAL | eksepsi:', String(e).slice(0, 300));
} finally {
  await b.close();
  for (const pid of produkIds) {
    try {
      sql(`DELETE FROM purchase_return_items WHERE purchase_item_id IN (SELECT id FROM purchase_items WHERE product_id = ${pid});`);
      sql(`DELETE FROM purchase_returns WHERE purchase_id IN (SELECT id FROM purchases WHERE note = '${NOTE}');`);
      sql(`DELETE FROM stock_moves WHERE product_id = ${pid};`);
      sql(`DELETE FROM products WHERE id = ${pid};`);
    } catch { /* cleanup terbaik; self-heal di awal run berikutnya */ }
  }
  bersihkanPo();
}

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [purchase-retur-test.mjs]`);
if (fail) process.exit(1);
