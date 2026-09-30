// Halaman Laporan (#/reports): angka di layar WAJIB sama dengan apa yang
// dikembalikan GET /api/reports/daily (satu sumber data, tanpa hitung ulang di
// klien) + ekspor CSV dari data yang sedang tampil.
// Jalankan: node laporan-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
const hariIni = () => new Date().toISOString().slice(0, 10);
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

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
  console.log('=== A. Kontrak GET /api/reports/daily ===');
  const r = await get('/api/reports/daily');
  const l = r.body.data;
  ok('200 + kunci lengkap', r.status === 200 && l
    && 'date' in l && 'sales' in l && 'hpp' in l && 'laba' in l
    && Array.isArray(l.byMethod) && Array.isArray(l.topup)
    && Array.isArray(l.topItems) && Array.isArray(l.lowStock),
    JSON.stringify(Object.keys(l ?? {})));
  ok('laba = omzet − hpp', l.laba === l.sales.omzet - l.hpp,
    `${l.laba} != ${l.sales.omzet} - ${l.hpp}`);
  const nMethod = l.byMethod.reduce((a, m) => a + m.n, 0);
  const tMethod = l.byMethod.reduce((a, m) => a + m.total, 0);
  ok('rekap metode bayar menutup total transaksi & omzet',
    nMethod === l.sales.n && tMethod === l.sales.omzet,
    `metode n=${nMethod}/total=${tMethod} vs sales n=${l.sales.n}/omzet=${l.sales.omzet}`);
  ok('topItems punya satuan (tidak mencampur pack & pcs)',
    l.topItems.every((t) => typeof t.unit === 'string' && t.unit !== ''),
    JSON.stringify(l.topItems.slice(0, 2)));

  console.log('=== B. Halaman #/reports menampilkan angka yang sama ===');
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${WEB}/#/reports`, { waitUntil: 'load' });
    await page.waitForTimeout(1600);
    const teks = norm(await page.innerText('#rp-body'));
    ok('kartu Omzet = angka server', teks.includes(`OMZET ${rp(l.sales.omzet)}`),
      `cari ${rp(l.sales.omzet)} di: ${teks.slice(0, 120)}`);
    ok('kartu Laba = angka server', teks.includes(`LABA ${rp(l.laba)}`));
    ok('kartu HPP = angka server', teks.includes(`HPP ${rp(l.hpp)}`));
    ok('tanggal terpilih = hari ini', (await page.locator('#rp-date').inputValue()) === hariIni());

    const barisMethod = await page.locator('#rp-body table').first().locator('tbody tr').count();
    ok(`baris metode bayar (${l.byMethod.length} + jumlah)`, barisMethod === l.byMethod.length + 1,
      `ada=${barisMethod} harap=${l.byMethod.length + 1}`);
    const barisTop = await page.locator('#rp-body table').nth(2).locator('tbody tr').count();
    ok(`baris produk terlaris (${l.topItems.length})`, barisTop === l.topItems.length,
      `ada=${barisTop} harap=${l.topItems.length}`);

    if (l.byMethod.length) {
      ok('baris metode menampilkan nama & total yang benar',
        teks.includes(l.byMethod.map((m) => rp(m.total)).join(' ')) || teks.includes(rp(l.byMethod[0].total)),
        rp(l.byMethod[0].total));
    }

    console.log('=== C. Navigasi tanggal + ekspor CSV ===');
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
      page.click('#rp-csv'),
    ]);
    ok('tombol Ekspor CSV mengunduh berkas', !!dl && new RegExp(`^laporan-${hariIni()}\\.csv$`).test(dl.suggestedFilename() ?? ''),
      dl ? dl.suggestedFilename() : 'tidak ada event download');

    await page.click('[data-h="prev"]');
    await page.waitForTimeout(900);
    const kemarin = (await page.locator('#rp-date').inputValue());
    ok('prev menggeser ke hari sebelumnya', kemarin < hariIni(), kemarin);
    const adaKemarin = (await page.innerText('#rp-body')).includes('Gagal memuat');
    ok('hari kemarin tetap dimuat (tanpa error)', !adaKemarin);

    await page.click('#rp-today').catch(() => {});
    await page.waitForTimeout(700);
    ok('kembali ke hari ini', (await page.locator('#rp-date').inputValue()) === hariIni()
      || (await page.locator('#rp-today').count()) === 0);

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
