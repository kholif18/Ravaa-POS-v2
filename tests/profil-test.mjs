// Profil Saya (#/profil, 2026-10-11): avatar opsional + nama + email +
// username read-only + sandi kondisional. Blok "Perangkat ini" pindah ke
// Sistem. Jalankan: node profil-test.mjs (butuh API :3001 + vite :5656).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const FOTO = '/tmp/opencode/foto-uji.jpg';
if (!fs.existsSync(FOTO)) {
  // JPEG 1x1 minimal (deterministik, tanpa dependensi)
  fs.writeFileSync(FOTO, Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A9/oooooA//9k=',
    'base64'));
}

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const post = (path, body) => p.evaluate(
  ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  [path, body],
);
const { pasangToken } = await import('./bantuan-uji.mjs');
await pasangToken(p);
await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
const namaAwal = (await api('/api/me')).data.user.name;

console.log('=== A. API avatar + profil ===');
const up = await post('/api/users/me/avatar', { image: `data:image/jpeg;base64,${fs.readFileSync(FOTO).toString('base64')}` });
chk('POST avatar -> 200 + nama file', up.status === 200 && /^avatar-1-\d+\.jpg$/.test(up.json.data?.avatar ?? ''), JSON.stringify(up.json.data));
const me1 = await api('/api/me');
chk('/api/me memuat avatar + email field', typeof me1.data.user.avatar === 'string' && 'email' in me1.data.user, JSON.stringify(me1.data.user));
chk('GET avatar publik (img tag) 200 + image/*',
  await p.evaluate((u) => fetch(u).then((r) => ({ s: r.status, ct: r.headers.get('content-type') })), `/api/users/1/avatar?${Date.now()}`)
    .then((r) => r.s === 200 && r.ct.startsWith('image/')));
chk('email valid disimpan', (await post('/api/users/profile', { name: namaAwal, email: 'owner@ravaa.id' })).json.data?.email === 'owner@ravaa.id');
chk('email tidak valid -> 400', (await post('/api/users/profile', { name: namaAwal, email: 'bukan-email' })).status === 400);
chk('avatar bukan dataURL -> 400', (await post('/api/users/me/avatar', { image: 'http://x/y.jpg' })).status === 400);
chk('hapus avatar -> null', (await post('/api/users/me/avatar', { image: '' })).json.data?.avatar === null);

console.log('=== B. UI profil ===');
await p.goto('http://localhost:5656/#/profil', { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
chk('username read-only', await p.locator('#pf-username[readonly]').count() === 1);
chk('sandi blok tersembunyi dulu', await p.locator('#pf-sandi-blok.hidden').count() === 1);
await p.setInputFiles('#pf-avatar-file', FOTO);
await p.waitForTimeout(2000);
chk('upload avatar -> img tampil', await p.locator('#pf-avatar-img').count() === 1);
const avDb = sql(`SELECT avatar FROM users WHERE id=1;`);
chk('kolom users.avatar terisi', /^avatar-1-\d+\.jpg$/.test(avDb), avDb);
await p.fill('#pf-email', 'uji-profil@ravaa.id');
await p.click('#pf-simpan');
await p.waitForTimeout(1000);
chk('simpan profil -> email tersimpan', (await api('/api/me')).data.user.email === 'uji-profil@ravaa.id');
await p.click('#pf-toggle-sandi');
await p.click('#pf-sandi-simpan'); // kosong semua -> toast warning, blok tetap
await p.waitForTimeout(500);
chk('sandi kosong ditolak (blok tetap)', await p.locator('#pf-sandi-blok:not(.hidden)').count() === 1);
await p.click('#pf-avatar-hapus');
await p.waitForTimeout(1500);
chk('hapus avatar -> inisial kembali', await p.locator('#pf-avatar-init').count() === 1
  && (await api('/api/me')).data.user.avatar === null);
chk('blok Perangkat TIDAK ada di profil', !(await p.textContent('#page')).includes('Tampilan perangkat'));

console.log('=== C. Sistem: kartu Tampilan perangkat ===');
await p.goto('http://localhost:5656/#/settings', { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
chk('kartu Tampilan perangkat ada di Sistem', (await p.textContent('#set-body')).includes('Tampilan perangkat ini'));
chk('input toko + tema tersedia', await p.locator('#set-dev-toko').count() === 1 && await p.locator('#set-dev-theme').count() === 1);

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan: email kosong lagi, avatar null, file yatim dibuang.
const av = sql(`SELECT avatar FROM users WHERE id=1;`);
if (av) { try { fs.unlinkSync(path0.join(REPO, 'apps/api/data/img', av)); } catch { /* yatim */ } }
sql(`UPDATE users SET avatar = NULL, email = '' WHERE id = 1;`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [profil-test.mjs]`);
if (fail) process.exit(1);

function sql(q) {
  return execFileSync('sqlite3', [DB, q], { encoding: 'utf8' }).trim();
}
