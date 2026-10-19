// Halaman Pengaturan (#/settings) — aturan yang berlaku untuk SEMUA device.
//
// Bedanya dengan "Pengaturan Akun" (ui/user.ts): yang di sana disimpan per
// browser lewat localStorage (nama kasir, nama toko, tema); yang di sini
// disimpan di SERVER lewat POST /api/settings, jadi satu perubahan langsung
// dipakai kasir di HP maupun di PC. Karena itu aturan yang menyangkut data
// (stok, harga, dsb) tidak boleh disimpan di localStorage — dua device bisa
// berbeda pendapat dan penjualan jadi tidak konsisten.
//
// PENGECUALIAN SATU-SATUNYA: kartu "Cetak struk" — sifatnya justru per-device
// (printer tiap PC kasir beda: thermal 58mm, Epson L3110, atau tanpa printer),
// jadi disimpan lewat ui/print-pref.ts di localStorage browser ini.

import { apiGet, apiPost, HttpError } from '../api';
import { confirmDialog } from '../ui/confirm';
import { icon, type IconName } from '../ui/icons';
import { getToko, setToko } from '../ui/user';
import { getAutoPrint, getPrintPause, getStrukLayout, setAutoPrint, setPrintPause, setStrukLayout, type LayoutStruk } from '../ui/print-pref';
import { switchHtml } from '../ui/switch';
import { toast } from '../ui/toast';
import { waktu } from '../ui/waktu';
import { LEBAR_LOGO, resetLogoStrukCache } from '../logo-struk';

type Settings = {
  allow_negative_stock: boolean; tolak_jual_kadaluarsa: boolean;
  store_name: string; store_address: string; store_phone: string; store_email: string;
  /** NAMA file logo di img/ ('' = tanpa logo) — butir ROADMAP 1.6.4. */
  store_logo: string;
};
type BarisBackup = { nama: string; ukuran: number; waktu: string };

const state = {
  loading: true, error: '', minus: false, kadaluarsa: false,
  backups: [] as BarisBackup[], backupErr: '', backupJalan: false,
  toko: { store_name: '', store_address: '', store_phone: '', store_email: '' },
  tokoJalan: false,
  /** Nama file logo struk thermal ('' = belum ada). */
  logo: '',
};

let host: HTMLElement | null = null;

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

// Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
// halaman Stok & Produk.
function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div>
        <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Pengaturan</h2>
        <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
          Aturan <b>server</b> berlaku untuk semua device kasir; preferensi
          <b>perangkat</b> (tema & cetak) hanya menempel di browser ini.
        </p>
      </div>
    </div>
    <div id="set-body"></div>
  </div>`;
}

function renderBody(): string {
  if (state.loading) return `<div class="card"><div class="skel h-6 w-56"></div></div>`;
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat pengaturan: ${esc(state.error)}</span></div></div>`;
  }

  const isiMinus = state.minus
    ? `Penjualan tetap jalan walaupun stok sudah habis — angka stok boleh menembus
       nol (minus) sampai barang diisi ulang. Cocok kalau hitungan fisik dan sistem
       sering selisih, dan tidak ada lagi pesan "stok kurang" yang menghentikan
       transaksi di meja kasir.`
    : `Begitu jumlah terjual melebihi sisa stok, penjualan <b>ditolak</b> dengan pesan
       "stok kurang: ... (butuh X, sisa Y)". Ini perilaku bawaan dan paling aman
       untuk menjaga stok tercatat sama persis dengan isi rak.`;

  const isiKadaluarsa = state.kadaluarsa
    ? `Baris jual yang tanggal kadaluarsanya sudah lewat <b>ditolak server</b> dengan
       pesan "barang kadaluarsa: ..." — bukan sekadar strip peringatan. Hari kadaluarsa
       sendiri masih boleh dijual. Aktifkan untuk kategori yang pakai tanggal
       kadaluarsa (snack, es krim).`
    : `Barang lewat tanggal kadaluarsa masih <b>boleh terjual</b> — layar kasir hanya
       menampilkan strip & badge peringatan. Matikan/menyalakan aturan ini tidak
       menghapus tanggal yang sudah tercatat di produk.`;

  // Sengaja TANPA badge status di sebelah judul: label saklarnya sendiri sudah
  // membaca "Aktif"/"Nonaktif", jadi badge hanya mengulang teks yang sama.
  // Status = posisi saklar; keterangan = paragraf di atas footer.
  // Kartu dikelompokkan per CAKUPAN lewat kepalaSeksi: "berlaku semua device"
  // (server) vs "tersimpan di browser ini" — konsep paling penting halaman ini.
  return `
  <div class="space-y-4">
    <section class="space-y-2">
      ${kepalaSeksi('Aturan transaksi', 'berlaku semua device')}
      <div class="grid items-stretch gap-3 lg:grid-cols-2">
        ${kartuSaklar({
          input: 'set-minus', judul: 'Stok boleh minus', isi: isiMinus,
          aktif: state.minus, label: state.minus ? 'Aktif' : 'Nonaktif',
          ikon: 'stock', tile: 'bg-primary-soft text-primary dark:bg-primary/15',
        })}
        ${kartuSaklar({
          input: 'set-kadaluarsa', judul: 'Tolak jual kadaluarsa', isi: isiKadaluarsa,
          aktif: state.kadaluarsa, label: state.kadaluarsa ? 'Aktif' : 'Nonaktif',
          ikon: 'calendar', tile: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
        })}
      </div>
    </section>
    <section class="space-y-2">
      ${kepalaSeksi('Identitas toko', 'berlaku semua device')}
      ${kartuToko()}
    </section>
    <section class="space-y-2">
      ${kepalaSeksi('Perangkat ini', 'tersimpan di browser ini')}
      <div class="grid items-stretch gap-3 xl:grid-cols-2">
        ${kartuPerangkat()}
        ${kartuCetak()}
      </div>
    </section>
    <section class="space-y-2">
      ${kepalaSeksi('Backup & pemulihan', 'di server')}
      ${kartuBackup()}
    </section>
  </div>`;
}

// Kepala kelompok kartu: label kecil uppercase + garis + keterangan cakupan
// di kanan. Quiet (11px abu) supaya tidak bersaing dengan judul kartunya.
function kepalaSeksi(judul: string, cakupan: string): string {
  return `
  <div class="flex items-center gap-2 px-0.5">
    <p class="form-sec">${judul}</p>
    <span class="h-px flex-1 bg-gray-200 dark:bg-gray-700" aria-hidden="true"></span>
    <span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">${cakupan}</span>
  </div>`;
}

// Kartu saklar aturan transaksi: ikon + judul + deskripsi, lalu footer
// pemisah berisi keterangan singkat (kiri) & saklar (kanan) — pola baris
// pengaturan yang seragam dengan kartu-kartu di bawahnya.
function kartuSaklar(opt: {
  input: string; judul: string; isi: string; aktif: boolean; label: string;
  ikon: IconName; tile: string;
}): string {
  return `
  <div class="card flex flex-col">
    <div class="flex flex-1 items-start gap-3">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-xl ${opt.tile} [&>svg]:size-4">${icon(opt.ikon)}</span>
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">${opt.judul}</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${opt.isi}</p>
      </div>
    </div>
    <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-2.5 dark:border-gray-700/60">
      <span class="text-xs text-gray-400 dark:text-gray-500">Dibaca server pada setiap penjualan</span>
      ${switchHtml(opt.input, opt.aktif, opt.label)}
    </div>
  </div>`;
}

