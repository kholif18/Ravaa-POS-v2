// Helper auth suite regresi (login 2026-10-11): API kini wajib token di semua
// endpoint, jadi setiap proses test butuh token sebelum menembak :3001.
//
// Cara pakai per suite (2 baris, TANPA menambah asersi):
//   import './bantuan-uji.mjs';            // patch fetch node otomatis
//   await pasangToken(p);                  // sesudah newPage, sebelum goto pertama
//
// - fetch node ke localhost:3001/api* otomatis membawa Authorization.
// - browser: addInitScript menyetel localStorage + membungkus window.fetch
//   (fetch mentah di page.evaluate ikut tersuntik).
// - login memakai RAVAA_UJI_USER/PASS (bawaan owner/admin123 hasil seed),
//   lalu self-change sandi-ke-sandi-sendiri (idempoten) untuk membersihkan
//   flag must_change — tanpa ini UI suite mental ke layar ganti sandi.
import { execFileSync } from 'node:child_process';

const API = 'http://localhost:3001';
let tokenCache = '';

function curlJson(args, input) {
  const out = execFileSync('curl', args, { input, encoding: 'utf8', timeout: 15000 });
  return JSON.parse(out || '{}');
}

export function tokenUji() {
  if (process.env.RAVAA_UJI_TOKEN) return process.env.RAVAA_UJI_TOKEN;
  if (tokenCache) return tokenCache;
  const user = process.env.RAVAA_UJI_USER || 'owner';
  const pass = process.env.RAVAA_UJI_PASS || 'admin123';
  let login;
  try {
    login = curlJson(
      ['-s', '-m', '10', '-X', 'POST', `${API}/api/login`, '-H', 'content-type: application/json', '-d', '@-'],
      JSON.stringify({ username: user, password: pass }),
    );
  } catch {
    throw new Error(
      `bantuan-uji: API :3001 tidak terjangkau — jalankan npm run dev:api dulu`,
    );
  }
  const token = login?.data?.token ?? '';
  if (!token) {
    throw new Error(
      `bantuan-uji: login gagal sebagai "${user}" — cocokkan RAVAA_UJI_USER/RAVAA_UJI_PASS dengan akun pemilik (bawaan seed: owner/admin123)`,
    );
  }
  // Bersihkan must_change (agar UI suite tidak mental ke layar ganti sandi).
  // Ganti-ke-sama = no-op aman bila flag sudah 0.
  try {
    curlJson(
      ['-s', '-m', '10', '-X', 'POST', `${API}/api/users/password`, '-H', 'content-type: application/json',
        '-H', `Authorization: Bearer ${token}`, '-d', '@-'],
      JSON.stringify({ old_password: pass, password: pass }),
    );
  } catch {
    /* abaikan — token tetap dipakai */
  }
  // Pastikan shift terbuka atas NAMA AKUN (header/POS memakai nama ini —
  // bila pemilik mengganti nama akun, gate "Buka shift dulu" akan menghalangi
  // semua suite UI). 409 = sudah terbuka, aman diabaikan.
  const nama = login?.data?.user?.name || user;
  try {
    curlJson(
      ['-s', '-m', '10', '-X', 'POST', `${API}/api/shifts/open`, '-H', 'content-type: application/json',
        '-H', `Authorization: Bearer ${token}`, '-d', '@-'],
      JSON.stringify({ modal_awal: 100000, cashier: nama }),
    );
  } catch {
    /* abaikan */
  }
  tokenCache = token;
  return token;
}

export function authHeaders() {
  return { Authorization: `Bearer ${tokenUji()}` };
}

// Patch sekali saat modul di-import: fetch node ke API otomatis berauth.
// /health TIDAK ikut (tanpa /api/) supaya cek "server hidup" tetap murni.
const fetchAsli = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const s = typeof url === 'string' ? url : String(url?.url ?? url);
  if (s.includes('localhost:3001/api')) {
    init = {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tokenUji()}` },
    };
  }
  return fetchAsli(url, init);
};

/** Suntik token + bungkus fetch di halaman browser (sebelum goto pertama). */
export async function pasangToken(page) {
  const t = tokenUji();
  await page.addInitScript((tok) => {
    try {
      localStorage.setItem('ravaa.token', tok);
      const _f = window.fetch.bind(window);
      window.fetch = (u, o = {}) => {
        const h = new Headers(o.headers || {});
        h.set('Authorization', `Bearer ${tok}`);
        return _f(u, { ...o, headers: h });
      };
    } catch {
      /* private mode: abaikan */
    }
  }, t);
}
