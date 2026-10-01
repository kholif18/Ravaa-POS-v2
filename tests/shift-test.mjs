// Halaman Shift Kasir (#/shifts) + endpoint baru GET /api/shifts.
// Kunci: agregat per shift (n_sales/omzet/tunai/n_topup) harus sama dengan
// data nyata; buka & tutup shift lewat UI harus mengubah server; shift `kasir`
// (dipakai suite POS) TIDAK boleh tersentuh — test ini memakai kasir uji sendiri.
// Jalankan: node shift-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;
const KASIR_UJI = `shift-uji-${Date.now().toString(36)}`;

/** Hapus keras artefak uji lewat sqlite3 langsung (test-only, pola sama
 *  dengan product-delete/sku-urut). shift-uji% tidak pernah punya sales /
 *  topup_txns (FK aman); shift `kasir` (dipakai suite POS) tidak tersentuh. */
const bersihShiftUji = () => {
  try {
    execFileSync('sqlite3', [DB, "DELETE FROM shifts WHERE cashier LIKE 'shift-uji%'"]);
    return execFileSync('sqlite3', [DB,
      `SELECT (SELECT COUNT(*) FROM shifts WHERE cashier LIKE 'shift-uji%')||'|'||(SELECT COUNT(*) FROM shifts WHERE cashier='kasir')`],
      { encoding: 'utf8' }).trim();
  } catch (e) { return 'gagal: ' + String(e).slice(0, 120); }
};

