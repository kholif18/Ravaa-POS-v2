// UI halaman Pengaturan (#/settings) — redesign 2026-10-20 ala POS populer:
//   * nav seksi kiri yang menempel + menu chip di mobile,
//   * pencarian pengaturan client-side (SEMUA kata harus cocok) + Ctrl+K,
//   * chip ringkasan status (stok minus / kadaluarsa / cetak / backup),
//   * penanda "belum disimpan" pada form toko + draft yang selamat dari
//     repaint toggle lain,
//   * putaran 2: pratinjau struk live (nama toko device + gambar tersimpan)
//     dan tombol "Tes cetak" lewat print-agent (hormat "Jeda semua cetak").
//
// Suite ini READ-ONLY terhadap server settings: tidak pernah menekan
// "Simpan toko" / saklar / Pulihkan, jadi tidak mengubah data pemilik
// (satu-satunya tulis = preferensi localStorage device uji yang dipulihkan).
//
// Jalankan: node settings-ui-test.mjs   (butuh API :3001 + vite :5656 hidup)
import './bantuan-uji.mjs';
import { pasangToken } from './bantuan-uji.mjs';
import { chromium } from 'playwright-core';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';

let lolos = 0, gagal = 0;
const ok = (n, cond, info = '') => {
  if (cond) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${info}` : ''}`); }
};

