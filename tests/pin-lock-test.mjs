// PIN cepat & auto-lock B5 — tes API dasar
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
chk('login owner', ownerLogin.status === 200);
let TOWNER = ownerLogin.json.data?.token;
await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, TOWNER);

console.log('=== A. Set PIN owner ===');
const setPin = await api('POST', '/api/users/pin', { pin: '123456' }, TOWNER);
chk('set PIN 123456 -> 200', setPin.status === 200);
const me1 = await api('GET', '/api/me', null, TOWNER);
chk('me.pin_set true', me1.json.data?.user?.pin_set === true);

console.log('=== B. Verify PIN ===');
const verifyOk = await api('POST', '/api/users/pin/verify', { pin: '123456' }, TOWNER);
chk('verify PIN benar -> 200', verifyOk.status === 200);
const verifyBad = await api('POST', '/api/users/pin/verify', { pin: '000000' }, TOWNER);
chk('verify PIN salah -> 401', verifyBad.status === 401);

console.log('=== C. Quick switch owner -> kasir ===');
const ts = Date.now().toString(36);
const u = `ujipin${ts}`;
const create = await api('POST', '/api/users', { username: u, name: 'Uji PIN', role: 'kasir', password: 'uji12345' }, TOWNER);
chk('buat kasir uji', create.status === 201);
const uid = create.json.data?.id;

// Set PIN kasir
const kLogin1 = await api('POST', '/api/login', { username: u, password: 'uji12345' });
let TK = kLogin1.json.data?.token;
await api('POST', '/api/users/password', { old_password: 'uji12345', password: 'uji12345' }, TK);
await api('POST', '/api/users/pin', { pin: '654321' }, TK);

// Owner switch ke kasir
const switchRes = await api('POST', '/api/users/pin/switch', { user_id: uid, pin: '654321' }, TOWNER);
chk('pin switch ok -> token baru', switchRes.status === 200 && switchRes.json.data?.token);
const TSWITCH = switchRes.json.data?.token;
const oldCheck = await api('GET', '/api/me', null, TOWNER);
chk('token owner lama dicabut -> 401', oldCheck.status === 401);
const meSwitch = await api('GET', '/api/me', null, TSWITCH);
chk('token switch aktif dan user kasir', meSwitch.status === 200 && meSwitch.json.data?.user?.username === u);

console.log('=== D. Reset PIN via owner memutus sesi ===');
// Login owner lagi
const ownerReLogin = await api('POST', '/api/login', { username: 'owner', password: 'admin123' });
const TOWNER2 = ownerReLogin.json.data?.token;
await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, TOWNER2);
// Hapus PIN kasir
const delPin = await api('DELETE', `/api/users/${uid}/pin`, null, TOWNER2);
chk('owner delete PIN kasir -> 200', delPin.status === 200);
const checkSession = await api('GET', '/api/me', null, TSWITCH);
chk('sesi kasir dicabut setelah reset PIN', checkSession.status === 401);

console.log('=== E. Ganti sandi menghapus PIN ===');
// Login owner lagi untuk set PIN baru
const ownerLogin2 = await api('POST', '/api/login', { username: 'owner', password: 'admin123' });
let TOWNER3 = ownerLogin2.json.data?.token;
await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, TOWNER3);
await api('POST', '/api/users/pin', { pin: '111111' }, TOWNER3);
// Ubah sandi
const chPass = await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, TOWNER3);
chk('ganti sandi sendiri ok', chPass.status === 200);
const me3 = await api('GET', '/api/me', null, TOWNER3);
chk('pin_set hilang setelah ganti sandi', me3.json.data?.user?.pin_set === false);

console.log('=== F. Cleanup ===');
sql(`DELETE FROM users WHERE username = '${u}';`);
console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [pin-lock-test.mjs]`);
if (fail) process.exit(1);
