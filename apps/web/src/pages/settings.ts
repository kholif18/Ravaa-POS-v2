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
import { icon } from '../ui/icons';
import { getAutoPrint, getStrukLayout, setAutoPrint, setStrukLayout, type LayoutStruk } from '../ui/print-pref';
import { switchHtml } from '../ui/switch';
import { toast } from '../ui/toast';
import { waktu } from '../ui/waktu';

type Settings = {
  allow_negative_stock: boolean; tolak_jual_kadaluarsa: boolean;
  store_name: string; store_address: string; store_phone: string; store_email: string;
};
type BarisBackup = { nama: string; ukuran: number; waktu: string };

const state = {
  loading: true, error: '', minus: false, kadaluarsa: false,
  backups: [] as BarisBackup[], backupErr: '', backupJalan: false,
  toko: { store_name: '', store_address: '', store_phone: '', store_email: '' },
  tokoJalan: false,
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
          Disimpan di <b>server</b>, jadi berlaku untuk semua device kasir — tidak
          seperti Pengaturan Akun yang hanya untuk browser ini.
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
  // membaca "Aktif"/"Nonaktif", jadi badge hanya mengulang teks yang sama dan
  // membuat mata membandingkan dua kolom identik untuk menemukan bedanya.
  // Status = posisi saklar; keterangan = paragraf di bawah.
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Stok boleh minus</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${isiMinus}</p>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            ${state.minus ? 'Sedang berlaku.' : 'Bawaan, belum diubah.'}
            Dibaca server pada SETIAP penjualan, jadi perubahan langsung berlaku di semua kasir.
          </p>
        </div>
        <div class="shrink-0">${switchHtml('set-minus', state.minus, state.minus ? 'Aktif' : 'Nonaktif')}</div>
      </div>
    </div>
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Tolak jual kadaluarsa</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${isiKadaluarsa}</p>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            ${state.kadaluarsa ? 'Sedang berlaku.' : 'Bawaan, belum diubah.'}
            Dibaca server pada SETIAP penjualan, jadi perubahan langsung berlaku di semua kasir.
          </p>
        </div>
        <div class="shrink-0">${switchHtml('set-kadaluarsa', state.kadaluarsa, state.kadaluarsa ? 'Aktif' : 'Nonaktif')}</div>
      </div>
    </div>
    ${kartuToko()}
    ${kartuCetak()}
    ${kartuBackup()}
  </div>`;
}

// Kartu "Pengaturan toko" — kop INVOICE A4 (cetak gaya Aronium). Disimpan di
// SERVER (4 kunci store_* di tabel settings) supaya semua device mencetak kop
// yang sama; nilai awal di-seed dari contoh pemilik. Form biasa + tombol
// Simpan, tanpa konfirmasi swal (non-destruktif seperti Backup).
function kartuToko(): string {
  const t = state.toko;
  const f = (id: string, label: string, nilai: string, opsional?: boolean, lebar?: boolean) => `
    <label class="block${lebar ? ' sm:col-span-2' : ''}">
      <span class="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">${label}${opsional ? ' <span class="font-normal">(opsional)</span>' : ''}</span>
      <input class="input w-full" id="${id}" value="${esc(nilai)}" maxlength="300" autocomplete="off">
    </label>`;
  return `
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pengaturan toko</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Kop <b>INVOICE A4</b> (cetak gaya Aronium) memakai empat isian ini.
            Disimpan di <b>server</b>, jadi seluruh device mencetak kop yang sama.
          </p>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            ${f('set-toko-nama', 'Nama toko', t.store_name)}
            ${f('set-toko-telepon', 'Phone', t.store_phone, true)}
            ${f('set-toko-alamat', 'Alamat', t.store_address, true, true)}
            ${f('set-toko-email', 'Email', t.store_email, true)}
          </div>
        </div>
        <button type="button" id="set-toko-simpan" class="btn btn-primary shrink-0" ${state.tokoJalan ? 'disabled' : ''}>
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
  const isiSaklar = nyala
    ? `Setiap penjualan selesai, dialog menawarkan pilihan <b>[Thermal] [A4] [Tidak]</b> —
        kasir memilih kertas per transaksi (A4 = invoice gaya Aronium). Topup/tarik
        langsung dicetak sesuai layout di bawah. Matikan bila device ini tanpa printer;
        penjualan tetap berjalan (cetak tidak pernah membatalkan transaksi).`
    : `Struk & invoice <b>tidak</b> ditawarkan otomatis. Kasir tetap bisa mencetak ulang
        (dengan pilihan Thermal/A4) lewat menu Riwayat transaksi. Nyalakan lagi kalau
        device ini sudah terpasang printer.`;
  const isiLayout = layout === 'a4'
    ? `Layout tersimpan: <b>Epson L3110 (A4)</b> — struk topup/tarik dicetak 64 kolom,
        tanpa potong, ditutup eject supaya kertas keluar. Pilihan A4 saat penjualan
        membuka invoice A4 (dicetak lewat browser, bukan print-agent).`
    : `Layout tersimpan: <b>Thermal 58mm</b> — 32 kolom, diakhiri potong kertas; dipakai
        untuk struk topup/tarik. Pilihan A4 saat penjualan tetap membuka invoice A4.`;
  return `
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Cetak struk</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${isiSaklar}</p>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">${isiLayout}</p>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Berlaku untuk <b>device ini saja</b> (tersimpan di browser, tidak ikut ke
            kasir lain) — karena dua PC bisa menempel pada printer yang berbeda.
          </p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-2">
          ${switchHtml('set-cetak', nyala, nyala ? 'Aktif' : 'Nonaktif')}
          <select id="set-layout" class="input input-sm" aria-label="Layout struk">
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
    ? `<ul class="mt-3 divide-y divide-gray-100 dark:divide-gray-700" data-backup-list>
        ${state.backups.map((b) => `
        <li class="flex items-center justify-between gap-2 py-2" data-nama="${esc(b.nama)}">
          <div class="min-w-0">
            <div class="truncate text-sm text-gray-700 dark:text-gray-300">${esc(b.nama)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">${waktu(b.waktu)} · ${ukuranFile(b.ukuran)}</div>
          </div>
          <a class="btn btn-outline btn-sm shrink-0" href="/api/backup/${encodeURIComponent(b.nama)}" download>
            ${icon('download')}<span>Unduh</span>
          </a>
        </li>`).join('')}
      </ul>`
    : `<p class="mt-3 text-xs text-gray-500 dark:text-gray-400" data-backup-kosong>
         Belum ada file backup. Klik "Backup sekarang" untuk membuat satu —
         atau tunggu jadwal otomatis (dicek tiap jam, 1× sehari).
       </p>`;
  const err = state.backupErr
    ? `<p class="mt-2 text-xs text-red-600 dark:text-red-400">${esc(state.backupErr)}</p>` : '';
  return `
    <div class="card">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Backup data</h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Salinan utuh database toko disimpan otomatis <b>1× sehari</b> (yang terbaru
            disimpan <b>14 file</b>, sisanya dibuang sendiri). File ada di folder
            <code>backups</code> sebelah database — restore = salin manual saat API
            mati (lihat README).
          </p>
          ${err}
          ${daftar}
        </div>
        <button type="button" id="set-backup" class="btn btn-outline shrink-0" ${state.backupJalan ? 'disabled' : ''}>
          ${icon('sync')}<span>${state.backupJalan ? 'Membuat backup…' : 'Backup sekarang'}</span>
        </button>
      </div>
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

  // Kartu "Cetak struk": dua preferensi per-device, langsung tersimpan tanpa
  // konfirmasi (non-destruktif & bisa dibalik — alasan sama dengan Backup).
  // Di-paint ulang supaya label saklar ("Aktif"/"Nonaktif") ikut terbarui.
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
