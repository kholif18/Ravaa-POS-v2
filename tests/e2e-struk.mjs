// E2E cetak struk: POS -> escpos.struk() -> print-agent.
// Request /print DISELA di Playwright supaya TIDAK menembak printer sungguhan
// (/dev/usb/lp0 ada dan user tergabung di grup lp — menulisnya akan membuang
// kertas nyata). Yang diuji adalah bytes yang benar-benar dikirim browser.
import { chromium } from 'playwright-core';

let lolos = 0, gagal = 0;
const ok = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const COLS = 32;

/** Buang urutan perintah ESC/POS supaya argumennya tak terbaca sebagai isi struk. */
function buangPerintah(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x1b && b[i + 1] === 0x40) { i += 1; continue; }
    if (b[i] === 0x1b && (b[i + 1] === 0x45 || b[i + 1] === 0x61 || b[i + 1] === 0x64)) { i += 2; continue; }
    if (b[i] === 0x1d && (b[i + 1] === 0x56 || b[i + 1] === 0x21)) { i += 2; continue; }
    out.push(b[i]);
  }
  return out;
}
const teksDari = (b) => buangPerintah(b)
  .map((c) => (c === 10 ? '\n' : c >= 32 && c < 127 ? String.fromCharCode(c) : ''))
  .join('');
const barisStruk = (b) => teksDari(b).split('\n');
const jmlGaris = (b) => (teksDari(b).match(/-{32}/g) || []).length;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Invoice A4 memanggil window.print() di popup (htmlInvoice). Stub di SEMUA
// page (context-wide) supaya popup tidak buntu di headless — alur cetaknya
// tetap teruji: fetch nota + render HTML + popup terbuka.
await page.context().addInitScript(() => { window.print = () => {}; });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // 500 dari rute /print adalah KEgagalan yang SENGAJA dipicu skenario D —
  // itu bukti fitur, bukan kerusakan. Sisanya dianggap error asli.
  if (gagalCetak && /500 \(Internal Server Error\)/.test(t)) return;
  errs.push(`console: ${t}`);
});

const tercetak = [];   // { base64 }
let gagalCetak = false;
await page.route('**/print', async (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  tercetak.push(body.data_base64 || '');
  if (gagalCetak) {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'PRINTER_PATH tidak ada' }) });
  } else {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, via: 'file', file: '/tmp/e2e.bin' }) });
  }
});

const API = 'http://localhost:3001';
const jpost = async (p, b) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const cari = async (q) => (await (await fetch(`${API}/api/products?q=${encodeURIComponent(q)}`)).json()).data?.[0];

// SEMUA produk yang dijual suite ini dicatat lalu DIJAMIN cukup, dan
// dikembalikan persis di finally. Tanpa ini suite ini perlahan memakan stok
// seed (Aqua, Chitato) sampai habis lalu gagal dengan "stok kurang ... (sisa 0)".
// Restock TANPA harga_beli supaya avg_cost tidak berubah.
const dikelola = [];
const jaminStok = async (sku, minimal = 20) => {
  const p = await cari(sku);
  if (!p) throw new Error(`produk ${sku} tidak ditemukan`);
  dikelola.push({ id: p.id, awal: p.stock });
  if (p.stock < minimal) await jpost('/api/restock', { product_id: p.id, qty: minimal, cashier: 'kasir' });
};
await jaminStok('PRD00013');
await jaminStok('PRD00014');

// Tunggu sampai N struk benar-benar terkirim ke /print. `tercetak` hidup di
// Node (bukan di page), jadi tidak bisa page.waitForFunction — polling manual.
const tungguTercetak = async (n, ms = 15000) => {
  const t0 = Date.now();
  while (tercetak.length < n && Date.now() - t0 < ms) await page.waitForTimeout(100);
};

// Modal resume [Thermal] [A4] [Selesai] muncul SETELAH SETIAP bayar sejak
// putaran 11 (2026-10-05, permintaan pemilik 1A) — TANPA syarat saklar
// "Cetak struk otomatis" (saklar mati hanya menahan pengiriman ke printer).
// pilihan=null = klik Selesai (tanpa cetak); pilihan='Escape' = tutup lewat
// Esc (putaran 11c — listener window-capture; tanpa itu Esc mati karena
// fokus sempat di kolom scan, bukan di popup). Semua titik bayar suite ini
// melewatinya.
const pilihCetak = async (pilihan) => {
  await page.waitForSelector('.swal2-popup', { timeout: 8000 });
  const sel = pilihan === 'A4' ? '.swal2-deny' : pilihan === 'Tidak' ? '.swal2-cancel' : '.swal2-confirm';
  await page.click(sel);
  await page.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });
};

const jual = async (paket, pilihan = 'Thermal') => {
  const n0 = tercetak.length;
  await page.fill('#pos-q', paket.q);
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  // Form bayar = MODAL sejak permintaan pemilik 2026-10-04 ("pindahkan ke
  // modal ketika klik bayar") — isian uang ada di dalamnya, jadi form dibuka
  // dulu lewat tombol Bayar sidebar (#pos-bayar).
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  if (paket.tunai) await page.fill('#pos-cash', String(paket.tunai));
  await page.click('#pos-pay');
  await page.waitForFunction(
    () => document.querySelector('#toast-root')?.textContent?.includes('Terjual'),
    { timeout: 15000 },
  );
  // Baca isi modal resume {judul, isi} SEBELUM tombol/Esc — dikembalikan
  // ke caller untuk asersi konten (1A: modal selalu muncul setiap bayar).
  await page.waitForSelector('.swal2-popup', { timeout: 8000 });
  const resume = await page.evaluate(() => ({
    judul: document.querySelector('.swal2-title')?.textContent?.trim() ?? '',
    isi: (document.querySelector('.swal2-popup')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  }));
  if (pilihan === 'Escape') {
    // Tutup lewat Esc (putaran 11c) — tidak ada klik tombol sama sekali.
    await page.keyboard.press('Escape');
    await page.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });
  } else {
    await pilihCetak(pilihan ?? 'Tidak');
  }
  // Struk Thermal baru terkirim sesudah tombol dialog diklik — tunggu betulan
  // supaya asersi `tercetak.length` tidak balapan dengan fetch print-agent.
  if (pilihan === 'Thermal') await tungguTercetak(n0 + 1);
  return resume;
};

