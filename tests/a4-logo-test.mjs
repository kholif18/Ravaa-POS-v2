// Logo toko di SEMUA dokumen A4 cetak-browser (revisi pemilik 19 Okt 2026:
// *"logo itu harusnya juga di terapkan pada a4 juga"*).
//
// Slot logo BERSAMA (urlLogoA4/logoA4Html/CSS_LOGO_A4 di invoice.ts) dipakai
// lima dokumen: invoice penjualan, laporan (#/reports semua menu), rekap shift
// (PDF), nota PO (purchases.ts), rincian hutang (debts.ts). Suite ini menjaga:
//   - builder invoice/laporan/rekap memuat <img class="logo-img"> ber-src
//     ABSOLUT (`<origin>/api/settings/logo` — popup cetak ber-about:blank
//     TIDAK bisa me-resolve src relatif) + bulatan fallback "R" + onerror
//     penyembunyi + CSS slot baru (width 84px);
//   - popup laporan NYATA (klik #rp-print) memuat logo sampai termuat
//     (naturalWidth > 0) saat logo ada;
//   - TANPA logo (endpoint 204): img menyembunyikan diri, bulatan fallback
//     tetap tampil — cetak tidak pernah gagal karena hiasan;
//   - suite membersihkan logonya sendiri (self-heal awal + hapus di akhir).
// Jalankan: node a4-logo-test.mjs   (butuh API :3001 + vite :5656 hidup)
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

