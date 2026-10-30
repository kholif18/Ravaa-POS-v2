// Analitik persediaan (butir ROADMAP 1.6.7, ACC pemilik 19 Okt 2026) — suite
// regresi GET /api/reports/analytics + menu #/reports > Analitik:
//   (1) valuasi SNAPSHOT per kategori barang fisik: Σ stok × modal tertimbang
//       vs Σ stok × harga jual — produk jasa (track_stock=0) tidak ikut;
//   (2) barang TIDAK LAKU dalam rentang (berstok > 0 tanpa penjualan; urut
//       nilai stok DESC) + last_sold all-time ("belum pernah" bila null).
//
// Fixture 3 produk nama EKSAK + self-heal di awal & akhir (AGENTS §5):
//   - 'UjiAnalitik Mati'    : stok 3, belum pernah laku -> dead, last_sold null
//   - 'UjiAnalitik Laku'    : stok 4, laku HARI INI -> bukan dead (rentang 30h)
//   - 'UjiAnalitik Musiman' : stok 6, satu-satunya penjualan dibackdate ke
//                             2020-01-01 -> dead + last_sold terisi
// Cleanup menghapus ANAK dulu — sale_payments, sale_items, sales, stock_moves
// (CLI sqlite3 tidak menegakkan FK/cascade, AGENTS §5), lalu produk; hanya
// baris milik fixture ini, data pihak lain tidak disentuh.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasangToken, tungguDokumenA4 } from './bantuan-uji.mjs';

const API = 'http://localhost:3001';
const WEB = 'http://localhost:5656';
const DB = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '../apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const hariIni = () => new Date().toISOString().slice(0, 10);
const geser = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

const NAMA = ['UjiAnalitik Mati', 'UjiAnalitik Laku', 'UjiAnalitik Musiman'];

function bersihkan() {
  const daftar = NAMA.map((n) => `'${n}'`).join(',');
  const ids = sql(`SELECT COALESCE(GROUP_CONCAT(id), '') FROM products WHERE name IN (${daftar});`);
  if (!ids) return;
  const sales = sql(`SELECT COALESCE(GROUP_CONCAT(DISTINCT sale_id), '') FROM sale_items WHERE product_id IN (${ids});`);
  if (sales) {
    const sl = sales.split(',').map((s) => `'${s.trim()}'`).join(',');
    sql(`DELETE FROM sale_payments WHERE sale_id IN (${sl});`);
    sql(`DELETE FROM sale_items WHERE sale_id IN (${sl});`);
    sql(`DELETE FROM sales WHERE id IN (${sl});`);
  }
  sql(`DELETE FROM stock_moves WHERE product_id IN (${ids});`);
  sql(`DELETE FROM product_units WHERE product_id IN (${ids});`);
  sql(`DELETE FROM product_borongan WHERE product_id IN (${ids});`);
  sql(`DELETE FROM products WHERE id IN (${ids});`);
}

