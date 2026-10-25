// Penerimaan PO BERTAHAP (butir ROADMAP 3.7, 2026-10-25): satu PO boleh
// datang berkali-kali. Kontrak yang dijaga suite ini:
//   - `POST /:id/receive` menerima `items:[{purchase_item_id,qty}]`; TANPA
//     `items` tetap = terima semua sisa (kompatibel pemanggil lama).
//   - status tersimpan tetap `order` sampai qty lengkap; "Sebagian" = computed
//     (`status_tampil`) — CHECK lama tidak diubah.
//   - `sisa` = nilai yang SUDAH diterima − terbayar (barang belum datang bukan
//     hutang); `sisa_terima` = progress barang.
//   - `dibayar` dicatat per KEDATANGAN → agregat shift & laporan harian ikut
//     tanggal event, bukan satu `received_at`; nota LAMA (received tanpa baris
//     kedatangan) tetap dihitung 1 event lewat fallback.
//   - `client_id` idempoten; cancel ditolak setelah ada penerimaan.
// UI: badge Sebagian + subline hutang, form qty per baris, riwayat kedatangan,
// A4 menampilkan kolom Diterima + label prioritas (hutang > belum datang >
// lunas). Data uji memakai note EKSAK 'UjiPO Sebagian' + self-heal + cleanup
// guest (stok/nota dihapus lewat id, bukan DELETE tanpa WHERE).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken, tungguDokumenA4 } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
const WEB = 'http://localhost:5656';
const NOTE = 'UjiPO Sebagian';

/** Hapus SEMUA PO milik suite (note eksak) + kembalikan stoknya. Dipakai
 *  sebagai self-heal di awal (sisa run yang crash) dan cleanup di akhir.
 *  CLI sqlite3 TIDAK menegakkan ON DELETE CASCADE — anak dihapus eksplisit. */
function bersihkanPo() {
  const ids = sql(`SELECT id FROM purchases WHERE note = '${NOTE}'`).split('\n').filter(Boolean).map(Number);
  for (const id of ids) {
    const status = sql(`SELECT status FROM purchases WHERE id = ${id}`);
    let rows = sql(
      `SELECT pi.product_id, SUM(ri.qty)
         FROM purchase_receive_items ri
         JOIN purchase_receives r ON r.id = ri.receive_id
         JOIN purchase_items pi ON pi.id = ri.purchase_item_id
        WHERE r.purchase_id = ${id} GROUP BY pi.product_id`,
    ).split('\n').filter(Boolean);
    // Nota LAMA (received tanpa baris kedatangan) pernah menambah stok penuh.
    if (!rows.length && status === 'received') {
      rows = sql(
        `SELECT product_id, SUM(qty) FROM purchase_items WHERE purchase_id = ${id} GROUP BY product_id`,
      ).split('\n').filter(Boolean);
    }
    for (const row of rows) {
      const [pid, qty] = row.split('|').map(Number);
      if (pid && qty > 0) sql(`UPDATE products SET stock = stock - ${qty} WHERE id = ${pid};`);
    }
    sql(`DELETE FROM stock_moves WHERE ref_id = 'PO-${id}';`);
    sql(`DELETE FROM purchase_receive_items WHERE receive_id IN (SELECT id FROM purchase_receives WHERE purchase_id = ${id});`);
    sql(`DELETE FROM purchase_receives WHERE purchase_id = ${id};`);
    sql(`DELETE FROM purchase_items WHERE purchase_id = ${id};`);
    sql(`DELETE FROM purchases WHERE id = ${id};`);
  }
}

bersihkanPo();

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
let produkIds = [];
let supUji = 0;