const WEB = 'http://localhost:5656';
let lolos = 0, gagal = 0;
const ok = (name, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${name}${info ? ` | ${info}` : ''}`); }
  else { gagal++; console.log(`  GAGAL ${name}${info ? ` | ${info}` : ''}`); }
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await pasangToken(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
  // Popup dokumen A4 = Page terpisah — ikut dipantau.
  ctx.on('page', (pg) => pg.on('pageerror', (e) => errs.push(`popup: ${String(e).slice(0, 150)}`)));
  // Stub window.print di SELURUH context (popup memanggil print() saat load).
  await ctx.addInitScript(() => { window.print = () => {}; });

  const get = (path) => page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, path);
  const post = (path, body) => page.evaluate(async ([u, bd]) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bd) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [path, body]);

  await page.goto(`${WEB}/#/reports`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#rp-print:not([disabled])', { timeout: 20000 });

  console.log('=== A. Builder dokumen: slot logo bersama (invoice/laporan/rekap) ===');
  // Self-heal: buang logo sisa run yang mungkin tertinggal.
  await post('/api/settings/logo', { image: '' });
  const bersih0 = await get('/api/settings/logo');
  ok('self-heal: logo dikosongkan dulu (GET 204)', bersih0.status === 204, `status=${bersih0.status}`);

  const cek = await page.evaluate(async (origin) => {
    const m = await import('/src/invoice.ts');
    const toko = { store_name: 'Uji Logo A4', store_address: 'Jl. Uji 1', store_phone: '0812-000', store_email: 'uji@contoh.id' };
    const inv = m.htmlInvoice(
      {
        id: 'uji-a4-logo', invoice_no: '261019-000001', created_at: '2026-10-19 04:00:00',
        pay_method: 'tunai', subtotal: 10000, discount: 0, total: 10000, cash_in: 10000,
        change: 0, cashier: 'uji', customer_name: 'Pelanggan Umum', sisa_hutang: 0,
      },
      [{ name: 'Barang Uji', qty: 1, price: 10000, amount: 10000, discount: 0, unit: 'pcs', base_unit: 'pcs', note: '' }],
      toko,
    );
    const lap = m.htmlLaporan(
      {
        judul: 'LAPORAN UJI', periode: '19/10/2026 — 19/10/2026', meta: [['Kasir', 'uji']],
        kolom: [{ label: 'Uraian' }, { label: 'Nilai', kanan: true }],
        baris: [['Omzet', 'Rp10.000']], ringkas: [['Total', 'Rp10.000']],
      },
      toko,
    );
    const rek = m.htmlRekapShift(
      {
        id: 9001, cashier: 'uji', opened_at: '2026-10-19 00:00:00', closed_at: null,
        modal_awal: 100000, omzet: 0, tunai: 0, qris: 0, transfer: 0, n_sales: 0,
        n_topup: 0, topup_nominal: 0, topup_admin: 0, tarik_nominal: 0, tarik_admin: 0,
        diskon_total: 0, hutang_baru: 0, piutang_bayar: 0, n_expense: 0, expense_total: 0,
        n_retur: 0, retur_total: 0, n_purchase: 0, purchase_total: 0,
        n_kas_masuk: 0, kas_masuk_total: 0, order_masuk_total: 0, order_omzet_total: 0,
        inv_awal: null, inv_akhir: null,
      },
      toko, null,
    );
    const satu = (h) => {
      const tag = h.match(/<img class="logo-img"[^>]*>/)?.[0] ?? '';
      return {
        adaImg: !!tag,
        absolut: h.includes(`src="${origin}/api/settings/logo"`),
        fb: h.includes('<span class="logo-fb">R</span>'),
        onerr: tag.includes(`onerror="this.style.display='none'"`),
        css: h.includes('width: 84px'),
      };
    };
    return { inv: satu(inv), lap: satu(lap), rek: satu(rek) };
  }, WEB);
  const full = (x) => x.adaImg && x.absolut && x.fb && x.onerr && x.css;
  ok('builder htmlInvoice: img absolut + fallback "R" + onerror + slot 84px',
    full(cek.inv), JSON.stringify(cek.inv));
  ok('builder htmlLaporan: img absolut + fallback "R" + onerror + slot 84px',
    full(cek.lap), JSON.stringify(cek.lap));
  ok('builder htmlRekapShift: img absolut + fallback "R" + onerror + slot 84px',
    full(cek.rek), JSON.stringify(cek.rek));

  console.log('=== B. Popup laporan NYATA: logo termuat ===');
  const unggah = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#0f2858'; g.fillRect(0, 0, 160, 160);
    g.fillStyle = '#ffffff'; g.font = 'bold 90px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('R', 80, 88);
    const r = await fetch('/api/settings/logo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: c.toDataURL('image/png') }),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, nama: j.data?.store_logo ?? '' };
  });
  ok('unggah logo uji berhasil (200 + nama file)', unggah.status === 200 && !!unggah.nama,
    `${unggah.status} / ${unggah.nama}`);

  const [popAda] = await Promise.all([page.waitForEvent('popup'), page.click('#rp-print')]);
  await popAda.waitForLoadState('domcontentloaded');
  let b = null;
  for (let i = 0; i < 25; i++) {
    await popAda.waitForTimeout(200);
    b = await popAda.evaluate(() => {
      const img = document.querySelector('img.logo-img');
      return {
        natural: img?.naturalWidth ?? 0,
        fb: (document.querySelector('.logo-fb')?.textContent ?? '').trim(),
      };
    });
    if (b && b.natural > 0) break;
  }
  ok('popup laporan: logo TERMUAT (naturalWidth > 0 — src absolut terjangkau dari about:blank)',
    !!b && b.natural > 0, `natural=${b?.natural}`);
  ok('popup laporan: bulatan fallback "R" tetap ada di DOM (penutup saat tanpa logo)',
    !!b && b.fb === 'R', JSON.stringify(b));
  await popAda.close().catch(() => {});

  console.log('=== C. TANPA logo (204): img menyembunyikan diri, fallback tampil ===');
  const hapus = await post('/api/settings/logo', { image: '' });
  ok('hapus logo uji (200 — koreksi/bersih)', hapus.status === 200, `status=${hapus.status}`);
  const [popKosong] = await Promise.all([page.waitForEvent('popup'), page.click('#rp-print')]);
  await popKosong.waitForLoadState('domcontentloaded');
  let c = null;
  for (let i = 0; i < 25; i++) {
    await popKosong.waitForTimeout(200);
    c = await popKosong.evaluate(() => {
      const img = document.querySelector('img.logo-img');
      const fb = document.querySelector('.logo-fb');
      const g = fb ? getComputedStyle(fb) : null;
      return {
        displayImg: img ? getComputedStyle(img).display : 'hilang',
        displayFb: g ? g.display : 'hilang',
        radius: g ? g.borderRadius : '',
      };
    });
    if (c && c.displayImg === 'none') break;
  }
  ok('tanpa logo: img menyembunyikan diri otomatis (onerror → display none)',
    !!c && c.displayImg === 'none', JSON.stringify(c));
  ok('tanpa logo: bulatan fallback tetap TAMPIL (logo tidak pernah menyandera cetak)',
    !!c && c.displayFb !== 'none' && c.displayFb !== 'hilang' && c.radius === '50%', JSON.stringify(c));
  await popKosong.close().catch(() => {});

  console.log('=== D. Bersih + pantau error ===');
  const bersih1 = await get('/api/settings/logo');
  ok('cleanup: logo tetap kosong seusai suite (GET 204)', bersih1.status === 204, `status=${bersih1.status}`);
  ok('tanpa pageerror (halaman + popup)', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  gagal++;
  console.log('  GAGAL suite crash:', String(e).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
}
console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
process.exit(gagal === 0 ? 0 : 1);