// Kartu "Tampilan perangkat" (2026-10-11, pindahan dari halaman Profil —
// nama toko kepala struk + tema). Per-device localStorage, tanpa API.
function kartuPerangkat(): string {
  const toko = getToko();
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  return `
    <div class="card flex flex-col">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('smartphone')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Tampilan perangkat ini</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Nama toko di <b>kepala struk thermal</b> + tema warna. Tersimpan di
            <b>browser device ini</b> — device lain tidak ikut berubah (beda
            dengan kop INVOICE A4 di atas yang berlaku semua device).
          </p>
        </div>
      </div>
      <div class="mt-3 grid flex-1 gap-2 sm:grid-cols-2">
        <div class="field-sm">
          <label class="label" for="set-dev-toko">Nama toko (struk thermal)</label>
          <input id="set-dev-toko" class="input input-sm" maxlength="32" value="${getToko() === 'RAVA POS' ? '' : getToko()}" placeholder="RAVA POS" />
        </div>
        <div class="field-sm">
          <label class="label" for="set-dev-theme">Tema</label>
          <select id="set-dev-theme" class="input input-sm">
            <option value="light" ${theme === 'light' ? 'selected' : ''}>Terang</option>
            <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Gelap</option>
          </select>
        </div>
      </div>
      <div class="mt-3 flex justify-end">
        <button type="button" id="set-dev-simpan" class="btn btn-primary">${icon('check')}<span>Simpan tampilan</span></button>
      </div>
    </div>`;
}

// Kartu "Pengaturan toko" — kop INVOICE A4 (cetak gaya Aronium). Disimpan di
// SERVER (4 kunci store_* di tabel settings) supaya semua device mencetak kop
// yang sama; nilai awal di-seed dari contoh pemilik. Form biasa + tombol
// Simpan, tanpa konfirmasi swal (non-destruktif seperti Backup).
//
// Sejak butir ROADMAP 1.6.4 (2026-10-19) kartu ini juga memuat unggah LOGO
// STRUK THERMAL: file disimpan di img/ (endpoint POST /api/settings/logo —
// hanya owner), tercetak di awal struk thermal semua jalur cetak. Unggah/hapus
// TIDAK mem-paint ulang form — isian store_* yang belum disimpan tidak boleh
// hilang karena render ulang (pola avatar di halaman Profil).
function logoHtml(): string {
  return state.logo
    ? `<img id="set-logo-img" src="/api/settings/logo?${esc(state.logo)}" alt="Logo toko" class="max-h-16 max-w-full object-contain" />`
    : `<span class="px-2 text-center text-xs text-gray-400 dark:text-gray-500">Belum ada logo</span>`;
}

/** Repaint parsial baris logo (bukan `paint()`): pertahankan ketikan form. */
function tampilLogo(): void {
  const wadah = host?.querySelector('#set-logo-wadah');
  if (wadah) wadah.innerHTML = logoHtml();
  host?.querySelector('#set-logo-hapus')?.classList.toggle('hidden', !state.logo);
  const lbl = host?.querySelector('#set-logo-label');
  if (lbl) lbl.textContent = state.logo ? 'Ganti logo' : 'Unggah logo';
}

/** Baca berkas logo → PNG skala maksimal LEBAR_LOGO (384px, lebar printer
 *  thermal) sebagai dataURL. PNG (bukan JPEG): tepi garis harus tajam karena
 *  raster struk memakai ambang luminance — derau JPEG berubah jadi bercak dot. */
