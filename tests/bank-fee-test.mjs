// bank-fee-test.mjs — Fitur potongan bank topup (2026-10-27).
//
// Menguji:
//  1. POST /api/topups menerima `bank_fee` + validasi bank_fee <= admin.
//  2. GET /api/topups mengembalikan `bank_fee`.
//  3. GET /api/shifts: agregat `topup_bank_fee` (Σ bank_fee kind=topup SAJA —
//     tarik tidak ikut; `topup_admin` tetap penuh = laci tidak berubah).
//  4. CRUD /api/topup-services (GET semua peran ber-token, POST/DELETE
//     hanyaOwner).
//  5. GET /api/topups/suggest-admin?provider= memakai master topup_services
//     (master menang atas tier fallback; fallback SELALU mengirim bank_fee:0).
//
// SELF-HEAL (aturan §5 — nama eksak milik suite ini):
//  - topup id prefix `test-bf-`
//  - provider master prefix `UJI-BF-` (+ audit_log-nya)
//  - shift kasir `UJI-BF-KASIR` (dihapus via better-sqlite3 beserta anaknya)
// Dihapus di awal (sisa run lama yang crash di tengah) DAN di akhir (finally).
// Provider asli (E-WALLET/PULSA/PLN-TOKEN) TIDAK PERNAH disentuh — master uji
// memakai kode sendiri supaya tier fallback yang diharapkan suite lain
// (e2e-topup-keranjang mengharapkan suggest-admin tanpa master) tidak berubah.
//
// TANPA import bantuan-uji.mjs: patch fetch-nya menyuntikkan Authorization ke
// SEMUA request localhost:3001/api sehingga test 401-tanpa-token mustahil
// (pola audit-test.mjs / login-test.mjs: login sendiri, fetch polos).
//
// Jalankan: node tests/bank-fee-test.mjs  (API :3001 harus hidup).

import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path0.join(REPO, 'apps/api/data/data.db');
const API = 'http://localhost:3001';
const UJI_USER = process.env.RAVAA_UJI_USER || 'owner';
const UJI_PASS = process.env.RAVAA_UJI_PASS || 'admin1234';

let lolos = 0, gagal = 0;
const ok = (label, cond, info = '') => {
  if (cond) { lolos++; console.log(`  ✓ ${label}`); }
  else { gagal++; console.log(`  ✗ GAGAL: ${label}${info ? ` | ${info}` : ''}`); process.exitCode = 1; }
};

const api = async (method, path, body, token) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// ── self-heal DB: hapus sisa suite lama (anak dulu — koneksi ini tidak
//    menyalakan foreign_keys, jadi urutan hapus dijaga manual) ────────────────
function bersihkanDB() {
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    for (const s of db.prepare("SELECT id FROM shifts WHERE cashier LIKE 'UJI-BF-KASIR%'").all()) {
      db.prepare('DELETE FROM topup_txns WHERE shift_id = ?').run(s.id);
    }
    db.prepare("DELETE FROM topup_txns WHERE id LIKE 'test-bf-%'").run();
    db.prepare("DELETE FROM topup_services WHERE provider LIKE 'UJI-BF-%'").run();
    db.prepare("DELETE FROM audit_log WHERE entity = 'topup_service' AND entity_id LIKE 'UJI-BF-%'").run();
    db.prepare("DELETE FROM shifts WHERE cashier LIKE 'UJI-BF-KASIR%'").run();
  })();
  db.close();
}
bersihkanDB();

// ── login owner ──────────────────────────────────────────────────────────────
const masuk = await api('POST', '/api/login', { username: UJI_USER, password: UJI_PASS });
if (masuk.status !== 200 || !masuk.json.data?.token) {
  console.log('  GAGAL setup: login owner gagal — pastikan API :3001 hidup & akun seed ada');
  process.exit(1);
}
const T = masuk.json.data.token;
await api('POST', '/api/users/password', { old_password: UJI_PASS, password: UJI_PASS }, T);

