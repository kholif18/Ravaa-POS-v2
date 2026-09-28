// Master satuan: CRUD di #/satuan + dropdown satuan di form produk.
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
const TAG = 'uji-' + Date.now().toString(36);

// sisa run yang gagal sebelumnya: satuan uji tidak boleh bocor ke test ini
sql("DELETE FROM units WHERE slug LIKE 'karung-%'");
sql("DELETE FROM products WHERE name LIKE 'Kertas Test %'");

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const err = [];
p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
const api = (path) => p.evaluate((u) => fetch(u).then((r) => r.json()), path);
const rows = () => p.locator('#unit-body tbody tr').count();

async function w(sel, v) { await p.fill(sel, v); await p.waitForTimeout(120); }

console.log('=== 1. Halaman Satuan terbuka & terisi ===');
await p.goto('http://localhost:5656/#/satuan', { waitUntil: 'networkidle' });
await p.waitForSelector('#unit-body tbody tr', { timeout: 15000 });
await p.waitForTimeout(600);
const seedUnits = (await api('/api/units')).data;
chk('nav "Satuan" ada di sidebar', await p.locator('a[href="#/satuan"].is-active').count() === 1);
chk('judul halaman benar', (await p.textContent('h2')).includes('Satuan'), await p.textContent('h2'));
chk('daftar satuan seed tampil', (await rows()) === seedUnits.length, `${await rows()} baris vs ${seedUnits.length} satuan`);
chk('pcs ada di daftar', (await p.textContent('#unit-body')).includes('pcs'));
chk('"Tanpa satuan" ada di daftar', (await p.textContent('#unit-body')).includes('Tanpa satuan'));
chk('kolom "Dipakai" terisi', /\d+ produk/.test(await p.textContent('#unit-body')), (await p.textContent('#unit-body tbody tr')).replace(/\s+/g, ' ').slice(0, 50));
// Guard regresi header: styling header tabel ada di kelas .th, bukan .table th.
const th = await p.evaluate(() => [...document.querySelectorAll('#unit-body th')].map((e) => ({
  t: e.textContent.trim(), cls: e.className, fs: getComputedStyle(e).fontSize, bb: getComputedStyle(e).borderBottomWidth,
})));
chk('header tabel ada 3 kolom', th.length === 3, JSON.stringify(th.map((x) => x.t)));
chk('setiap header pakai kelas .th', th.every((x) => x.cls.includes('th')), JSON.stringify(th.map((x) => x.cls)));
chk('header ter-style (12px + border bawah)', th.every((x) => x.fs === '12px' && x.bb === '1px'), JSON.stringify(th.map((x) => `${x.fs}/${x.bb}`)));
chk('tidak ada kolom "Urutan"', !th.some((x) => /urutan/i.test(x.t)), JSON.stringify(th.map((x) => x.t)));

console.log('=== 2. Tambah satuan (slug otomatis dari nama) ===');
await p.click('#unit-new'); await p.waitForSelector('.modal');
await w('#u-name', 'Karung Api');
chk('slug terisi otomatis saat nama diketik', (await p.inputValue('#u-slug')) === 'karung-api', await p.inputValue('#u-slug'));
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
chk('modal tertutup', (await p.locator('.modal').count()) === 0);
const afterAdd = (await api('/api/units')).data;
const baru = afterAdd.find((u) => u.slug === 'karung-api');
chk('tersimpan di server', !!baru, JSON.stringify(baru));
chk('nama tersimpan utuh', baru?.name === 'Karung Api', baru?.name);
chk('tidak ada kolom sort di respons API', baru && !('sort' in baru), JSON.stringify(baru));
chk('baris baru muncul di tabel', (await p.textContent('#unit-body')).includes('Karung Api'));

console.log('=== 3. Tambah satuan nama sama -> upsert, bukan duplikat ===');
await p.click('#unit-new'); await p.waitForSelector('.modal');
await w('#u-name', 'Karung Api'); await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const afterDup = (await api('/api/units')).data;
chk('tidak jadi dua baris', afterDup.filter((u) => u.slug === 'karung-api').length === 1, `${afterDup.filter((u) => u.slug === 'karung-api').length} baris`);