async function kecilkanLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gambar tidak bisa dibaca'));
      i.src = url;
    });
    const skala = Math.min(1, LEBAR_LOGO / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * skala));
    const h = Math.max(1, Math.round(img.naturalHeight * skala));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('canvas tidak tersedia');
    ctx.fillStyle = '#fff'; // PNG transparan → latar putih, bukan hitam
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function kartuToko(): string {
  const t = state.toko;
  const f = (id: string, label: string, nilai: string, opsional?: boolean, lebar?: boolean) => `
    <div class="field-sm${lebar ? ' sm:col-span-2' : ''}">
      <label class="label" for="${id}">${label}${opsional ? ' <span class="font-normal">(opsional)</span>' : ''}</label>
      <input class="input" id="${id}" value="${esc(nilai)}" maxlength="300" autocomplete="off">
    </div>`;
  return `
    <div class="card">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('receipt')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pengaturan toko</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Kop <b>INVOICE A4</b> (cetak gaya Aronium) memakai empat isian ini,
            dan <b>logo</b> di bawah tercetak di awal <b>struk thermal</b>.
            Disimpan di <b>server</b>, jadi seluruh device mencetak yang sama.
          </p>
        </div>
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        ${f('set-toko-nama', 'Nama toko', t.store_name)}
        ${f('set-toko-telepon', 'Phone', t.store_phone, true)}
        ${f('set-toko-alamat', 'Alamat', t.store_address, true, true)}
        ${f('set-toko-email', 'Email', t.store_email, true)}
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-gray-100 p-3 dark:border-gray-700/60">
        <div id="set-logo-wadah" class="flex h-16 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800">
          ${logoHtml()}
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-gray-900 dark:text-white">Logo struk thermal</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Tercetak hitam-putih di awal struk (lebar maks ${LEBAR_LOGO}px — gambar diskalakan otomatis).
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <label class="btn btn-ghost btn-sm relative" for="set-logo-file">
            ${icon('upload')}<span id="set-logo-label">${state.logo ? 'Ganti logo' : 'Unggah logo'}</span>
            <input id="set-logo-file" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" />
          </label>
          <button type="button" id="set-logo-hapus" class="btn btn-ghost btn-sm !text-red-600 dark:!text-red-400 ${state.logo ? '' : 'hidden'}">${icon('trash')}<span>Hapus</span></button>
        </div>
      </div>
      <div class="mt-3 flex justify-end">
        <button type="button" id="set-toko-simpan" class="btn btn-primary" ${state.tokoJalan ? 'disabled' : ''}>
          ${icon('check')}<span>${state.tokoJalan ? 'Menyimpan…' : 'Simpan toko'}</span>
        </button>
      </div>
    </div>`;
}

// Kartu "Cetak struk" — preferensi PER DEVICE (localStorage lewat
// ui/print-pref.ts), BUKAN POST /api/settings: printer tiap PC kasir beda
// (thermal 58mm vs Epson L3110 vs HP tanpa printer), jadi menyimpannya
// di server justru memaksa semua device ikut. Tanpa konfirmasi swal —
// non-destruktif dan langsung bisa dibalik (alasan sama dengan kartu Backup).
function kartuCetak(): string {
  const nyala = getAutoPrint();
  const layout = getStrukLayout();
  const jeda = getPrintPause();
  const isiSaklar = nyala
    ? `Setiap penjualan selesai, dialog menawarkan <b>[Thermal] [A4] [Tidak]</b> —
        kasir memilih kertas per transaksi. Topup/tarik langsung dicetak sesuai
        layout. Cetak gagal tidak pernah membatalkan penjualan.`
    : `Dialog cetak <b>tidak</b> muncul otomatis. Cetak ulang (Thermal/A4) tetap
        bisa lewat menu Riwayat transaksi — nyalakan lagi kalau device ini sudah
        terpasang printer.`;
  const isiLayout = layout === 'a4'
    ? `<b>Epson L3110 (A4)</b> — 64 kolom, tanpa potong, ditutup eject supaya
        kertas keluar. Dipakai struk topup/tarik via print-agent.`
    : `<b>Thermal 58mm</b> — 32 kolom, diakhiri potong kertas. Dipakai struk
        topup/tarik via print-agent.`;
  const isiJeda = jeda
    ? `JEDA <b>AKTIF</b> — semua kirim ke printer (struk, label, kick laci)
        ditahan; nol kertas terbuang. Invoice A4 lewat browser tetap bisa dicetak.`
    : `Nonaktif — struk, label harga, dan kick laci mengirim ke printer seperti biasa.`;
  return `
    <div class="card flex flex-col">
      <div class="flex items-start gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400 [&>svg]:size-4">${icon('print')}</span>
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Cetak struk</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Preferensi <b>device ini</b> — printer tiap PC kasir bisa berbeda
            (thermal 58mm, Epson L3110, atau tanpa printer), jadi tidak ikut ke kasir lain.
          </p>
        </div>
      </div>
      <div class="mt-2 flex-1 divide-y divide-gray-100 dark:divide-gray-700/60">
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Jeda semua cetak</p>
            <p class="mt-0.5 text-xs ${jeda ? 'font-medium text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}">${isiJeda}</p>
          </div>
          <div class="shrink-0">${switchHtml('set-pause', !jeda, jeda ? 'Dijeda' : 'Cetak ON')}</div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Cetak otomatis setelah bayar</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${isiSaklar}</p>
          </div>
          <div class="shrink-0">${switchHtml('set-cetak', nyala, nyala ? 'Aktif' : 'Nonaktif')}</div>
        </div>
        <div class="flex items-start justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">Layout struk</p>
            <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${isiLayout}</p>
          </div>
          <select id="set-layout" class="input input-sm !w-auto shrink-0" aria-label="Layout struk">
            <option value="thermal"${layout === 'thermal' ? ' selected' : ''}>Thermal 58mm</option>
            <option value="a4"${layout === 'a4' ? ' selected' : ''}>Epson L3110 (A4)</option>
          </select>
        </div>
      </div>
    </div>`;
}

