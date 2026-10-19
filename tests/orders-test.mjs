// Pesanan jasa + DP/status (butir ROADMAP 1.6.6, ACC pemilik 19 Okt 2026) —
// suite regresi jalur lengkap: buat pesanan (item teks bebas), DP, ubah
// status, serah (take = nota penjualan penuh + atribusi per metode + hutang
// sisa ke ledger), batal (refund), agregat laci (`order_masuk_total` /
// `order_omzet_total`), piutang laporan harian, pencarian, dan UI halaman
// #/orders (sub-rute baru/<id>, Alt+N, dialog DP/Serahkan/Batalkan, cetak
// nota pesanan thermal + struk penjualan via jalur Cetak ulang Riwayat).
// Jalankan: node orders-test.mjs  (API :3001 + vite :5656 hidup; runner
// membuka shift kasir). Data uji = pelanggan 'UjiOrd Pelanggan' (dibuat
// suite, dibersihkan suite — AGENTS §5: nama EKSAK + self-heal).
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
const TODAY = new Date().toISOString().slice(0, 10);

/* ---------- self-heal: sisa run yang crash ---------- */
// Urutan FK: baris anak dulu (sales -> penjualan nota take; order_payments/
// order_items; ledger charge pelanggan uji + charge yang menunjuk nomor
// pesanan; audit; pelanggan). Penanda pesanan uji = CATATAN ATAU pelanggan
// uji ATAU nama item uji — order yang dibuat lewat UI boleh tak bercatatan,
// jadi catatan saja tak cukup (kejadian nyata run pertama: order UI lolos
// dari self-heal). Catatan: shim sqlite3 sandbox = 1 statement per invoke.
const OD_UJI = `(SELECT id FROM orders WHERE note LIKE 'UjiOrd%'
  OR customer_id IN (SELECT id FROM customers WHERE name = 'UjiOrd Pelanggan')
  OR id IN (SELECT DISTINCT order_id FROM order_items WHERE name LIKE 'UjiOrd%'))`;