console.log('=== 4. Ubah satuan ===');
await p.click(`[data-unit-edit="karung-api"]`); await p.waitForSelector('.modal');
chk('form terisi nama lama', (await p.inputValue('#u-name')) === 'Karung Api', await p.inputValue('#u-name'));
chk('slug TERKUNCI saat edit', await p.getAttribute('#u-slug', 'readonly') !== null);
chk('petunjuk slug terkunci tampil', (await p.textContent('#u-slug-hint')).includes('tidak bisa diubah'), (await p.textContent('#u-slug-hint')).trim().slice(0, 50));
await w('#u-name', 'Karung Api Besar'); await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
const afterEdit = (await api('/api/units')).data.find((u) => u.slug === 'karung-api');
chk('nama berubah, slug tetap', afterEdit?.name === 'Karung Api Besar' && afterEdit?.slug === 'karung-api', JSON.stringify(afterEdit));

console.log('=== 5. Hapus satuan yang dipakai produk -> DITOLAK ===');
await p.click('[data-unit-del="pcs"]');
await p.waitForSelector('.swal2-container', { timeout: 8000 });
const pesan = (await p.textContent('.swal2-container')).replace(/\s+/g, ' ');
chk('konfirmasi menyebut jumlah pemakaian', /dipakai \d+ produk/.test(pesan), pesan.slice(0, 90));
await p.waitForTimeout(500); // tunggu animasi zoom selesai, jangan ukur saat scale<1
const gaya = await p.locator('.swal2-container .sw-btn-danger').evaluate((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { h: Math.round(r.height), w: Math.round(r.width), bg: s.backgroundColor, teks: e.textContent.trim() }; });
chk('tombol hapus terlihat & bisa disentuh (h>=40px, ada teks)', gaya.h >= 40 && gaya.w > 60 && gaya.bg !== 'rgba(0, 0, 0, 0)' && gaya.teks.length > 0, JSON.stringify(gaya));
const jarak = await p.evaluate(() => { const b = [...document.querySelectorAll('.swal2-container .sw-btn')].map((e) => e.getBoundingClientRect()); return b.length === 2 ? Math.round(Math.abs(b[0].left - b[1].right)) : -1; });
chk('jarak antar 2 tombol >= 8px', jarak >= 8, `${jarak}px`);
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1200);
const toastTeks = (await p.textContent('.toast-root').catch(() => '')).replace(/\s+/g, ' ');
chk('toast error muncul', /Gagal hapus/.test(toastTeks), toastTeks.slice(0, 80));
chk('pcs MASIH ada (tidak terhapus)', (await api('/api/units')).data.some((u) => u.slug === 'pcs'));

console.log('=== 6. Hapus satuan yang tidak dipakai -> BERHASIL ===');
const sebelum = (await api('/api/units')).data.length;
await p.click('[data-unit-del="karung-api"]');
await p.waitForSelector('.swal2-container', { timeout: 8000 });
chk('konfirmasi tahu satuan ini kosong', !/dipakai \d+ produk/.test(await p.textContent('.swal2-container')));
await p.click('.swal2-container .sw-btn-danger'); await p.waitForTimeout(1200);
const sesudah = (await api('/api/units')).data;
chk(' hilang dari server', !sesudah.some((u) => u.slug === 'karung-api'), `${sebelum} -> ${sesudah.length} satuan`);
chk('baris hilang dari tabel', (await rows()) === sesudah.length, `${await rows()} baris`);