const post = async (p, body) => {
  const r = await fetch(API + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(API + p)).json();
const status = async (p) => (await fetch(API + p)).status;

bersihkan(); // self-heal sisa run crash

/* ---------- fixture ---------- */
async function buat(nama, price) {
  const r = await post('/api/products', {
    name: nama, category_slug: 'atk', unit: 'pcs', price, stock: 0, min_stock: 0, is_active: 1,
  });
  if (r.s !== 201) {
    console.error('setup produk gagal:', nama, r.s, JSON.stringify(r.j).slice(0, 160));
    process.exit(1);
  }
  return r.j.data;
}
const mati = await buat(NAMA[0], 1500);
const laku = await buat(NAMA[1], 5000);
const musiman = await buat(NAMA[2], 800);
for (const [p, qty, harga_beli] of [[mati, 3, 1000], [laku, 5, 2000], [musiman, 7, 500]]) {
  const r = await post('/api/restock', { product_id: p.id, qty, harga_beli, cashier: 'kasir' });
  if (r.s !== 200) {
    console.error('restock gagal:', p.sku, r.s, JSON.stringify(r.j).slice(0, 160));
    process.exit(1);
  }
}
// Shift terbuka untuk kasir default (runner menyiapkannya; suite tetap
// membuka sendiri supaya bisa dijalankan berdiri sendiri).
{
  const buka = await get('/api/shifts/open?cashier=kasir');
  if (!buka?.data?.id) await post('/api/shifts/open', { modal_awal: 100000, cashier: 'kasir' });
}
const shiftId = (await get('/api/shifts/open?cashier=kasir'))?.data?.id ?? null;

const jual = async (p, harga) => {
  const id = randomUUID();
  const r = await post('/api/sales', {
    id, shift_id: shiftId, pay_method: 'tunai', cash_in: harga, cashier: 'kasir',
    items: [{ product_id: p.id, name: p.name, qty: 1, price: harga }],
  });
  if (r.s !== 201) {
    console.error('jual gagal:', p.sku, r.s, JSON.stringify(r.j).slice(0, 160));
    process.exit(1);
  }
  return id;
};
const saleLaku = await jual(laku, 5000); // laku HARI INI -> tidak boleh masuk "tidak laku"
const saleMusiman = await jual(musiman, 800);
// Satu-satunya penjualan musiman dipindah ke 2020: di luar SEMUA rentang uji,
// tetapi last_sold (MAX all-time) harus tetap terisi.
sql(`UPDATE sales SET created_at = '2020-01-01 10:00:00' WHERE id = '${saleMusiman}';`);

const DARI = geser(-29);
const SAMPAI = hariIni();
const cariDead = (data, sku) => (data?.dead?.rows ?? []).find((r) => r.sku === sku);

console.log('=== A. API analitik ===');
const an = (await get(`/api/reports/analytics?from=${DARI}&to=${SAMPAI}`))?.data;
chk('A1 rentang + shape valuasi/dead',
  !!an && an.from === DARI && an.to === SAMPAI
  && Array.isArray(an.valuasi?.rows) && Array.isArray(an.dead?.rows)
  && typeof an.valuasi?.total?.hpp === 'number' && typeof an.dead?.nilai === 'number',
  `${an?.from}..${an?.to}`);

const vSql = sql(`SELECT SUM(CASE WHEN p.stock <> 0 THEN 1 ELSE 0 END) || '|' || COALESCE(SUM(p.stock), 0)
  || '|' || COALESCE(SUM(p.stock * p.avg_cost), 0) || '|' || COALESCE(SUM(p.stock * p.price), 0)
  FROM products p JOIN categories c ON c.id = p.category_id
  WHERE p.is_active = 1 AND p.deleted_at IS NULL AND c.track_stock = 1;`).split('|').map(Number);
chk('A2 valuasi.total = SQL seluruh barang fisik aktif (item/qty/hpp/jual)',
  an?.valuasi?.total?.n_items === vSql[0] && an?.valuasi?.total?.qty === vSql[1]
  && an?.valuasi?.total?.hpp === vSql[2] && an?.valuasi?.total?.jual === vSql[3],
  `${JSON.stringify(an?.valuasi?.total)} vs ${vSql.join('|')}`);

const hppRows = (an?.valuasi?.rows ?? []).map((r) => r.hpp);
chk('A3 valuasi per kategori urut HPP DESC + field angka',
  hppRows.length > 0 && hppRows.every((v, i) => i === 0 || hppRows[i - 1] >= v)
  && an.valuasi.rows.every((r) => typeof r.category === 'string'
    && [r.n_items, r.qty, r.hpp, r.jual].every(Number.isFinite)),
  `rows=${hppRows.length}`);

const dSql = sql(`SELECT COUNT(*) || '|' || COALESCE(SUM(p.stock * p.avg_cost), 0)
  FROM products p JOIN categories c ON c.id = p.category_id
  WHERE p.is_active = 1 AND p.deleted_at IS NULL AND c.track_stock = 1 AND p.stock > 0
    AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                     WHERE si.product_id = p.id
                       AND date(s.created_at) BETWEEN date('${DARI}') AND date('${SAMPAI}'));`)
  .split('|').map(Number);
chk('A4 dead.n + dead.nilai = SQL (seluruh baris, bukan yang terbatas)',
  an?.dead?.n === dSql[0] && an?.dead?.nilai === dSql[1],
  `${an?.dead?.n}/${an?.dead?.nilai} vs ${dSql.join('|')}`);

const dMati = cariDead(an, mati.sku);
chk('A5 fixture belum pernah laku = dead (stok 3 · nilai 3000 · last_sold null)',
  !!dMati && dMati.stock === 3 && dMati.nilai === 3000 && dMati.last_sold === null,
  JSON.stringify(dMati));

chk('A6 fixture yang laku HARI INI TIDAK masuk dead rentang 30 hari',
  !!an && !cariDead(an, laku.sku));

const dMusiman = cariDead(an, musiman.sku);
chk('A7 fixture musiman = dead + last_sold 2020-01-01 + stok 6 · nilai 3000',
  !!dMusiman && dMusiman.stock === 6 && dMusiman.nilai === 3000
  && String(dMusiman.last_sold).startsWith('2020-01-01'),
  JSON.stringify(dMusiman));

const nilaiRows = (an?.dead?.rows ?? []).map((r) => r.nilai);
chk('A8 dead urut nilai stok DESC (modal menganggur terbesar di atas)',
  nilaiRows.every((v, i) => i === 0 || nilaiRows[i - 1] >= v), nilaiRows.slice(0, 5).join(','));

chk('A9 tidak terpotong + rows = n + terpotong boolean',
  an?.dead?.terpotong === false && an?.dead?.rows?.length === an?.dead?.n,
  `rows=${an?.dead?.rows?.length}/${an?.dead?.n}`);

const an19 = (await get('/api/reports/analytics?from=2019-01-01&to=2019-01-01'))?.data;
chk('A10 jendela 2019 (tanpa penjualan): kedua fixture ikut "tidak laku"',
  !!cariDead(an19, laku.sku) && !!cariDead(an19, musiman.sku));

const anT = (await get(`/api/reports/analytics?from=${SAMPAI}&to=${SAMPAI}`))?.data;
chk('A11 jendela hari ini: laku hari ini bukan dead, yang mati tetap dead',
  !cariDead(anT, laku.sku) && !!cariDead(anT, mati.sku));

chk('A12 validasi from>to 400', (await status('/api/reports/analytics?from=2026-10-19&to=2026-10-01')) === 400);
chk('A13 validasi format rusak 400', (await status('/api/reports/analytics?from=rabu')) === 400);
chk('A14 validasi >366 hari 400', (await status('/api/reports/analytics?from=2024-01-01&to=2026-10-11')) === 400);

const anDef = (await get('/api/reports/analytics'))?.data;
chk('A15 tanpa parameter: from=to=hari ini (bacaRentang)', anDef?.from === SAMPAI && anDef?.to === SAMPAI,
  `${anDef?.from}..${anDef?.to}`);

console.log('=== B. UI menu Analitik ===');
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pasangToken(p);
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));