try {
  await pasangToken(p);
  const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
  const post = (path, body) => p.evaluate(
    ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
    [path, body],
  );
  const w = async (sel, v) => { await p.fill(sel, v); await p.waitForTimeout(200); };
  const qProduk = async (nama) => {
    const q = encodeURIComponent(nama);
    return (await api(`/api/products?q=${q}`)).data.find((x) => x.name === nama);
  };
  const tunggu = async (fn, label) => {
    for (let i = 0; i < 60; i++) {
      const v = await fn();
      if (v) return v;
      await p.waitForTimeout(200);
    }
    return label ? null : null;
  };

  await p.goto(`${WEB}/#/dashboard`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  // Setup: supplier tetap + dua produk unik (nama ber-TS supaya run paralel
  // tidak bertabrakan; note PO tetap EKSAK untuk self-heal).
  const supAda = await api('/api/suppliers?q=' + encodeURIComponent(`${NOTE} Sup`));
  const supId = supAda.data.length
    ? supAda.data[0].id
    : (await post('/api/suppliers', { name: `${NOTE} Sup` })).json.data.id;
  supUji = supId;
  const TS = Date.now();
  const NA = `${NOTE} A ${TS}`;
  const NB = `${NOTE} B ${TS}`;
  const prodA = await post('/api/products', { name: NA, category_slug: 'atk', price: 5000, stock: 0 });
  const prodB = await post('/api/products', { name: NB, category_slug: 'atk', price: 3000, stock: 0 });
  const paId = prodA.json.data.id;
  const pbId = prodB.json.data.id;
  produkIds = [paId, pbId];

  const shift = await api('/api/shifts/open?cashier=kasir');
  const shiftId = shift.data.id;
  const shAwal = (await api('/api/shifts?cashier=kasir&limit=200')).data.find((s) => s.id === shiftId);
  const hari = new Date().toISOString().slice(0, 10);
  const dlAwal = (await api(`/api/reports/daily?date=${hari}`)).data.purchase;
  const stokAwalA = (await qProduk(NA)).stock;
  const stokAwalB = (await qProduk(NB)).stock;

  console.log('=== A. Buat PO dua baris (tanpa sentuh stok) ===');
  const o = await post('/api/purchases', {
    supplier_id: supId,
    items: [
      { product_id: paId, qty: 4, harga_beli: 1000 },
      { product_id: pbId, qty: 2, harga_beli: 2500 },
    ],
    note: NOTE,
    cashier: 'kasir',
  });
  const poId = o.json.data?.purchase?.id;
  chk('POST PO -> 201 order: total 9.000, diterima 0, belum datang 9.000',
    o.status === 201 && o.json.data.purchase.status === 'order'
      && o.json.data.purchase.status_tampil === 'order'
      && o.json.data.purchase.total === 9000 && o.json.data.purchase.diterima === 0
      && o.json.data.purchase.sisa === 0 && o.json.data.purchase.sisa_terima === 9000
      && o.json.data.purchase.n_terima === 0, JSON.stringify(o.json.data?.purchase));

  const det0 = (await api(`/api/purchases/${poId}`)).data;
  const itemA = det0.items.find((it) => it.product_id === paId);
  const itemB = det0.items.find((it) => it.product_id === pbId);
  chk('detail awal: tiap baris diterima 0 + sisa = qty, riwayat kedatangan kosong',
    det0.items.length === 2 && det0.items.every((it) => it.diterima === 0 && it.sisa_terima === it.qty)
      && Array.isArray(det0.receives) && det0.receives.length === 0);
  chk('order TANPA sentuh stok', (await qProduk(NA)).stock === stokAwalA && (await qProduk(NB)).stock === stokAwalB,
    `A=${(await qProduk(NA)).stock} B=${(await qProduk(NB)).stock}`);

  console.log('=== B. Kedatangan pertama (sebagian) ===');
  const cid1 = `uji-po-sebagian-1-${TS}`;
  const r1 = await post(`/api/purchases/${poId}/receive`, {
    items: [{ purchase_item_id: itemA.id, qty: 1 }],
    shift_id: shiftId, cashier: 'kasir', note: 'datang 1', client_id: cid1,
  });
  chk('receive sebagian -> 200: event = qty 1 × 1.000, dibayar bawaan = nilai event',
    r1.status === 200 && r1.json.data.receive?.total === 1000
      && r1.json.data.receive?.dibayar === 1000 && r1.json.data.receive?.note === 'datang 1'
      && r1.json.data.receive?.client_id === cid1, JSON.stringify(r1.json.data?.receive));
  chk('status TERSIMPAN tetap order; tampil sebagian + progress benar',
    r1.json.data.status === 'order' && r1.json.data.status_tampil === 'sebagian'
      && r1.json.data.diterima === 1000 && r1.json.data.terbayar === 1000
      && r1.json.data.sisa === 0 && r1.json.data.sisa_terima === 8000
      && r1.json.data.n_terima === 1 && !!r1.json.data.received_at,
    JSON.stringify({ s: r1.json.data?.status, t: r1.json.data?.status_tampil, d: r1.json.data?.diterima }));
  chk('stok hanya baris yang datang (A +1, B tetap)', (await qProduk(NA)).stock === stokAwalA + 1
    && (await qProduk(NB)).stock === stokAwalB);
  // qty stock_moves REAL (dukung qty pecahan) -> CAST supaya '1|1', bukan '1|1.0'.
  chk('stock_moves beli ref PO tepat 1 baris qty 1',
    sql(`SELECT COUNT(*) || '|' || CAST(COALESCE(SUM(qty),0) AS INTEGER) FROM stock_moves
          WHERE reason='beli' AND ref_id='PO-${poId}' AND product_id=${paId};`) === '1|1');
  const fSeb = await api('/api/purchases?status=sebagian');
  const fOrd = await api('/api/purchases?status=order');
  const fRec = await api('/api/purchases?status=received');
  chk('filter sebagian memuat PO; order/received tidak (status tersimpan order)',
    fSeb.data.some((x) => x.id === poId) && !fOrd.data.some((x) => x.id === poId)
      && !fRec.data.some((x) => x.id === poId), `n=${fSeb.total}`);
  const batal1 = await post(`/api/purchases/${poId}/cancel`, {});
  chk('cancel setelah ada penerimaan -> 400 (koreksi lewat opname/pengeluaran)',
    batal1.status === 400 && /penerimaan/i.test(batal1.json.error ?? ''), batal1.json.error);
  chk('qty melebihi sisa -> 400',
    (await post(`/api/purchases/${poId}/receive`, { items: [{ purchase_item_id: itemA.id, qty: 4 }] })).status === 400);
  chk('purchase_item_id asing -> 400',
    (await post(`/api/purchases/${poId}/receive`, { items: [{ purchase_item_id: 999999, qty: 1 }] })).status === 400);
  chk('purchase_item_id duplikat -> 400',
    (await post(`/api/purchases/${poId}/receive`, {
      items: [{ purchase_item_id: itemA.id, qty: 1 }, { purchase_item_id: itemA.id, qty: 1 }],
    })).status === 400);
  chk('qty 0 -> 400',
    (await post(`/api/purchases/${poId}/receive`, { items: [{ purchase_item_id: itemA.id, qty: 0 }] })).status === 400);
  chk('items array kosong -> 400 (bukan diam-diam terima semua)',
    (await post(`/api/purchases/${poId}/receive`, { items: [] })).status === 400);
  chk('client_id > 64 karakter -> 400',
    (await post(`/api/purchases/${poId}/receive`, {
      items: [{ purchase_item_id: itemA.id, qty: 1 }], client_id: 'x'.repeat(65),
    })).status === 400);

  console.log('=== C. Idempotensi client_id ===');
  const r1b = await post(`/api/purchases/${poId}/receive`, {
    items: [{ purchase_item_id: itemA.id, qty: 1 }],
    shift_id: shiftId, cashier: 'kasir', note: 'datang 1', client_id: cid1,
  });
  chk('kirim ulang client_id -> 200 duplicate, id event SAMA',
    r1b.status === 200 && r1b.json.data.duplicate === true
      && r1b.json.data.receive?.id === r1.json.data.receive.id, JSON.stringify(r1b.json.data?.receive));
  chk('idempoten: stok & n_terima tidak bertambah',
    (await qProduk(NA)).stock === stokAwalA + 1
      && (await api(`/api/purchases/${poId}`)).data.purchase.n_terima === 1
      && (await api(`/api/purchases/${poId}`)).data.purchase.terbayar === 1000);
  const oX = await post('/api/purchases', {
    items: [{ product_id: paId, qty: 1, harga_beli: 100 }], note: NOTE, cashier: 'kasir',
  });
  const oXid = oX.json.data.purchase.id;
  chk('client_id dipakai PO lain -> 400 (kunci idempotensi unik global)',
    (await post(`/api/purchases/${oXid}/receive`, {
      items: [{ purchase_item_id: (await api(`/api/purchases/${oXid}`)).data.items[0].id, qty: 1 }],
      client_id: cid1,
    })).status === 400);
  await post(`/api/purchases/${oXid}/cancel`, {});

  console.log('=== D. Kedatangan berikut + bayar saat masih sebagian ===');
  const r2 = await post(`/api/purchases/${poId}/receive`, {
    items: [{ purchase_item_id: itemA.id, qty: 2 }], dibayar: 1500,
    shift_id: shiftId, cashier: 'kasir', client_id: `uji-po-sebagian-2-${TS}`,
  });
  chk('kedatangan 2 (qty 2 × 1.000, dibayar 1.500) -> diterima 3.000, hutang 500',
    r2.status === 200 && r2.json.data.diterima === 3000 && r2.json.data.terbayar === 2500
      && r2.json.data.sisa === 500 && r2.json.data.sisa_terima === 6000
      && r2.json.data.status_tampil === 'sebagian', JSON.stringify(r2.json.data));
  const p1 = await post(`/api/purchases/${poId}/pay`, { amount: 500 });
  chk('lunasi kekurangan saat barang BELUM lengkap -> sisa 0', p1.status === 200 && p1.json.data.sisa === 0
    && p1.json.data.terbayar === 3000, JSON.stringify(p1.json.data));
  chk('bayar lagi saat sisa 0 -> 400', (await post(`/api/purchases/${poId}/pay`, { amount: 100 })).status === 400);
  const r3 = await post(`/api/purchases/${poId}/receive`, {
    items: [{ purchase_item_id: itemB.id, qty: 2 }], dibayar: 0,
    shift_id: shiftId, cashier: 'kasir', client_id: `uji-po-sebagian-3-${TS}`,
  });
  chk('kedatangan 3 (barang lain, dibayar 0) -> hutang 5.000, sisa barang 1.000',
    r3.status === 200 && r3.json.data.diterima === 8000 && r3.json.data.terbayar === 3000
      && r3.json.data.sisa === 5000 && r3.json.data.sisa_terima === 1000
      && r3.json.data.status_tampil === 'sebagian', JSON.stringify(r3.json.data));
  const det3 = (await api(`/api/purchases/${poId}`)).data;
  chk('detail: 3 event, Σ dibayar event 2.500, riwayat memuat nama barang',
    det3.receives.length === 3
      && det3.receives.reduce((s, r) => s + r.dibayar, 0) === 2500
      && det3.receives.every((r) => (r.items ?? []).length === 1 && !!r.items[0].name),
    JSON.stringify(det3.receives.map((r) => r.dibayar)));
  chk('stok B 2 dengan avg_cost 2.500 (rumus restock)', (await qProduk(NB)).stock === 2
    && (await qProduk(NB)).avg_cost === 2500);

  console.log('=== E. Kedatangan terakhir TANPA items (kompatibel perilaku lama) ===');
  const r4 = await post(`/api/purchases/${poId}/receive`, { shift_id: shiftId, cashier: 'kasir' });
  chk('receive tanpa items = terima semua SISA -> status received & lengkap',
    // `dibayar` bawaan = nilai kedatangan ini (1.000) -> terbayar 4.000 dari
    // nilai diterima 9.000, jadi sisa hutang 5.000 (barang lengkap != lunas).
    r4.status === 200 && r4.json.data.status === 'received' && r4.json.data.status_tampil === 'received'
      && r4.json.data.receive?.total === 1000 && r4.json.data.diterima === 9000
      && r4.json.data.terbayar === 4000 && r4.json.data.sisa === 5000
      && r4.json.data.sisa_terima === 0, JSON.stringify(r4.json.data));
  chk('receive PO yang sudah lengkap -> 400',
    (await post(`/api/purchases/${poId}/receive`, {})).status === 400);
  chk('stok akhir A 4 & B 2', (await qProduk(NA)).stock === 4 && (await qProduk(NB)).stock === 2,
    `A=${(await qProduk(NA)).stock} B=${(await qProduk(NB)).stock}`);
  const fRec2 = await api('/api/purchases?status=received');
  chk('filter received memuat PO lengkap; sebagian tidak; hutang MEMUAT (masih sisa 5.000)',
    fRec2.data.some((x) => x.id === poId)
      && !(await api('/api/purchases?status=sebagian')).data.some((x) => x.id === poId)
      && (await api('/api/purchases?status=hutang')).data.some((x) => x.id === poId));
  const det4 = (await api(`/api/purchases/${poId}`)).data;
  chk('detail akhir: 4 event, Σ dibayar event 3.500 (bayar langsung 500 di luar event)',
    det4.purchase.n_terima === 4 && det4.receives.length === 4
      && det4.receives.reduce((s, r) => s + r.dibayar, 0) === 3500,
    JSON.stringify(det4.receives.map((r) => r.dibayar)));

  console.log('=== F. Agregat shift & laporan per KEDATANGAN ===');
  const shAkhir = (await api('/api/shifts?cashier=kasir&limit=200')).data.find((s) => s.id === shiftId);
  chk('shift: n_purchase bertambah 4 event, purchase_total +4.000 (3.500 event + 500 cicilan)',
    shAkhir.n_purchase - shAwal.n_purchase === 4
      && shAkhir.purchase_total - shAwal.purchase_total === 4000,
    JSON.stringify({ n: shAkhir.n_purchase - shAwal.n_purchase, tot: shAkhir.purchase_total - shAwal.purchase_total }));
  const dlAkhir = (await api(`/api/reports/daily?date=${hari}`)).data.purchase;
  chk('laporan harian: 4 kedatangan, nilai 9.000 (bukan 1 nota)',
    dlAkhir.n - dlAwal.n === 4 && dlAkhir.total - dlAwal.total === 9000, JSON.stringify(dlAkhir));

  // Fallback nota LAMA: buat PO, receive normal, lalu hapus baris kedatangan
  // dan tandai received — meniru DB era sebelum fitur ini. Agregat wajib tetap
  // menghitungnya 1 event (tanggal received_at) & nilai penuh.
  const oL = await post('/api/purchases', {
    items: [{ product_id: paId, qty: 1, harga_beli: 700 }], note: NOTE, cashier: 'kasir',
  });
  const oLid = oL.json.data.purchase.id;
  const itemL = (await api(`/api/purchases/${oLid}`)).data.items[0];
  await post(`/api/purchases/${oLid}/receive`, {
    items: [{ purchase_item_id: itemL.id, qty: 1 }], dibayar: 700, shift_id: shiftId,
  });
  sql(`DELETE FROM purchase_receive_items WHERE receive_id IN (SELECT id FROM purchase_receives WHERE purchase_id = ${oLid});`);
  sql(`DELETE FROM purchase_receives WHERE purchase_id = ${oLid};`);
  sql(`UPDATE purchases SET status='received', received_at=datetime('now'), terbayar=700 WHERE id=${oLid};`);
  const detL = (await api(`/api/purchases/${oLid}`)).data;
  chk('fallback nota lama: n_terima 0 tetapi diterima = total (bukan 0)',
    detL.purchase.n_terima === 0 && detL.purchase.diterima === 700
      && detL.purchase.status_tampil === 'received' && detL.purchase.sisa === 0);
  const shL = (await api('/api/shifts?cashier=kasir&limit=200')).data.find((s) => s.id === shiftId);
  chk('shift fallback: +1 kejadian, +700 (tanpa baris kedatangan)',
    shL.n_purchase - shAwal.n_purchase === 5 && shL.purchase_total - shAwal.purchase_total === 4700,
    JSON.stringify({ n: shL.n_purchase - shAwal.n_purchase, tot: shL.purchase_total - shAwal.purchase_total }));
  const dlL = (await api(`/api/reports/daily?date=${hari}`)).data.purchase;
  chk('laporan fallback: +1 kedatangan, +700', dlL.n - dlAwal.n === 5 && dlL.total - dlAwal.total === 9700,
    JSON.stringify(dlL));

  console.log('=== G. UI halaman Pembelian (daftar + form terima per baris) ===');
  const oU = await post('/api/purchases', {
    supplier_id: supId, items: [{ product_id: paId, qty: 5, harga_beli: 1000 }], note: NOTE, cashier: 'kasir',
  });
  const poUid = oU.json.data.purchase.id;
  const itemU = (await api(`/api/purchases/${poUid}`)).data.items[0];
  const rU = await post(`/api/purchases/${poUid}/receive`, {
    items: [{ purchase_item_id: itemU.id, qty: 2 }], dibayar: 1000,
    shift_id: shiftId, cashier: 'kasir', client_id: `uji-po-sebagian-ui-${TS}`,
  });
  chk('setup UI: PO 5 qty, diterima 2 (2.000), dibayar 1.000 -> hutang 1.000',
    rU.status === 200 && rU.json.data.diterima === 2000 && rU.json.data.terbayar === 1000
      && rU.json.data.sisa === 1000 && rU.json.data.sisa_terima === 3000,
    JSON.stringify(rU.json.data));

  await p.goto(`${WEB}/#/purchases`, { waitUntil: 'networkidle' });
  await p.waitForSelector(`tr[data-row="${poUid}"]`, { timeout: 15000 });
  const row = (await p.textContent(`tr[data-row="${poUid}"]`)) ?? '';
  chk('daftar: badge Sebagian + subline Hutang + progress diterima',
    row.includes('Sebagian') && row.includes('Hutang Rp1.000') && row.includes('diterima Rp2.000'),
    row.replace(/\s+/g, ' ').slice(0, 140));

  await p.click(`tr[data-row="${poUid}"]`);
  await p.waitForSelector('[data-pt-qty]', { timeout: 10000 });
  const ui1 = await p.evaluate(() => {
    const th = [...document.querySelectorAll('#page th')].map((x) => (x.textContent ?? '').trim());
    const qty = document.querySelector('[data-pt-qty]');
    const bayar = document.querySelector('#pt-bayar');
    return {
      url: location.hash,
      modal: document.querySelectorAll('.modal-overlay').length,
      th,
      max: qty?.getAttribute('max') ?? '',
      qtyVal: qty?.value ?? '',
      bayar: bayar?.value ?? '',
      total: (document.querySelector('#pt-total')?.textContent ?? '').trim(),
      batal: document.querySelectorAll('[data-po-batal]').length,
      teks: (document.querySelector('#page')?.textContent ?? '').replace(/\s+/g, ' '),
    };
  });
  chk('rincian = HALAMAN (bukan modal) + kolom Qty PO/Diterima/Sisa',
    ui1.modal === 0 && ui1.url.includes(`#/purchases/${poUid}`)
      && ['Qty PO', 'Diterima', 'Sisa'].every((x) => ui1.th.includes(x)), JSON.stringify(ui1.th));
  chk('form terima: qty bawaan = SEMUA sisa (3), nilai 3.000, dibayar bawaan 3.000',
    ui1.max === '3' && ui1.qtyVal === '3' && ui1.total === 'Rp3.000' && ui1.bayar === '3000',
    JSON.stringify({ max: ui1.max, qty: ui1.qtyVal, total: ui1.total, bayar: ui1.bayar }));
  chk('rincian menampilkan Belum datang (bukan hutang) + tidak ada tombol Batalkan PO',
    ui1.teks.includes('Belum datang (bukan hutang)') && ui1.batal === 0
      && ui1.teks.includes('tidak bisa dibatalkan'), `batal=${ui1.batal}`);
  chk('riwayat kedatangan tampil (event + nama barang)',
    ui1.teks.includes('Riwayat kedatangan') && ui1.teks.includes('1 baris') && ui1.teks.includes(NA));

  await w('[data-pt-qty]', '1');
  const ui2 = await p.evaluate(() => {
    const inp = document.querySelector('#pt-bayar');
    return {
      total: (document.querySelector('#pt-total')?.textContent ?? '').trim(),
      bayar: inp?.value ?? '',
      maks: inp?.max ?? '',
    };
  });
  // Maks bayar = nilai diterima (2.000) + nilai event (1.000) − terbayar
  // (1.000) = 2.000. Barang belum datang TIDAK boleh dibayar duluan.
  chk('ubah qty datang -> nilai 1.000 & dibayar ikut 1.000 (maks 2.000)',
    ui2.total === 'Rp1.000' && ui2.bayar === '1000' && ui2.maks === '2000', JSON.stringify(ui2));

  // A4 saat masih sebagian: kolom Diterima, status SEBAGIAN, baris ketiga
  // "Sisa hutang" (prioritas uang kurang di atas barang kurang).
  await p.context().addInitScript(() => { window.print = () => {}; });
  const [pop] = await Promise.all([p.waitForEvent('popup'), p.click('[data-po-cetak]')]);
  await tungguDokumenA4(pop);
  const a4 = await pop.evaluate((id) => {
    const rk = document.querySelector('.total-section');
    const th = [...document.querySelectorAll('th')].map((x) => (x.textContent ?? '').trim());
    const body = document.body.innerText;
    return {
      judul: body.includes('NOTA PEMBELIAN'),
      nomor: body.includes(`PO-${id}`),
      seba: body.includes('SEBAGIAN'),
      th,
      ringkas: rk ? [...rk.querySelectorAll('.total-row')].map((r) => r.innerText.replace(/\s+/g, ' ')) : [],
      kaki: /Dicetak melalui Ravaa POS pada: \d{1,2} [A-Za-z]+ \d{4} \d{2}:\d{2}:\d{2}/.test(body),
    };
  }, poUid);
  chk('A4 sebagian: judul + nomor + status SEBAGIAN + kolom Diterima',
    a4.judul && a4.nomor && a4.seba && a4.th.includes('Diterima'), JSON.stringify(a4.th));
  chk('A4: tepat 3 baris ringkas, ketiga "Sisa hutang Rp 1.000" + footer berdetik',
    a4.ringkas.length === 3 && /Sisa hutang/.test(a4.ringkas[2]) && /Rp\s*1\.000/.test(a4.ringkas[2])
      && a4.kaki, JSON.stringify(a4.ringkas));
  await pop.close().catch(() => {});

  // Terima 1 unit lewat UI (dibayar 1.000) -> n_terima 2.
  await p.click('#pt-ok');
  const detU2 = await tunggu(async () => {
    const d = (await api(`/api/purchases/${poUid}`)).data;
    return d.purchase.n_terima === 2 ? d : null;
  });
  chk('klik Terima barang -> event baru tersimpan (n_terima 2, diterima 3.000, dibayar 2.000)',
    detU2?.purchase.diterima === 3000 && detU2?.purchase.terbayar === 2000,
    JSON.stringify(detU2?.purchase));

  // Lunasi sisa hutang lewat form inline (masih sebagian).
  await p.waitForSelector('#pb-amount', { timeout: 10000 });
  const pbVal = await p.inputValue('#pb-amount');
  chk('form Bayar sisa muncul saat sebagian dengan nilai = sisa 1.000', pbVal === '1000', pbVal);
  await p.click('#pb-ok');
  const detU3 = await tunggu(async () => {
    const d = (await api(`/api/purchases/${poUid}`)).data;
    return d.purchase.sisa === 0 ? d : null;
  });
  chk('bayar sisa via halaman -> lunas (sisa 0, barang masih kurang 2.000)',
    detU3?.purchase.sisa === 0 && detU3?.purchase.sisa_terima === 2000,
    JSON.stringify(detU3?.purchase));

  // Selesaikan kedatangan terakhir (qty bawaan = semua sisa) -> received.
  await p.waitForSelector('[data-pt-qty]', { timeout: 10000 });
  await p.click('#pt-ok');
  const detU4 = await tunggu(async () => {
    const d = (await api(`/api/purchases/${poUid}`)).data;
    return d.purchase.status === 'received' ? d : null;
  });
  chk('kedatangan terakhir via halaman -> status received lengkap',
    detU4?.purchase.status === 'received' && detU4?.purchase.diterima === 5000
      && detU4?.purchase.terbayar === 5000 && detU4?.purchase.sisa_terima === 0,
    JSON.stringify(detU4?.purchase));
  // Poll API selesai SEBELUM render ulang halaman — tunggu teksnya, bukan
  // membaca #page apa adanya (balapan render vs polling).
  const adaTeks = await p.waitForFunction(
    () => (document.querySelector('#page')?.textContent ?? '').includes('Semua barang sudah diterima'),
    null, { timeout: 10000 },
  ).then(() => true).catch(() => false);
  chk('detail lengkap: "Semua barang sudah diterima" + tetap tanpa tombol batal',
    adaTeks && (await p.locator('[data-po-batal]').count()) === 0);

  await p.click('[data-po-kembali]');
  await p.waitForSelector(`tr[data-row="${poUid}"]`, { timeout: 10000 });
  // Baca BADGE (data-po-badge), bukan seluruh teks baris: nama supplier
  // suite ini memuat kata "Sebagian" dan dulu membuat assertion palsu.
  const badgeAkhir = (await p.textContent(`tr[data-row="${poUid}"] [data-po-badge]`)) ?? '';
  chk('daftar setelah lengkap & lunas: badge Lunas (bukan Sebagian)',
    badgeAkhir.trim() === 'Lunas', badgeAkhir.trim());

  chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
} finally {
  // Cleanup TANPA menyentuh data pihak lain: semua lewat note EKSAK + id
  // produk milik suite ini. Stok dikembalikan, baru baris produk dibuang.
  try { bersihkanPo(); } catch (e) { console.log('  INFO  cleanup PO gagal:', String(e).slice(0, 120)); }
  // Supplier suite ini baru bisa dibuang setelah tidak ada PO yang menunjuknya.
  if (supUji) {
    try {
      sql(`DELETE FROM suppliers WHERE id = ${supUji}
             AND id NOT IN (SELECT supplier_id FROM purchases WHERE supplier_id IS NOT NULL);`);
    } catch (e) { console.log('  INFO  cleanup supplier gagal:', String(e).slice(0, 120)); }
  }
  for (const pid of produkIds) {
    try {
      sql(`DELETE FROM stock_moves WHERE product_id = ${pid};`);
      sql(`DELETE FROM product_units WHERE product_id = ${pid};`);
      sql(`DELETE FROM product_borongan WHERE product_id = ${pid};`);
      sql(`DELETE FROM products WHERE id = ${pid};`);
    } catch (e) { console.log('  INFO  cleanup produk gagal:', String(e).slice(0, 120)); }
  }
  await b.close().catch(() => {});
}

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [purchase-partial-test.mjs]`);
if (fail) process.exit(1);
