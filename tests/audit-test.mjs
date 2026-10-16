// Jejak audit (2026-10-16): GET /api/audit — filter entity/q/date, limit/offset,
// guard pemilik, pencatatan create/update/delete kategori, dan halaman #/audit.
// SENGAJA tidak meng-import bantuan-uji: test ini butuh request TANPA token dan
// token KASIR — patch fetch bantuan-uji akan menimpanya. Semua eksplisit.
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

// Bersihkan sisa run lama (kalau suite pernah gagal di tengah).
sql(`DELETE FROM audit_log WHERE entity_id LIKE 'uji-audit-%';`);
sql(`DELETE FROM categories WHERE slug LIKE 'uji-audit-%';`);
sql(`DELETE FROM audit_log WHERE entity = 'user' AND username LIKE 'ujiaudit%';`);
sql(`DELETE FROM users WHERE username LIKE 'ujiaudit%';`);

const masuk = await api('POST', '/api/login', { username: UJI_USER, password: UJI_PASS });
if (masuk.status !== 200 || !masuk.json.data?.token) {
  console.log(`  GAGAL setup: login ${UJI_USER} gagal — samakan RAVAA_UJI_USER/PASS`);
  process.exit(1);
}
const T = masuk.json.data.token;
await api('POST', '/api/users/password', { old_password: UJI_PASS, password: UJI_PASS }, T);

const TAG = `uji-audit-${Date.now().toString(36)}`;

console.log('=== A. Pencatatan create/update/delete kategori ===');
const buat = await api('POST', '/api/categories', { name: `Uji Audit ${TAG}`, slug: TAG, track_stock: 0 }, T);
chk('POST kategori -> 201', buat.status === 201);
let list = await api('GET', `/api/audit?entity=category&q=${TAG}`, null, T);
chk('audit create tercatat utuh',
  list.status === 200 && list.json.total === 1
  && list.json.data[0].action === 'create'
  && list.json.data[0].entity === 'category'
  && list.json.data[0].entity_id === TAG
  && list.json.data[0].username === UJI_USER,
  `total=${list.json.total}`);
chk('detail create memuat nama', String(list.json.data[0]?.detail ?? '').includes(TAG));

const ubah = await api('POST', '/api/categories', { name: `Uji Audit ${TAG} v2`, slug: TAG, track_stock: 0 }, T);
chk('POST kategori sama -> 200 update', ubah.status === 200);
list = await api('GET', `/api/audit?entity=category&q=${TAG}`, null, T);
chk('audit update tercatat', list.json.total === 2 && list.json.data[0].action === 'update', `total=${list.json.total}`);

const hapus = await api('DELETE', `/api/categories/${TAG}`, null, T);
chk('DELETE kategori -> 200', hapus.status === 200);
list = await api('GET', `/api/audit?entity=category&q=${TAG}`, null, T);
chk('audit delete tercatat (total 3, terbaru dulu)', list.json.total === 3 && list.json.data[0].action === 'delete');

console.log('=== B. Filter multi-kata, tanggal, limit/offset ===');
const multitk = await api('GET', `/api/audit?q=${TAG}%20delete`, null, T);
chk('q multi-kata (slug + delete) -> 1 baris', multitk.json.total === 1 && multitk.json.data[0]?.action === 'delete');
const hariIni = new Date().toISOString().slice(0, 10);
const tglOk = await api('GET', `/api/audit?q=${TAG}&date=${hariIni}`, null, T);
chk('filter tanggal hari ini -> 3 baris', tglOk.json.total === 3, `date=${hariIni}`);
chk('tanggal mustahil 2026-02-31 -> 400', (await api('GET', '/api/audit?date=2026-02-31', null, T)).status === 400);
const satu = await api('GET', `/api/audit?entity=category&q=${TAG}&limit=1`, null, T);
const dua = await api('GET', `/api/audit?entity=category&q=${TAG}&limit=1&offset=1`, null, T);
chk('limit=1 + offset bergeser + total stabil',
  satu.json.data.length === 1 && dua.json.data.length === 1
  && satu.json.data[0].id !== dua.json.data[0].id && satu.json.total === dua.json.total && satu.json.total === 3);