await p.goto(`${WEB}/#/reports`, { waitUntil: 'networkidle' });
await p.waitForSelector('#rp-body', { timeout: 15000 });
await p.waitForTimeout(1200);
chk('B1 9 menu laporan (Harian…Akuntansi + Stok + Analitik)',
  await p.locator('[data-menu]').count() === 9 && await p.locator('[data-menu="analitik"]').count() === 1);

await p.click('[data-menu="analitik"]');
await p.waitForTimeout(1500);
const teks = (await p.textContent('#rp-body')) ?? '';
chk('B2 kartu valuasi + tidak laku + chip modal menganggur',
  teks.includes('Valuasi persediaan — snapshot saat ini') && teks.includes('Tidak laku —')
  && teks.includes('Modal menganggur'),
  teks.replace(/\s+/g, ' ').slice(0, 150));

const tabelVal = p.locator('#rp-body table').filter({ has: p.locator('th', { hasText: /^Kategori$/ }) });
const teksJumlahVal = (await tabelVal.locator('tbody tr').last().textContent()) ?? '';
chk('B3 valuasi: baris Jumlah = angka server (hpp + jual)',
  teksJumlahVal.includes('Jumlah') && teksJumlahVal.includes(rp(an.valuasi.total.hpp))
  && teksJumlahVal.includes(rp(an.valuasi.total.jual)),
  teksJumlahVal.replace(/\s+/g, ' ').slice(0, 140));

