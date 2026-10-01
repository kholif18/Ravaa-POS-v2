// Halaman Pengaturan (#/settings) — aturan yang berlaku untuk SEMUA device.
//
// Bedanya dengan "Pengaturan Akun" (ui/user.ts): yang di sana disimpan per
// browser lewat localStorage (nama kasir, nama toko, tema); yang di sini
// disimpan di SERVER lewat POST /api/settings, jadi satu perubahan langsung
// dipakai kasir di HP maupun di PC. Karena itu aturan yang menyangkut data
// (stok, harga, dsb) tidak boleh disimpan di localStorage — dua device bisa
// berbeda pendapat dan penjualan jadi tidak konsisten.

import { apiGet, apiPost, HttpError } from '../api';
import { confirmDialog } from '../ui/confirm';
import { icon } from '../ui/icons';
import { switchHtml } from '../ui/switch';
import { toast } from '../ui/toast';

type Settings = { allow_negative_stock: boolean; tolak_jual_kadaluarsa: boolean };

const state = { loading: true, error: '', minus: false, kadaluarsa: false };

let host: HTMLElement | null = null;

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

// Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
// halaman Stok & Produk.
function renderPage(): string {
  return `
  <div class="space-y-4">
    <div class="card">
      <div>
        <h2 class="text-base font-semibold text-gray-900 dark:text-white">Pengaturan</h2>
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
      <div class="flex flex-wrap items-start justify-between gap-4">
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
      <div class="flex flex-wrap items-start justify-between gap-4">
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
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const s = await apiGet<{ data: Settings }>('/api/settings');
    state.minus = s.data?.allow_negative_stock === true;
    state.kadaluarsa = s.data?.tolak_jual_kadaluarsa === true;
  } catch (e) {
    state.error = errMsg(e);
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
