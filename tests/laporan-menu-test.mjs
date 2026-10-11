// Katalog laporan ala Aronium (2026-10-11): menu Harian/Kasir/Produk/Piutang/
// Stok + summary range + cashiers + products + piutang + cetak/PDF/CSV.
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const hariIni = () => new Date().toISOString().slice(0, 10);

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const get = (path) => p.evaluate(async (u) => {
  const r = await fetch(u);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, path);

await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

console.log('=== A. API summary/cashiers/products ===');
const s = (await api(`/api/reports/summary?from=${hariIni()}&to=${hariIni()}`)).data;
const d = (await api(`/api/reports/daily?date=${hariIni()}`)).data;
const kunci = (o) => Object.keys(o).filter((k) => !['date', 'from', 'to'].includes(k)).sort().join(',');
chk('summary = daily untuk 1 hari', kunci(s) === kunci(d), kunci(s));
chk('piutang punya baru+ bayar', typeof s.piutang?.baru === 'number' && typeof s.piutang?.bayar === 'number',
  JSON.stringify(s.piutang));
const k = (await api(`/api/reports/cashiers?from=${hariIni()}&to=${hariIni()}`)).data;
chk('kasir: jumlah baris = total', k.total.n === k.rows.reduce((a, r) => a + r.n, 0)
  && k.total.omzet === k.rows.reduce((a, r) => a + r.omzet, 0), JSON.stringify(k.total));
chk('kasir: omzet = omzet summary', k.total.omzet === s.sales.omzet, `${k.total.omzet} vs ${s.sales.omzet}`);
const pr = (await api(`/api/reports/products?from=${hariIni()}&to=${hariIni()}&limit=3`)).data;
chk('produk: baris bawa hpp + limit dipatuhi', pr.rows.length <= 3 && pr.rows.every((r) => typeof r.hpp === 'number'),
  `${pr.rows.length}/${pr.total}`);
chk('validasi: from>to 400', (await get('/api/reports/summary?from=2026-10-11&to=2026-10-01')).status === 400);
chk('validasi: format rusak 400', (await get('/api/reports/summary?from=rabu')).status === 400);
chk('validasi: >366 hari 400', (await get('/api/reports/summary?from=2024-01-01&to=2026-10-11')).status === 400);

console.log('=== B. UI menu + filter ===');
await p.goto('http://localhost:5656/#/reports', { waitUntil: 'networkidle' });
await p.waitForSelector('#rp-body', { timeout: 15000 });
await p.waitForTimeout(1200);
chk('5 chip menu, Harian aktif', await p.locator('[data-menu]').count() === 5
  && await p.locator('[data-menu="harian"]').count() === 1);
await p.click('[data-menu="kasir"]'); await p.waitForTimeout(1200);
chk('menu Kasir: tabel kasir tampil', (await p.textContent('#rp-body')).includes('Penjualan per kasir'));
await p.click('[data-menu="produk"]'); await p.waitForTimeout(1200);
chk('menu Produk: ada cari + tabel', await p.locator('#rp-q').count() === 1);
await p.click('[data-menu="piutang"]'); await p.waitForTimeout(1200);
chk('menu Piutang: 3 kartu', (await p.textContent('#rp-body')).includes('Sisa berjalan kini'));
await p.click('[data-menu="stok"]'); await p.waitForTimeout(1200);
chk('menu Stok: saran order', (await p.textContent('#rp-body')).includes('Saran order'));

console.log('=== C. Cetak + CSV per menu ===');
await p.context().addInitScript(() => { window.print = () => {}; });
const [pop] = await Promise.all([
  p.waitForEvent('popup'),
  p.click('#rp-print'),
]);
await pop.waitForLoadState('domcontentloaded');
chk('popup cetak: judul + tabel + kaki', (await pop.title()).includes('STOK')
  && (await pop.content()).includes('Saran order')
  && (await pop.content()).includes('Dicetak dari Ravaa POS'));
await pop.close().catch(() => {});
const [dl] = await Promise.all([
  p.waitForEvent('download'),
  p.click('#rp-csv'),
]);
chk('CSV stok: nama berkas menu', /^laporan-stok-\d{4}-\d{2}-\d{2}_sd_\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename() ?? ''),
  dl.suggestedFilename());

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
