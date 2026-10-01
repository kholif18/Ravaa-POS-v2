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

type Settings = { allow_negative_stock: boolean };

const state = { loading: true, error: '', minus: false };

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

  const isi = state.minus
    ? `Penjualan tetap jalan walaupun stok sudah habis — angka stok boleh menembus
       nol (minus) sampai barang diisi ulang. Cocok kalau hitungan fisik dan sistem
       sering selisih, dan tidak ada lagi pesan "stok kurang" yang menghentikan
       transaksi di meja kasir.`
    : `Begitu jumlah terjual melebihi sisa stok, penjualan <b>ditolak</b> dengan pesan
       "stok kurang: ... (butuh X, sisa Y)". Ini perilaku bawaan dan paling aman
       untuk menjaga stok tercatat sama persis dengan isi rak.`;

  // Sengaja TANPA badge status di sebelah judul: label saklarnya sendiri sudah
  // membaca "Aktif"/"Nonaktif", jadi badge hanya mengulang teks yang sama dan
  // membuat mata membandingkan dua kolom identik untuk menemukan bedanya.
  // Status = posisi saklar; keterangan = paragraf di bawah.
  return `
  <div class="card">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0 flex-1">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Stok boleh minus</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${isi}</p>
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          ${state.minus ? 'Sedang berlaku.' : 'Bawaan, belum diubah.'}
          Dibaca server pada SETIAP penjualan, jadi perubahan langsung berlaku di semua kasir.
        </p>
      </div>
      <div class="shrink-0">${switchHtml('set-minus', state.minus, state.minus ? 'Aktif' : 'Nonaktif')}</div>
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
  const input = host?.querySelector<HTMLInputElement>('#set-minus');
  if (!input) return;
  input.addEventListener('change', async () => {
    const next = input.checked;
    const yes = await confirmDialog({
      title: next ? 'Izinkan stok minus?' : 'Kembalikan aturan stok ketat?',
      message: next
        ? 'Penjualan akan terus berjalan walau stok sudah habis, dan angka stok bisa menjadi negatif. Anda tetap bisa mematikannya kapan saja.'
        : 'Penjualan yang melebihi stok akan ditolak lagi dengan pesan "stok kurang". Stok yang sudah minus tidak otomatis dikembalikan.',
      okLabel: next ? 'Ya, izinkan' : 'Ya, kembalikan',
      cancelLabel: 'Batal, jangan diubah',
      danger: next,
    });
    if (!yes) {
      input.checked = !next;
      return;
    }
    try {
      await apiPost('/api/settings', { allow_negative_stock: next });
      state.minus = next;
      toast(next ? 'Stok boleh minus: aktif' : 'Stok tidak boleh minus: aktif lagi', 'success');
      paint();
    } catch (e) {
      input.checked = !next;
      toast(`Gagal simpan: ${errMsg(e)}`, 'error');
    }
  });
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  try {
    const s = await apiGet<{ data: Settings }>('/api/settings');
    state.minus = s.data?.allow_negative_stock === true;
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