const get = async (u) => {
  const r = await fetch(API + u);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (u, data) => {
  const r = await fetch(API + u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} | ${info}`); }
};

try {
  // Bersihkan sisa run sebelumnya (termasuk run yang crash di tengah) supaya
  // total/urutan di bawah tidak dibawa-bawa artefak lama.
  bersihShiftUji();
  console.log('=== A. Kontrak GET /api/shifts ===');
  const semua = await get('/api/shifts?status=semua');
  ok('200 + {data, total}', semua.status === 200 && Array.isArray(semua.body.data)
    && typeof semua.body.total === 'number', `status=${semua.status}`);
  const wajib = ['id', 'opened_at', 'modal_awal', 'cashier', 'status', 'n_sales', 'omzet', 'tunai', 'n_topup'];
  ok('baris memuat kolom shift + agregat', semua.body.data.every((s) => wajib.every((k) => k in s)),
    JSON.stringify(Object.keys(semua.body.data[0] ?? {})));
  const ids = semua.body.data.map((s) => s.id);
  ok('urutan id DESC', ids.every((v, i) => i === 0 || ids[i - 1] > v), JSON.stringify(ids));

  const buruk = await get('/api/shifts?status=buka');
  ok('status tak dikenal -> 400', buruk.status === 400 && /open\|closed\|semua/.test(buruk.body.error ?? ''),
    JSON.stringify(buruk.body));
  const open = await get('/api/shifts?status=open');
  ok('status=open hanya baris open', open.status === 200
    && open.body.data.every((s) => s.status === 'open'), JSON.stringify(open.body.data.map((s) => s.status)));
  const closed = await get('/api/shifts?status=closed');
  ok('status=closed hanya baris closed', closed.status === 200
    && closed.body.data.every((s) => s.status === 'closed'), JSON.stringify(closed.body.data.map((s) => s.status)));
  const limit1 = await get('/api/shifts?limit=1');
  ok('limit=1 membatasi data, total tetap jumlah sebenarnya',
    limit1.body.data.length === 1 && limit1.body.total === semua.body.total,
    `data=${limit1.body.data.length} total=${limit1.body.total}/${semua.body.total}`);

  console.log('=== B. Agregat = hitungan dari data nyata ===');
  // Satu target saja (deterministik, jumlah asersi tetap): shift yang SEDANG
  // terbuka. Agregat server dihitung ALL-TIME per shift, sedangkan
  // GET /api/sales memfilter per hari (default = hari UTC ini) — jadi tarik
  // penjualannya sejak TANGGAL SHIFT DIBUKA sampai hari ini, baru saring
  // shift_id. (Terbukti gagal kalau cuma memakai default hari ini: shift #1
  // dibuka 30 Sep, test dijalankan sudah lewat tengah malam jadi daftar kosong.)
  const target = open.body.data[0] ?? semua.body.data[0];
  const tglBuka = target.opened_at.slice(0, 10);
  const tglHariIni = new Date().toISOString().slice(0, 10);
  const rentang = [];
  for (let d = tglBuka; d <= tglHariIni && rentang.length < 14; ) {
    rentang.push(d);
    const dd = new Date(`${d}T00:00:00Z`);
    dd.setUTCDate(dd.getUTCDate() + 1);
    d = dd.toISOString().slice(0, 10);
  }
  const perHari = await Promise.all(rentang.map((d) => get(`/api/sales?date=${d}&limit=200`)));
  const baris = perHari.flatMap((r) => r.body.data ?? []).filter((sl) => sl.shift_id === target.id);
  const omzet = baris.reduce((a, sl) => a + sl.total, 0);
  const tunai = baris.filter((sl) => sl.pay_method === 'tunai').reduce((a, sl) => a + sl.total, 0);
  ok(`shift #${target.id}: n_sales & omzet cocok (n=${baris.length}, ${rp(omzet)})`,
    target.n_sales === baris.length && target.omzet === omzet,
    `api n=${target.n_sales} omzet=${target.omzet} vs hitung n=${baris.length} omzet=${omzet} (rentang ${rentang[0]}..${rentang.at(-1)})`);
  ok(`shift #${target.id}: tunai cocok (${rp(tunai)})`, target.tunai === tunai,
    `api=${target.tunai} vs ${tunai}`);

  console.log('=== C. UI: render & filter ===');
  const kasirSebelum = await get('/api/shifts/open?cashier=kasir');
  const kasirId = kasirSebelum.body.data?.id ?? null;

  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${WEB}/#/shifts`, { waitUntil: 'load' });
    await page.waitForTimeout(1600);
    const nBaris = Math.min(semua.body.total, 200);
    ok(`tabel menampilkan ${nBaris} baris (Semua)`,
      (await page.locator('#sh-body tbody tr').count()) === nBaris,
      `ada=${await page.locator('#sh-body tbody tr').count()} harap=${nBaris}`);
    ok('tabel punya 10 kolom kepala', (await page.locator('#sh-body thead th').count()) === 10,
      `kolom=${await page.locator('#sh-body thead th').count()}`);

    await page.click('[data-f="open"]');
    await page.waitForTimeout(800);
    const barisOpen = await page.locator('#sh-body tbody tr').allInnerTexts();
    ok('filter Terbuka: semua baris badge Terbuka',
      barisOpen.length === open.body.data.length && barisOpen.every((t) => t.includes('Terbuka')),
      `baris=${barisOpen.length} api=${open.body.data.length}`);

    console.log('=== D. Buka shift (UI) -> POST /api/shifts/open ===');
    await page.click('#sh-open');
    await page.waitForTimeout(350);
    await page.fill('#sh-kasir', KASIR_UJI);
    await page.fill('#sh-modal', '40000');
    await page.click('.modal-overlay [data-ok]');
    await page.waitForTimeout(1200);
    const uji = await get(`/api/shifts?cashier=${encodeURIComponent(KASIR_UJI)}`);
    ok('shift uji terbuka di server (modal 40000)',
      uji.body.data.length === 1 && uji.body.data[0].status === 'open'
      && uji.body.data[0].modal_awal === 40000, JSON.stringify(uji.body.data));
    const ujiId = uji.body.data[0]?.id;
    ok('baris shift uji muncul di tabel',
      (await page.locator('#sh-body tbody tr', { hasText: KASIR_UJI }).count()) === 1);

    console.log('=== E. Tutup shift (UI): selisih + POST close ===');
    await page.locator('#sh-body tbody tr', { hasText: KASIR_UJI }).locator('[data-tutup]').click();
    await page.waitForTimeout(350);
    await page.fill('#sh-akhir', '47000'); // 47000 - 40000 = Rp7.000
    await page.waitForTimeout(200);
    const selisih = await page.locator('#sh-selisih').innerText();
    ok('selisih live = kas fisik − modal awal (Rp7.000)', selisih.includes('7.000'), selisih);
    await page.click('.modal-overlay [data-ok]');
    await page.waitForTimeout(1200);
    const uji2 = await get(`/api/shifts?cashier=${encodeURIComponent(KASIR_UJI)}`);
    const row2 = uji2.body.data.find((s) => s.id === ujiId);
    ok('shift uji closed + modal_akhir tersimpan',
      row2?.status === 'closed' && row2?.modal_akhir === 47000, JSON.stringify(row2));

    console.log('=== F. Shift kasir (suite POS) tidak tersentuh + tanpa error ===');
    const sesudah = await get('/api/shifts/open?cashier=kasir');
    ok('shift kasir tetap terbuka dengan id sama',
      (sesudah.body.data?.id ?? null) === kasirId && sesudah.body.data?.status === 'open',
      `sebelum=${kasirId} sesudah=${sesudah.body.data?.id}`);
    ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  // Cleanup keras di akhir (juga jalan saat crash): DB dev harus kembali
  // tanpa baris shift-uji, dan shift `kasir` wajib masih ada — invarian suite
  // ini, sama seperti "0 sisa UJI-% / 0 tombstone" di product-delete-test.
  const akhir = bersihShiftUji();
  const [nUji, nKasir] = akhir.split('|').map(Number);
  console.log(`\ncleanup shift-uji: sisa uji=${nUji}, shift kasir=${nKasir} (harus 0|>=1)`);
  ok('cleanup: 0 sisa shift-uji & shift kasir tetap ada', nUji === 0 && nKasir >= 1, akhir);
  const nama = fileURLToPath(import.meta.url).split('/').pop();
  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [${nama}]`);
  if (gagal) process.exit(1);
}
