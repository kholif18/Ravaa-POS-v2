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

const ownerLogin = await api('POST', '/api/login', { username: 'owner', password: 'admin123' });
chk('login owner 200', ownerLogin.status === 200 && ownerLogin.json.data?.token);
const TOWNER = ownerLogin.json.data?.token;
if (ownerLogin.status !== 200) { console.log('Gagal login owner'); process.exit(1); }

// Bersihkan must_change owner
await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, TOWNER);

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

console.log('=== E. Core rejection ===');
const badPerm = await api('POST', '/api/users', {
  username: `ujiizinbad${ts}`, name: 'Bad', role: 'kasir', password: 'uji12345',
  permissions: ['pengaturan.ubah']
}, TOWNER);
chk('core izin ditolak saat buat kasir', badPerm.status === 400 && /core/.test(String(badPerm.json.error)));

console.log('=== F. Cleanup ===');
await api('DELETE', `/api/users/${idStandar}`, null, TOWNER);
await api('DELETE', `/api/users/${createKetat.json.data?.id}`, null, TOWNER);
// hapus sisa user uji
sql(`DELETE FROM users WHERE username LIKE 'ujiiz%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [izin-test.mjs]`);
if (fail) process.exit(1);
