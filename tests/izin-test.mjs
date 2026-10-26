// Izin granular B4 + gate API dasar
// Tes ini menguji enforcement server untuk izin operasional kasir Standar/Ketat,
// penolakan core, identitas kasir, dan beberapa gate penjualan/laporan.
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:3001';
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();

const api = async (method, path, body, token) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const ownerLogin = await api('POST', '/api/login', { username: 'owner', password: 'admin1234' });
chk('login owner 200', ownerLogin.status === 200 && ownerLogin.json.data?.token);
const TOWNER = ownerLogin.json.data?.token;
if (ownerLogin.status !== 200) { console.log('Gagal login owner'); process.exit(1); }

// Bersihkan must_change owner
await api('POST', '/api/users/password', { old_password: 'admin1234', password: 'admin1234' }, TOWNER);

console.log('=== A. Buat kasir Standar & Ketat ===');
const ts = Date.now().toString(36);
const uStandar = `ujiizst${ts}`;
const uKetat = `ujiizkt${ts}`;
const createStandar = await api('POST', '/api/users', {
  username: uStandar, name: 'Uji Izin Standar', role: 'kasir', password: 'uji12345', permissions: null
}, TOWNER);
chk('buat kasir standar', createStandar.status === 201 && createStandar.json.data?.id);
const idStandar = createStandar.json.data?.id;

// Ketat: hanya pos.jual, pelanggan.lihat, shift.lihat/buka/tutup
const createKetat = await api('POST', '/api/users', {
  username: uKetat, name: 'Uji Izin Ketat', role: 'kasir', password: 'uji12345',
  permissions: ['pos.jual','pelanggan.lihat','shift.lihat','shift.buka','shift.tutup']
}, TOWNER);
chk('buat kasir ketat custom', createKetat.status === 201);

const loginStandar = await api('POST', '/api/login', { username: uStandar, password: 'uji12345' });
const TSTANDAR = loginStandar.json.data?.token;
chk('login standar ok', loginStandar.status === 200 && TSTANDAR);
// Bersihkan must_change agar API tidak diblokir
await api('POST', '/api/users/password', { old_password: 'uji12345', password: 'uji12345' }, TSTANDAR);

const loginKetat = await api('POST', '/api/login', { username: uKetat, password: 'uji12345' });
const TKETAT = loginKetat.json.data?.token;
chk('login ketat ok', loginKetat.status === 200 && TKETAT);
await api('POST', '/api/users/password', { old_password: 'uji12345', password: 'uji12345' }, TKETAT);

console.log('=== B. Gate API Standar ===');
chk('standar GET products 200', (await api('GET', '/api/products?since=0', null, TSTANDAR)).status === 200);
chk('standar POST products 403 (produk.kelola tidak ada)', (await api('POST', '/api/products', { name: 'X', category_slug: 'atk', unit: 'pcs', price: 1000 }, TSTANDAR)).status === 403);
chk('standar GET customers 200 (pelanggan.lihat)', (await api('GET', '/api/customers', null, TSTANDAR)).status === 200);
chk('standar GET reports daily 403 (laporan.lihat tidak ada)', (await api('GET', '/api/reports/daily?date=2026-01-01', null, TSTANDAR)).status === 403);
chk('standar GET shifts 200 (shift.lihat)', (await api('GET', '/api/shifts', null, TSTANDAR)).status === 200);
chk('standar GET users 403 (core owner only)', (await api('GET', '/api/users', null, TSTANDAR)).status === 403);

console.log('=== C. Gate API Ketat ===');
chk('ketat GET products 200 (baca produk tanpa kelola)', (await api('GET', '/api/products?since=0', null, TKETAT)).status === 200);
chk('ketat POST sales 200 (pos.jual ada)', (await api('POST', '/api/sales', { id: 'test-'+ts, items: [], pay_method: 'tunai', cash_in: 0 }, TKETAT)).status === 400); // items kosong -> 400 bukan 403
chk('ketat GET reports 403', (await api('GET', '/api/reports/daily?date=2026-01-01', null, TKETAT)).status === 403);
chk('ketat GET customers 200', (await api('GET', '/api/customers', null, TKETAT)).status === 200);
chk('ketat GET suppliers 403 (supplier.kelola tidak ada)', (await api('GET', '/api/suppliers', null, TKETAT)).status === 403);

console.log('=== D. Profil akun izin ===');
const me = await api('GET', '/api/me', null, TSTANDAR);
chk('me ada permissions field', me.status === 200 && me.json.data?.user?.permissions !== undefined);
chk('standar permissions_custom false (default)', me.json.data?.user?.permissions_custom === false);

console.log('=== F. Gate kategori & analitik (2026-10-25) ===');
// `produk.kelola` kini juga menjaga mutasi kategori (dulu terbuka untuk semua
// sesi). Membaca kategori tetap terbuka: semua form produk butuh daftarnya.
chk('standar GET categories 200 (baca tetap terbuka)', (await api('GET', '/api/categories', null, TSTANDAR)).status === 200);
chk('standar POST categories 403 (produk.kelola)', (await api('POST', '/api/categories', { name: 'Uji Izin' }, TSTANDAR)).status === 403);
chk('standar DELETE categories 403 (produk.kelola)', (await api('DELETE', '/api/categories/atk', null, TSTANDAR)).status === 403);
chk('standar GET analytics 403 (laporan.lihat)', (await api('GET', '/api/reports/analytics', null, TSTANDAR)).status === 403);