// Format ukuran file: 12 KB / 3,4 MB (id-ID).
function ukuranFile(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
}

// Kartu Backup (fitur 1.2): tombol backup manual + daftar file terakhir +
// unduh. BUKAN kartu saklar — tidak ada konfirmasi swal (backup non-destruktif,
// boleh diklik berulang), pola tetap kartu + tombol .btn yang sudah ada.
function kartuBackup(): string {
  const daftar = state.backups.length
    ? `<ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-700" data-backup-list>
        ${state.backups.map((b) => `
        <li class="flex flex-wrap items-center justify-between gap-2 py-2" data-nama="${esc(b.nama)}">
          <div class="min-w-0">
            <div class="truncate text-sm text-gray-700 dark:text-gray-300">${esc(b.nama)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">${waktu(b.waktu)} · ${ukuranFile(b.ukuran)}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <!-- Pulihkan (2026-10-16): server verifikasi integritas -> backup
                 pengaman -> ganti DB. Tombol disabilitas saat backup jalan. -->
            <button type="button" data-restore="${esc(b.nama)}" class="btn btn-ghost btn-sm !text-red-600 dark:!text-red-400"
                    ${state.backupJalan ? 'disabled' : ''} title="Kembalikan SELURUH database ke isi file backup ini">
              ${icon('sync')}<span>Pulihkan</span>
            </button>
            <a class="btn btn-outline btn-sm shrink-0" href="/api/backup/${encodeURIComponent(b.nama)}" download>
              ${icon('download')}<span>Unduh</span>
            </a>
          </div>
        </li>`).join('')}
      </ul>`
    : `<p class="mt-2 text-sm text-gray-500 dark:text-gray-400" data-backup-kosong>
         Belum ada file backup. Klik "Backup sekarang" untuk membuat satu —
         atau tunggu jadwal otomatis (dicek tiap jam, 1× sehari).
       </p>`;
  const err = state.backupErr
    ? `<p class="mt-2 text-xs text-red-600 dark:text-red-400">${esc(state.backupErr)}</p>` : '';
  return `
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('shieldCheck')}</span>
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Backup data</h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Salinan utuh database dibuat otomatis <b>1× sehari</b> — <b>14 file</b> terbaru
              disimpan. <b>Pulihkan</b> mengembalikan SELURUH database ke isi file itu: data
              setelah backup (penjualan, stok, hutang) hilang dan device bisa diminta login
              ulang; server membuat backup pengaman lebih dulu.
            </p>
            <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
              API mati? Restore manual = salin file backup saat API berhenti (lihat README).
            </p>
          </div>
        </div>
        <button type="button" id="set-backup" class="btn btn-outline w-full shrink-0 sm:w-auto" ${state.backupJalan ? 'disabled' : ''}>
          ${icon('sync')}<span>${state.backupJalan ? 'Membuat backup…' : 'Backup sekarang'}</span>
        </button>
      </div>
      ${err}
      ${daftar}
    </div>`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function paint(): void {
  const body = host?.querySelector('#set-body');
  if (!body) return;
  body.innerHTML = renderBody();
  bind();
}

function bind(): void {
  // Kedua saklar pola sama: konfirmasi -> POST HANYA kunci yang diubah
  // (endpoint menerima update parsial) -> snapshot state -> paint ulang.
  const saklar: {
    id: keyof typeof state; input: string; key: 'allow_negative_stock' | 'tolak_jual_kadaluarsa';
    tanya: (n: boolean) => { title: string; message: string; okLabel: string; danger: boolean };
    sukses: (n: boolean) => string;
  }[] = [
    {
      id: 'minus', input: '#set-minus', key: 'allow_negative_stock',
      tanya: (n) => ({
        title: n ? 'Izinkan stok minus?' : 'Kembalikan aturan stok ketat?',
        message: n
          ? 'Penjualan akan terus berjalan walau stok sudah habis, dan angka stok bisa menjadi negatif. Anda tetap bisa mematikannya kapan saja.'
          : 'Penjualan yang melebihi stok akan ditolak lagi dengan pesan "stok kurang". Stok yang sudah minus tidak otomatis dikembalikan.',
        okLabel: n ? 'Ya, izinkan' : 'Ya, kembalikan',
        danger: n,
      }),
      sukses: (n) => (n ? 'Stok boleh minus: aktif' : 'Stok tidak boleh minus: aktif lagi'),
    },
    {
      id: 'kadaluarsa', input: '#set-kadaluarsa', key: 'tolak_jual_kadaluarsa',
      tanya: (n) => ({
        title: n ? 'Tolak jual barang kadaluarsa?' : 'Bolehkan jual barang kadaluarsa lagi?',
        message: n
          ? 'Server akan menolak penjualan yang memuat barang lewat tanggal kadaluarsa (pesan "barang kadaluarsa: ..."). Hari kadaluarsa masih boleh dijual. Strip peringatan di layar kasir tetap tampil.'
          : 'Barang lewat tanggal kadaluarsa kembali boleh terjual; layar kasir hanya menampilkan peringatan visual. Tanggal di produk tidak dihapus.',
        okLabel: n ? 'Ya, tolak' : 'Ya, izinkan',
        danger: n,
      }),
      sukses: (n) => (n ? 'Tolak jual kadaluarsa: aktif' : 'Tolak jual kadaluarsa: nonaktif lagi'),
    },
  ];
  for (const s of saklar) {
    const input = host?.querySelector<HTMLInputElement>(s.input);
    if (!input) continue;
    input.addEventListener('change', async () => {
      const next = input.checked;
      const { title, message, okLabel, danger } = s.tanya(next);
      const yes = await confirmDialog({
        title, message, okLabel, cancelLabel: 'Batal, jangan diubah', danger,
      });
      if (!yes) {
        input.checked = !next;
        return;
      }
      try {
        await apiPost('/api/settings', { [s.key]: next });
        (state as Record<string, unknown>)[s.id] = next;
        toast(s.sukses(next), 'success');
        paint();
      } catch (e) {
        input.checked = !next;
        toast(`Gagal simpan: ${errMsg(e)}`, 'error');
      }
    });
  }

  // Kartu "Pengaturan toko": baca 4 field lalu POST sekali (endpoint menerima
  // update parsial multi-kunci). Respon dijadikan snapshot state supaya nilai
  // yang tampil = nilai TRIM hasil server, bukan hasil ketik kasar.
  host?.querySelector('#set-toko-simpan')?.addEventListener('click', async () => {
    if (state.tokoJalan) return;
    const val = (id: string) => (host?.querySelector<HTMLInputElement>(id)?.value ?? '').trim();
    const payload = {
      store_name: val('#set-toko-nama'),
      store_address: val('#set-toko-alamat'),
      store_phone: val('#set-toko-telepon'),
      store_email: val('#set-toko-email'),
    };
    state.tokoJalan = true;
    paint();
    try {
      const r = await apiPost<{ data: Settings }>('/api/settings', payload);
      state.toko = {
        store_name: r.data.store_name ?? '',
        store_address: r.data.store_address ?? '',
        store_phone: r.data.store_phone ?? '',
        store_email: r.data.store_email ?? '',
      };
      toast('Pengaturan toko disimpan — kop invoice A4 memakai nilai ini', 'success');
    } catch (e) {
      toast(`Gagal simpan pengaturan toko: ${errMsg(e)}`, 'error');
    } finally {
      state.tokoJalan = false;
      if (host?.isConnected) paint();
    }
  });

  // Logo struk thermal (butir ROADMAP 1.6.4): unggah diproses di klien dulu
  // (PNG ≤384px) lalu POST /api/settings/logo; sukses/gagal TIDAK mem-paint
  // ulang form — ketikan store_* yang belum disimpan harus tetap utuh.
  // resetLogoStrukCache() supaya struk berikutnya memakai logo terbaru.
  host?.querySelector<HTMLInputElement>('#set-logo-file')?.addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // pilih berkas yang sama dua kali tetap memicu change
    if (!file) return;
    try {
      const dataUrl = await kecilkanLogo(file);
      const r = await apiPost<{ data: { store_logo: string } }>('/api/settings/logo', { image: dataUrl });
      state.logo = r.data.store_logo ?? '';
      resetLogoStrukCache();
      tampilLogo();
      toast('Logo disimpan — struk thermal berikutnya mencetak logo ini', 'success');
    } catch (e) {
      toast(`Gagal unggah logo: ${errMsg(e)}`, 'error');
    }
  });
  // Hapus logo: tanpa swal (pola avatar — non-destruktif, berkasnya bisa
  // diunggah ulang kapan saja; swal repo ini untuk aksi yang menghilangkan data).
  host?.querySelector('#set-logo-hapus')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/settings/logo', { image: '' });
      state.logo = '';
      resetLogoStrukCache();
      tampilLogo();
      toast('Logo dihapus — struk thermal kembali tanpa logo', 'success');
    } catch (e) {
      toast(`Gagal hapus logo: ${errMsg(e)}`, 'error');
    }
  });

  // Kartu "Cetak struk": preferensi per-device, langsung tersimpan tanpa
  // konfirmasi (non-destruktif & bisa dibalik — alasan sama dengan Backup).
  // Di-paint ulang supaya label saklar ("Aktif"/"Nonaktif") ikut terbarui.
  // Kartu "Tampilan perangkat ini": localStorage saja (tanpa API) — pindahan
  // dari halaman Profil (2026-10-11). applyTheme + event ravaa:theme agar
  // sidebar/header ikut tercatat ulang seketika.
  host?.querySelector('#set-dev-simpan')?.addEventListener('click', () => {
    const toko = (host?.querySelector<HTMLInputElement>('#set-dev-toko')?.value ?? '').trim() || 'RAVA POS';
    const t = (host?.querySelector<HTMLSelectElement>('#set-dev-theme')?.value ?? 'light') === 'dark' ? 'dark' : 'light';
    setToko(toko);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('ravaa.theme', t); } catch { /* abaikan */ }
    document.dispatchEvent(new CustomEvent('ravaa:theme'));
    toast('Tampilan perangkat disimpan', 'success');
  });
  host?.querySelector<HTMLInputElement>('#set-pause')?.addEventListener('change', (e) => {
    const nyala = (e.target as HTMLInputElement).checked;
    setPrintPause(!nyala); // saklar menyala = CETAK menyala = pause mati
    toast(
      nyala
        ? 'Jeda cetak DIMATIKAN — struk/label/kick laci kirim ke printer lagi'
        : 'Jeda cetak AKTIF — semua kirim ke printer ditahan (kertas aman)',
      nyala ? 'success' : 'warning',
    );
    paint();
  });
  host?.querySelector<HTMLInputElement>('#set-cetak')?.addEventListener('change', (e) => {
    const nyala = (e.target as HTMLInputElement).checked;
    setAutoPrint(nyala);
    toast(nyala ? 'Cetak otomatis: aktif (device ini)' : 'Cetak otomatis: nonaktif (device ini)', 'success');
    paint();
  });
  host?.querySelector<HTMLSelectElement>('#set-layout')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    const layout: LayoutStruk = v === 'a4' ? 'a4' : 'thermal';
    setStrukLayout(layout);
    toast(
      layout === 'a4' ? 'Layout struk: Epson L3110 (A4) — eject tanpa potong' : 'Layout struk: Thermal 58mm',
      'success',
    );
    paint();
  });

  // Tombol Backup sekarang: POST -> refresh daftar -> toast. Tanpa konfirmasi
  // (non-destruktif; retensi 14 file di server yang menjaga jumlah).
  host?.querySelector('#set-backup')?.addEventListener('click', async () => {
    if (state.backupJalan) return;
    state.backupJalan = true;
    state.backupErr = '';
    paint();
    try {
      const r = await apiPost<{ data: BarisBackup }>('/api/backup', {});
      toast(`Backup dibuat: ${r.data.nama} (${ukuranFile(r.data.ukuran)})`, 'success');
      await muatBackup();
    } catch (e) {
      state.backupErr = `Gagal backup: ${errMsg(e)}`;
      toast(state.backupErr, 'error');
    } finally {
      state.backupJalan = false;
      if (host?.isConnected) paint();
    }
  });
  // Tombol "Pulihkan" per baris backup (2026-10-16): operasi PALING berbahaya
  // di halaman ini — konfirmasi danger, lalu server verifikasi integritas +
  // membuat backup pengaman sebelum mengganti database. Setelah sukses,
  // halaman DI-Reload: seluruh cache & angka di layar sudah basi.
  host?.querySelectorAll<HTMLElement>('[data-restore]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (state.backupJalan) return;
      const nama = btn.dataset.restore ?? '';
      if (!nama) return;
      const yes = await confirmDialog({
        title: `Pulihkan database dari ${nama}?`,
        message:
          'SELURUH database dikembalikan ke isi file backup ini. Semua data yang dibuat ' +
          'SETELAH backup (penjualan, stok, hutang, pengguna baru) akan HILANG dan tidak ' +
          'bisa dikembalikan. Server membuat backup pengaman lebih dulu, dan device bisa ' +
          'diminta login ulang. Lakukan hanya saat pemilik memerintahkan.',
        okLabel: 'Ya, pulihkan',
        cancelLabel: 'Batal, jangan dipulihkan',
        danger: true,
      });
      if (!yes) return;
      state.backupJalan = true;
      state.backupErr = '';
      paint();
      try {
        const r = await apiPost<{ data: { nama: string; pengaman: string } }>('/api/backup/restore', { nama });
        toast(
          `Database dipulihkan dari ${r.data.nama} · pengaman: ${r.data.pengaman}`,
          'success',
        );
        // Tunda sebentar supaya toast terbaca, lalu muat ulang halaman.
        window.setTimeout(() => location.reload(), 1500);
      } catch (e) {
        state.backupErr = `Gagal memulihkan: ${errMsg(e)}`;
        toast(state.backupErr, 'error');
        state.backupJalan = false;
        if (host?.isConnected) paint();
      }
    }),
  );
}

