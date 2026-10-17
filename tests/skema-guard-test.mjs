// Guard skema DB (2026-10-18) — dua perilaku yang diuji di sini:
// (1) Saat start, DB yang ketinggalan kolom memunculkan peringatan BESAR
//     berisi daftar kolom + perintah ALTER siap tempel (SENGAJA tanpa
//     auto-ALTER — kebijakan §5 AGENTS: migrasi manual).
// (2) Error "no such column" dari query yang menyentuh kolom hilang dibalas
//     500 JSON {error} yang menjelaskan penyebabnya — bukan "Internal Server
//     Error" bisu (kasus nyata 2026-10-18: halaman 500 tanpa petunjuk).
// Suite ini menyalakan API-nya SENDIRI (DB temp + PORT bebas) — tidak
// menyentuh DB dev ataupun API :3001.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ravaa-skema-'));
const DB = path.join(TMP, 'data.db');
const sql = (q) => execFileSync('sqlite3', [DB, q]).toString().trim();
const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});
const BASE = `http://localhost:${port}`;

const procs = [];
async function startApi() {
  const proc = spawn(TSX, ['apps/api/src/index.ts'], {
    cwd: REPO,
    env: { ...process.env, DB_PATH: DB, PORT: String(port) },
    detached: true,
  });
  procs.push(proc);
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return () => log; } catch {}
    await tidur(250);
  }
  throw new Error('API uji tidak hidup — log terakhir: ' + log.slice(-500));
}
const stopApi = (proc) => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} };
const api = (m, p, b, t) => fetch(`${BASE}${p}`, {
  method: m,
  headers: { ...(b ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) },
  body: b ? JSON.stringify(b) : undefined,
});

try {
  console.log('=== A. DB baru: seed & start BERSIH (tanpa peringatan) ===');
  const outSeed = execFileSync(TSX, ['apps/api/src/seed.ts'], {
    cwd: REPO, env: { ...process.env, DB_PATH: DB }, encoding: 'utf8',
  });
  chk('seed DB baru: TANPA peringatan skema', !outSeed.includes('[SKEMA DB TIDAK SINKRON]'),
    outSeed.trim().split('\n').pop()?.slice(0, 60));

  const log1 = await startApi();
  chk('start API DB sehat: TANPA peringatan skema', !log1().includes('[SKEMA DB TIDAK SINKRON]'));

  const masuk = await (await api('POST', '/api/login', { username: 'owner', password: 'admin123' })).json();
  const T = masuk?.data?.token;
  chk('login owner di DB uji', !!T, `must_change=${masuk?.data?.must_change}`);
  await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, T);
  const jual = await api('GET', '/api/sales', undefined, T);
  chk('GET /api/sales DB sehat -> 200', jual.status === 200, `status=${jual.status}`);
  stopApi(procs[0]);
  await tidur(400);

  console.log('=== B. DB ketinggalan kolom: peringatan start + 500 informatif ===');
  sql('ALTER TABLE sales DROP COLUMN customer_name;'); // simulasi DB era 2026-10-03
  const log2 = await startApi();
  chk('start API DB ketinggalan kolom: MEMUAT peringatan besar', log2().includes('[SKEMA DB TIDAK SINKRON]'));
  chk('peringatan menyebut kolom yang hilang', log2().includes('sales.customer_name'));
  chk('peringatan memuat perintah ALTER siap tempel', log2().includes('ALTER TABLE sales ADD COLUMN customer_name'));

  const masuk2 = await (await api('POST', '/api/login', { username: 'owner', password: 'admin123' })).json();
  const T2 = masuk2?.data?.token;
  await api('POST', '/api/users/password', { old_password: 'admin123', password: 'admin123' }, T2);
  const rusak = await api('GET', '/api/sales', undefined, T2);
  const isiRusak = await rusak.json().catch(() => null);
  chk('GET /api/sales DB rusak -> 500 JSON (bukan teks polos)',
    rusak.status === 500 && (rusak.headers.get('content-type') || '').includes('application/json'),
    `status=${rusak.status} ct=${rusak.headers.get('content-type')}`);
  chk('pesan 500 menjelaskan penyebab + arah perbaikan',
    !!isiRusak?.error?.includes('tidak sinkron dengan skema') && !!isiRusak?.error?.includes('customer_name'),
    isiRusak?.error?.slice(0, 100));
  chk('server tetap hidup setelah 500 (endpoint lain tidak ikut mati)', (await api('GET', '/health')).status === 200);
  const lain = await api('GET', '/api/products', undefined, T2);
  chk('endpoint yang TIDAK menyentuh kolom hilang tetap 200', lain.status === 200, `status=${lain.status}`);
} finally {
  for (const proc of procs) stopApi(proc);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