// Analitik dulu `hanyaOwner`; kini cukup `laporan.lihat` (satu aturan dengan
// laporan lain) — kasir yang diberi izin itu harus benar-benar bisa membuka.
const uLap = `ujiizlp${ts}`;
const createLap = await api('POST', '/api/users', {
  username: uLap, name: 'Uji Izin Laporan', role: 'kasir', password: 'uji12345',
  permissions: ['pos.jual', 'laporan.lihat', 'riwayat.lihat'],
}, TOWNER);
chk('buat kasir laporan custom', createLap.status === 201);
const loginLap = await api('POST', '/api/login', { username: uLap, password: 'uji12345' });
const TLAP = loginLap.json.data?.token;
chk('login kasir laporan ok', loginLap.status === 200 && TLAP);
await api('POST', '/api/users/password', { old_password: 'uji12345', password: 'uji12345' }, TLAP);
chk('laporan GET analytics 200 (laporan.lihat cukup)', (await api('GET', '/api/reports/analytics', null, TLAP)).status === 200);
chk('laporan POST categories 403 (bukan produk.kelola)', (await api('POST', '/api/categories', { name: 'Uji Izin' }, TLAP)).status === 403);

console.log('=== G. Riwayat transaksi per pelanggan ===');
// Nama EKSAK (bukan prefix) supaya cleanup tidak pernah menjaring data suite
// lain; sisa run yang crash dibersihkan lebih dulu (self-heal) termasuk nota
// anak-anaknya — CLI sqlite3 tidak menjalankan ON DELETE CASCADE.
const CUST_UJI = 'UjiIzin Pelanggan Riwayat';
const SALE_UJI_LAMA = `SELECT s.id FROM sales s JOIN customers c ON c.id = s.customer_id WHERE c.name = '${CUST_UJI}'`;
sql(`DELETE FROM sale_items WHERE sale_id IN (${SALE_UJI_LAMA});
DELETE FROM sale_payments WHERE sale_id IN (${SALE_UJI_LAMA});
DELETE FROM sales WHERE id IN (${SALE_UJI_LAMA});
DELETE FROM customers WHERE name = '${CUST_UJI}';`);
const buatCust = await api('POST', '/api/customers', { name: CUST_UJI }, TOWNER);
const custId = buatCust.json.data?.id;
chk('buat pelanggan uji', buatCust.status === 201 && Number.isInteger(custId));
// Nota manual tanpa shift: fokus tes = filter `customer_id`, bukan laci.
const saleId = `ujiizin-${ts}`;
const jual = await api('POST', '/api/sales', {
  id: saleId, customer_id: custId, pay_method: 'tunai', cash_in: 1000,
  items: [{ name: 'UjiIzin Jasa', qty: 1, price: 1000 }],
}, TOWNER);
chk('jual manual untuk pelanggan uji', jual.status === 201 && jual.json.data?.sale?.customer_id === custId);
const riwayat = await api('GET', `/api/sales?customer_id=${custId}`, null, TOWNER);
chk('GET sales?customer_id 200', riwayat.status === 200 && riwayat.json.total >= 1);
chk('tanpa date = SELURUH riwayat pelanggan', Array.isArray(riwayat.json.data)
  && riwayat.json.data.length >= 1
  && riwayat.json.data.every((s) => s.customer_id === custId));
chk('customer_id bukan integer -> 400', (await api('GET', '/api/sales?customer_id=abc', null, TOWNER)).status === 400);
chk('customer_id 0 -> 400', (await api('GET', '/api/sales?customer_id=0', null, TOWNER)).status === 400);
const riwayatLain = await api('GET', `/api/sales?customer_id=${custId}&date=2000-01-01`, null, TOWNER);
chk('customer_id + date lain -> 0 baris', riwayatLain.status === 200 && riwayatLain.json.total === 0);

console.log('=== H. Core rejection ===');
const badPerm = await api('POST', '/api/users', {
  username: `ujiizinbad${ts}`, name: 'Bad', role: 'kasir', password: 'uji12345',
  permissions: ['pengaturan.ubah']
}, TOWNER);
chk('core izin ditolak saat buat kasir', badPerm.status === 400 && /core/.test(String(badPerm.json.error)));

console.log('=== I. Cleanup ===');
await api('DELETE', `/api/users/${idStandar}`, null, TOWNER);
await api('DELETE', `/api/users/${createKetat.json.data?.id}`, null, TOWNER);
await api('DELETE', `/api/users/${createLap.json.data?.id}`, null, TOWNER);
// Baris nota uji: hapus anak dulu — CLI sqlite3 TIDAK menjalankan ON DELETE
// CASCADE (foreign_keys OFF), dan `sale_payments` ber-UNIQUE(sale_id, method)
// akan memblokir POST ulang id yang sama pada run berikutnya.
sql(`DELETE FROM sale_items WHERE sale_id = '${saleId}'; DELETE FROM sale_payments WHERE sale_id = '${saleId}'; DELETE FROM sales WHERE id = '${saleId}';`);
if (Number.isInteger(custId)) await api('DELETE', `/api/customers/${custId}`, null, TOWNER);
// hapus sisa user uji
sql(`DELETE FROM users WHERE username LIKE 'ujiiz%';`);
sql(`DELETE FROM customers WHERE name = '${CUST_UJI}';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [izin-test.mjs]`);
if (fail) process.exit(1);