try {
  // Shift khusus uji (owner bebas buka shift atas nama kasir lain — lihat
  // POST /api/shifts/open) supaya agregat shift diuji EKSAK tanpa menyentuh
  // shift 'kasir' milik suite POS.
  let buka = await api('POST', '/api/shifts/open', { modal_awal: 50000, cashier: 'UJI-BF-KASIR' }, T);
  let sid = buka.json?.data?.id;
  if (!sid) { // sisa run lama masih terbuka (cleanup DB gagal) — pakai shift itu
    const cari = await api('GET', '/api/shifts?status=open&cashier=UJI-BF-KASIR', null, T);
    sid = cari.json?.data?.[0]?.id;
  }
  ok(`shift uji UJI-BF-KASIR siap (id=${sid})`, Number.isInteger(sid), `status buka=${buka.status}`);

  // ── 1. POST /api/topups menerima bank_fee ──────────────────────────────────
  console.log('\n=== 1. POST /api/topups bank_fee ===');

  const ew = await api('POST', '/api/topups', {
    id: 'test-bf-ew', kind: 'topup', provider: 'UJI-BF-EW',
    nomor: '', token: '', nominal: 100000, admin: 3000, bank_fee: 1500,
    pay_method: 'tunai', shift_id: sid, cashier: 'owner',
  }, T);
  ok('POST topup bank_fee=1500 → 201', ew.status === 201, JSON.stringify(ew.json).slice(0, 120));
  ok('balasan (RETURNING *) memuat bank_fee=1500', ew.json?.data?.bank_fee === 1500,
    JSON.stringify(ew.json?.data ?? {}).slice(0, 120));

  const pu = await api('POST', '/api/topups', {
    id: 'test-bf-pu', kind: 'topup', provider: 'UJI-BF-PU',
    nomor: '', token: '', nominal: 50000, admin: 2000,
    pay_method: 'tunai', shift_id: sid, cashier: 'owner',
  }, T);
  ok('POST topup TANPA bank_fee → 201', pu.status === 201, JSON.stringify(pu.json).slice(0, 120));
  ok('balasan bank_fee=0 (default)', pu.json?.data?.bank_fee === 0,
    JSON.stringify(pu.json?.data ?? {}).slice(0, 120));

  const jelek = await api('POST', '/api/topups', {
    id: 'test-bf-jelek', kind: 'topup', provider: 'UJI-BF-EW',
    nomor: '', token: '', nominal: 100000, admin: 1000, bank_fee: 2000,
    pay_method: 'tunai', cashier: 'owner',
  }, T);
  ok('bank_fee > admin → 400', jelek.status === 400, `status=${jelek.status}`);
  ok('pesan memuat "potongan bank"', String(jelek.json?.error ?? '').includes('potongan bank'),
    JSON.stringify(jelek.json).slice(0, 120));

  const tk = await api('POST', '/api/topups', {
    id: 'test-bf-tk', kind: 'tarik', provider: 'UJI-BF-TK',
    nomor: '', token: '', nominal: 200000, admin: 5000, bank_fee: 2000,
    pay_method: 'tunai', shift_id: sid, cashier: 'owner',
  }, T);
  ok('POST tarik dengan bank_fee=2000 → 201', tk.status === 201, JSON.stringify(tk.json).slice(0, 120));
  ok('balasan tarik memuat bank_fee=2000', tk.json?.data?.bank_fee === 2000,
    JSON.stringify(tk.json?.data ?? {}).slice(0, 120));

  // ── 2. GET /api/topups mengembalikan bank_fee ──────────────────────────────
  console.log('\n=== 2. GET /api/topups bank_fee ===');

  const today = new Date().toISOString().slice(0, 10);
  const daftar = await api('GET', `/api/topups?date=${today}&limit=200`, null, T);
  const rows = daftar.json?.data ?? [];
  const rowEw = rows.find((r) => r.id === 'test-bf-ew');
  const rowPu = rows.find((r) => r.id === 'test-bf-pu');
  const rowTk = rows.find((r) => r.id === 'test-bf-tk');
  ok('baris topup UJI-BF-EW bank_fee=1500', rowEw?.bank_fee === 1500, JSON.stringify(rowEw ?? null).slice(0, 160));
  ok('baris topup UJI-BF-PU bank_fee=0', rowPu?.bank_fee === 0, JSON.stringify(rowPu ?? null).slice(0, 160));
  ok('baris tarik UJI-BF-TK bank_fee=2000', rowTk?.bank_fee === 2000, JSON.stringify(rowTk ?? null).slice(0, 160));

  // ── 3. GET /api/shifts: agregat topup_bank_fee ─────────────────────────────
  console.log('\n=== 3. GET /api/shifts topup_bank_fee ===');

  const shResp = await api('GET', '/api/shifts?status=open&cashier=UJI-BF-KASIR', null, T);
  const shift = (shResp.json?.data ?? []).find((s) => s.id === sid);
  ok('shift uji ada di GET /api/shifts', shift != null, JSON.stringify(shResp.json).slice(0, 160));
  // Eksak: hanya 2 topup uji terikat shift ini (1500 + 0); bank_fee tarik
  // (2000) TIDAK ikut — aggregate filter kind='topup' saja.
  ok('topup_bank_fee = 1500 eksak (tarik tidak ikut)', shift?.topup_bank_fee === 1500,
    `nilai=${shift?.topup_bank_fee}`);
  // Laci tidak berubah oleh bank_fee: topup_admin tetap Σ admin penuh
  // (3000 + 2000 = 5000) — pengurangan laba-bersih hanya lapisan laporan.
  ok('topup_admin = 5000 (laci tetap admin penuh)', shift?.topup_admin === 5000,
    `nilai=${shift?.topup_admin}`);
  ok('n_topup = 3 (semua kind dihitung)', shift?.n_topup === 3, `nilai=${shift?.n_topup}`);

  // ── 4. CRUD /api/topup-services ────────────────────────────────────────────
  console.log('\n=== 4. CRUD /api/topup-services ===');

  const noAuth = await api('GET', '/api/topup-services');
  ok('GET tanpa token → 401 (global middleware)', noAuth.status === 401, `status=${noAuth.status}`);

  const get1 = await api('GET', '/api/topup-services', null, T);
  ok('GET dengan token → 200', get1.status === 200, `status=${get1.status}`);
  ok('GET mengembalikan array', Array.isArray(get1.json?.data), JSON.stringify(get1.json).slice(0, 120));

  const post1 = await api('POST', '/api/topup-services', {
    provider: 'UJI-BF-EW', label: 'Layanan Uji EW', admin_default: 3000, bank_fee_default: 1500,
  }, T);
  ok('POST UJI-BF-EW → 201', post1.status === 201, JSON.stringify(post1.json).slice(0, 160));

  const post2 = await api('POST', '/api/topup-services', {
    provider: 'UJI-BF-EW', label: 'Layanan Uji EW v2', admin_default: 3500, bank_fee_default: 1500,
  }, T);
  ok('POST ulang UJI-BF-EW → 200 (upsert)', post2.status === 200, `status=${post2.status}`);

  const get2 = await api('GET', '/api/topup-services', null, T);
  const arr2 = get2.json?.data ?? [];
  const rowEwSvc = arr2.find((s) => s.provider === 'UJI-BF-EW');
  ok('GET memuat UJI-BF-EW', rowEwSvc != null, JSON.stringify(arr2).slice(0, 160));
  ok('upsert mengganti admin_default=3500', rowEwSvc?.admin_default === 3500,
    `nilai=${rowEwSvc?.admin_default}`);

  const noProvider = await api('POST', '/api/topup-services', { label: 'X', admin_default: 0, bank_fee_default: 0 }, T);
  ok('POST tanpa provider → 400', noProvider.status === 400, `status=${noProvider.status}`);
  ok('pesan "provider wajib"', String(noProvider.json?.error ?? '').includes('provider wajib'),
    JSON.stringify(noProvider.json).slice(0, 120));

  const noLabel = await api('POST', '/api/topup-services', { provider: 'UJI-BF-KOSONG', admin_default: 0, bank_fee_default: 0 }, T);
  ok('POST tanpa label → 400', noLabel.status === 400, `status=${noLabel.status}`);
  ok('pesan "label wajib"', String(noLabel.json?.error ?? '').includes('label wajib'),
    JSON.stringify(noLabel.json).slice(0, 120));

  const bfGede = await api('POST', '/api/topup-services', {
    provider: 'UJI-BF-GEDE', label: 'X', admin_default: 1000, bank_fee_default: 2000,
  }, T);
  ok('bank_fee_default > admin_default → 400', bfGede.status === 400, `status=${bfGede.status}`);
  ok('pesan "potongan bank default"', String(bfGede.json?.error ?? '').includes('potongan bank default'),
    JSON.stringify(bfGede.json).slice(0, 120));

  const postNoAuth = await api('POST', '/api/topup-services', {
    provider: 'UJI-BF-NOAUTH', label: 'X', admin_default: 0, bank_fee_default: 0,
  });
  ok('POST tanpa token → 401', postNoAuth.status === 401, `status=${postNoAuth.status}`);

  const del = await api('DELETE', '/api/topup-services/UJI-BF-EW', null, T);
  ok('DELETE UJI-BF-EW → 200', del.status === 200, `status=${del.status}`);
  ok('DELETE mengembalikan deleted:true', del.json?.data?.deleted === true, JSON.stringify(del.json).slice(0, 120));

  const delLagi = await api('DELETE', '/api/topup-services/UJI-BF-EW', null, T);
  ok('DELETE ulang → 404', delLagi.status === 404, `status=${delLagi.status}`);

  const delNoAuth = await api('DELETE', '/api/topup-services/UJI-BF-PU');
  ok('DELETE tanpa token → 401', delNoAuth.status === 401, `status=${delNoAuth.status}`);

  // ── 5. suggest-admin?provider= ─────────────────────────────────────────────
  console.log('\n=== 5. suggest-admin?provider= ===');

  const svc = await api('POST', '/api/topup-services', {
    provider: 'UJI-BF-SVC', label: 'Layanan Uji SVC', admin_default: 1200, bank_fee_default: 300,
  }, T);
  ok('POST UJI-BF-SVC → 201', svc.status === 201, JSON.stringify(svc.json).slice(0, 160));

  const sugMaster = await api('GET', '/api/topups/suggest-admin?nominal=50000&provider=UJI-BF-SVC', null, T);
  ok('master menang atas tier: admin=1200', sugMaster.json?.data?.admin === 1200,
    JSON.stringify(sugMaster.json).slice(0, 160));
  ok('master menang atas tier: bank_fee=300', sugMaster.json?.data?.bank_fee === 300,
    JSON.stringify(sugMaster.json).slice(0, 160));

  const sugTanpa = await api('GET', '/api/topups/suggest-admin?nominal=100000', null, T);
  ok('tanpa provider → 200 (fallback tier)', sugTanpa.status === 200, `status=${sugTanpa.status}`);
  ok('tier 100rb → admin=5000', sugTanpa.json?.data?.admin === 5000,
    JSON.stringify(sugTanpa.json).slice(0, 160));
  ok('fallback tier SELALU mengirim bank_fee=0', sugTanpa.json?.data?.bank_fee === 0,
    JSON.stringify(sugTanpa.json).slice(0, 160));

  const sugUkyn = await api('GET', '/api/topups/suggest-admin?nominal=250000&provider=UJI-BF-TIDAK-ADA', null, T);
  ok('provider tidak dikenal → tier 250rb → admin=7000', sugUkyn.json?.data?.admin === 7000,
    JSON.stringify(sugUkyn.json).slice(0, 160));
  ok('provider tidak dikenal → bank_fee=0', sugUkyn.json?.data?.bank_fee === 0,
    JSON.stringify(sugUkyn.json).slice(0, 160));
} finally {
  bersihkanDB(); // buang topup uji + master UJI-BF-* + shift uji + audit-nya
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [bank-fee-test.mjs]`);