const pengaturan = (await (await fetch(`${API}/api/settings`)).json()).data ?? {};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await pasangToken(page);
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

  await page.goto(`${WEB}/#/settings`, { waitUntil: 'load' });
  await page.waitForSelector('#set-kadaluarsa', { timeout: 10000 });
  await page.waitForTimeout(300);

  const urutanSeksi = ['transaksi', 'toko', 'perangkat', 'data'];
  const seksiTersembunyi = () => page.evaluate((ids) =>
    ids.map((id) => document.querySelector(`[data-set-sec="${id}"]`).hidden), urutanSeksi);

  console.log('=== A. Struktur & navigasi seksi ===');
  ok('menu pengaturan berisi 4 seksi', (await page.locator('[data-set-nav]').count()) === 4);
  ok('empat seksi isi dirender', (await page.locator('[data-set-sec]').count()) === 4);
  ok('kartu ditandai untuk pencarian (>= 6)',
    (await page.locator('[data-set-card]').count()) >= 6,
    `jumlah=${await page.locator('[data-set-card]').count()}`);
  // Revisi pemilik 2026-10-20: kartu judul di atas dihapus (judul sudah ada
  // di header shell) agar halaman tidak terasa "dua scroll"; pencarian tetap
  // hidup sebagai toolbar ramping.
  ok('tidak ada kartu judul di atas menu — pencarian ada di toolbar',
    await page.locator('#set-cari').evaluate((el) => !el.closest('.card')));

  await page.locator('[data-set-nav="data"]').click();
  await page.waitForTimeout(300);
  const navData = await page.evaluate(() => {
    const sec = document.querySelector('#set-sec-data');
    const btn = document.querySelector('[data-set-nav="data"]');
    const style = window.getComputedStyle(sec);
    return {
      visible: style.display !== 'none',
      aria: btn.getAttribute('aria-current'),
      display: [...document.querySelectorAll('[data-set-sec]')].map((s) => window.getComputedStyle(s).display),
    };
  });
  ok('klik menu Backup menampilkan seksi Data & menandainya aktif',
    navData.visible && navData.aria === 'true', JSON.stringify(navData));
  // Panel mode (2026-10-20): hanya seksi aktif yang tampil — bukan semua
  // seksi bertumpuk lalu disorot scroll-spy seperti desain awal.
  ok('panel mode: hanya seksi aktif yang ditampilkan',
    navData.display.filter((d) => d !== 'none').length === 1
    && navData.display[3] !== 'none',
    JSON.stringify(navData.display));

  console.log('=== B. Pencarian pengaturan (client-side) ===');
  await page.locator('#set-cari').fill('logo');
  await page.waitForTimeout(150);
  ok('cari "logo" menyisakan seksi Identitas toko saja',
    JSON.stringify(await seksiTersembunyi()) === JSON.stringify([true, false, true, true]),
    JSON.stringify(await seksiTersembunyi()));

  await page.locator('#set-cari').fill('alamat email');
  await page.waitForTimeout(150);
  ok('cari multi-kata "alamat email" juga hanya menyisakan Identitas toko',
    JSON.stringify(await seksiTersembunyi()) === JSON.stringify([true, false, true, true]),
    JSON.stringify(await seksiTersembunyi()));

  await page.locator('#set-cari').fill('zzzz');
  await page.waitForTimeout(150);
  ok('tanpa hasil: empty-state tampil & menu seksi ikut kosong',
    (await page.locator('#set-kosong').isVisible())
    && (await page.locator('[data-set-nav]:visible').count()) === 0);

  await page.locator('#set-cari').press('Escape');
  await page.waitForTimeout(150);
  ok('Esc di kolom cari mengembalikan semua seksi',
    (await page.locator('#set-cari').inputValue()) === ''
    && (await seksiTersembunyi()).every((h) => !h));

  await page.locator('#set-cari').fill('printer');
  await page.waitForTimeout(150);
  ok('filter kartu: hanya "Cetak struk" yang tampil di seksi Perangkat',
    (await page.locator('[data-set-card]:visible').count()) === 1,
    `tampil=${await page.locator('[data-set-card]:visible').count()}`);
  ok('tombol bersihkan muncul saat ada kata kunci',
    await page.locator('#set-cari-hapus').isVisible());
  await page.locator('#set-cari-hapus').click();
  await page.waitForTimeout(150);
  ok('tombol bersihkan mengosongkan kata kunci & memulihkan seksi',
    (await page.locator('#set-cari').inputValue()) === ''
    && (await seksiTersembunyi()).every((h) => !h));

  console.log('=== C. Chip ringkasan status ===');
  ok('empat chip ringkasan dirender', (await page.locator('#set-ringkas [data-set-chip]').count()) === 4);
  const nilaiMinus = await page.locator('[data-set-chip="minus"]').getAttribute('data-set-nilai');
  const nilaiKadaluarsa = await page.locator('[data-set-chip="kadaluarsa"]').getAttribute('data-set-nilai');
  ok('chip Stok minus & Kadaluarsa mencerminkan aturan server',
    nilaiMinus === (pengaturan.allow_negative_stock === true ? 'Aktif' : 'Nonaktif')
    && nilaiKadaluarsa === (pengaturan.tolak_jual_kadaluarsa === true ? 'Ditolak' : 'Boleh'),
    `minus=${nilaiMinus} kadaluarsa=${nilaiKadaluarsa}`);

  await page.locator('[data-set-chip="cetak"]').click();
  await page.waitForTimeout(300);
  const lompat = await page.evaluate(() => {
    const sec = document.querySelector('#set-sec-perangkat');
    const btn = document.querySelector('[data-set-nav="perangkat"]');
    const style = window.getComputedStyle(sec);
    return {
      visible: style.display !== 'none',
      aria: btn.getAttribute('aria-current'),
    };
  });
  ok('chip Cetak menampilkan seksi Perangkat & menandainya aktif',
    lompat.visible && lompat.aria === 'true', JSON.stringify(lompat));

  // Seksi Perangkat paling tinggi (banyak saklar); inilah kondisi yang dulu
  // memunculkan scrollbar KEDUA di <html> karena input sr-only absolut lolos
  // dari area gulir .page. Sekarang hanya `.page` yang boleh menggulir.
  const gulir = await page.evaluate(() => {
    const pageEl = document.getElementById('page');
    const nav = document.querySelector('#set-nav-host .card')?.getBoundingClientRect();
    const bar = document.querySelector('#set-cari')?.getBoundingClientRect();
    return {
      doc: document.documentElement.scrollHeight,
      vh: window.innerHeight,
      pageH: pageEl?.scrollHeight ?? 0,
      pageClient: pageEl?.clientHeight ?? 0,
      navX: Math.round(nav?.x ?? 0), navW: Math.round(nav?.width ?? 0),
      navTop: Math.round(nav?.y ?? 0),
      barX: Math.round(bar?.x ?? 0), barTop: Math.round(bar?.y ?? 0),
    };
  });
  // Revisi pemilik 2026-10-20: layout mengikuti halaman Laporan — menu seksi
  // di kolom kiri (sticky), pencarian + ringkasan status di atas isi kolom
  // kanan. Bukan toolbar selebar halaman di atas kedua kolom.
  ok('dua kolom ala halaman Laporan: menu kiri, toolbar + isi di kanan',
    gulir.barX >= gulir.navX + gulir.navW && gulir.barTop <= gulir.navTop + 2,
    JSON.stringify(gulir));
  ok('hanya area konten yang menggulir (tanpa scrollbar ganda)',
    gulir.doc <= gulir.vh && gulir.pageH > gulir.pageClient,
    JSON.stringify(gulir));

  // Kartu menu kiri memakai `lg:sticky lg:top-0` di dalam <aside> yang mengisi
  // tinggi baris grid (pola reports.ts): saat halaman digulir, menu tetap di
  // posisinya sementara toolbar kanan ikut naik.
  await page.locator('#page').evaluate((el) => { el.scrollTop = 400; });
  await page.waitForTimeout(150);
  const sticky = await page.evaluate(() => {
    const nav = document.querySelector('#set-nav-host .card')?.getBoundingClientRect();
    const bar = document.querySelector('#set-cari')?.getBoundingClientRect();
    return { navTop: Math.round(nav?.y ?? 0), barTop: Math.round(bar?.y ?? 0) };
  });
  ok('menu seksi kiri menempel saat halaman digulir',
    sticky.navTop === gulir.navTop && sticky.barTop < gulir.barTop,
    `${JSON.stringify(gulir)} -> ${JSON.stringify(sticky)}`);
  await page.locator('#page').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(150);

  console.log('=== D. Form toko: status simpan & draft ===');
  // Panel mode: form toko ada di seksi Identitas toko — tampilkan dulu.
  await page.locator('[data-set-nav="toko"]').click();
  await page.waitForTimeout(200);
  const namaAwal = await page.locator('#set-toko-nama').inputValue();
  ok('awalnya bersih: status tersimpan & tombol simpan mati',
    (await page.locator('#set-toko-status').innerText()).includes('tersimpan')
    && (await page.locator('#set-toko-simpan').isDisabled()));

  await page.locator('#set-toko-nama').fill(`${namaAwal} UJI`);
  ok('ketikan menyalakan "belum disimpan" & tombol simpan hidup',
    (await page.locator('#set-toko-status').innerText()).includes('belum disimpan')
    && !(await page.locator('#set-toko-simpan').isDisabled()));

  // Toggle cetak ada di seksi Perangkat — tampilkan dulu (panel mode).
  await page.locator('[data-set-nav="perangkat"]').click();
  await page.waitForTimeout(200);
  const cetakAwal = await page.locator('#set-cetak').isChecked();
  await page.locator('label[for="set-cetak"]').click();
  await page.waitForTimeout(400);
  ok('draft toko selamat dari repaint toggle cetak',
    (await page.locator('#set-toko-nama').inputValue()).endsWith('UJI'));
  await page.locator('label[for="set-cetak"]').click();
  await page.waitForTimeout(400);
  ok('preferensi cetak kembali ke kondisi semula',
    (await page.locator('#set-cetak').isChecked()) === cetakAwal);

  await page.locator('[data-set-nav="toko"]').click();
  await page.waitForTimeout(200);
  await page.locator('#set-toko-nama').fill(namaAwal);
  ok('dikembalikan ke nilai server: status bersih lagi (tanpa menulis)',
    (await page.locator('#set-toko-status').innerText()).includes('tersimpan')
    && (await page.locator('#set-toko-simpan').isDisabled()));

  console.log('=== E. Kartu Dokumen & struk (riset Aronium 2026-10-20) ===');
  const idDok = ['set-dok-form', 'set-dok-judul', 'set-dok-footer-a4', 'set-dok-footer-struk',
    'set-dok-cust-name', 'set-dok-cust-address', 'set-dok-cust-phone',
    'set-dok-item', 'set-dok-nomor', 'set-dok-hutang', 'set-dok-simpan'];
  ok('kartu dokumen & struk merender semua kontrolnya',
    (await page.locator('#set-dok-form').count()) === 1
    && await page.evaluate((list) => list.every((id) => !!document.getElementById(id)), idDok),
    `form=${await page.locator('#set-dok-form').count()}`);

  // Revisi pemilik 2026-10-20: kartu ini milik pengaturan cetak/pratinjau,
  // jadi tinggal di seksi Perangkat & cetak (bukan Identitas toko).
  ok('kartu dokumen berada di seksi Perangkat & cetak, bukan Identitas toko',
    (await page.locator('#set-sec-perangkat #set-dok-form').count()) === 1
    && (await page.locator('#set-sec-toko #set-dok-form').count()) === 0);

  const dokAwal = await page.evaluate(() => ({
    judul: document.querySelector('#set-dok-judul').value,
    footerA4: document.querySelector('#set-dok-footer-a4').value,
    footerStruk: document.querySelector('#set-dok-footer-struk').value,
    nama: document.querySelector('#set-dok-cust-name').checked,
    alamat: document.querySelector('#set-dok-cust-address').checked,
    item: document.querySelector('#set-dok-item').checked,
    nomor: document.querySelector('#set-dok-nomor').checked,
    hutang: document.querySelector('#set-dok-hutang').checked,
  }));
  ok('nilai awal kartu = pengaturan server',
    dokAwal.judul === (pengaturan.invoice_title ?? 'INVOICE')
    && dokAwal.footerA4 === (pengaturan.invoice_footer ?? '')
    && dokAwal.footerStruk === (pengaturan.receipt_footer ?? 'Terima kasih sudah berbelanja')
    && dokAwal.nama === (pengaturan.receipt_customer ?? 'name').split(',').includes('name')
    && dokAwal.alamat === (pengaturan.receipt_customer ?? 'name').split(',').includes('address')
    && dokAwal.item === (pengaturan.receipt_show_items !== false)
    && dokAwal.nomor === (pengaturan.receipt_short_no === true)
    && dokAwal.hutang === (pengaturan.receipt_show_debt !== false),
    JSON.stringify(dokAwal));

  // Draft lokal (TIDAK disimpan — suite tetap read-only): ubah footer, matikan
  // jumlah item, nyalakan nomor pendek, dan pilih alamat pelanggan.
  // Panel mode: kartu ada di seksi Perangkat — tampilkan dulu.
  await page.locator('[data-set-nav="perangkat"]').click();
  await page.waitForTimeout(200);
  await page.locator('#set-dok-footer-struk').fill('UJI footer struk');
  await page.locator('label[for="set-dok-item"]').click();
  await page.locator('label[for="set-dok-nomor"]').click();
  await page.locator('#set-dok-cust-address').check();
  await page.waitForTimeout(200);
  ok('draft dokumen menyalakan "belum disimpan" & tombol simpan',
    (await page.locator('#set-dok-status').innerText()).includes('belum disimpan')
    && !(await page.locator('#set-dok-simpan').isDisabled()));

  // Pratinjau ada di seksi Perangkat; panel mode mengharuskan seksi itu aktif.
  await page.locator('[data-set-nav="perangkat"]').click();
  await page.waitForTimeout(200);
  const teksDok = await page.locator('#set-preview-struk').innerText();
  ok('pratinjau mengikuti draft: footer, nomor pendek, alamat, tanpa jumlah item',
    teksDok.includes('UJI footer struk')
    && teksDok.includes('No. 000012')
    && teksDok.includes('Alamat:')
    && !teksDok.includes('Jumlah item'),
    teksDok.replace(/\n/g, ' / ').slice(0, 120));

  // Reload penuh = buang draft; nilai server kembali (tanpa POST).
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#set-dok-form', { state: 'attached', timeout: 10000 });
  await page.locator('[data-set-nav="perangkat"]').click();
  await page.waitForTimeout(200);
  const dokPulih = await page.evaluate(() => ({
    footer: document.querySelector('#set-dok-footer-struk').value,
    item: document.querySelector('#set-dok-item').checked,
    nomor: document.querySelector('#set-dok-nomor').checked,
    alamat: document.querySelector('#set-dok-cust-address').checked,
    status: document.querySelector('#set-dok-status').textContent,
  }));
  ok('reload membuang draft & memulihkan nilai server',
    dokPulih.footer === (pengaturan.receipt_footer ?? 'Terima kasih sudah berbelanja')
    && dokPulih.item === (pengaturan.receipt_show_items !== false)
    && dokPulih.nomor === (pengaturan.receipt_short_no === true)
    && dokPulih.alamat === (pengaturan.receipt_customer ?? 'name').split(',').includes('address')
    && (dokPulih.status ?? '').includes('tersimpan'),
    JSON.stringify(dokPulih));

  console.log('=== F. Pratinjau struk (riset putaran 2) ===');
  await page.locator('[data-set-nav="perangkat"]').click();
  await page.waitForTimeout(200);
  const namaDevice = await page.locator('#set-dev-toko').innerText();
  const teksPreview = await page.locator('#set-preview-struk').innerText();
  ok('pratinjau struk dirender & memuat nama toko dari Identitas toko',
    (await page.locator('#set-preview-struk').isVisible())
    && teksPreview.includes('Contoh barang')
    && teksPreview.includes(namaDevice || 'RAVA POS'),
    `teks=${teksPreview.replace(/\n/g, ' / ').slice(0, 90)}`);

  // Nama toko kini mengikuti Identitas toko (server), tidak ada input per-device untuk diisi
  ok('nama toko di kartu perangkat menjadi teks statis, tidak bisa diisi ulang',
    (await page.locator('#set-dev-toko input').count()) === 0);

  const jmlGambarPreview = await page.locator('#set-preview-struk img').count();
  ok('slot gambar pratinjau mengikuti logo tersimpan di server',
    jmlGambarPreview === (pengaturan.store_logo ? 1 : 0),
    `img=${jmlGambarPreview} store_logo=${JSON.stringify(pengaturan.store_logo)}`);

  console.log('=== G. Tombol Tes cetak (riset putaran 2) ===');
  ok('tombol Tes cetak dirender di kartu Cetak struk',
    (await page.locator('#set-tes-cetak').count()) === 1);

  const permintaanPrint = [];
  await page.route('**/print', async (route) => {
    try { permintaanPrint.push(route.request().postDataJSON()); } catch { permintaanPrint.push({}); }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"via":"uji"}' });
  });
  const pauseAwal = await page.evaluate(() => localStorage.getItem('ravaa.printpause'));

  // G1: jeda aktif (bawaan) -> ditolak dengan toast, NOL request (kertas aman).
  await page.evaluate(() => localStorage.setItem('ravaa.printpause', '1'));
  await page.locator('#set-tes-cetak').click();
  await page.waitForTimeout(300);
  const teksToast = await page.evaluate(() =>
    [...document.querySelectorAll('#toast-root .toast')].map((t) => t.textContent ?? '').join(' | '));
  ok('jeda aktif: tes cetak ditolak & nol request ke print-agent',
    permintaanPrint.length === 0 && teksToast.includes('Jeda'),
    `req=${permintaanPrint.length} toast=${teksToast.slice(0, 80)}`);

  // G2: jeda mati -> payload struk contoh benar-benar terkirim.
  await page.evaluate(() => localStorage.setItem('ravaa.printpause', '0'));
  await page.locator('#set-tes-cetak').click();
  for (let i = 0; i < 25 && permintaanPrint.length === 0; i++) await page.waitForTimeout(100);
  const isiPrint = permintaanPrint.length
    ? Buffer.from(String(permintaanPrint[0].data_base64 ?? ''), 'base64').toString('latin1') : '';
  ok('tes cetak mengirim struk contoh ke print-agent (memuat "TES CETAK")',
    permintaanPrint.length === 1 && isiPrint.includes('TES CETAK'),
    `req=${permintaanPrint.length} isi=${isiPrint.slice(0, 60)}`);

  // Kembalikan preferensi jeda device ke kondisi awal.
  await page.evaluate((v) => {
    if (v === null) localStorage.removeItem('ravaa.printpause');
    else localStorage.setItem('ravaa.printpause', v);
  }, pauseAwal);

  console.log('=== G2. Preferensi perangkat: print-agent & kick laci ===');
  // Hardware tiap PC kasir bisa beda: agent mungkin tidak jalan di localhost
  // dan sebagian printer tidak tersambung ke laci. Keduanya preferensi device
  // (localStorage), bukan settings server — diuji tulis + dipulihkan.
  ok('alamat print-agent + tombol simpan + saklar kick laci dirender',
    (await page.locator('#set-agent').count()) === 1
    && (await page.locator('#set-agent-simpan').count()) === 1
    && (await page.locator('#set-laci').count()) === 1);

  const prefAwal = await page.evaluate(() => ({
    agent: localStorage.getItem('ravaa.printagent') || 'http://localhost:9100',
    laci: localStorage.getItem('ravaa.lacikick') !== '0',
    laciBytes: localStorage.getItem('ravaa.lacibytes'),
  }));
  const agentAwal = await page.locator('#set-agent').inputValue();
  const laciAwal = await page.locator('#set-laci').isChecked();
  ok('nilai awal agent & kick laci mengikuti preferensi device',
    agentAwal === prefAwal.agent.replace(/\/+$/, '') && laciAwal === prefAwal.laci,
    `agent=${agentAwal} laci=${laciAwal} pref=${JSON.stringify(prefAwal)}`);

  await page.locator('#set-agent').fill('http://192.168.1.10:9100');
  await page.locator('#set-agent-simpan').click();
  await page.waitForTimeout(250);
  const agentTersimpan = await page.evaluate(() => localStorage.getItem('ravaa.printagent'));
  ok('Simpan alamat print-agent menulis preferensi device',
    agentTersimpan === 'http://192.168.1.10:9100', String(agentTersimpan));
  // Pulihkan alamat awal (default = kunci dihapus oleh setAgentUrl).
  await page.locator('#set-agent').fill(agentAwal);
  await page.locator('#set-agent-simpan').click();
  await page.waitForTimeout(250);

  await page.locator('label[for="set-laci"]').click();
  await page.waitForTimeout(350);
  const laciTersimpan = await page.evaluate(() => localStorage.getItem('ravaa.lacikick'));
  ok('saklar kick laci menulis preferensi device',
    laciTersimpan === (laciAwal ? '0' : '1'), `laci=${laciTersimpan}`);
  // Pulihkan kondisi awal supaya suite tidak meninggalkan perubahan device.
  await page.locator('label[for="set-laci"]').click();
  await page.waitForTimeout(350);

  // Perintah kick laci hex (Paket A, 2026-10-20): bawaan Epson dapat diganti
  // per device. Semua nilai device uji dipulihkan di akhir suite.
  ok('input perintah kick laci + tombol simpan dirender dengan bawaan Epson',
    (await page.locator('#set-laci-bytes').count()) === 1
    && (await page.locator('#set-laci-bytes-simpan').count()) === 1
    && (await page.locator('#set-laci-bytes').inputValue()) === '1B 70 00 19 FA',
    `nilai=${await page.locator('#set-laci-bytes').inputValue()}`);

  await page.locator('#set-laci-bytes').fill('ZZ 70');
  await page.locator('#set-laci-bytes-simpan').click();
  await page.waitForTimeout(300);
  const toastsHex = await page.evaluate(() =>
    [...document.querySelectorAll('#toast-root .toast')].map((t) => t.textContent ?? '').join(' | '));
  ok('hex tidak valid ditolak: preferensi TIDAK berubah',
    (await page.evaluate(() => localStorage.getItem('ravaa.lacibytes'))) === prefAwal.laciBytes
    && /tidak valid/i.test(toastsHex),
    toastsHex.slice(0, 100));

  await page.locator('#set-laci-bytes').fill('0x1b, 0x70, 0x01, 0x19, 0xfa');
  await page.locator('#set-laci-bytes-simpan').click();
  await page.waitForTimeout(300);
  ok('hex valid disimpan ternormalisasi (huruf besar, spasi)',
    (await page.evaluate(() => localStorage.getItem('ravaa.lacibytes'))) === '1B 70 01 19 FA'
    && (await page.locator('#set-laci-bytes').inputValue()) === '1B 70 01 19 FA',
    String(await page.evaluate(() => localStorage.getItem('ravaa.lacibytes'))));

  await page.locator('#set-laci-bytes').fill('');
  await page.locator('#set-laci-bytes-simpan').click();
  await page.waitForTimeout(300);
  ok('kosong = hapus preferensi & kembali ke perintah Epson bawaan',
    (await page.evaluate(() => localStorage.getItem('ravaa.lacibytes'))) === null
    && (await page.locator('#set-laci-bytes').inputValue()) === '1B 70 00 19 FA');
  // Pulihkan nilai device semula (suite tidak boleh meninggalkan perubahan).
  await page.evaluate((v) => {
    if (v === null) localStorage.removeItem('ravaa.lacibytes');
    else localStorage.setItem('ravaa.lacibytes', v);
  }, prefAwal.laciBytes);

  console.log('=== H. Pintasan Ctrl+K (riset putaran 2) ===');
  ok('hint kbd "Ctrl K" tampil di toolbar pencarian',
    (await page.locator('kbd.kbd').count()) >= 1
    && (await page.locator('kbd.kbd').first().innerText()).trim() === 'Ctrl K');

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Control+KeyK');
  await page.waitForTimeout(120);
  ok('Ctrl+K memfokuskan kolom pencarian pengaturan',
    await page.evaluate(() => document.activeElement?.id === 'set-cari'));

  console.log('=== I. Kontrak id lama + kebersihan console ===');
  const ids = ['set-minus', 'set-kadaluarsa', 'set-toko-nama', 'set-toko-telepon',
    'set-toko-alamat', 'set-toko-email', 'set-toko-simpan', 'set-logo-wadah',
    'set-logo-file', 'set-logo-hapus', 'set-dev-toko', 'set-dev-theme',
    'set-dev-simpan', 'set-pause', 'set-cetak', 'set-layout', 'set-backup',
    'set-laci-bytes', 'set-laci-bytes-simpan'];
  ok('semua id kontrak lama tetap ada',
    await page.evaluate((list) => list.every((id) => !!document.getElementById(id)), ids));
  ok('tanpa error console', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('=== J. Listener Ctrl+K dilepas saat keluar halaman ===');
  await page.goto(`${WEB}/#/dashboard`, { waitUntil: 'load' });
  await page.waitForSelector('#set-cari', { state: 'detached', timeout: 10000 });
  const ctrlKDitahan = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  ok('Ctrl+K tidak lagi ditahan setelah keluar dari halaman Pengaturan', ctrlKDitahan === false);
} catch (e) {
  gagal++;
  console.log('  CRASH', String(e.message || e).slice(0, 400));
} finally {
  await browser.close();
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})  [settings-ui-test.mjs]`);
if (gagal) process.exit(1);
