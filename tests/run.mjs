#!/usr/bin/env node
/* Runner regresi Ravaa POS — jalankan:  npm run test  (atau: node tests/run.mjs)
 *
 * Aturan keras (jangan dilunakkan — ini pernah bikin 3 suite MODULE_NOT_FOUND
 * tercetak "OK" palsu):
 *   1. file hilang            -> GAGAL (bukan dilewati)
 *   2. proses crash / exit!=0 -> GAGAL
 *   3. 0 assertion terbaca    -> GAGAL (test diam = test rusak)
 *   4. lolos != `ekspek`      -> GAGAL (jumlah asersi turun diam-diam)
 *
 * `ekspek` adalah jumlah asersi terakhir yang hijau. Bila Anda MEMANG sengaja
 * menambah/mengurangi asersi, update angkanya di sini — jangan dihapus.
 *
 * Prasyarat: API (:3001) dan web (:5656) sudah jalan. Suite .ts dijalankan
 * lewat tsx, .mjs lewat node biasa.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const SUITE = [
  ['importcsv-test.ts', 73],
  ['escpos-test.ts', 55],
  ['product-delete-test.mjs', 25],
  ['e2e-import.mjs', 24],
  ['e2e-opname.mjs', 23],
  ['e2e-label.mjs', 20],
  ['e2e-struk.mjs', 34],
  ['e2e-hpp.mjs', 26],
  ['satuan-test.mjs', 43],
  ['e2e-multisatuan.mjs', 29],
];

let total = 0;
const bermasalah = [];

/* Prasyarat yang TIDAK boleh disembunyikan: API harus hidup, dan harus ada
 * shift terbuka — suite POS menembak penjualan lewat UI, jadi tanpa shift layar
 * menampilkan gerbang "Buka shift dulu" dan semua asersi gagal dengan pesan
 * membingungkan. Dulu shift dibuka manual, jadi hasil test tergantung apakah
 * penulisnya baru membuka shift atau tidak. */
const API = 'http://localhost:3001';
async function siapkan() {
  let sehat = false;
  try {
    sehat = (await fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch { /* dibawah */ }
  if (!sehat) {
    console.log('GAGAL     API tidak terjangkau di :3001 — jalankan `npm run dev:api` dulu');
    process.exit(1);
  }
  const buka = async () => {
    const r = await fetch(`${API}/api/shifts/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modal_awal: 100000, cashier: 'kasir' }),
    });
    return r.ok;
  };
  const ada = await (await fetch(`${API}/api/shifts/open?cashier=kasir`)).json().catch(() => ({}));
  if (!ada?.data?.id) {
    // 409 = shift kasir ini sudah terbuka (UNIQUE INDEX) — cukup satu per kasir.
    await buka();
    const ulang = await (await fetch(`${API}/api/shifts/open?cashier=kasir`)).json().catch(() => ({}));
    if (!ulang?.data?.id) {
      console.log('GAGAL     tidak bisa membuka shift — suite POS mustahil lulus');
      process.exit(1);
    }
  }
}

await siapkan();

for (const [nama, ekspek] of SUITE) {
  const file = path.join(DIR, nama);
  if (!existsSync(file)) {
    console.log(`HILANG    ${nama}  <-- FILE TIDAK ADA`);
    bermasalah.push(nama);
    continue;
  }
  const cmd = nama.endsWith('.ts') ? ['npx', ['tsx', file]] : ['node', [file]];
  let out = '';
  let kode = 0;
  try {
    out = execFileSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 900_000, cwd: path.join(DIR, '..') });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    kode = e.status ?? -1;
  }
  const lolos = Number((out.match(/lolos: (\d+)/) ?? [])[1] ?? 0);
  const gagal = Number((out.match(/gagal: (\d+)/) ?? [])[1] ?? 0);
  const crash = kode !== 0 || /MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND|TimeoutError|SyntaxError/.test(out);

  if (crash || lolos === 0) {
    console.log(`CRASH     ${nama}  lolos=${lolos} gagal=${gagal} exit=${kode}`);
    out.split('\n').filter((l) => /Error|error|GAGAL|waiting for/.test(l)).slice(0, 4)
      .forEach((l) => console.log(`            ${l.trim()}`));
    bermasalah.push(nama);
    continue;
  }
  if (gagal > 0) {
    console.log(`GAGAL     ${nama}  lolos=${lolos} gagal=${gagal}`);
    out.split('\n').filter((l) => l.includes('GAGAL')).slice(0, 6)
      .forEach((l) => console.log(`            ${l.trim()}`));
    bermasalah.push(nama);
    total += lolos;
    continue;
  }
  if (ekspek !== null && lolos !== ekspek) {
    console.log(`JUMLAH    ${nama}  lolos=${lolos} (ekspektasi ${ekspek}) — asersi berubah diam-diam`);
    bermasalah.push(nama);
    total += lolos;
    continue;
  }
  console.log(`OK        ${nama}  (${lolos} assertion)`);
  total += lolos;
}

console.log(`\n=== TOTAL: ${total} assertion lolos ===`);
if (bermasalah.length) {
  console.log('SUITE BERMASALAH: ' + bermasalah.join(', '));
  process.exit(1);
}
console.log('SEMUA HIJAU');