try {
  const salesSebelum = await (await fetch('http://localhost:3001/api/reports/daily')).json();

  // Kunci layout THERMAL untuk suite ini: puluhan asersi di bawah menguji
  // kolom 32 + ekor CUT, jadi jangan bergantung pada nilai default pref yang
  // bisa berubah. Layout A4 diuji terpisah di section E.
  await page.addInitScript(() => {
    try { localStorage.setItem('ravaa.struklayout', 'thermal'); } catch { /* */ }
  });

  console.log('=== A. Saklar & penjualan ===');
  await page.goto('http://localhost:5656/#/pos', { waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  ok('saklar "Cetak struk otomatis" tampil di baris Mode', await page.isVisible('#pos-autoprint'));
  ok('saklar NYALA secara bawaan', await page.isChecked('#pos-autoprint'));

  // Cari pakai SKU seed, BUKAN kata generik. POS memang sengaja memecah jadi
  // kata dan SEMUA kata harus cocok di nama/SKU/barcode, jadi begitu toko
  // menambah produk ber-"aqua" kedua, .suggest-item pertama berubah menjadi
  // produk yang salah dan struknya ikut salah isi. Query persis = exact SKU
  // -> tepat 1 hasil (lihat pos.ts pencarian).
  const r1 = await jual({ q: 'PRD00013', tunai: 20000 });
  ok('struk dikirim sekali', tercetak.length === 1, tercetak.length);
  const s1 = Buffer.from(tercetak[0], 'base64');
  ok('diawali INIT', s1[0] === 0x1b && s1[1] === 0x40);
  ok('diakhiri CUT', s1[s1.length - 3] === 0x1d && s1[s1.length - 2] === 0x56 && s1[s1.length - 1] === 0x00);
  const t1 = teksDari(s1);
  const b1 = barisStruk(s1);
  ok('membawa nama toko (default aplikasi)', t1.includes('RAVA POS'), b1.slice(0, 2));
  // Revisi nomor 2026-10-04: `No.` = invoice YYMMDD-NNNNNN (tanggal hari ini
  // UTC + urut harian), bukan lagi 8 digit uuid — dan dipisah baris dari
  // waktu supaya tidak kena potong 32 kolom.
  const ymdStruk = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  ok(`membawa no transaksi ${ymdStruk}-NNNNNN + kasir + shift`,
    new RegExp(`No\\. ${ymdStruk}-\\d{6}`).test(t1) && /Kasir:/.test(t1) && /Shift:/.test(t1), b1.slice(1, 5));
  ok('membawa item terjual', /1 x Aqua 600ml/.test(t1), b1.filter((x) => x.includes('Aqua')));
  ok('membawa subtotal', t1.includes('Subtotal') && t1.includes('Rp4.000'));
  ok('membawa TOTAL', t1.includes('TOTAL') && t1.includes('Rp4.000'));
  ok('membawa tunai & kembalian', t1.includes('Tunai') && t1.includes('Rp20.000') && t1.includes('Rp16.000'),
    b1.filter((x) => /Tunai|Kembalian/.test(x)));
  ok('membawa kaki struk', t1.includes('Terima kasih sudah berbelanja'));
  // Modal resume pasca-bayar (putaran 11, 2026-10-05): judul hero KEMBALIAN
  // + badan ringkasan No. nota / item / Total / Tunai. Regex `i` karena
  // kelas `uppercase` di baris No. nota membuat innerText jadi "NO. …".
  ok('modal resume memuat judul Kembalian + No. nota + item + Tunai',
    /Kembalian/.test(r1.judul) && new RegExp(`No\\. ${ymdStruk}-\\d{6}`, 'i').test(r1.isi)
      && r1.isi.includes('1 × Aqua 600ml') && r1.isi.includes('Total') && r1.isi.includes('Tunai'),
    JSON.stringify(r1).slice(0, 400));
  // Riset KulaPOS (2026-10-06, butir 1): subtitle layan-berikutnya + jam di
  // baris no nota. Regex jam `i` tidak relevan (angka) — tapi pastikan jam
  // benar-benar HH:MM, bukan kebetulan angka lain yang mengandung ":".
  ok('resume memuat subtitle "Siap melayani pelanggan berikutnya"',
    r1.isi.includes('Siap melayani pelanggan berikutnya'), JSON.stringify(r1).slice(0, 300));
  ok('resume memuat jam cetak HH:MM di baris no nota',
    new RegExp(`No\\. ${ymdStruk}-\\d{6} · \\d{2}:\\d{2}`, 'i').test(r1.isi),
    JSON.stringify(r1).slice(0, 300));
  const lewat1 = b1.filter((x) => x.length > COLS);
  ok(`semua baris <= 32 kolom (maks ${Math.max(...b1.map((x) => x.length))})`, lewat1.length === 0, lewat1);
  ok('3 garis pemisah (item + rincian)', jmlGaris(s1) === 3, jmlGaris(s1));
  ok('baris TOTAL dicetak tebal', (() => {
    const idx = s1.findIndex((_, i) =>
      s1[i] === 0x1b && s1[i + 1] === 0x45 && s1[i + 2] === 1 &&
      s1.slice(i + 3, i + 8).toString() === 'TOTAL');
    return idx >= 0;
  })());

  console.log('=== B. Saklar mati = tidak dicetak ===');
  // Input-nya sr-only (tersembunyi demi aksesibilitas) — user asli mengklik
  // labelnya, jadi begitu juga yang diuji.
  await page.click('label[for="pos-autoprint"]');
  ok('posisi saklar terbaca mati', !(await page.isChecked('#pos-autoprint')));
  // Chitato, bukan Pulpen Hitam: pulpen adalah fixture baseline E2E opname.
  // Tutup dialog dengan ESC (putaran 11c): sejak putaran 11 (1A) modal resume
  // TETAP muncul walau saklar mati — yang ditahan hanya pengiriman ke printer.
  const rB = await jual({ q: 'PRD00014', tunai: 20000 }, 'Escape');
  ok('modal resume TETAP muncul walau saklar cetak mati (1A)',
    /Kembalian|Pembayaran berhasil/.test(rB.judul), JSON.stringify(rB).slice(0, 200));
  ok('Esc MENUTUP modal resume langsung (11c)', !(await page.isVisible('.swal2-popup')));
  const fokusEsc = await page.evaluate(() => document.activeElement?.id ?? '');
  ok('fokus kembali ke kolom scan setelah resume ditutup (11c)',
    fokusEsc === 'pos-q', fokusEsc);
  ok('penjualan jalan walau cetak mati', await page.isVisible('#pos-rows'));
  ok('TIDAK ada permintaan cetak tambahan', tercetak.length === 1, tercetak.length);

  // Pintasan katalog produk layanan (AGENTS §1): produk kategori `topup` bukan
  // item jual — klik harus MEMBUKA form topup/tarik, bukan memasukkan ke keranjang.
  // Sejak SKU seed jadi PRD#####, cabang `/tarik/i.test(p.sku)` tidak pernah cocok
  // lagi untuk produk "Tarik tunai"; yang menentukan kini hanya NAMAnya.
  // Test ini menutup celah itu — tanpanya perubahan nama bisa mematikan mode.
  await page.click('[data-mode="jual"]');
  await page.waitForSelector('#pos-q', { timeout: 8000 });
  await page.fill('#pos-q', 'PRD00018');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#tp-submit', { timeout: 8000 });
  const adaTarikBank = await page.locator('#tp-jenis [data-jenis="tarik-bank"]').count();
  const adaEWallet = await page.locator('#tp-jenis [data-jenis="e-wallet"]').count();
  ok('produk "Tarik tunai" membuka mode TARIK (bukan topup)',
    adaTarikBank === 1 && adaEWallet === 0,
    `tarik-bank=${adaTarikBank} e-wallet=${adaEWallet}`);
  const toastPintasan = norm(await page.innerText('#toast-root'));
  ok('produk layanan TIDAK masuk keranjang (toast mengajak isi form)',
    /isi form tarik tunai/.test(toastPintasan), toastPintasan);

  console.log('=== C. Topup tetap memakai saklar yang sama ===');
  await page.click('label[for="pos-autoprint"]');
  ok('saklar bisa dinyalakan lagi', await page.isChecked('#pos-autoprint'));
  await page.click('[data-mode="topup"]');
  await page.waitForSelector('#tp-submit', { timeout: 8000 });
  await page.fill('#tp-nomor', '081234567890');
  await page.fill('#tp-nominal', '50000');
  await page.waitForTimeout(400);          // suggest-admin memanggil API
  const admin = await page.inputValue('#tp-admin');
  // Kontrak: <50rb -> 3000, <200rb -> 5000. Rp50.000 bukan "<50rb" -> tier 5000.
  ok('admin terisi otomatis sesuai tier (<200rb = Rp5.000)', admin === '5000', admin);
  await page.fill('#tp-tunai', '60000');
  await page.click('#tp-submit');
  await page.waitForFunction(
    () => document.querySelector('#toast-root')?.textContent?.match(/Topup /),
    { timeout: 15000 },
  );
  // Topup/tarik TANPA dialog pilihan (keputusan: hanya penjualan yang memilih
  // Thermal/A4) — struk langsung terkirim, tapi tetap ditunggu via polling.
  await tungguTercetak(2);
  ok('struk topup dikirim', tercetak.length === 2, tercetak.length);
  const s3 = Buffer.from(tercetak[1], 'base64');
  const t3 = teksDari(s3);
  const b3 = barisStruk(s3);
  ok('memuat judul layanan', /TOPUP/.test(t3), b3[0]);
  ok('memuat nomor tujuan', t3.includes('081234567890'));
  ok('memuat nominal & admin', t3.includes('Rp50.000') && t3.includes('Rp5.000'),
    b3.filter((x) => /Nominal|Admin/.test(x)));
  ok('memuat TOTAL Rp55.000', t3.includes('Rp55.000'), b3.filter((x) => x.includes('TOTAL')));
  ok('memuat kembalian Rp5.000', t3.includes('Rp5.000') && b3.some((x) => x.includes('Kembalian')),
    b3.filter((x) => /Kembalian|Tunai/.test(x)));
  ok('tanpa baris "(tanpa item)"', !t3.includes('tanpa item'));
  ok('hanya 2 garis (tanpa blok item)', jmlGaris(s3) === 2, jmlGaris(s3));
  const lewat3 = b3.filter((x) => x.length > COLS);
  ok('semua baris topup <= 32 kolom', lewat3.length === 0, lewat3);

  console.log('=== D. Gagal cetak TIDAK membatalkan penjualan ===');
  gagalCetak = true;
  await page.click('[data-mode="jual"]');
  await page.waitForSelector('#pos-q', { timeout: 8000 });
  await jual({ q: 'PRD00013', tunai: 20000 });
  ok('permintaan cetak tetap dikirim (dicoba)', tercetak.length === 3, tercetak.length);
  // Toast peringatan muncul SESUDAH tombol dialog Thermal diklik (alur cetak
  // baru jalan saat itu) — tunggu eksplisit, jangan balapan dengan render.
  await page.waitForFunction(
    () => document.querySelector('#toast-root')?.textContent?.includes('Struk tidak tercetak'),
    { timeout: 15000 },
  );
  const toast = norm(await page.innerText('#toast-root'));
  ok('toast peringatan cetak muncul', /Struk tidak tercetak/.test(toast), toast);
  ok('penjualan tetap berhasil (toast Terjual)', /Terjual/.test(toast), toast);
  const laporan = await (await fetch('http://localhost:3001/api/reports/daily')).json();
  // reports/daily mengembalikan sales = {n, omzet, diskon}, bukan array.
  const n1 = salesSebelum?.data?.sales?.n ?? 0;
  const n2 = laporan?.data?.sales?.n ?? 0;
  ok(`3 penjualan tercatat di server (${n1} -> ${n2})`, n2 - n1 === 3, JSON.stringify({ n1, n2 }));

  console.log('=== E. Invoice A4 (gaya Aronium) — pilihan A4 setelah bayar ===');
  // Section D meninggalkan mode gagal-cetak; kembalikan ke sukses dulu.
  gagalCetak = false;
  await page.click('[data-mode="jual"]');
  await page.waitForSelector('#pos-q', { timeout: 8000 });
  // Bayar dengan pilihan 'A4' -> pilihCetakSelesai -> cetakInvoice() ->
  // fetch GET /api/sales/:id + /api/settings -> window.open popup berisi
  // htmlInvoice(). STRUK print-agent TIDAK dikirim (browser/CUPS yang mencetak).
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    jual({ q: 'PRD00013', tunai: 20000 }, 'A4'),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  const teksE = await popup.innerText('body');
  const tokoE = (await (await fetch(API + '/api/settings')).json()).data?.store_name || '';
  ok('E: popup invoice terbuka (judul INVOICE + kop nama toko)',
    /INVOICE/.test(teksE) && tokoE !== '' && teksE.includes(tokoE),
    JSON.stringify({ toko: tokoE, awal: teksE.slice(0, 80) }));
  ok('E: memuat nomor invoice pola YYMMDD-NNNNNN', /\b\d{6}-\d{6}\b/.test(teksE),
    (teksE.match(/\b\d{6}-\d{6}\b/) || [])[0]);
  ok('E: memuat Bill to + Payment status Lunas',
    teksE.includes('Bill to') && teksE.includes('Pelanggan Umum') && teksE.includes('Lunas'));
  ok('E: memuat item terjual + Total ringkasan + Paid amount',
    teksE.includes('Aqua 600ml') && /Total\b/.test(teksE) && teksE.includes('Paid amount'),
    teksE.replace(/\s+/g, ' ').slice(-220));
  ok('E: invoice lewat browser — /print print-agent TIDAK ikut (tetap 3)',
    tercetak.length === 3, tercetak.length);

  console.log('=== F. Nominal cepat + pintasan level document ===');
  // Bug yang ditutup: F2/Enter dulu menempel di `host`, jadi mati begitu fokus
  // jatuh ke <body> (mis. sesudah blur / pindah dari modal). Sekarang listener
  // di document (bindPintasan) dengan guard modal + field.
  const tungguCetak = async (n, ms = 15000) => {
    const t0 = Date.now();
    while (tercetak.length < n && Date.now() - t0 < ms) await page.waitForTimeout(100);
    // PERSIS n: kalau pay() ke-trigger dua kali, jumlahnya langsung > n.
    ok(`struk ke-${n} terkirim tepat sekali (tanpa bayar dobel)`, tercetak.length === n, tercetak.length);
  };
  await page.click('[data-mode="jual"]');
  await page.waitForSelector('#pos-q', { timeout: 8000 });
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  // Sidebar tak lagi memuat isian pembayaran — klik Bayar = buka FORM BAYAR
  // (modal). Semua id lama (#pos-cash, data-cash, #pos-pay) pindah ke sana.
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  ok('klik Bayar membuka form bayar (modal) berisi metode + uang diterima + chip',
    (await page.locator('[data-cash]').count()) === 4 && await page.isVisible('#pos-cash'),
    await page.locator('[data-cash]').count());
  ok('chip nominal cepat tampil (4 pecahan: 20rb-200rb)', await page.locator('[data-cash]').count() === 4,
    await page.locator('[data-cash]').count());
  // Putaran 10 (2026-10-05): layout modal bayar dua panel ala Ravaa POS v1 —
  // kiri = Total tagihan + Pelanggan + kartu metode, kanan = uang diterima.
  const layoutBayar = await page.evaluate(() => {
    const wrap = document.querySelector('.modal-body > div');
    const kolom = wrap ? [...wrap.children] : [];
    const idx = (sel) => kolom.findIndex((c) => c.querySelector(sel));
    return {
      kolom: kolom.length,
      totalDiKiri: idx('#bayar-total'),
      uangDiKanan: idx('#pos-cash'),
      kartuMetode: document.querySelectorAll('[data-pay]').length,
      pelanggan: !!document.querySelector('#bayar-cust'),
    };
  });
  ok('modal bayar 2 panel ala v1 (total+metode kiri, uang diterima kanan)',
    layoutBayar.kolom === 2 && layoutBayar.totalDiKiri === 0 && layoutBayar.uangDiKanan === 1
      && layoutBayar.kartuMetode === 3 && layoutBayar.pelanggan,
    JSON.stringify(layoutBayar));
  // Putaran 10d (2026-10-05, pemilik): form uang diterima JANGAN langsung
  // terisi "uang pas" — tujuannya memasukkan uang KURANG / LEBIH, jadi
  // default 0 (kosong). Auto-isi P1 dihapus; auto-focus tetap (dicek di
  // section barrier di bawah). Uang pas kini hanya F12 #pos-pay-pas.
  ok('uang diterima default KOSONG (tanpa auto-isi — putaran 10d)',
    (await page.inputValue('#pos-cash')) === '',
    await page.inputValue('#pos-cash'));

  // BARRIER tunai (keluhan pemilik 2026-10-03): uang diterima KOSONG —
  // dulu `cashIn=0` lolos cek dan transaksi selesai tanpa menerima uang.
  // Kolom memang sudah kosong sejak dibuka (putaran 10d); fill('') tetap
  // dijalankan sebagai langkah eksplisit kasir mengosongkan kolom —
  // barrier wajib tetap menolak.
  const nSebelumBarrier = tercetak.length;   // snapshot: section lama sudah cetak
  await page.fill('#pos-cash', '');
  await page.click('#pos-pay');
  let tolakKosong = false;
  try {
    await page.waitForFunction(
      () => document.querySelector('#toast-root')?.textContent?.includes('Uang diterima belum diisi'),
      { timeout: 5000 },
    );
    tolakKosong = true;
  } catch { /* toast tidak muncul = barrier gagal */ }
  ok('bayar dengan uang diterima KOSONG ditolak', tolakKosong, norm(await page.innerText('#toast-root')));
  ok('struk tidak terkirim (transaksi tidak selesai)', tercetak.length === nSebelumBarrier, tercetak.length);
  ok('popup pilihan cetak tidak muncul', (await page.locator('.swal2-popup').count()) === 0,
    await page.locator('.swal2-popup').count());
  ok('fokus kembali ke input uang diterima',
    await page.evaluate(() => document.activeElement?.id) === 'pos-cash',
    await page.evaluate(() => document.activeElement?.id));

  // Uang diterima ADA tapi kurang dari total (Rp1.000 < Rp4.000) tetap ditolak
  // dengan pesan bahasa Indonesia (pesan lama "Uang receivable..." diganti).
  await page.fill('#pos-cash', '1000');
  await page.click('#pos-pay');
  let tolakKurang = false;
  try {
    await page.waitForFunction(
      (t) => document.querySelector('#toast-root')?.textContent?.includes(`Uang diterima kurang dari total ${t}`),
      'Rp4.000', { timeout: 5000 },
    );
    tolakKurang = true;
  } catch { /* toast tidak muncul = barrier gagal */ }
  ok('bayar dengan uang diterima KURANG ditolak + pesan total', tolakKurang,
    norm(await page.innerText('#toast-root')));
  ok('struk tetap tidak terkirim setelah dua kali penolakan', tercetak.length === nSebelumBarrier,
    tercetak.length);

  // Pecahan dulu: Rp100.000 -> kembalian 96.000 (total 4.000).
  await page.click('[data-cash="100000"]');
  ok('klik pecahan mengisi uang diterima', (await page.inputValue('#pos-cash')) === '100000',
    await page.inputValue('#pos-cash'));
  // Putaran 10: chip membalikkan fokus ke kolom uang supaya Enter = bayar
  // (kecepatan transaksi — sebelumnya fokus tertinggal di chip).
  ok('klik chip langsung memfokus kolom uang (siap Enter bayar)',
    (await page.evaluate(() => document.activeElement?.id)) === 'pos-cash',
    await page.evaluate(() => document.activeElement?.id));
  ok('kembalian ikut terhitung', norm(await page.innerText('#pos-change')) === 'Rp96.000',
    await page.innerText('#pos-change'));
  // Putaran 10c (2026-10-05): chip "Uang pas" DIHAPUS dari modal (sudah ada
  // F12 #pos-pay-pas) — ganti pecahan baru 20.000; uang persis total kini
  // lewat ketik manual.
  await page.click('[data-cash="20000"]');
  ok('chip 20.000 mengisi persis uang diterima', (await page.inputValue('#pos-cash')) === '20000',
    await page.inputValue('#pos-cash'));
  ok('chip 20.000 tersorot sebagai pilihan aktif',
    (await page.locator('[data-cash="20000"]').getAttribute('class') || '').includes('!border-primary'));
  await page.fill('#pos-cash', '4000');
  ok('kembalian jadi Rp0 saat uang = total', norm(await page.innerText('#pos-change')) === 'Rp0',
    await page.innerText('#pos-change'));

  // Pintasan global: blur ke <body> lalu F2 — dulu host tidak pernah menerima
  // keydown ini, kasir harus mengklik kolom dulu supaya F2 hidup.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  ok('pra-syarat: fokus jatuh ke body', await page.evaluate(() => document.activeElement?.tagName) === 'BODY');
  await page.keyboard.press('F2');
  await pilihCetak('Thermal');
  await tungguCetak(4);

  // Enter = bayar dari kolom uang (alur kas: ketik -> Enter), bukan cuma F2.
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  // Form bayar ikut tertutup setelah F2 sukses di atas — buka lagi.
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  await page.focus('#pos-cash');
  await page.fill('#pos-cash', '4000');
  await page.keyboard.press('Enter');
  await pilihCetak('Thermal');
  await tungguCetak(5);

  // F12 = bayar pas TANPA membuka form (referensi Aronium: "Default payment
  // can be accessed using F12 key ... automatically close current order").
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.keyboard.press('F12');
  await pilihCetak('Thermal');
  await tungguCetak(6);
  ok('F12 bayar pas selesai tanpa membuka form bayar',
    (await page.locator('.modal-overlay:not(.is-closing)').count()) === 0,
    await page.locator('.modal-overlay:not(.is-closing)').count());

  console.log('=== G. Qty item berikutnya (F4) + layar cari produk (F3) ===');
  // F4: preset qty dipakai SEKALI untuk item berikutnya lalu kembali ke 1.
  await page.keyboard.press('F4');
  await page.waitForSelector('#pos-ask', { timeout: 5000 });
  ok('F4 membuka dialog qty item berikutnya', await page.isVisible('#pos-ask'));
  await page.fill('#pos-ask', '3');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#pos-ask', { state: 'detached', timeout: 5000 });
  // innerText memuat <kbd>F4</kbd> — refreshQtyChip() kini menyegarkannya lewat
  // innerHTML (dulu textContent diam-diam membuang label shortcut).
  ok('chip Qty menampilkan 3 + tersorot',
    norm(await page.innerText('#pos-qty')) === 'Qty 3 F4'
    && (await page.locator('#pos-qty').getAttribute('class') || '').includes('!border-primary'),
    await page.innerText('#pos-qty'));

  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  ok('item pertama masuk dengan qty 3', (await page.inputValue('#pos-rows [data-act="qty"]')) === '3',
    await page.inputValue('#pos-rows [data-act="qty"]'));
  ok('qtyNext kembali 1 setelah dipakai (sekali pakai)',
    norm(await page.innerText('#pos-qty')) === 'Qty 1 F4', await page.innerText('#pos-qty'));

  // F3: layar cari penuh. Filter + Enter = tambah + tutup.
  await page.keyboard.press('F3');
  await page.waitForSelector('#pc-q', { timeout: 5000 });
  ok('F3 membuka layar cari produk', await page.isVisible('#pc-list'));
  ok('daftar awal terisi', (await page.locator('#pc-list [data-i]').count()) > 0,
    await page.locator('#pc-list [data-i]').count());
  await page.fill('#pc-q', 'PRD00014');
  ok('filter mempersempit ke 1 hasil', (await page.locator('#pc-list [data-i]').count()) === 1,
    await page.locator('#pc-list [data-i]').count());
  await page.keyboard.press('Enter');
  let cariTutup = true;
  try { await page.waitForSelector('#pc-list', { state: 'detached', timeout: 5000 }); } catch { cariTutup = false; }
  ok('Enter memilih hasil & menutup layar cari', cariTutup);
  // `:not(.note-row)` — tr catatan (fitur use_note) juga membawa data-key,
  // jadi tanpa penyaringan ini hitungannya bocor 1 baris tiap produk use_note.
  ok('produk terpilih masuk keranjang (2 baris)', (await page.locator('#pos-rows tr[data-key]:not(.note-row)').count()) === 2,
    await page.locator('#pos-rows tr[data-key]:not(.note-row)').count());
  ok('fokus kembali ke scan bar', await page.evaluate(() => document.activeElement?.id) === 'pos-q',
    await page.evaluate(() => document.activeElement?.id));

  // Guard: F3 saat layar cari terbuka tidak membuka modal ganda; Esc menutup.
  await page.keyboard.press('F3');
  await page.waitForSelector('#pc-q', { timeout: 5000 });
  await page.keyboard.press('F3');
  await page.waitForTimeout(200);
  ok('F3 saat modal terbuka tidak membuka modal ganda',
    (await page.locator('.modal-overlay:not(.is-closing)').count()) === 1,
    await page.locator('.modal-overlay:not(.is-closing)').count());
  await page.keyboard.press('Escape');
  let escTutup = true;
  try { await page.waitForSelector('#pc-q', { state: 'detached', timeout: 5000 }); } catch { escTutup = false; }
  ok('Esc menutup layar cari', escTutup);

  console.log('=== H. Catatan per baris (use_note -> sale_items.note -> struk) ===');
  // Nyalakan saklar "Catatan di POS" utk PRD00013 lewat API (payload LENKAP —
  // POST /api/products me-reset field yang absen, lihat AGENTS §3).
  const p13h = await cari('PRD00013');
  const setNote = await jpost('/api/products', { ...p13h, use_note: 1 });
  ok('API: use_note=1 tersimpan & version naik', setNote.s === 201 && setNote.j?.data?.use_note === 1,
    JSON.stringify({ s: setNote.s, use_note: setNote.j?.data?.use_note }));

  // Reload = mount ulang POS -> delta sync menarik use_note=1 ke cache.
  // Keranjang PERSISTEN (putaran 16, localStorage sinkron) — kosongkan dulu,
  // supaya section H mulai dari keranjang bersih dan tidak memulihkan 2 baris
  // sisa section G (tujuan test di sini = sync master, bukan pemulihan
  // keranjang; perilaku pemulihan diuji di section M).
  if (await page.locator('#pos-rows tr[data-key]:not(.note-row)').count()) {
    await page.click('#pos-clear');
    await page.waitForFunction(() => !document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length);
  }
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });

  // Produk use_note=1 -> input catatan di bawah barisnya; use_note=0 tidak.
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.fill('#pos-q', 'PRD00014');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForFunction(() => document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length >= 2);
  ok('Aqua (use_note=1) punya input catatan; Chitato tidak — total 1 input',
    (await page.locator('#pos-rows [data-act="note"]').count()) === 1,
    await page.locator('#pos-rows [data-act="note"]').count());
  await page.fill('#pos-rows [data-act="note"]', 'ukuran 1 x 3 meter');
  ok('isi input catatan masuk ke value', (await page.inputValue('#pos-rows [data-act="note"]')) === 'ukuran 1 x 3 meter',
    await page.inputValue('#pos-rows [data-act="note"]'));

  // F10 = buka form bayar (referensi Aronium "Payment (F10) opens payment
  // form") — jalur kedua selain klik tombol Bayar sidebar.
  await page.keyboard.press('F10');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  ok('F10 membuka form bayar (modal)', await page.isVisible('#pos-cash'),
    await page.evaluate(() => document.activeElement?.id));
  await page.focus('#pos-cash');
  await page.fill('#pos-cash', '20000');
  await page.click('#pos-pay');
  await pilihCetak('Thermal');
  await tungguCetak(7);
  // Indeks ABSOLUT: setiap section menambah penjualan — struk ke-7 = slot 7
  // (dulu [5] sebelum section F menambah kasus F12 bayar pas).
  const s7 = Buffer.from(tercetak[6], 'base64');
  const t7 = teksDari(s7);
  const b7 = barisStruk(s7);
  ok('struk memuat baris catatan indented di bawah item',
    b7.some((x) => x.trim() === '- ukuran 1 x 3 meter'),
    b7.filter((x) => /ukuran|Aqua|Chitato/.test(x)));
  ok('hanya 1 baris catatan (Chitato use_note=0 tanpa catatan)',
    b7.filter((x) => x.startsWith('  - ')).length === 1,
    b7.filter((x) => x.startsWith('  - ')));
  const lewat7 = b7.filter((x) => x.length > COLS);
  ok(`catatan tetap <= 32 kolom (maks ${Math.max(0, ...b7.map((x) => x.length))})`, lewat7.length === 0, lewat7);

  // Snapshot di server: GET /api/sales/:id membawa sale_items.note utk cetak ulang.
  const hari = new Date().toISOString().slice(0, 10);
  const daftarH = await (await fetch(`${API}/api/sales?date=${hari}`)).json();
  const idH = daftarH.data?.[0]?.id;
  const notaH = await (await fetch(`${API}/api/sales/${encodeURIComponent(idH)}`)).json();
  const nAqua = notaH.data?.items?.find((i) => i.sku === 'PRD00013' || i.product_id === 13);
  ok('server menyimpan note (trimmed)', nAqua?.note === 'ukuran 1 x 3 meter', JSON.stringify(nAqua?.note));
  const nChit = notaH.data?.items?.find((i) => i.product_id === 14);
  ok('baris tanpa catatan disimpan sebagai ""', nChit?.note === '', JSON.stringify(nChit?.note));
  // Nota membawa nomor invoice = tanggal + urut harian (revisi 2026-10-04):
  // YYMMDD-NNNNNN dengan tanggal hari ini UTC.
  const ymdH = hari.slice(2).replace(/-/g, ''); // 2026-10-04 -> 261004
  ok(`nota membawa invoice_no pola ${ymdH}-NNNNNN (tanggal + urut harian)`,
    new RegExp(`^${ymdH}-\\d{6}$`).test(notaH.data?.sale?.invoice_no ?? ''), notaH.data?.sale?.invoice_no);

  console.log('=== I. Pengaturan toko (kop invoice A4) & guard API settings ===');
  const set0 = (await (await fetch(`${API}/api/settings`)).json()).data || {};
  ok('GET settings memuat 4 kunci store_* (string, utk kop invoice)',
    ['store_name', 'store_address', 'store_phone', 'store_email'].every((k) => typeof set0[k] === 'string'),
    JSON.stringify({ n: set0.store_name, a: set0.store_address, p: set0.store_phone, e: set0.store_email }));
  const setUji = await jpost('/api/settings', { store_phone: '0000000000' });
  ok('POST store_* parsial diterima (200 + nilai terpasang)',
    setUji.s === 200 && setUji.j?.data?.store_phone === '0000000000', JSON.stringify(setUji));
  ok('kunci store LAIN tidak ikut ter-reset oleh update parsial',
    setUji.j?.data?.store_name === set0.store_name && setUji.j?.data?.store_email === set0.store_email,
    JSON.stringify({ n0: set0.store_name, n1: setUji.j?.data?.store_name }));
  const setAsing = await jpost('/api/settings', { waduh: 'siape' });
  ok('kunci asing ditolak 400', setAsing.s === 400, JSON.stringify(setAsing));
  // Kembalikan persis seperti ditemukan (DB dev milik pemilik).
  await jpost('/api/settings', { store_phone: set0.store_phone });

  console.log('=== J. Bayar pas di side panel + uang kurang = hutang ===');
  // 1) Permintaan pemilik putaran kedua (2026-10-04): "bayar uang pas
  //    letakkan di sidepanel bawahnya Bayar F10" — jadi BUKAN isi form lagi.
  const urutPas = await page.evaluate(() => {
    const b = document.querySelector('#pos-bayar');
    const p = document.querySelector('#pos-pay-pas');
    return { ada: !!b && !!p, diModal: !!p?.closest('.modal-overlay'), berurut: b?.nextElementSibling === p };
  });
  ok('Bayar pas ada di side panel, tepat setelah tombol Bayar F10',
    urutPas.ada && !urutPas.diModal && urutPas.berurut, JSON.stringify(urutPas));

  // 2) Klik Bayar pas = bayar seketika, form bayar tidak ikut terbuka.
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.click('#pos-pay-pas');
  const cekPas = { pay: await page.locator('#pos-pay').count(), ov: await page.locator('.modal-overlay:not(.is-closing)').count() };
  ok('Bayar pas membayar tanpa membuka form bayar', cekPas.pay === 0 && cekPas.ov === 0, JSON.stringify(cekPas));
  await pilihCetak('Thermal');
  await tungguCetak(8);

  // 3) Uang kurang + pelanggan BAWAAN = tetap ditolak barrier (hutang butuh
  //    pelanggan nyata) — pesan persis barrier lama, penjualan tidak terkirim.
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  await page.fill('#pos-cash', '3000');
  const jmlSebelum = (await (await fetch(`${API}/api/sales?date=${hari}`)).json()).total;
  await page.click('#pos-pay');
  let tolakUmum = false;
  try {
    await page.waitForFunction(
      () => document.querySelector('#toast-root')?.textContent?.includes('Uang diterima kurang dari total Rp4.000'),
      { timeout: 5000 },
    );
    tolakUmum = true;
  } catch { /* toast tidak muncul = penolakan gagal */ }
  const jmlSesudah = (await (await fetch(`${API}/api/sales?date=${hari}`)).json()).total;
  ok('uang kurang + Pelanggan Umum ditolak (penjualan tidak terkirim)',
    tolakUmum && jmlSesudah === jmlSebelum, JSON.stringify({ tolakUmum, jmlSebelum, jmlSesudah }));

  // 4) Pelanggan NYATA -> OTOMATIS lanjut (putaran 12 2026-10-06, instruksi
  //    pemilik: "uang kurang / uang 0 akan otomatis masuk ke hutang dengan
  //    catatan harus terpilih customer") — TANPA dialog konfirmasi lama,
  //    popup pertama yang muncul = RESUME, dan resume memuat baris HUTANG.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-overlay:not(.is-closing)', { state: 'detached', timeout: 5000 });
  // Pelanggan uji DIPAKAI ULANG tiap run — jangan dihapus: penjualan tadi
  // membawa customer_id (FK `sales.customer_id -> customers.id` dengan
  // foreign_keys=ON), jadi DELETE = SQLite constraint error -> 500 (terbukti
  // saat ditulis pertama kali). Yang dibersihkan hanya baris ledgernya.
  const preJ = await (await fetch(`${API}/api/customers?q=${encodeURIComponent('UjiHutang POS E2E')}`)).json();
  let custJ = preJ.data?.[0];
  if (!custJ) custJ = (await jpost('/api/customers', { name: 'UjiHutang POS E2E', phone: '081999888777' })).j?.data;
  const cidJ = custJ?.id;
  ok('pelanggan uji siap (pakai ulang bila sudah ada)', !!cidJ, JSON.stringify(custJ));
  // Sisa run sebelumnya (gagal di tengah jalan) = buang dulu supaya asersi
  // `sisa` di bawah benar-benar milik penjualan ini saja.
  const ledPre = await (await fetch(`${API}/api/customer-debts/${cidJ}`)).json();
  for (const r of ledPre.data?.rows ?? []) await fetch(`${API}/api/customer-debts/${r.id}`, { method: 'DELETE' });
  // Select pelanggan diinfo bar dirender saat mount -> reload supaya pelanggan
  // baru ikut masuk daftar (pola sama dengan section H). Keranjang masih
  // memuat 1 baris PRD00013 sisa barrier langkah 3 di atas (pay ditolak =
  // cart dipertahankan) — kosongkan dulu: putaran 16 membuatnya persisten,
  // tanpa clear ini reload akan memulihkannya lalu langkah 4 jadi qty 2 /
  // total Rp8.000, bukan Rp4.000 (semua asersi hutang di bawah patah).
  if (await page.locator('#pos-rows tr[data-key]:not(.note-row)').count()) {
    await page.click('#pos-clear');
    await page.waitForFunction(() => !document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length);
  }
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  await page.selectOption('#pos-customer', String(cidJ));
  ok('pelanggan terpilih di info bar', (await page.inputValue('#pos-customer')) === String(cidJ),
    await page.inputValue('#pos-customer'));
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  await page.fill('#pos-cash', '3000');
  await page.click('#pos-pay');
  await page.waitForSelector('.swal2-popup', { timeout: 8000 });
  const isiPopup = norm(await page.innerText('.swal2-popup'));
  ok('uang kurang + pelanggan valid -> OTOMATIS resume tanpa konfirmasi',
    isiPopup.includes('Siap melayani pelanggan berikutnya')
      && !isiPopup.includes('Uang kurang — catat jadi hutang'), isiPopup.slice(0, 200));
  ok('resume memuat baris HUTANG sisa Rp1.000 (merah)',
    isiPopup.includes('Hutang') && isiPopup.includes('Rp1.000'), isiPopup.slice(0, 200));
  await pilihCetak('Thermal');
  await tungguCetak(9);

  const daftarJ = await (await fetch(`${API}/api/sales?date=${hari}`)).json();
  const notaJ = await (await fetch(`${API}/api/sales/${encodeURIComponent(daftarJ.data?.[0]?.id ?? '')}`)).json();
  ok('penjualan tersimpan: uang diterima < total + pelanggan di-snapshot',
    notaJ.data?.sale?.cash_in === 3000 && notaJ.data?.sale?.customer_name === 'UjiHutang POS E2E',
    JSON.stringify({ cash_in: notaJ.data?.sale?.cash_in, total: notaJ.data?.sale?.total, cust: notaJ.data?.sale?.customer_name }));

  const ledJ = await (await fetch(`${API}/api/customer-debts/${cidJ}`)).json();
  const sisaJ = (notaJ.data?.sale?.total ?? 0) - 3000;
  const barisJ = ledJ.data?.rows?.[0];
  ok('sisa tercatat sebagai HUTANG (charge) di ledger pelanggan',
    (ledJ.data?.sisa ?? -1) === sisaJ && barisJ?.type === 'charge' && barisJ?.amount === sisaJ,
    JSON.stringify({ sisa: ledJ.data?.sisa, sisaJ, barisJ }));
  ok('catatan hutang menyebut nomor nota (invoice_no)',
    typeof barisJ?.note === 'string' && barisJ.note.includes(notaJ.data?.sale?.invoice_no ?? '~~'),
    JSON.stringify(barisJ?.note));

  // 5) UANG 0 — kolom uang sengaja TIDAK diisi (default kosong sejak putaran
  //    10d) + pelanggan masih valid -> OTOMATIS seluruh total jadi HUTANG
  //    (instruksi pemilik 2026-10-06: "uang kurang / uang 0"). Pelanggan
  //    tadi sudah kembali ke bawaan setelah penjualan -> pilih ulang.
  await page.selectOption('#pos-customer', String(cidJ));
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.click('#pos-bayar');
  await page.waitForSelector('#pos-pay', { timeout: 8000 });
  await page.click('#pos-pay'); // tanpa isi #pos-cash = uang 0
  await page.waitForSelector('.swal2-popup', { timeout: 8000 });
  const isi0 = norm(await page.innerText('.swal2-popup'));
  ok('uang 0 + pelanggan valid -> OTOMATIS hutang penuh di resume',
    isi0.includes('Hutang') && isi0.includes('Rp4.000') && isi0.includes('Tunai'),
    isi0.slice(0, 220));
  await pilihCetak('Thermal');
  await tungguCetak(10);
  const daftar0 = await (await fetch(`${API}/api/sales?date=${hari}`)).json();
  const nota0 = await (await fetch(`${API}/api/sales/${encodeURIComponent(daftar0.data?.[0]?.id ?? '')}`)).json();
  const led0 = await (await fetch(`${API}/api/customer-debts/${cidJ}`)).json();
  ok('nota uang-0 tersimpan (cash_in 0) + ledger sisa Rp5.000 (2 charge)',
    nota0.data?.sale?.cash_in === 0 && (led0.data?.sisa ?? -1) === 5000
      && (led0.data?.rows?.length ?? -1) === 2,
    JSON.stringify({ cash_in: nota0.data?.sale?.cash_in, sisa: led0.data?.sisa, n: led0.data?.rows?.length }));

  // Penanda HUTANG di Riwayat (putaran 13): field computed `sisa_hutang` di
  // GET /api/sales (daftar) DAN GET /api/sales/:id (rincian) — nilai persis
  // sisa dua nota uji di atas (sisaJ = total−3000 = Rp1.000, uang-0 = Rp4.000).
  const s4 = daftar0.data?.find((x) => x.id === notaJ.data?.sale?.id);
  ok('GET /api/sales & /:id memuat sisa_hutang (penanda hutang di Riwayat)',
    daftar0.data?.[0]?.sisa_hutang === 4000 && s4?.sisa_hutang === sisaJ
      && notaJ.data?.sale?.sisa_hutang === sisaJ
      && daftar0.data?.[0]?.customer_name === 'UjiHutang POS E2E',
    JSON.stringify({
      s5: daftar0.data?.[0]?.sisa_hutang, s4: s4?.sisa_hutang, sisaJ,
      diId: notaJ.data?.sale?.sisa_hutang, cust: daftar0.data?.[0]?.customer_name,
    }));

  // Bersih-bersih: SEMUA baris ledger (2 penjualan di atas) — fetch ulang,
  // jangan pakai `ledJ` yang sudah basi. Pelanggan TIDAK dihapus (FK
  // penjualan — lihat catatan find-or-create di atas) dan tetap dipakai
  // run berikutnya.
  const ledAkhir = await (await fetch(`${API}/api/customer-debts/${cidJ}`)).json();
  for (const r of ledAkhir.data?.rows ?? []) await fetch(`${API}/api/customer-debts/${r.id}`, { method: 'DELETE' });
  const ledKosong = await (await fetch(`${API}/api/customer-debts/${cidJ}`)).json();
  ok('bersih-bersih: ledger pelanggan uji kembali kosong',
    (ledKosong.data?.rows?.length ?? -1) === 0, JSON.stringify(ledKosong.data?.rows ?? ledKosong));

  // ——— Section K: putaran 7 pemilik 2026-10-04 ———
  // "baris Subtotal dihapus", "Item manual di scan bar dihapus karena sudah
  // ada di deretan tombol panel kanan", dan "tambahkan cari pelanggan seperti
  // cari produk F3" (openCariPelanggan, tombol #pos-cust-cari di info bar).
  const nSub = await page.locator('#pos-subtotal').count();
  ok('baris Subtotal di sidebar sudah dihapus', nSub === 0, `#pos-subtotal count=${nSub}`);
  const nManual = await page.locator('#pos-manual').count();
  const nQaManual = await page.locator('#pos-qa-manual').count();
  ok('tombol Item manual ganda di scan bar dihapus (tetap ada di panel kanan)',
    nManual === 0 && nQaManual === 1, JSON.stringify({ scanBar: nManual, panelKanan: nQaManual }));

  // Reset dulu ke opsi LAIN supaya pemilihan lewat layar cari benar-benar
  // terbukti mengubah select (bukan kebetulan sudah terpilih).
  const nilaiLain = await page.$eval('#pos-customer', (s, keep) =>
    [...s.options].find((o) => o.value !== keep)?.value ?? '', String(cidJ));
  if (nilaiLain) await page.selectOption('#pos-customer', nilaiLain);

  // Test F1 & F8 (fokus scan) sebelum membuka modal
  await page.click('body'); // buang fokus
  await page.keyboard.press('F1');
  const fokusF1 = await page.evaluate(() => document.activeElement?.id);
  await page.click('body');
  await page.keyboard.press('F8');
  const fokusF8 = await page.evaluate(() => document.activeElement?.id);
  ok('F1 & F8 memindahkan fokus ke kolom scan (ala KulaPOS)',
    fokusF1 === 'pos-q' && fokusF8 === 'pos-q', `F1=${fokusF1}, F8=${fokusF8}`);

  await page.keyboard.press('F9');
  await page.waitForSelector('#pcust-q', { timeout: 5000 });
  const fokusCari = await page.evaluate(() => document.activeElement?.id);
  ok('F9 (Cari pelanggan) membuka layar cari pelanggan + fokus di kolom cari',
    (await page.locator('#pcust-list').count()) === 1 && fokusCari === 'pcust-q',
    JSON.stringify({ list: await page.locator('#pcust-list').count(), fokus: fokusCari }));

  await page.fill('#pcust-q', 'UjiHutang');
  await page.waitForFunction(
    () => document.querySelectorAll('#pcust-list .suggest-item').length >= 1, { timeout: 5000 },
  );
  const nHasil = await page.locator('#pcust-list .suggest-item').count();
  ok('ketik nama memfilter daftar pelanggan', nHasil >= 1 && nHasil < 50, `n=${nHasil}`);

  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal-overlay:not(.is-closing)', { state: 'detached', timeout: 5000 });
  const pilihCari = await page.inputValue('#pos-customer');
  ok('Enter memilih baris -> select pelanggan terisi id itu',
    pilihCari === String(cidJ), `select=${pilihCari} (cidJ=${cidJ})`);

  // Pencarian tanpa hasil = pesan kosong, modal tetap terbuka (batal = Esc).
  await page.click('#pos-cust-cari');
  await page.waitForSelector('#pcust-q', { timeout: 5000 });
  await page.fill('#pcust-q', 'zzzzzzzzzz');
  const kosong = norm(await page.innerText('#pcust-list'));
  ok('pencarian tanpa hasil menampilkan pesan kosong',
    kosong.includes('Tidak ada pelanggan yang cocok'), kosong);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal-overlay:not(.is-closing)', { state: 'detached', timeout: 5000 });

  // ——— Section L: putaran 13 pemilik 2026-10-06 ———
  // "riwayat transaksi tambahkan kalau itu hutang, beri tanda untuk mudah
  // mencari yang transaksi hutang, dan juga langsung tercatat otomatis di
  // halaman hutang". Poin terakhir sudah jalan sejak putaran 12 (charge
  // otomatis di pay()) — di sini dibuktikan dari penanda + rincian nota yang
  // menunjuk halaman Hutang. Note: regex /i karena innerText kena
  // text-transform pada chip.
  console.log('=== L. Riwayat: penanda HUTANG + filter ===');
  await page.goto('http://localhost:5656/#/history', { waitUntil: 'load' });
  await page.waitForSelector('tr[data-trx]', { timeout: 15000 });
  const cekBadge = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[data-trx]')];
    const h = rows.filter((r) => /hutang rp/i.test(r.innerText));
    return { n: rows.length, hutang: h.length, angka: h.every((r) => /rp[\d.]+/i.test(r.innerText)) };
  });
  ok('Riwayat menampilkan penanda "Hutang RpX" per baris',
    cekBadge.hutang >= 2 && cekBadge.angka, JSON.stringify(cekBadge));

  await page.click('#h-hutang');
  const cekFilter = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr[data-trx]')];
    const text = document.querySelector('#h-body')?.innerText ?? '';
    return {
      n: rows.length,
      semua: rows.length > 0 && rows.every((r) => /hutang rp/i.test(r.innerText)),
      caption: /disaring hanya transaksi hutang/i.test(text),
    };
  });
  ok('filter chip HUTANG menyisakan hanya baris berhutang (client-side)',
    cekFilter.semua && cekFilter.caption, JSON.stringify(cekFilter));

  await page.click('tr[data-trx]');
  await page.waitForSelector('.det-row [data-reprint]', { timeout: 8000 });
  const detHutang = await page.evaluate(() => document.querySelector('.det-row')?.innerText ?? '');
  ok('rincian nota: kotak Hutang + catatan "tercatat di halaman Hutang"',
    /hutang/i.test(detHutang) && /halaman Hutang/i.test(detHutang),
    detHutang.replace(/\s+/g, ' ').slice(0, 240));

  // Invoice A4 ikut membawa HUTANG (putaran 14 pemilik 2026-10-06: "pada
  // invoice silakan sesuaikan tambahkan hutang jika pelanggan berhutang").
  // Charge ledger uji 7000 sengaja LEBIH BESAR dari hutang nota (Rp4.000)
  // supaya baris "Sisa hutang (semua nota)" teruji terpisah; dihapus lagi
  // setelahnya — bersih-bersih section J menuntut ledger kembali 0.
  const chInv = await jpost('/api/customer-debts', {
    customer_id: cidJ, type: 'charge', amount: 7000, note: 'Uji invoice A4',
  });
  // Buka baris NOTA UJI sendiri (bisa bukan baris pertama — pelanggan lain
  // boleh berhutang lebih baru); toggle bila kebetulan sudah terbuka.
  const invUji = String(nota0.data?.sale?.invoice_no ?? '');
  const barisUji = page.locator('tr[data-trx]', { hasText: invUji });
  if ((await barisUji.first().getAttribute('aria-expanded')) !== 'true') {
    await barisUji.first().click();
  }
  await page.waitForSelector('.det-row [data-reprint]', { timeout: 8000 });
  const nPrintA4 = tercetak.length;
  const [popupInv] = await Promise.all([
    page.waitForEvent('popup'),
    (async () => {
      await page.click('.det-row [data-reprint]');
      await page.waitForSelector('.swal2-popup', { timeout: 8000 });
      await page.click('.swal2-deny'); // A4
      await page.waitForSelector('.swal2-popup', { state: 'detached', timeout: 8000 });
    })(),
  ]);
  await popupInv.waitForLoadState('domcontentloaded');
  const teksInv = await popupInv.innerText('body');
  ok('L: invoice A4 nota berhutang -> "Belum lunas" + baris Hutang tercetak',
    /Belum lunas/i.test(teksInv) && /Hutang:?\s*Rp[\d,]+\.00/i.test(teksInv),
    teksInv.replace(/\s+/g, ' ').slice(0, 300));
  ok('L: sisa piutang ledger (Rp7.000,00) tercetak sebagai baris terpisah',
    /Sisa hutang \(semua nota\)/i.test(teksInv) && /Rp7,000\.00/.test(teksInv),
    (teksInv.match(/Sisa hutang[^\n]*/) || [''])[0]);
  ok('L: invoice A4 tidak lewat print-agent (browser/CUPS)', tercetak.length === nPrintA4,
    `${nPrintA4} -> ${tercetak.length}`);
  if (chInv.j?.data?.id) {
    await fetch(`${API}/api/customer-debts/${chInv.j.data.id}`, { method: 'DELETE' });
  }

  // ——— Section M: keranjang persisten (putaran 16, 2026-10-06) ———
  // Permintaan pemilik: "produk yang berada di keranjang jika kasir pindah ke
  // halaman dashboard atau tidak sengaja terrefresh barang tidak hilang /
  // keranjang tidak kosong". Sumber kebenaran = localStorage `ravaa.keranjang`
  // (store.ts getKeranjang/saveKeranjang, TULIS SINKRON — bukan antrean
  // IndexedDB yang bisa terbuang reload kilat) yang ditulis tiap mutasi
  // (pos.ts simpanKeranjang) dan dipulihkan mountPosPage -> muatKeranjang()
  // saat cart memori kosong.
  console.log('=== M. Keranjang persisten (reload + pindah halaman) ===');
  await page.goto('http://localhost:5656/#/pos', { waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 15000 });
  // Titik awal deterministik: buang sisa section sebelumnya (bila ada) —
  // tombol Bersihkan ikut menulis localStorage, jadi sesudahnya benar-benar kosong.
  if (await page.locator('#pos-rows tr[data-key]:not(.note-row)').count()) {
    await page.click('#pos-clear');
    await page.waitForFunction(() => !document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length);
  }
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  const kosongM = (await page.locator('#pos-rows tr[data-key]:not(.note-row)').count()) === 0;
  ok('M: baseline — reload saat penyimpanan kosong = keranjang kosong', kosongM);

  // Isi keranjang + diskon transaksi, ukur sebelum reload.
  await page.fill('#pos-q', 'PRD00013');
  await page.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
  await page.click('#pos-results .suggest-item');
  await page.waitForSelector('#pos-rows tr[data-key]', { timeout: 8000 });
  await page.fill('#pos-discount', '500');
  const sebelumM = {
    baris: await page.locator('#pos-rows tr[data-key]:not(.note-row)').count(),
    grand: norm(await page.innerText('#pos-grand')),
    disc: await page.inputValue('#pos-discount'),
  };
  ok('M: keranjang terisi sebelum reload (1 baris + diskon 500)',
    sebelumM.baris >= 1 && sebelumM.disc === '500', JSON.stringify(sebelumM));

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  let pulihToast = false;
  try {
    await page.waitForFunction(
      () => document.querySelector('#toast-root')?.textContent?.includes('Keranjang dipulihkan'),
      { timeout: 5000 },
    );
    pulihToast = true;
  } catch { /* toast lewat sebelum sempat dibaca — asersi data di bawah yang menentukan */ }
  ok('M: reload -> toast "Keranjang dipulihkan" muncul', pulihToast);
  const sesudahM = {
    baris: await page.locator('#pos-rows tr[data-key]:not(.note-row)').count(),
    grand: norm(await page.innerText('#pos-grand')),
    disc: await page.inputValue('#pos-discount'),
  };
  ok('M: reload -> baris keranjang pulih (tidak kosong)',
    sesudahM.baris === sebelumM.baris && sesudahM.baris >= 1, JSON.stringify({ sebelumM, sesudahM }));
  ok('M: reload -> TOTAL BELANJA identik', sesudahM.grand === sebelumM.grand,
    `${sebelumM.grand} -> ${sesudahM.grand}`);
  ok('M: reload -> diskon transaksi ikut pulih', sesudahM.disc === '500', sesudahM.disc);

  // Pindah halaman = hash route TANPA reload dokumen -> mountPosPage ulang;
  // isi memori dipertahankan, keranjang tidak boleh hilang.
  await page.goto('http://localhost:5656/#/dashboard', { waitUntil: 'load' });
  await page.waitForSelector('#db-reload', { timeout: 15000 });
  await page.goto('http://localhost:5656/#/pos', { waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 15000 });
  const navM = {
    baris: await page.locator('#pos-rows tr[data-key]:not(.note-row)').count(),
    grand: norm(await page.innerText('#pos-grand')),
  };
  ok('M: pindah ke Dashboard lalu kembali = keranjang utuh',
    navM.baris === sebelumM.baris && navM.grand === sebelumM.grand, JSON.stringify(navM));

  // "Bersihkan" menulis isi kosong -> reload sesudahnya TETAP kosong.
  await page.click('#pos-clear');
  await page.waitForFunction(() => !document.querySelectorAll('#pos-rows tr[data-key]:not(.note-row)').length);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#pos-q', { timeout: 20000 });
  const tetapKosong = (await page.locator('#pos-rows tr[data-key]:not(.note-row)').count()) === 0;
  ok('M: "Bersihkan" persisten — reload sesudahnya tetap kosong', tetapKosong);

  ok('tanpa error halaman', errs.length === 0, errs.slice(0, 3));
} catch (e) {
  gagal++;
  console.log('  GAGAL (exception) |', e.message);
  try { console.log('  toast:', norm(await page.innerText('#toast-root'))); } catch { /* */ }
} finally {
  await browser.close();
  // Kembalikan stok tiap produk persis seperti awal (opname = set absolut,
  // bukan +/−), supaya run berikutnya tidak mewarisi sisa run ini.
  for (const k of dikelola) {
    await jpost('/api/stock-opname', { product_id: k.id, qty_fisik: k.awal, cashier: 'kasir' }).catch(() => {});
  }
}
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
