// Fitur 1.2 — Backup otomatis DB:
//   GET  /api/backup        -> daftar file (terbaru dulu)
//   POST /api/backup        -> backup manual (selalu file baru; integrity
//                              check + retensi 14 jalan juga di sini)
//   GET  /api/backup/:nama  -> unduh; guard GANDA path.basename + whitelist
//                              pola nama (traversal harus 404)
// Retensi & jadwal harian idempoten diuji via hitungan file di folder
// `apps/api/data/backups` (fs), bukan cuma respon API.
//
// KONVENSI AMAN: file backup yang sudah ada SEBELUM test di-snapshot dulu,
// di `finally` file yang hilang dikembalikan dan file yang dibuat test
// dibuang — test tidak boleh menghapus milik pemilik (retensi membuang file
// TERLAMA; dummy sengaja dibuat tahun 2020 supaya yang terbuang cuma dummy).
//
// Jalankan: node backup-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import path0 from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path0.join(REPO, 'apps/api/data/backups'); // ikut DB_PATH dev
const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const POLA = /^data-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

const ambil = async (u, init) => {
  const r = await fetch(API + u, init);
  return { status: r.status, hdr: r.headers, body: await r.json().catch(() => ({})) };
};
const daftarFs = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => POLA.test(n)).sort() : []);

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};

// ---- snapshot file asli (milik pemilik) ----
const SNAP = '/tmp/opencode/backup-snap';
fs.mkdirSync(SNAP, { recursive: true });
const asli = daftarFs();
for (const n of asli) fs.copyFileSync(path0.join(DIR, n), path0.join(SNAP, n));
console.log(`snapshot ${asli.length} file asli -> ${SNAP}`);

