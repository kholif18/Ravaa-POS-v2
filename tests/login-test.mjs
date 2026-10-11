// Login & peran (2026-10-11): 401 tanpa token, 403 kasir di jalur pemilik,
// must_change, kepemilikan tutup-shift, guard akun, gate UI + nav peran.
// SENGAJA tidak meng-import bantuan-uji (patch fetch-nya akan menyuntikkan
// token ke panggilan "tanpa token" di bawah) — semua request eksplisit.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
const UJI_USER = process.env.RAVAA_UJI_USER || 'pemilik';
const UJI_PASS = process.env.RAVAA_UJI_PASS || 'admin123';

const api = async (method, path, body, token) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const masuk = await api('POST', '/api/login', { username: UJI_USER, password: UJI_PASS });
if (masuk.status !== 200 || !masuk.json.data?.token) {
  console.log(`  GAGAL setup: login ${UJI_USER} gagal — samakan RAVAA_UJI_USER/PASS`);
  process.exit(1);
}
const T = masuk.json.data.token;
// Bersihkan must_change akun pemilik (bila masih 1 dari seed/reset terakhir):
// ganti-ke-sama idempoten — suite lain (bantuan-uji) melakukan hal yang sama.
await api('POST', '/api/users/password', { old_password: UJI_PASS, password: UJI_PASS }, T);

console.log('=== A. Tanpa token = 401 ===');
chk('GET produk tanpa token -> 401', (await api('GET', '/api/products?since=0')).status === 401);
chk('POST produk tanpa token -> 401', (await api('POST', '/api/products', { name: 'X', category_slug: 'atk' })).status === 401);

console.log('=== B. Login salah ===');
chk('sandi salah -> 401', (await api('POST', '/api/login', { username: UJI_USER, password: 'jelas-salah' })).status === 401);
const asing = await api('POST', '/api/login', { username: 'tidak-ada-uji', password: 'x' });
const salah = await api('POST', '/api/login', { username: UJI_USER, password: 'jelas-salah' });
chk('username asing = sandi salah (tak bocor)', asing.status === 401 && salah.status === 401
  && asing.json.error === salah.json.error, `${asing.json.error}`);
chk('kosong -> 400', (await api('POST', '/api/login', { username: '', password: '' })).status === 400);

console.log('=== C. Kasir ditolak di jalur pemilik ===');
const k1 = await api('POST', '/api/users', { username: `ujilogin${Date.now().toString(36)}`, name: 'Uji Login Kasir', role: 'kasir', password: 'kasir123' }, T);
const kasirId = k1.json.data.id;
const kasirLogin = await api('POST', '/api/login', { username: k1.json.data.username, password: 'kasir123' });
const TK = kasirLogin.json.data.token;
chk('login kasir ok + wajib ganti', kasirLogin.status === 200 && kasirLogin.json.data.must_change === true);
chk('kasir POST produk -> 403', (await api('POST', '/api/products', { name: 'X', category_slug: 'atk' }, TK)).status === 403);
chk('kasir GET reports -> 403', (await api('GET', '/api/reports/daily', null, TK)).status === 403);
chk('kasir GET users -> 403', (await api('GET', '/api/users', null, TK)).status === 403);

console.log('=== D. must_change mengunci sampai diganti ===');
chk('kasir baru GET sales -> 403 wajib-ganti',
  (await api('GET', '/api/sales?date=2026-10-11', null, TK)).status === 403);
chk('ganti sandi lama salah -> 401',
  (await api('POST', '/api/users/password', { old_password: 'salah', password: 'baru1234' }, TK)).status === 401);
chk('ganti sandi ok -> terbuka',
  (await api('POST', '/api/users/password', { old_password: 'kasir123', password: 'kasir456' }, TK)).status === 200
  && (await api('GET', '/api/sales?date=2026-10-11', null, TK)).status === 200);
chk('setelah ganti: kasir GET products -> 200 (boleh baca)',
  (await api('GET', '/api/products?since=0', null, TK)).status === 200);

console.log('=== E. Tutup shift orang lain ===');
const sh = await api('POST', '/api/shifts/open', { modal_awal: 1000, cashier: 'kasir-lain-uji' }, T);
const shId = sh.json.data.id;
chk('kasir tutup shift orang -> 403',
  (await api('POST', `/api/shifts/${shId}/close`, { modal_akhir: 1000 }, TK)).status === 403);
chk('pemilik tutup shift orang -> 200',
  (await api('POST', `/api/shifts/${shId}/close`, { modal_akhir: 1000 }, T)).status === 200);

console.log('=== F. Guard akun ===');
chk('hapus diri sendiri -> 400',
  (await api('DELETE', `/api/users/${masuk.json.data.user.id}`, null, T)).status === 400);
chk('nonaktifkan diri -> 400',
  (await api('POST', '/api/users', { id: masuk.json.data.user.id, is_active: 0 }, T)).status === 400);
chk('turunkan peran diri -> 400',
  (await api('POST', '/api/users', { id: masuk.json.data.user.id, role: 'kasir' }, T)).status === 400);

console.log('=== G. Gate UI + nav peran ===');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
await p.goto(`${WEB}/#/pos`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
chk('tanpa sesi -> #/login + form', (await p.evaluate(() => location.hash)) === '#/login'
  && (await p.locator('#login-form').count()) === 1);
await p.fill('#login-user', 'salah');
await p.fill('#login-pass', 'salah');
await p.click('#login-ok');
await p.waitForTimeout(800);
chk('sandi salah -> tetap + pesan', (await p.evaluate(() => location.hash)) === '#/login'
  && ((await p.textContent('#login-err')) ?? '').length > 0);
await p.fill('#login-user', k1.json.data.username);
await p.fill('#login-pass', 'kasir456');
await p.click('#login-ok');
await p.waitForTimeout(1500);
chk('kasir masuk -> #/pos (bawaan kasir)', (await p.evaluate(() => location.hash)) === '#/pos');
// POS tanpa sidebar/header — cek nav di halaman Riwayat (ada sidebar).
await p.goto(`${WEB}/#/history`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
chk('nav kasir: tanpa Laporan/Pengaturan/Pengguna',
  await p.locator('a[href="#/reports"]').count() === 0
  && await p.locator('a[href="#/settings"]').count() === 0
  && await p.locator('a[href="#/users"]').count() === 0);
chk('nav kasir: ada Stok + Hutang + Shift',
  await p.locator('a[href="#/stock"]').count() === 1
  && await p.locator('a[href="#/debts"]').count() === 1
  && await p.locator('a[href="#/shifts"]').count() === 1);
await p.goto(`${WEB}/#/reports`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
chk('kasir buka #/reports -> mental ke #/pos', (await p.evaluate(() => location.hash)) === '#/pos');
await p.goto(`${WEB}/#/history`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.click('#user-btn');
await p.click('[data-user-act="logout"]');
await p.waitForSelector('.swal2-popup', { timeout: 8000 });
await p.click('.swal2-popup .sw-btn-danger');
await p.waitForTimeout(1500);
chk('keluar -> #/login + token hilang', (await p.evaluate(() => location.hash)) === '#/login'
  && ((await p.evaluate(() => localStorage.getItem('ravaa.token'))) ?? '') === '');

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan: kasir uji + shift lain-uji (sales tak ada di shift itu — FK aman).
await api('DELETE', `/api/users/${kasirId}`, null, T);
sql(`DELETE FROM shifts WHERE cashier = 'kasir-lain-uji';`);
sql(`DELETE FROM users WHERE username LIKE 'ujilogin%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [login-test.mjs]`);
if (fail) process.exit(1);