const tabelDead = p.locator('#rp-body table').filter({ has: p.locator('th', { hasText: 'Terakhir laku' }) });
const barisMati = tabelDead.locator('tbody tr').filter({ hasText: NAMA[0] });
chk('B4 baris belum pernah laku + label "belum pernah"',
  await barisMati.count() === 1 && ((await barisMati.textContent()) ?? '').includes('belum pernah'),
  `${await barisMati.count()} baris`);

const barisMusiman = tabelDead.locator('tbody tr').filter({ hasText: NAMA[2] });
chk('B5 musiman: terakhir laku 1 Januari 2020 (tahun ikut, bukan hanya tgl/bulan)',
  await barisMusiman.count() === 1 && ((await barisMusiman.textContent()) ?? '').includes('1 Januari 2020'),
  (await barisMusiman.textContent())?.replace(/\s+/g, ' ').slice(0, 120));

chk('B6 fixture yang laku hari ini TIDAK tampil di daftar tidak laku',
  await tabelDead.locator('tbody tr').filter({ hasText: NAMA[1] }).count() === 0);

const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#rp-csv')]);
chk('B7 CSV: nama berkas menu analitik', /^laporan-analitik-\d{4}-\d{2}-\d{2}_sd_\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename() ?? ''),
  dl.suggestedFilename());
const isiCsv = readFileSync(await dl.path(), 'utf8');
chk('B8 CSV: dua seksi + fixture + baris Jumlah',
  isiCsv.includes('Valuasi persediaan') && isiCsv.includes('Tidak laku dalam rentang')
  && isiCsv.includes(NAMA[0]) && isiCsv.includes(NAMA[2]) && isiCsv.includes('Jumlah'),
  `len=${isiCsv.length}`);

await p.context().addInitScript(() => { window.print = () => {}; });
const [pop] = await Promise.all([p.waitForEvent('popup'), p.click('#rp-print')]);
await tungguDokumenA4(pop);
const isiPop = await pop.content();
const nTabelPop = await pop.locator('table.items').count();
chk('B9 cetak satu dokumen: tabel valuasi + seksi TIDAK LAKU + kaki',
  (await pop.title()).includes('ANALITIK') && nTabelPop === 2
  && isiPop.includes('TIDAK LAKU DALAM') && isiPop.includes(NAMA[0])
  && isiPop.includes('Dicetak melalui Ravaa POS pada:'),
  `tabel=${nTabelPop}`);
await pop.close().catch(() => {});

console.log('=== C. Bersih-bersih ===');
bersihkan();
chk('C1 fixture + penjualannya terhapus (0 sisa)',
  Number(sql(`SELECT COUNT(*) FROM products WHERE name IN (${NAMA.map((n) => `'${n}'`).join(',')});`)) === 0
  && Number(sql(`SELECT COUNT(*) FROM sales WHERE id IN ('${saleLaku}','${saleMusiman}');`)) === 0,
  `sku=${mati.sku},${laku.sku},${musiman.sku}`);

chk('C2 tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
