#!/usr/bin/env node
/* Runner regresi Ravaa POS — jalankan:  npm run test  (atau: node tests/run.mjs)
 *
 * Aturan keras (jangan dilunakkan — ini pernah bikin 3 suite MODULE_NOT_FOUND
 * tercetak "OK" palsu):
 *   1. file hilang            -> GAGAL (bukan dilewati)
 *   2. proses crash / exit!=0 -> GAGAL
 *   3. 0 assertion terbaca    -> GAGAL (test diam = test rusak)
 *   4. lolos != `ekspek`      -> GAGAL (jumlah asersi turun diam-diam)
 *   5. path absolut milik mesin di file test -> GAGAL sebelum suite dijalankan
 *
 * `ekspek` adalah jumlah asersi terakhir yang hijau. Bila Anda MEMANG sengaja
 * menambah/mengurangi asersi, update angkanya di sini — jangan dihapus.
 *
 * Prasyarat: API (:3001) dan web (:5656) sudah jalan. Suite .ts dijalankan
 * lewat tsx, .mjs lewat node biasa.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/* Aturan keras #5: file test tidak boleh memuat path absolut milik mesin
 * (awalan direktori home pengguna, atau direktori user di macOS). Path begitu
 * membuat suite gagal begitu pindah clone / ganti mesin / naik versi Node —
 * dulu importcsv-test, escpos-test, enam suite e2e, dan satuan-test
 * memakainya; satuan-test bahkan mengimpor paket browser lewat path global
 * yang memuat nomor versi Node di dalamnya, jadi ia pecah pada saat Node
 * diganti, bukan saat kode diubah. Semuanya kini diturunkan dari
 * import.meta.url atau specifier relatif. */
function cekPathAbsolut() {
  const jelek = [];
  for (const nama of readdirSync(DIR)) {
    if (!/\.(mjs|ts)$/.test(nama)) continue;
    readFileSync(path.join(DIR, nama), 'utf8').split('\n').forEach((b, i) => {
      const m = b.match(/\/(home|Users)\/[A-Za-z0-9._-]+/);
      if (m) jelek.push(`${nama}:${i + 1}  ${m[0]}`);
    });
  }
  if (jelek.length) {
    console.log('GAGAL     path absolut milik mesin di file test — turunkan dari import.meta.url:');
    jelek.forEach((j) => console.log(`            ${j}`));
    process.exit(1);
  }
}

const SUITE = [
  ['importcsv-test.ts', 176],
  ['escpos-test.ts', 71],
  ['sku-urut-test.mjs', 17],
  ['product-delete-test.mjs', 31],
  ['e2e-import.mjs', 43],
  ['e2e-opname.mjs', 38],
  ['e2e-label.mjs', 21],
  ['e2e-struk.mjs', 138],
  ['e2e-hpp.mjs', 28],
  ['satuan-test.mjs', 44],
  ['e2e-multisatuan.mjs', 30],
  ['e2e-duplikat.mjs', 37],
  ['e2e-aksi.mjs', 34],
  ['pos-qtykode-test.mjs', 26],
  ['kategori-expiry-test.mjs', 14],
  ['history-test.mjs', 26],
  ['laporan-test.mjs', 16],
  ['dashboard-test.mjs', 19],
  ['shift-test.mjs', 23],
  ['foto-tambah-test.mjs', 10],
  ['kadaluarsa-jual-test.mjs', 17],
  ['backup-test.mjs', 27],
  ['customer-debt-test.mjs', 35],
  ['harga-dinamis-test.mjs', 18],
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

cekPathAbsolut();
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