function bersihkan() {
  sql(`DELETE FROM sale_items WHERE sale_id IN (SELECT sale_id FROM orders WHERE id IN ${OD_UJI} AND sale_id IS NOT NULL);`);
  sql(`DELETE FROM sale_payments WHERE sale_id IN (SELECT sale_id FROM orders WHERE id IN ${OD_UJI} AND sale_id IS NOT NULL);`);
  sql(`DELETE FROM sales WHERE id IN (SELECT sale_id FROM orders WHERE id IN ${OD_UJI} AND sale_id IS NOT NULL);`);
  sql(`DELETE FROM customer_debts WHERE customer_id IN (SELECT id FROM customers WHERE name = 'UjiOrd Pelanggan')
    OR EXISTS (SELECT 1 FROM orders o WHERE o.id IN ${OD_UJI} AND customer_debts.note LIKE '%' || o.order_no || '%');`);
  sql(`DELETE FROM order_payments WHERE order_id IN ${OD_UJI};`);
  sql(`DELETE FROM order_items WHERE order_id IN ${OD_UJI};`);
  sql(`DELETE FROM audit_log WHERE entity='order' AND entity_id IN ${OD_UJI};`);
  sql(`DELETE FROM orders WHERE id IN ${OD_UJI};`);
  sql(`DELETE FROM customers WHERE name = 'UjiOrd Pelanggan';`);
}
bersihkan();

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await pasangToken(p);
// Cetak: jeda cetak dimatikan + mock print-agent (TIDAK menyentuh :9100).
await p.addInitScript(() => { try { localStorage.setItem('ravaa.printpause', '0'); } catch { /* abaikan */ } });
const prints = [];
await ctx.route('**/print', async (route) => {
  const bd = route.request().postDataJSON();
  prints.push(Buffer.from(bd.data_base64 ?? '', 'base64').toString('latin1'));
  await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 160)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const status = (path) => p.evaluate((u) => fetch(u).then((r) => r.status), path);
const post = (path, body) => p.evaluate(
  ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  [path, body],
);

// fetch() relatif butuh origin — buka app dulu sebelum evaluate.
await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(700);

const open = await api('/api/shifts/open?cashier=kasir');
const kasirId = open.data?.id;
const shAwal = (await api('/api/shifts?status=open&limit=200')).data.find((s) => s.cashier === 'kasir') ?? {};
const harAwal = await api(`/api/reports/daily?date=${TODAY}`);

console.log('=== A. Buat pesanan + validasi ===');
const cust = await post('/api/customers', { name: 'UjiOrd Pelanggan', note: 'UjiOrd master uji' });
chk('pelanggan uji dibuat', cust.status === 201 && Number.isInteger(cust.json.data.id), JSON.stringify(cust.json.data?.id));
const custId = cust.json.data.id;
const ITEM_A1 = { name: 'UjiOrd Banner A', qty: 2, price: 15000, note: 'ukuran 2x1 m' };
const ITEM_A2 = { name: 'UjiOrd Pasang A', qty: 1, price: 10000 };
const buatA = await post('/api/orders', { customer_id: custId, items: [ITEM_A1, ITEM_A2], note: 'UjiOrd nota A', cashier: 'kasir' });
const A = buatA.json.data?.order;
chk('POST valid -> 201 + nomor ORD-YYMMDD-NNN', buatA.status === 201 && /^ORD-\d{6}-\d{3}$/.test(A?.order_no ?? ''), A?.order_no);
chk('awal: status dikerjakan + kasir tercatat', A?.status === 'dikerjakan' && A?.cashier === 'kasir');
chk('total 40000 + dibayar 0 + sisa 40000 + 2 item', A?.total === 40000 && A?.dibayar === 0 && A?.sisa === 40000 && A?.n_items === 2, JSON.stringify({ t: A?.total, d: A?.dibayar, s: A?.sisa, n: A?.n_items }));
chk('items kosong -> 400', (await post('/api/orders', { customer_id: custId, items: [] })).status === 400);
chk('customer_id absen -> 400', (await post('/api/orders', { items: [ITEM_A1] })).status === 400);
const cacat = await post('/api/orders', { customer_id: 99999, items: [ITEM_A1] });
chk('pelanggan tak ada -> 400 pesan', cacat.status === 400 && cacat.json.error === 'pelanggan tidak dikenal: 99999', cacat.json.error);
const n1 = await post('/api/orders', { customer_id: custId, items: [{ name: '  ', qty: 1, price: 1000 }] });
chk('nama item kosong -> 400 pesan', n1.status === 400 && n1.json.error === 'item 1: nama wajib diisi', n1.json.error);
const q0 = await post('/api/orders', { customer_id: custId, items: [{ name: 'UjiOrd X', qty: 0, price: 1000 }] });
chk('qty 0 -> 400 pesan', q0.status === 400 && q0.json.error === 'item 1: qty harus > 0', q0.json.error);
const pn = await post('/api/orders', { customer_id: custId, items: [{ name: 'UjiOrd X', qty: 1, price: -1 }] });
chk('harga negatif -> 400 pesan', pn.status === 400 && pn.json.error === 'item 1: harga harus angka >= 0', pn.json.error);
chk('note > 200 -> 400', (await post('/api/orders', { customer_id: custId, items: [ITEM_A1], note: 'x'.repeat(201) })).status === 400);
chk('GET :id tak ada -> 404', (await status('/api/orders/999999')) === 404);

console.log('=== B. DP + ubah status ===');
const b1 = await post(`/api/orders/${A.id}/payments`, { method: 'qris', amount: 5000, cashier: 'kasir', shift_id: kasirId });
chk('DP 5000 qris -> 201', b1.status === 201, JSON.stringify(b1.json.data?.id ?? b1.json.error));
const seg1 = (await api(`/api/orders/${A.id}`)).data.order;
chk('DP: dibayar 5000 + sisa 35000', seg1.dibayar === 5000 && seg1.sisa === 35000, JSON.stringify({ d: seg1.dibayar, s: seg1.sisa }));
const b2 = await post(`/api/orders/${A.id}/payments`, { method: 'tunai', amount: 40000 });
chk('DP melebihi sisa -> 400 pesan sisa', b2.status === 400 && b2.json.error === 'melebihi sisa pesanan (sisa 35000)', b2.json.error);
const b3 = await post(`/api/orders/${A.id}/payments`, { method: 'tunai', amount: 0 });
chk('DP 0 -> 400 pesan', b3.status === 400 && b3.json.error === 'jumlah harus rupiah bulat > 0', b3.json.error);
chk('DP desimal -> 400', (await post(`/api/orders/${A.id}/payments`, { method: 'tunai', amount: 100.5 })).status === 400);
const b5 = await post(`/api/orders/${A.id}/payments`, { method: 'bitcoin', amount: 1000 });
chk('metode tak dikenal -> 400 pesan', b5.status === 400 && b5.json.error === 'metode pembayaran tidak dikenal: bitcoin', b5.json.error);
const b6 = await post(`/api/orders/${A.id}/payments`, { method: 'tunai', amount: 1000, shift_id: 999999 });
chk('shift_id tak ada -> 400 pesan', b6.status === 400 && b6.json.error === 'shift tidak dikenal', b6.json.error);
const s1 = await post(`/api/orders/${A.id}/status`, { status: 'selesai' });
chk('status -> selesai', s1.status === 200 && s1.json.data?.status === 'selesai');
const s2 = await post(`/api/orders/${A.id}/status`, { status: 'diambil' });
chk('status "diambil" lewat /status -> 400 petunjuk', s2.status === 400 && s2.json.error === 'status harus dikerjakan|selesai (diambil lewat Serahkan, batal lewat Batalkan)', s2.json.error);

console.log('=== C. Serahkan (take) ===');
const t1 = await post(`/api/orders/${A.id}/take`, { method: 'tunai', diterima: 15000, cashier: 'kasir', shift_id: kasirId });
chk('take uang kurang -> kembalian 0 + hutang 20000', t1.status === 200 && t1.json.data?.kembalian === 0 && t1.json.data?.hutang === 20000, JSON.stringify({ k: t1.json.data?.kembalian, h: t1.json.data?.hutang }));
const saleA = t1.json.data?.sale;
chk('take -> nota invoice YYMMDD-NNNNNN', /^\d{6}-\d{6}$/.test(saleA?.invoice_no ?? ''), saleA?.invoice_no);
const segA = (await api(`/api/orders/${A.id}`)).data.order;
chk('order: diambil + sale_id + hutang_sisa 20000', segA.status === 'diambil' && segA.sale_id === saleA.id && segA.hutang_sisa === 20000 && !!segA.taken_at, JSON.stringify({ st: segA.status, hs: segA.hutang_sisa }));
const daftar = (await api(`/api/sales?date=${TODAY}&limit=200`)).data;
const barisA = daftar.find((s) => s.id === saleA.id);
chk('nota take muncul di GET /api/sales + order_no + sisa_hutang', barisA?.order_no === A.order_no && barisA?.sisa_hutang === 20000, JSON.stringify({ o: barisA?.order_no, s: barisA?.sisa_hutang }));
const detA = (await api(`/api/sales/${saleA.id}`)).data;
const sumA = detA.payments.reduce((a, x) => a + x.amount, 0);
chk('atribusi sale_payments: Σ = total nota (invarian split 1.6.5)', sumA === 40000, `Σ=${sumA}`);
const tunaiA = detA.payments.find((x) => x.method === 'tunai')?.amount;
const qrisA = detA.payments.find((x) => x.method === 'qris')?.amount;
chk('DP qris 5000 + sisa hutang menempel metode serah (tunai 35000)', qrisA === 5000 && tunaiA === 35000, JSON.stringify({ tunai: tunaiA, qris: qrisA }));
const ledA = await api(`/api/customer-debts/${custId}`);
const chargeA = (ledA.data?.rows ?? []).find((r) => r.type === 'charge' && (r.note ?? '').includes('sisa pesanan'));
chk('ledger Hutang: charge 20000 + note nomor nota & pesanan', chargeA?.amount === 20000 && chargeA.note.includes(saleA.invoice_no) && chargeA.note.includes(A.order_no), chargeA?.note);
const t2 = await post(`/api/orders/${A.id}/take`, { method: 'tunai', diterima: 0 });
chk('take ulang -> 400 sudah diambil', t2.status === 400 && t2.json.error === 'pesanan sudah diambil', t2.json.error);
const b7 = await post(`/api/orders/${A.id}/payments`, { method: 'tunai', amount: 1000 });
chk('DP setelah diambil -> 400', b7.status === 400 && b7.json.error === 'pesanan sudah diambil — tidak bisa menerima pembayaran lagi', b7.json.error);
const c1 = await post(`/api/orders/${A.id}/cancel`, {});
chk('cancel setelah diambil -> 400', c1.status === 400 && c1.json.error.startsWith('pesanan sudah diambil'), c1.json.error);

console.log('=== D. Laci shift + laporan harian (delta) ===');
const shAkhir1 = (await api('/api/shifts?status=open&limit=200')).data.find((s) => s.cashier === 'kasir') ?? {};
chk('delta order_masuk_total = DP + pelunasan (20000)', (shAkhir1.order_masuk_total ?? 0) - (shAwal.order_masuk_total ?? 0) === 20000, JSON.stringify({ awal: shAwal.order_masuk_total, akhir: shAkhir1.order_masuk_total }));
chk('delta order_omzet_total = 40000', (shAkhir1.order_omzet_total ?? 0) - (shAwal.order_omzet_total ?? 0) === 40000);
chk('delta omzet shift ikut penuh (tunai nota take)', (shAkhir1.omzet ?? 0) - (shAwal.omzet ?? 0) === 40000);
chk('delta tunai shift = 35000 (pelunasan 15000 + hutang 20000 menempel tunai)', (shAkhir1.tunai ?? 0) - (shAwal.tunai ?? 0) === 35000);
const harAkhir1 = await api(`/api/reports/daily?date=${TODAY}`);
chk('delta piutang.baru = 20000 (hutang serah pesanan)', (harAkhir1.data.piutang.baru ?? 0) - (harAwal.data.piutang.baru ?? 0) === 20000, JSON.stringify({ awal: harAwal.data.piutang.baru, akhir: harAkhir1.data.piutang.baru }));

console.log('=== E. Batal + refund ===');
const buatB = await post('/api/orders', { customer_id: custId, items: [{ name: 'UjiOrd Batal B', qty: 1, price: 20000 }], note: 'UjiOrd batal' });
const B = buatB.json.data?.order;
chk('pesanan B dibuat', buatB.status === 201 && B?.total === 20000);
chk('DP B 5000 tunai', (await post(`/api/orders/${B.id}/payments`, { method: 'tunai', amount: 5000, shift_id: kasirId })).status === 201);
const c2 = await post(`/api/orders/${B.id}/cancel`, { note: 'UjiOrd pelanggan batal', method: 'tunai', cashier: 'kasir', shift_id: kasirId });
chk('cancel -> refund 5000', c2.status === 200 && c2.json.data?.refund === 5000, JSON.stringify(c2.json.data?.refund));
const segB = (await api(`/api/orders/${B.id}`)).data;
chk('B: status batal + dibayar 0 (net dp−refund) + sisa 0', segB.order.status === 'batal' && segB.order.dibayar === 0 && segB.order.sisa === 0, JSON.stringify({ st: segB.order.status, d: segB.order.dibayar, s: segB.order.sisa }));
const refundB = segB.payments.find((x) => x.kind === 'refund');
chk('baris refund tercatat (metode + nominal)', refundB?.amount === 5000 && refundB?.method === 'tunai', JSON.stringify(refundB ?? null));
const c3 = await post(`/api/orders/${B.id}/cancel`, {});
chk('cancel ulang -> 400 sudah dibatalkan', c3.status === 400 && c3.json.error === 'pesanan sudah dibatalkan', c3.json.error);
const t3 = await post(`/api/orders/${B.id}/take`, { method: 'tunai', diterima: 0 });
chk('take setelah batal -> 400', t3.status === 400 && t3.json.error === 'pesanan sudah dibatalkan', t3.json.error);
chk('DP setelah batal -> 400', (await post(`/api/orders/${B.id}/payments`, { method: 'tunai', amount: 1000 })).status === 400);
const shAkhir2 = (await api('/api/shifts?status=open&limit=200')).data.find((s) => s.cashier === 'kasir') ?? {};
chk('delta order_masuk_total tetap 20000 (refund B mengurangi lagi)', (shAkhir2.order_masuk_total ?? 0) - (shAwal.order_masuk_total ?? 0) === 20000, String((shAkhir2.order_masuk_total ?? 0) - (shAwal.order_masuk_total ?? 0)));

console.log('=== F. Daftar + pencarian + ringkas ===');
const cari = await api('/api/orders?q=UjiOrd%20Banner%20A&status=semua&limit=50');
chk('cari nama ITEM menemukan pesanan', cari.total === 1 && cari.data[0].id === A.id, JSON.stringify({ total: cari.total }));
const cariCust = await api('/api/orders?q=UjiOrd%20Pelanggan&status=semua&limit=50');
chk('cari nama pelanggan menemukan semua pesanan uji', cariCust.total === 2, String(cariCust.total));
const listBatal = await api('/api/orders?status=batal&limit=50');
chk('filter status=batal memuat B', listBatal.data.some((o) => o.id === B.id) && listBatal.ringkas.batal >= 1, JSON.stringify(listBatal.ringkas));
chk('status tak dikenal -> 400 pesan', (await status('/api/orders?status=waduh')) === 400);
const au = await api('/api/audit?entity=order&limit=100');
const aksiOrder = new Set((au.data ?? []).map((r) => r.action));
chk('jejak audit order: create + update tercatat', aksiOrder.has('create') && aksiOrder.has('update'), [...aksiOrder].join(','));

console.log('=== G. UI #/orders (buat -> DP -> serah -> cetak) ===');
await p.goto('http://localhost:5656/#/orders', { waitUntil: 'networkidle' });
await p.waitForSelector('#ord-body', { timeout: 15000 });
await p.waitForTimeout(700);
chk('nav "Pesanan" aktif + tombol memuat hint Alt+N', (await p.locator('a[href="#/orders"].is-active').count()) === 1
  && (await p.textContent('#ord-new .kbd')) === 'Alt+N');
chk('chip filter hitungan dari ringkas server', /Dikerjakan \(0\)/.test((await p.textContent('.chip-tabs')).replace(/\s+/g, ' ')));
await p.keyboard.press('Alt+n');
await p.waitForTimeout(500);
chk('Alt+N -> sub-halaman #/orders/baru', (await p.evaluate(() => location.hash)) === '#/orders/baru');
const opsiVal = await p.locator('#ord-cust option', { hasText: 'UjiOrd Pelanggan' }).first().getAttribute('value');
await p.selectOption('#ord-cust', opsiVal);
await p.fill('[data-ob-row="0"] [data-ob="name"]', 'UjiOrd Desain C');
await p.fill('[data-ob-row="0"] [data-ob="qty"]', '2');
await p.fill('[data-ob-row="0"] [data-ob="price"]', '15000');
await p.click('#ord-add');
await p.waitForTimeout(200);
await p.fill('[data-ob-row="1"] [data-ob="name"]', 'UjiOrd Cetak C');
await p.fill('[data-ob-row="1"] [data-ob="price"]', '10000');
await p.fill('#ord-note', 'UjiOrd ui C');
chk('form: total baris live = Rp40.000', (await p.textContent('#ord-total')) === 'Rp40.000');
await p.click('#ord-simpan');
await p.waitForTimeout(1600);
const hashC = await p.evaluate(() => location.hash);
const idC = Number(hashC.split('/')[2]);
const teksC = (await p.textContent('#page')).replace(/\s+/g, ' ');
chk('simpan -> rincian pesanan + badge Dikerjakan', /^#\/orders\/\d+$/.test(hashC) && /ORD-\d{6}-\d{3}/.test(teksC) && teksC.includes('Dikerjakan'), hashC);
// DP: tombol "Penuh" mengisi sisa, lalu diganti nominal sebagian (metode Transfer).
await p.click('[data-oact="dp"]');
await p.waitForSelector('.modal', { timeout: 8000 });
await p.click('#dp-penuh');
const penuhVal = await p.inputValue('#dp-nominal');
await p.fill('#dp-nominal', '10000');
await p.click('[data-dpmetode="transfer"]');
await p.click('.modal [data-ok]');
await p.waitForTimeout(1300);
const teksDp = (await p.textContent('#page')).replace(/\s+/g, ' ');
chk('dialog DP: "Penuh" = 40000, simpan -> baris Transfer Rp10.000 + sisa 30000', penuhVal === '40000'
  && teksDp.includes('Transfer') && teksDp.includes('Rp10.000') && /Sisa Rp30\.000/.test(teksDp));
await p.click('[data-oact="selesai"]');
await p.waitForTimeout(1300);
chk('tombol Tandai selesai -> badge Selesai', (await p.textContent('#page')).includes('Selesai'));
await p.click('[data-oact="serahkan"]');
await p.waitForSelector('.modal', { timeout: 8000 });
await p.fill('#sr-terima', '15000');
await p.waitForTimeout(250);
const srOut = (await p.textContent('#sr-out')).replace(/\s+/g, ' ');
chk('dialog Serahkan: preview pelunasan + Masuk Hutang Rp15.000', /Pelunasan\s*Rp15\.000/.test(srOut) && /Masuk Hutang\s*Rp15\.000/.test(srOut), srOut.slice(0, 120));
await p.click('.modal [data-ok]');
await p.waitForTimeout(2000);
const swalC = (await p.textContent('.swal2-popup').catch(() => '')) .replace(/\s+/g, ' ');
chk('sesudah serah -> swal resume (nota + pilihan cetak)', swalC.includes('Pesanan diserahkan') && swalC.includes('Struk penjualan') && swalC.includes('Nota pesanan'), swalC.slice(0, 120));
await p.click('.swal2-container .swal2-deny'); // "Nota pesanan"
await p.waitForTimeout(1200);
const ordC = (await api(`/api/orders/${idC}`)).data.order;
const detC = (await api(`/api/sales/${ordC.sale_id}`)).data.sale;
chk('cetak Nota pesanan -> payload thermal memuat judul + nomor', prints.length === 1 && prints[0].includes('NOTA PESANAN') && prints[0].includes(ordC.order_no), `print=${prints.length}`);
const teksSetelah = (await p.textContent('#page')).replace(/\s+/g, ' ');
chk('rincian setelah serah: Diambil + link #/debts + tombol struk', teksSetelah.includes('Diambil')
  && (await p.locator('a[href="#/debts"]').count()) >= 1 && (await p.locator('[data-oact="cetak-struk"]').count()) === 1);
chk('rincian memuat nominal hutang tercatat (Rp15.000)', /Rp15\.000 tercatat di/.test(teksSetelah), teksSetelah.slice(0, 0) + (teksSetelah.match(/Rp15\.000 tercatat di/) ?? ['tidak ada'])[0]);
await p.click('[data-oact="cetak-struk"]');
await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.waitForTimeout(300);
await p.click('.swal2-container .swal2-confirm'); // "Thermal" (dialog Cetak ulang Riwayat)
await p.waitForTimeout(1200);
// Struk thermal memotong nama item agar muat kolom (terbukti: "UjiOrd Desai.")
// — jadi asersi = nomor nota + potongan nama yang pasti terbaca.
chk('Struk penjualan (jalur cetak ulang) -> payload memuat nomor nota + item', prints.length === 2 && prints[1].includes(detC.invoice_no) && prints[1].includes('UjiOrd Cetak'), `print=${prints.length}`);

console.log('=== H. Riwayat: nota take + penanda Pesanan/Hutang ===');
chk('GET /api/sales/:id nota take: order_no + sisa_hutang 15000', detC.order_no === ordC.order_no && detC.sisa_hutang === 15000, JSON.stringify({ o: detC.order_no, s: detC.sisa_hutang }));
await p.goto('http://localhost:5656/#/history', { waitUntil: 'networkidle' });
await p.waitForSelector('tr[data-trx]', { timeout: 15000 });
await p.waitForTimeout(800);
const trC = p.locator('tr[data-trx]').filter({ hasText: detC.invoice_no });
chk('baris take ketemu di linimasa Riwayat', (await trC.count()) === 1, detC.invoice_no);
await trC.first().click();
await p.waitForTimeout(1300);
const teksR = (await p.textContent('#page')).replace(/\s+/g, ' ');
chk('rincian Riwayat memuat baris "Pesanan <nomor>"', teksR.includes(`Pesanan ${ordC.order_no}`));
chk('rincian Riwayat memuat kotak Hutang Rp15.000', /Hutang Rp15\.000/.test(teksR));

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan data uji (urutan FK sama dengan self-heal di atas).
bersihkan();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