// Ambil daftar backup — gagal TIDAK menggagalkan halaman (kartu saklar tetap
// jalan), cukup pesan inline di kartu Backup.
async function muatBackup(): Promise<void> {
  try {
    const r = await apiGet<{ data: BarisBackup[] }>('/api/backup');
    state.backups = Array.isArray(r.data) ? r.data : [];
    state.backupErr = '';
  } catch (e) {
    state.backupErr = `Gagal memuat daftar backup: ${errMsg(e)}`;
  }
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  // Settings dan daftar backup paralel — daftar tidak memblokir kartu saklar.
  const [s, _] = await Promise.allSettled([
    apiGet<{ data: Settings }>('/api/settings'),
    muatBackup(),
  ]);
  if (s.status === 'fulfilled') {
    state.minus = s.value.data?.allow_negative_stock === true;
    state.kadaluarsa = s.value.data?.tolak_jual_kadaluarsa === true;
    state.toko = {
      store_name: s.value.data?.store_name ?? '',
      store_address: s.value.data?.store_address ?? '',
      store_phone: s.value.data?.store_phone ?? '',
      store_email: s.value.data?.store_email ?? '',
    };
    state.logo = s.value.data?.store_logo ?? '';
  } else {
    state.error = errMsg(s.reason);
  }
  state.loading = false;
  if (host?.isConnected) paint();
}

export async function mountSettingsPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  await load();
}
