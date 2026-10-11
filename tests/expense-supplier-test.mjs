// Supplier (pindahan customers.supplier_no) + Pengeluaran kas Tahap 1.
// Master supplier CRUD + penomoran SUP, customers tanpa supplier_no,
// expenses CRUD + validasi + agregat shift + kartu laporan.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path0.join(REPO, 'apps/api/data/data.db');
const sql = (q) => execSync(`sqlite3 ${DB} "${q}"`).toString().trim();
const TODAY = new Date().toISOString().slice(0, 10);

// Bersihkan sisa run sebelumnya.
sql(`DELETE FROM expenses WHERE kategori LIKE 'UjiExp%' OR note LIKE 'UjiExp%';`);
sql(`DELETE FROM suppliers WHERE name LIKE 'UjiExp%';`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiExp%';`);

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const post = (path, body) => p.evaluate(
  ([u, bd]) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  [path, body],
);
async function w(sel, v) { await p.fill(sel, v); await p.waitForTimeout(150); }

// fetch() relatif butuh origin — buka app dulu sebelum semua evaluate.
await p.goto('http://localhost:5656/#/dashboard', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);

console.log('=== A. Suppliers API: CRUD + penomoran SUP ===');
const s1 = await post('/api/suppliers', { name: 'UjiExp Kulakan A', phone: '0811' });
chk('POST supplier -> 201 + code SUP-6digit', s1.status === 201 && /^SUP-\d{6}$/.test(s1.json.data?.code), JSON.stringify(s1.json.data));
const s2 = await post('/api/suppliers', { name: 'UjiExp Kulakan B' });
chk('nomor naik tidak dipakai ulang', s2.status === 201 && s2.json.data.code > s1.json.data.code, `${s1.json.data?.code} -> ${s2.json.data?.code}`);
const s3 = await post('/api/suppliers', { id: s1.json.data.id, name: 'UjiExp Kulakan A Baru' });
chk('PUT: nama berubah + code tetap', s3.status === 200 && s3.json.data.name === 'UjiExp Kulakan A Baru' && s3.json.data.code === s1.json.data.code, JSON.stringify(s3.json.data));
const q1 = await api('/api/suppliers?q=' + encodeURIComponent('ujiexp kulakan'));
chk('cari multi-kata ketemu', q1.data.length >= 2 && q1.total >= 2, `${q1.data.length}/${q1.total}`);
chk('POST tanpa nama -> 400', (await post('/api/suppliers', { name: '' })).status === 400);
chk('PUT id ngawur -> 404', (await post('/api/suppliers', { id: 999999, name: 'X' })).status === 404);
await p.evaluate((id) => fetch(`/api/suppliers/${id}`, { method: 'DELETE' }), s2.json.data.id);
chk('DELETE + hilang dari GET', !(await api('/api/suppliers')).data.some((s) => s.id === s2.json.data.id));

console.log('=== B. Customers: supplier_no sudah cabut ===');
const cl = await api('/api/customers');
chk('tak ada baris ber-key supplier_no', cl.data.every((c) => !('supplier_no' in c)), `${cl.data.length} baris`);
const c1 = await post('/api/customers', { name: 'UjiExp Cust' });
chk('POST customer bersih tanpa supplier_no', c1.status === 201 && !('supplier_no' in c1.json.data) && /^CUS-\d{6}$/.test(c1.json.data.code), JSON.stringify(c1.json.data));
const c2 = await post('/api/customers', { id: c1.json.data.id, name: 'UjiExp Cust Baru' });
chk('PUT: code tetap', c2.status === 200 && c2.json.data.code === c1.json.data.code);
chk('DELETE bersih ok', (await p.evaluate((id) => fetch(`/api/customers/${id}`, { method: 'DELETE' }).then((r) => r.json()), c1.json.data.id)).data?.deleted === true);

console.log('=== C. Expenses API: CRUD + validasi ===');
const e1 = await post('/api/expenses', { kategori: 'UjiExp Plastik', jumlah: 15000, note: 'UjiExp nota' });
chk('POST valid -> 201 + shift null', e1.status === 201 && e1.json.data.shift_id === null, JSON.stringify(e1.json.data));
chk('kategori kosong -> 400', (await post('/api/expenses', { kategori: '', jumlah: 1000 })).status === 400);
chk('jumlah 0 -> 400', (await post('/api/expenses', { kategori: 'UjiExp X', jumlah: 0 })).status === 400);
chk('jumlah negatif -> 400', (await post('/api/expenses', { kategori: 'UjiExp X', jumlah: -5 })).status === 400);
chk('jumlah desimal -> 400', (await post('/api/expenses', { kategori: 'UjiExp X', jumlah: 1.5 })).status === 400);
chk('note >200 char -> 400', (await post('/api/expenses', { kategori: 'UjiExp X', jumlah: 1000, note: 'x'.repeat(201) })).status === 400);
chk('shift_id ngawur -> 400', (await post('/api/expenses', { kategori: 'UjiExp X', jumlah: 1000, shift_id: 999999 })).status === 400);
const gl = await api(`/api/expenses?date=${TODAY}`);
chk('GET hari ini memuat + jumlah ikut', gl.data.some((e) => e.id === e1.json.data.id) && gl.jumlah >= 15000, `n=${gl.total} jumlah=${gl.jumlah}`);
chk('date rusak -> 400', await p.evaluate(() => fetch('/api/expenses?date=rabu').then((r) => r.status)) === 400);
chk('DELETE ok', (await p.evaluate((id) => fetch(`/api/expenses/${id}`, { method: 'DELETE' }).then((r) => r.json()), e1.json.data.id)).data?.deleted === true);

console.log('=== D. Agregat shift ikut pengeluaran ===');
const openShift = await api('/api/shifts/open?cashier=kasir');
chk('shift kasir terbuka (prasyarat runner)', !!openShift.data?.id, JSON.stringify(openShift.data));
const e2 = await post('/api/expenses', { kategori: 'UjiExp Bensin', jumlah: 20000, shift_id: openShift.data.id });
chk('POST terikat shift -> 201', e2.status === 201 && e2.json.data.shift_id === openShift.data.id);
const sh = await api('/api/shifts?cashier=kasir&status=open');
const baris = sh.data.find((s) => s.id === openShift.data.id);
chk('agregat n_expense/expense_total ikut', baris?.n_expense >= 1 && baris?.expense_total >= 20000, JSON.stringify({ n: baris?.n_expense, tot: baris?.expense_total }));

console.log('=== E. UI suppliers ===');
await p.goto('http://localhost:5656/#/suppliers', { waitUntil: 'networkidle' });
await p.waitForSelector('#sup-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('nav "Supplier" aktif', await p.locator('a[href="#/suppliers"].is-active').count() === 1);
await p.click('#sup-new'); await p.waitForSelector('.modal');
await w('#s-name', 'UjiExp UI Sup');
await w('#s-phone', '0822');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
chk('tambah via modal -> baris + nomor SUP muncul', (await p.locator('.modal').count()) === 0 && (await p.textContent('#sup-body')).includes('UjiExp UI Sup') && /SUP-\d{6}/.test(await p.textContent('#sup-body')));
await w('#sup-q', 'UjiExp UI'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
chk('cari memfilter', (await p.locator('#sup-body tbody tr').count()) === 1, `${await p.locator('#sup-body tbody tr').count()} baris`);
await p.click('[data-sup-del]'); await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1200);
chk('hapus via konfirmasi -> hilang', !(await p.textContent('#sup-body')).includes('UjiExp UI Sup'));

console.log('=== F. UI expenses ===');
await p.goto('http://localhost:5656/#/expenses', { waitUntil: 'networkidle' });
await p.waitForSelector('#exp-body', { timeout: 15000 });
await p.waitForTimeout(600);
chk('kartu jumlah tampil Rp', /Rp[\d.]+/.test(await p.textContent('#exp-jumlah')), await p.textContent('#exp-jumlah'));
const jum0 = Number(((await p.textContent('#exp-jumlah')) ?? '').replace(/\D/g, '')) || 0;
await p.click('#exp-new'); await p.waitForSelector('.modal');
await w('#e-kategori', 'UjiExp UI Listrik');
await w('#e-jumlah', '25000');
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const bodyExp = await p.textContent('#exp-body');
const jum1 = Number(((await p.textContent('#exp-jumlah')) ?? '').replace(/\D/g, '')) || 0;
chk('catat via modal -> baris muncul + kartu +25000', bodyExp.includes('UjiExp UI Listrik') && jum1 - jum0 === 25000, `kartu ${jum0} -> ${jum1}`);
await p.click('[data-exp-del]'); await p.waitForSelector('.swal2-container', { timeout: 8000 });
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1200);
chk('hapus via konfirmasi -> hilang', !(await p.textContent('#exp-body')).includes('UjiExp UI Listrik'));

console.log('=== G. UI customers bersih + kartu laporan ===');
await p.goto('http://localhost:5656/#/customers', { waitUntil: 'networkidle' });
await p.waitForSelector('#cust-body', { timeout: 15000 });
await p.click('#cust-new'); await p.waitForSelector('.modal');
chk('modal customer TANPA "No. supplier"', !(await p.textContent('.modal')).includes('No. supplier'));
await p.click('.modal [data-x]'); await p.waitForTimeout(300);
await p.goto(`http://localhost:5656/#/reports?x=${Date.now()}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
chk('laporan memuat kartu Pengeluaran', (await p.textContent('#page')).includes('Pengeluaran'));

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();

// Bersihkan data uji.
sql(`DELETE FROM expenses WHERE kategori LIKE 'UjiExp%' OR note LIKE 'UjiExp%';`);
sql(`DELETE FROM suppliers WHERE name LIKE 'UjiExp%';`);
sql(`DELETE FROM customers WHERE name LIKE 'UjiExp%';`);

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