console.log('=== C. Guard pemilik ===');
chk('tanpa token -> 401', (await api('GET', '/api/audit')).status === 401);
const k1 = await api('POST', '/api/users', { username: `ujiaudit${Date.now().toString(36)}`, name: 'Uji Audit Kasir', role: 'kasir', password: 'kasir1234' }, T);
const kasirId = k1.json.data.id;
const kasirLogin = await api('POST', '/api/login', { username: k1.json.data.username, password: 'kasir1234' });
const TK0 = kasirLogin.json.data.token;
await api('POST', '/api/users/password', { old_password: 'kasir1234', password: 'kasir5678' }, TK0); // bersihkan must_change
const TK = (await api('POST', '/api/login', { username: k1.json.data.username, password: 'kasir5678' })).json.data.token;
const tolak = await api('GET', '/api/audit', null, TK);
chk('kasir -> 403 khusus pemilik', tolak.status === 403 && String(tolak.json.error).includes('khusus pemilik'), tolak.json.error);

console.log('=== D. Login ikut tercatat ===');
const gagal = await api('POST', '/api/login', { username: UJI_USER, password: 'jelas-salah' });
const sesi = await api('GET', '/api/audit?entity=session&q=login-gagal', null, T);
chk('login gagal tercatat', gagal.status === 401 && sesi.json.total >= 1, `total=${sesi.json.total}`);

console.log('=== E. Halaman #/audit ===');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript((tok) => { try { localStorage.setItem('ravaa.token', tok); } catch { /* abaikan */ } }, T);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));

await p.goto(`${WEB}/#/audit`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
chk('nav Sistem aktif di #/audit', await p.locator('a[href="#/audit"].is-active').count() === 1);
const totalServer = (await api('GET', '/api/audit?limit=1', null, T)).json.total;
const chipTxt = (await p.textContent('#audit-count')) ?? '';
chk('chip jumlah = total server', chipTxt.includes(`${totalServer} catatan`), chipTxt.trim());
chk('tabel terisi', await p.locator('[data-audit-row]').count() > 0);

await p.fill('#audit-q', TAG);
await p.waitForTimeout(700); // debounce 250ms + fetch
chk('cari via UI -> 3 baris', await p.locator('[data-audit-row]').count() === 3);
chk('filter entitas kategori tetap 3', await p.locator('[data-audit-row]').count() === 3);

// Baris TERAKHIR = aksi create (terlama di halaman, urutan id DESC) — satu-
// satunya yang detailnya JSON berisi nama; baris delete sengaja tanpa detail.
await p.locator('[data-audit-row]').last().click();
await p.waitForSelector('.modal', { timeout: 5000 });
const isiModal = (await p.textContent('.modal-body')) ?? '';
chk('detail modal memuat slug + detail JSON', isiModal.includes(TAG) && isiModal.includes('{'), isiModal.slice(0, 80).replace(/\s+/g, ' '));
chk('modal hanya-baca: 1 tombol footer "Tutup"',
  await p.locator('.modal-footer button').count() === 1
  && ((await p.textContent('.modal-footer')) ?? '').trim().includes('Tutup'));
await p.keyboard.press('Escape');
await p.waitForTimeout(400);
chk('Esc menutup modal', await p.locator('.modal').count() === 0);

await p.fill('#audit-date', '2026-02-31').catch(() => {});
await p.waitForTimeout(400);
chk('badan tabel tetap hidup setelah tanggal ditolak browser',
  await p.locator('#audit-body').count() === 1);
chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan data uji (audit dulu — tidak ada FK ke categories/users, tapi rapi).
sql(`DELETE FROM audit_log WHERE entity_id LIKE '${TAG}' OR (entity = 'user' AND username LIKE 'ujiaudit%');`);
sql(`DELETE FROM categories WHERE slug LIKE 'uji-audit-%';`);
await api('DELETE', `/api/users/${kasirId}`, null, T);
sql(`DELETE FROM audit_log WHERE entity = 'user' AND entity_id = '${kasirId}';`);
sql(`DELETE FROM users WHERE username LIKE 'ujiaudit%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [audit-test.mjs]`);
if (fail) process.exit(1);