try {
  console.log('=== A. GET /api/backup — daftar + urutan ===');
  const awal = await ambil('/api/backup');
  ok('list 200 + data[] array', awal.status === 200 && Array.isArray(awal.body.data),
    JSON.stringify(awal.body).slice(0, 120));
  const urut = awal.body.data.map((b) => b.nama);
  ok('urut terbaru dulu (leksikografis turun)',
    urut.every((n, i) => i === 0 || urut[i - 1] >= n), urut.slice(0, 3).join(' > '));
  ok('tiap baris punya nama+ukuran+waktu',
    awal.body.data.every((b) => POLA.test(b.nama) && typeof b.ukuran === 'number'
      && typeof b.waktu === 'string' && b.ukuran > 0));

  console.log('=== B. POST /api/backup — backup manual ===');
  const post = await ambil('/api/backup', { method: 'POST' });
  ok('POST 201 + nama cocok pola + ukuran > 0',
    post.status === 201 && POLA.test(post.body.data?.nama ?? '') && post.body.data.ukuran > 0,
    JSON.stringify(post.body).slice(0, 160));
  const namaBaru = post.body.data?.nama;
  ok('file benar-benar lahir di disk (bukan cuma respon)',
    typeof namaBaru === 'string' && fs.existsSync(path0.join(DIR, namaBaru)), String(namaBaru));
  const sesudah = await ambil('/api/backup');
  ok('list memuat file baru & jumlah naik (atau sudah di cap retensi 14)',
    sesudah.body.data.some((b) => b.nama === namaBaru)
    && sesudah.body.data.length === Math.min(awal.body.data.length + 1, 14),
    `${awal.body.data.length} -> ${sesudah.body.data.length}`);

  console.log('=== C. Unduh + guard traversal ===');
  const unduh = await fetch(`${API}/api/backup/${namaBaru}`);
  const bytes = Buffer.from(await unduh.arrayBuffer());
  ok('unduh 200 + Content-Disposition attachment',
    unduh.status === 200 && /attachment/.test(unduh.headers.get('content-disposition') ?? ''),
    `status=${unduh.status} cd=${unduh.headers.get('content-disposition')}`);
  ok('byte utuh (== ukuran di list)',
    bytes.length === sesudah.body.data.find((b) => b.nama === namaBaru)?.ukuran,
    `${bytes.length} byte`);
  // Bukti isi: file hasil backup harus jadi database SQLite sehat dengan isi
  // yang sama (products ikut ter-copy) — inilah yang menentukan restore bisa.
  const cekFile = path0.join(DIR, namaBaru);
  const tmp = path0.join('/tmp/opencode/uji-backup-unduh.db');
  fs.copyFileSync(cekFile, tmp);
  {
    const d = new Database(tmp, { readonly: true });
    const ic = d.pragma('integrity_check');
    const nProd = d.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    d.close();
    ok('isi file = SQLite sehat + data ikut tercopy (products ada)',
      ic[0]?.integrity_check === 'ok' && nProd >= 1,
      `integrity=${ic[0]?.integrity_check} products=${nProd}`);
  }
  const trav = await fetch(`${API}/api/backup/..%2Fdata.db`);
  ok('traversal ..%2Fdata.db -> 404', trav.status === 404, `status=${trav.status}`);
  const diLuarkeluar = await fetch(`${API}/api/backup/bohong.db`);
  ok('nama di luar pola -> 404', diLuarkeluar.status === 404, `status=${diLuarkeluar.status}`);
  const polaKosong = await fetch(`${API}/api/backup/data-1999-01-01-000000.db`);
  ok('pola valid tapi file tidak ada -> 404', polaKosong.status === 404, `status=${polaKosong.status}`);

  console.log('=== D. Retensi 14 file ===');
  // File asli pemilik DIPINDAH sementara ke SNAP supaya retensi test tidak
  // bisa membuangnya — folder mulai dari kondisi terkendali (hanya file POST
  // dari bagian B). Dikembalikan oleh blok finally di bawah.
  // copy+rm, BUKAN rename: SNAP ada di /tmp (filesystem beda) -> renameSync
  // meledak EXDEV "cross-device link not permitted". existsSync: file asli
  // bisa saja sudah terbuang retensi saat POST-B tadi (bila folder penuh).
  for (const n of asli) {
    const dari = path0.join(DIR, n);
    if (fs.existsSync(dari)) {
      fs.copyFileSync(dari, path0.join(SNAP, n));
      fs.rmSync(dari);
    }
  }
  fs.mkdirSync(DIR, { recursive: true });
  for (let i = 1; i <= 16; i++) {
    // Timestamp 2020 (paling tua) — yang terbuang retensi WAJIB dummy ini,
    // bukan file tahun-2026 milik test/pemilik.
    fs.writeFileSync(path0.join(DIR, `data-2020-01-01-${String(i).padStart(6, '0')}.db`), 'dummy');
  }
  const nSebelum = daftarFs().length; // file-B + 16 dummy = 17
  const post2 = await ambil('/api/backup', { method: 'POST' });
  const nSesudah = daftarFs().length;
  ok('POST saat folder penuh -> tetap 201', post2.status === 201, JSON.stringify(post2.body).slice(0, 120));
  ok(`retensi membatasi <= 14 file (${nSebelum} + 1 -> ${nSesudah})`,
    nSebelum === 17 && nSesudah === 14, `sebelum=${nSebelum} sesudah=${nSesudah}`);
  const isiKini = daftarFs();
  const dummySisa = isiKini.filter((n) => n.startsWith('data-2020-'));
  ok('yang terbuang = dummy tertua (file POST utuh, sisa dummy < 16)',
    dummySisa.length === 12
    && isiKini.includes(namaBaru)
    && isiKini.includes(post2.body.data?.nama)
    && isiKini.every((n) => n.startsWith('data-2020-') || n.startsWith('data-2026-')),
    `dummy sisa=${dummySisa.length} isi=${isiKini.join(',')}`);

  console.log('=== E. Halaman Pengaturan (UI kartu Backup) ===');
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${WEB}/#/settings`, { waitUntil: 'load' });
    await page.waitForSelector('#set-backup', { timeout: 8000 });
    const judul = await page.locator('.card h3', { hasText: 'Backup data' }).count();
    ok('kartu "Backup data" tampil', judul === 1, `jumlah=${judul}`);
    const nBarisSebelum = await page.locator('[data-backup-list] li').count();
    ok(`daftar file terisi (${nBarisSebelum} baris)`, nBarisSebelum >= 1, `jumlah=${nBarisSebelum}`);
    const adaUnduh = await page.locator('[data-backup-list] li a[download]').count();
    ok('setiap baris punya tombol Unduh', adaUnduh === nBarisSebelum,
      `unduh=${adaUnduh} baris=${nBarisSebelum}`);
    // Nama baris pertama SEBELUM klik. Sesudah klik, folder sudah di cap 14
    // (retensi) — jadi jumlah baris bisa TETAP; tanda daftar ter-refresh =
    // baris paling atas kini file BARU (urutan terbaru dulu).
    const atasSebelum = await page.locator('[data-backup-list] li').first().getAttribute('data-nama');
    await page.locator('#set-backup').click();
    await page.waitForSelector('#toast-root .toast', { timeout: 8000 });
    const toastTxt = (await page.locator('#toast-root .toast').allInnerTexts()).join(' ');
    ok('klik "Backup sekarang" -> toast "Backup dibuat: ..."',
      /Backup dibuat: data-\d{4}/.test(toastTxt), toastTxt.slice(0, 160));
    await page.waitForFunction(
      (atas) => document.querySelector('[data-backup-list] li')?.dataset.nama !== atas,
      atasSebelum, { timeout: 8000 },
    );
    ok('daftar ter-refresh: baris paling atas = file baru', true);
    ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  // ---- restore: buang file yang dibuat test, kembalikan file asli hilang ----
  try {
    const kini = daftarFs();
    for (const n of kini) {
      if (!asli.includes(n)) fs.rmSync(path0.join(DIR, n), { force: true });
    }
    for (const n of asli) {
      if (!kini.includes(n)) fs.copyFileSync(path0.join(SNAP, n), path0.join(DIR, n));
    }
    const akhir = daftarFs();
    console.log(`restore: ${asli.length} asli -> ${akhir.length} (test dibersihkan)`);
    if (JSON.stringify(akhir) !== JSON.stringify(asli)) {
      gagal++;
      console.log(`  GAGAL isi folder backup kembali persis seperti awal | awal=${asli.join(',')} akhir=${akhir.join(',')}`);
    }
  } catch (e) {
    gagal++;
    console.log('  GAGAL restore folder backup |', String(e.message || e).slice(0, 200));
  }
  const nama = fileURLToPath(import.meta.url).split('/').pop();
  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [${nama}]`);
  if (gagal) process.exit(1);
}
