// Halaman Riwayat transaksi (menu sidebar) = dua endpoint baru:
//   GET /api/sales?date=&limit=&offset=     -> daftar penjualan + n_items
//   GET /api/topups?date=&limit=&offset=    -> daftar topup/tarik
// Aturan hari-nya WAJIB sama dengan /api/reports/daily (`date(created_at) =
// date(?)`, default hari UTC), supaya ringkasan di halaman Riwayat dan angka
// halaman Laporan tidak mungkin berbeda — itu yang diuji di bagian A/B.
// Jalankan: node history-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';

const ambil = async (u) => {
  const r = await fetch(API + u);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const hariIni = () => new Date().toISOString().slice(0, 10); // default server: UTC

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};

try {
  console.log('=== A. GET /api/sales — kontrak daftar penjualan ===');
  const dflt = await ambil('/api/sales');
  ok('default 200 + punya data[] dan total', dflt.status === 200
    && Array.isArray(dflt.body.data) && typeof dflt.body.total === 'number',
    JSON.stringify(dflt.body).slice(0, 160));
  const eks = await ambil(`/api/sales?date=${hariIni()}`);
  ok('hari default = hari UTC (sama dengan ?date=<hari ini>)',
    eks.status === 200 && eks.body.total === dflt.body.total
    && JSON.stringify(eks.body.data) === JSON.stringify(dflt.body.data));

  const rep = (await ambil('/api/reports/daily')).body.data;
  ok(`total penjualan == reports/daily (n=${rep.sales.n})`, dflt.body.total === rep.sales.n,
    `sales=${dflt.body.total} vs reports=${rep.sales.n}`);

  const b0 = dflt.body.data[0] ?? null;
  ok('baris memuat n_items + kolom nota', b0 === null
    || (typeof b0.n_items === 'number' && b0.n_items >= 1
      && 'subtotal' in b0 && 'total' in b0 && 'pay_method' in b0 && 'cashier' in b0),
    JSON.stringify(b0));

  const urut = dflt.body.data.map((r) => r.created_at);
  ok('urutan terbaru dulu (created_at tidak naik)',
    urut.every((t, i) => i === 0 || urut[i - 1] >= t), urut.slice(0, 4).join(' > '));

  if (b0) {
    const isi = await ambil(`/api/sales/${encodeURIComponent(b0.id)}`);
    ok('isi nota (GET /api/sales/:id) cocok dengan n_items di daftar',
      isi.status === 200 && isi.body.data.items.length === b0.n_items,
      `items=${isi.body.data.items?.length} n_items=${b0.n_items}`);
    // base_unit ikut terkirim sejak cetak ulang struk (P3/F1): struk hanya
    // mencetak unit penjualan bila berbeda dari satuan dasar produknya.
    ok('isi nota memuat base_unit (dasar cetak ulang struk)',
      isi.status === 200 && isi.body.data.items.every((it) => 'base_unit' in it),
      JSON.stringify(isi.body.data.items?.[0] ?? null).slice(0, 200));
  }

  console.log('=== B. limit/offset & tanggal rusak ===');
  const hal2 = await ambil(`/api/sales?date=${hariIni()}&limit=2`);
  ok('limit=2 membatasi baris tapi total tetap', hal2.body.data.length <= 2
    && hal2.body.total === dflt.body.total,
    `rows=${hal2.body.data.length} total=${hal2.body.total}/${dflt.body.total}`);
  const ofs = await ambil(`/api/sales?date=${hariIni()}&limit=2&offset=2`);
  const idHal1 = new Set(hal2.body.data.map((r) => r.id));
  ok('offset=2 menyusulkan baris berikutnya (bukan halaman pertama lagi)',
    ofs.body.data.length <= 2 && ofs.body.data.every((r) => !idHal1.has(r.id)),
    JSON.stringify({ hal1: [...idHal1].map((i) => i.slice(0, 8)), offset: ofs.body.data.map((r) => r.id.slice(0, 8)) }));
  for (const jelek of ['rabu', '31-02-2026', '2026-02-31']) {
    const r = await ambil(`/api/sales?date=${jelek}`);
    const t = await ambil(`/api/topups?date=${jelek}`);
    ok(`tanggal rusak "${jelek}" -> 400 (bukan hari kosong palsu)`,
      r.status === 400 && t.status === 400, `sales=${r.status} topups=${t.status}`);
  }
  const kosong = await ambil('/api/sales?date=2000-01-01');
  ok('tanggal tanpa transaksi -> data [] dan total 0',
    kosong.status === 200 && kosong.body.data.length === 0 && kosong.body.total === 0,
    JSON.stringify(kosong.body));

  console.log('=== C. GET /api/topups — daftar topup/tarik ===');
  const tp = await ambil('/api/topups');
  ok('default 200 + punya data[] dan total', tp.status === 200
    && Array.isArray(tp.body.data) && typeof tp.body.total === 'number');
  const perKind = rep.topup.reduce((a, k) => a + k.n, 0);
  ok(`total topup == jumlah reports/daily (${perKind})`, tp.body.total === perKind,
    `topups=${tp.body.total} vs reports=${perKind}`);
  const tb = tp.body.data[0] ?? null;
  ok('baris topup memuat kind/provider/nominal/admin/total/pay_method', tb === null
    || (['topup', 'tarik'].includes(tb.kind) && typeof tb.provider === 'string'
      && typeof tb.nominal === 'number' && typeof tb.admin === 'number'
      && typeof tb.total === 'number' && typeof tb.pay_method === 'string'),
    JSON.stringify(tb));
  ok('total = nominal + admin (aturan §domain topup)',
    tb === null || tb.total === tb.nominal + tb.admin, JSON.stringify(tb));
  const t0 = await ambil('/api/topups?date=2000-01-01');
  ok('tanggal tanpa transaksi (topup) -> [] dan total 0',
    t0.status === 200 && t0.body.data.length === 0 && t0.body.total === 0);

  console.log('=== D. Halaman Riwayat transaksi (UI) ===');
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
    await page.goto(`${WEB}/#/history`, { waitUntil: 'load' });
    await page.waitForTimeout(1800);
    const menu = await page.locator('a[href="#/history"]').count();
    ok('menu sidebar "Riwayat transaksi" ada', menu === 1, `jumlah=${menu}`);
    const nBaris = await page.locator('#page tbody tr[data-trx]').count();
    const harap = Math.min(dflt.body.total, 200) + Math.min(tp.body.total, 200);
    ok(`baris linimasa = penjualan + topup hari ini (${harap})`, nBaris === harap,
      `ada=${nBaris} harap=${harap}`);
    const ringkas = (await page.locator('#h-body .card .chip').allInnerTexts()).join(' ');
    ok('ringkasan seangka laporan (n penjualan & omzet)',
      ringkas.includes(`${rep.sales.n} penjualan`) && ringkas.includes('omzet'), ringkas);

    if (dflt.body.total > 0) {
      await page.locator('#page tbody tr[data-trx]').first().click();
      await page.waitForTimeout(1000);
      ok('klik baris -> rincian terbuka', await page.locator('#page tbody tr.det-row').count() === 1);

      // Cetak ulang struk (P3/F1): tombol ada di kartu Pembayaran rincian nota.
      // Print-agent (:9100) boleh hidup (toast sukses) atau mati (toast gagal) —
      // dua-duanya memuat kata "Struk", yang dilarang hanya error console/crash.
      await page.waitForSelector('[data-reprint]', { timeout: 8000 });
      const nTombol = await page.locator('[data-reprint]').count();
      ok('rincian penjualan punya tombol "Cetak ulang struk"', nTombol === 1,
        `jumlah=${nTombol}`);
      await page.locator('[data-reprint]').click();
      await page.waitForTimeout(2500);
      const toastTxt = (await page.locator('#toast-root .toast').allInnerTexts()).join(' ');
      ok('klik cetak ulang -> toast "Struk ..." (sukses/tidak tercetak)',
        /Struk/i.test(toastTxt), toastTxt.slice(0, 160));
    }

    const sebelum = await page.locator('#h-date').inputValue();
    await page.locator('[data-h="prev"]').click();
    await page.waitForTimeout(700);
    const sesudah = await page.locator('#h-date').inputValue();
    ok('tombol prev menggeser tanggal satu hari', sesudah < sebelum, `${sebelum} -> ${sesudah}`);

    ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  const nama = fileURLToPath(import.meta.url).split('/').pop();
  console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [${nama}]`);
  if (gagal) process.exit(1);
}
