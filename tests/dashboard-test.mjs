// Halaman Dashboard (#/dashboard): angka kartu & grafik 7 hari WAJIB sama
// dengan GET /api/reports/daily (7 tanggal), status shift sama dengan
// GET /api/shifts/open?cashier= (satu sumber dengan gerbang POS), dan
// antrian offline = outboxCount() (0 di konteks browser baru).
// Jalankan: node dashboard-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
  import { pasangToken } from './bantuan-uji.mjs';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const hariIni = () => new Date().toISOString().slice(0, 10);
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const geserUTC = (iso, delta) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

const get = async (u) => {
  const r = await fetch(API + u);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} | ${info}`); }
};

try {
  console.log('=== A. Data acuan dari API (7 hari + shift) ===');
  const tanggal = Array.from({ length: 7 }, (_, i) => geserUTC(hariIni(), i - 6));
  const laporan = await Promise.all(
    tanggal.map(async (d) => ({ d, j: (await get(`/api/reports/daily?date=${d}`)).body.data })),
  );
  const hariIniData = laporan[6].j;
  const totalOmzet = laporan.reduce((a, x) => a + x.j.sales.omzet, 0);
  const totalN = laporan.reduce((a, x) => a + x.j.sales.n, 0);
  const nominal = hariIniData.topup.reduce((a, t) => a + t.nominal, 0);
  ok('7 panggilan laporan sukses', laporan.every((x) => x.j?.date === x.d),
    laporan.map((x) => x.j?.date).join(','));

  // Nama kasir = nama AKUN yang login (bukan lagi hardcoded 'kasir') —
  // dashboard menampilkan shift atas nama sesi ini (satu sumber dgn gerbang POS).
  const me = await get('/api/me');
  const kasir = me.body?.data?.user?.name ?? 'kasir';
  const sh = await get(`/api/shifts/open?cashier=${kasir}`);
  ok('200 shifts/open (bukan 404/500)', sh.status === 200, `status=${sh.status}`);

  console.log('=== B. Dashboard = default route & render ===');
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
await pasangToken(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${WEB}/`, { waitUntil: 'load' }); // tanpa hash -> #/dashboard
    await page.waitForTimeout(2200);
    ok('rute kosong -> #/dashboard', page.url().endsWith('#/dashboard'), page.url());
    ok('host #db-body ada', (await page.locator('#db-body').count()) === 1);

    const teks = norm(await page.innerText('#db-body'));
    ok(`kartu Omzet hari ini = API (${rp(hariIniData.sales.omzet)})`,
      teks.includes(`OMZET HARI INI ${rp(hariIniData.sales.omzet)}`), teks.slice(0, 140));
    ok(`kartu Laba hari ini = API (${rp(hariIniData.laba)})`,
      teks.includes(`LABA HARI INI ${rp(hariIniData.laba)}`));
    ok(`kartu Topup & tarik = jumlah nominal API (${rp(nominal)})`,
      teks.includes(`TOPUP & TARIK ${rp(nominal)}`),
    );

    console.log('=== C. Grafik 7 hari (batang dari data-*) ===');
    const bars = await page.locator('#db-body [data-tgl]').evaluateAll((els) =>
      els.map((e) => ({ tgl: e.dataset.tgl, omzet: e.dataset.omzet, n: e.dataset.n })),
    );
    ok('tepat 7 batang', bars.length === 7, `jumlah=${bars.length}`);
    ok('tanggal 7 batang = 7 hari UTC menaik',
      JSON.stringify(bars.map((b) => b.tgl)) === JSON.stringify(tanggal),
      JSON.stringify(bars.map((b) => b.tgl)));
    const barHariIni = bars[6];
    ok(`batang hari ini omzet = API (${hariIniData.sales.omzet})`,
      Number(barHariIni?.omzet) === hariIniData.sales.omzet, `dom=${barHariIni?.omzet}`);
    ok(`batang hari ini jumlah transaksi = API (${hariIniData.sales.n})`,
      Number(barHariIni?.n) === hariIniData.sales.n, `dom=${barHariIni?.n}`);
    ok(`total 7 hari di chip = API (${rp(totalOmzet)}, ${totalN} transaksi)`,
      teks.includes(`${rp(totalOmzet)} · ${totalN} transaksi`),
      `cari ${rp(totalOmzet)} · ${totalN}`);

    console.log('=== D. Status shift (satu sumber dengan gerbang POS) ===');
    const shift = sh.body.data;
    if (shift) {
      ok('shift terbuka ditampilkan + nomornya', teks.includes(`SHIFT #${shift.id} · TERBUKA`)
        || teks.includes(`Shift #${shift.id} · terbuka`), `cari Shift #${shift.id}`);
      ok('modal awal shift tampil', teks.includes(rp(shift.modal_awal)), rp(shift.modal_awal));
      ok('kasir shift tampil', teks.includes(shift.cashier), shift.cashier);
    } else {
      ok('tanpa shift -> ajakan buka shift tampil', teks.toLowerCase().includes('belum punya shift terbuka'), teks.slice(0, 200));
    }

    console.log('=== E. Antrian offline & stok menipis ===');
    // Konteks browser baru tanpa POS berjalan = outbox 0 (localStorage bersih).
    ok('kartu Antrian offline = 0 (konteks bersih)', teks.includes('ANTRIAN OFFLINE 0'), teks.slice(0, 300));
    const low = hariIniData.lowStock;
    if (low.length) {
      ok('stok menipis: nama produk pertama tampil', teks.includes(low[0].name), low[0].name);
    } else {
      // `.empty` TIDAK memakai uppercase — cocokkan tanpa mempedulikan huruf besar/kecil.
      ok('stok menipis: pesan aman tampil', teks.toLowerCase().includes('semua stok aman'), teks.slice(-200));
    }

    console.log('=== F. Segarkan + tanpa error console ===');
    await page.click('#db-reload');
    await page.waitForTimeout(1800);
    const sesudah = await page.locator('#db-body [data-tgl]').count();
    ok('Segarkan memuat ulang, tetap 7 batang', sesudah === 7, `jumlah=${sesudah}`);
    ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));

    console.log('=== G. Grafik 30 hari tidak meluap (regresi 2026-10-19) ===');
    // Laporan pemilik: "jika di pilih 30 hari maka menerobos kanan hingga
    // menimpa card pada status shift" — baris 30 label sumbu-X dulu memaksa
    // track grid `1fr` melar (min-content ±887px) sampai kontainer batang
    // keluar kartu. Kontrak: batang tetap 30, tidak melewati tepi kanan
    // kartu grafik, tidak menyentuh kartu Status shift, label dijarangkan.
    await page.selectOption('#db-n', '30');
    await page.waitForFunction(
      () => document.querySelectorAll('#db-body [data-tgl]').length === 30,
      { timeout: 15000 },
    );
    await page.waitForTimeout(300);
    const g30 = await page.evaluate(() => {
      const kartu = [...document.querySelectorAll('.card')].find((c) =>
        /^Penjualan \d+ hari/.test(c.querySelector('h2')?.textContent || ''),
      );
      const bars = kartu.querySelector('[role="img"]');
      const shift = [...document.querySelectorAll('.card')].find((c) =>
        /Shift/i.test(c.querySelector('h2')?.textContent || ''),
      );
      const row = kartu.querySelector('.grid')?.children?.[3];
      return {
        batang: bars.querySelectorAll('[data-tgl]').length,
        kananBatang: Math.round(bars.getBoundingClientRect().right),
        kananKartu: Math.round(kartu.getBoundingClientRect().right),
        kiriShift: shift ? Math.round(shift.getBoundingClientRect().left) : null,
        label: row ? [...row.children].filter((c) => c.textContent.trim() !== '').length : 0,
      };
    });
    ok('30 hari -> tetap 30 batang', g30.batang === 30, `jumlah=${g30.batang}`);
    ok('batang tidak melewati tepi kanan kartu grafik',
      g30.kananBatang <= g30.kananKartu + 1, `kanan=${g30.kananBatang} kartu=${g30.kananKartu}`);
    ok('batang tidak menyentuh kartu Status shift',
      g30.kiriShift === null || g30.kananBatang <= g30.kiriShift,
      `kanan=${g30.kananBatang} shift=${g30.kiriShift}`);
    ok('label sumbu-X dijarangkan (6 label, jangkar hari terakhir)',
      g30.label === 6, `label=${g30.label}`);
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