console.log('=== 7. Form produk: satuan = DROPDOWN dari master ===');
await p.goto('http://localhost:5656/#/products', { waitUntil: 'networkidle' });
await p.waitForSelector('#prod-new'); await p.waitForTimeout(1800);
await p.click('#prod-new'); await p.waitForSelector('.modal');
const tag = p.locator('#f-unit');
chk('kontrolnya SELECT (bukan ketik bebas)', await tag.evaluate((e) => e.tagName) === 'SELECT', await tag.evaluate((e) => e.tagName));
const opts = await tag.evaluate((e) => [...e.options].map((o) => o.value));
const serverUnits = (await api('/api/units')).data.map((u) => u.slug);
chk('opsi = master satuan (tanpa sisa hardcode)', JSON.stringify(opts) === JSON.stringify(serverUnits), `form=${opts.length} master=${serverUnits.length}`);
chk('tidak ada datalist lagi', (await p.locator('#f-unit-list').count()) === 0);
chk('pcs jadi default saat produk baru', await tag.inputValue() === 'pcs', await tag.inputValue());
chk('ada unit non-pcs untuk中选择', opts.includes('lembar') && opts.includes('box'), opts.join(','));
await p.selectOption('#f-cat', 'snack');
await w('#f-name', `Kertas Test ${TAG}`);
await tag.selectOption('lembar');
chk('bisa pilih satuan lain', await tag.inputValue() === 'lembar', await tag.inputValue());
await p.click('.modal [data-ok]'); await p.waitForTimeout(1400);
const tersimpan = (await p.evaluate((t) => fetch('/api/products?since=0&status=semua').then((r) => r.json()), TAG)).data
  .find((x) => x.name === `Kertas Test ${TAG}`);
chk('satuan tersimpan ke server', tersimpan?.unit === 'lembar', JSON.stringify({ unit: tersimpan?.unit, sku: tersimpan?.sku }));
chk('satuan tampil di baris tabel', (await p.textContent('tbody')).includes('· lembar'), (await p.textContent('tbody')).replace(/\s+/g, ' ').slice(0, 60));
sql(`DELETE FROM products WHERE name = 'Kertas Test ${TAG}'`);

console.log('=== 8. Edit produk lama: satuan existing terpilih ===');
// Nama seed produk ini "Aqua 600ml" (SKU PRD00013) -> cari pakai SKU.
await p.fill('#q', ''); await w('#q', 'PRD00013');
await p.waitForTimeout(900);
chk('cari by SKU ketemu 1 baris', (await p.locator('tr[data-row]').count()) === 1, `${await p.locator('tr[data-row]').count()} baris`);
await p.click('tr[data-row] [data-edit]'); await p.waitForSelector('.modal');
chk('dropdown menampilkan satuan lama (btl)', await p.inputValue('#f-unit') === 'btl', await p.inputValue('#f-unit'));
// Pengawas jebakan paling mahal: mode Ubah tidak lagi merender input #f-stock,
// jadi payload wajib mengirim nilai lama. Tanpa itu `num('f-stock')` jatuh ke 0
// dan server men-reset stok (AGENTS §3) -> penjualan berikutnya "stok kurang".
const stokSebelum = Number(sql(`SELECT stock FROM products WHERE sku='PRD00013';`));
await p.click('.modal [data-ok]'); await p.waitForTimeout(1200);
chk('tanpa ubah satuan, nilainya tetap di server', sql(`SELECT unit FROM products WHERE sku='PRD00013';`) === 'btl');
const stokSesudah = Number(sql(`SELECT stock FROM products WHERE sku='PRD00013';`));
chk('stok TIDAK tertimpa 0 saat simpan form Ubah', stokSesudah === stokSebelum, `${stokSebelum} -> ${stokSesudah}`);

console.log('=== 9. Error state: halaman survive saat API down ===');
await p.route('**/api/units', (r) => r.abort());
await p.goto('http://localhost:5656/#/satuan', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
chk('halaman tetap tampil (tidak blank)', (await p.locator('#unit-body').count()) === 1);
chk('pesan error goofy tertera', /Gagal memuat satuan/.test(await p.textContent('#unit-body')), (await p.textContent('#unit-body')).replace(/\s+/g, ' ').slice(0, 60));
await p.unroute('**/api/units');

chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
await b.close();
console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})`);
process.exit(fail ? 1 : 0);
