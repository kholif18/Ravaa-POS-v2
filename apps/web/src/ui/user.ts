// Menu user (avatar + dropdown): nama kasir, profil, keluar.
// Modul ini SENGAJA tidak meng-import shell.ts (reverse juga avoided) supaya
// tidak ada circular import. Perubahan disiarkan lewat CustomEvent
// ('ravaa:user' / 'ravaa:theme') dan shell.ts yang mengecat ulang header.
//
// Login 2026-10-11: sesi token server (lihat ui/auth.ts). "Nama kasir"
// mengikuti display name AKUN (diisi saat masuk) dan dipakai untuk shift +
// laporan — profil TIDAK lagi mengubah nama (akan memutus kepemilikan shift).
// "Keluar" = hapus sesi server + token lokal, kembali ke halaman Login.

import { openModal } from './modal';
import { confirmDialog } from './confirm';
import { toast } from './toast';
import { icon } from './icons';
import { getToko as getStoreFromIdentitas, setToko as setStoreToIdentitas } from './identitas-struk';

const KEY = 'ravaa.cashier';

export function getCashier(): string {
  try {
    return localStorage.getItem(KEY)?.trim() || 'kasir';
  } catch {
    return 'kasir';
  }
}

export function setCashier(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* private mode: abaikan */
  }
  document.dispatchEvent(new CustomEvent('ravaa:user'));
}

/** Inisial untuk avatar: "Budi Santoso" -> "BS", "Ravaa" -> "RA", "" -> "?" */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Escape untuk disisipkan ke HTML. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Nama toko di kepala struk. Default `RAVA POS` adalah MERK APLIKASI, bukan
 *  nama toko sungguhan — pemilik menggantinya sekali lewat Pengaturan Akun.
 *  Disimpan per device (sama seperti nama kasir) karena struk memang dicetak
 *  dari device yang memegang printer. */
const TOKO_KEY = 'ravaa.toko';
export function getToko(): string {
  const fromIdentitas = getStoreFromIdentitas();
  if (fromIdentitas && fromIdentitas !== 'RAVA POS') return fromIdentitas;
  try {
    const legacy = localStorage.getItem(TOKO_KEY)?.trim();
    if (legacy) return legacy;
  } catch {}
  return getStoreFromIdentitas();
}
export function setToko(name: string): void {
  setStoreToIdentitas(name);
  try {
    localStorage.setItem(TOKO_KEY, name.trim());
  } catch {
    /* abaikan */
  }
}

/** Modal pengaturan akun: info akun (read-only) + tema + ganti sandi.
 *  Nama toko struk kini mengikuti Identitas toko (server) dan tidak bisa diubah
 *  di sini. Nama kasir mengikuti AKUN dan tidak bisa diubah di sini.
 */
export function openProfileModal(): void {
  const name = getCashier();
  const toko = getToko();
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

  openModal({
    title: 'Pengaturan Akun',
    okLabel: 'Simpan',
    body: `
      <div class="flex items-center gap-2 rounded-xl bg-gray-50 p-3 dark:bg-gray-900/40">
        <span class="avatar avatar-lg" id="pf-avatar">${esc(initials(name))}</span>
        <div class="min-w-0">
          <p class="text-sm font-semibold text-gray-900 dark:text-white">${esc(name)}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">Nama kasir = nama akun (diubah di halaman Pengguna).</p>
        </div>
      </div>
      <div class="field mt-4">
        <label class="label">Nama toko (kepala struk)</label>
        <div class="input flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          <span>${esc(toko || 'RAVA POS')}</span>
          <span class="text-xs text-gray-500 dark:text-gray-400">dari Identitas toko</span>
        </div>
      </div>
      <div class="field">
        <label class="label" for="pf-theme">Tampilan</label>
        <select id="pf-theme" class="input">
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Terang</option>
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Gelap</option>
        </select>
      </div>
      <button type="button" id="pf-sandi" class="btn btn-ghost w-full justify-center">Ganti sandi</button>`,
    onMount: ({ el, ok, close }) => {
      const themeEl = el.querySelector('#pf-theme') as HTMLSelectElement;
      el.querySelector('#pf-sandi')?.addEventListener('click', () => {
        close();
        location.hash = '#/ubah-sandi';
      });

      ok.addEventListener('click', () => {
        // Nama toko tidak disimpan per-device lagi
        const t = themeEl.value === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = t;
        try {
          localStorage.setItem('ravaa.theme', t);
        } catch {
          /* abaikan */
        }
        document.dispatchEvent(new CustomEvent('ravaa:theme'));
        toast('Pengaturan akun disimpan', 'success');
        close();
      });
    },
  });
}

/** Keluar: hapus sesi server + token lokal, kembali ke halaman Login. */
export async function logout(): Promise<void> {
  const yes = await confirmDialog({
    title: `Keluar dari "${getCashier()}"?`,
    message:
      'Sesi di server diputus dan perangkat ini kembali ke halaman Login. Keranjang yang belum dibayar akan hilang.',
    okLabel: 'Ya, keluar',
    cancelLabel: 'Batal, jangan keluar',
    danger: true,
  });
  if (!yes) return;
  const { keluar } = await import('./auth');
  await keluar();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* abaikan */
  }
  document.dispatchEvent(new CustomEvent('ravaa:user'));
  toast('Sudah keluar — sampai jumpa', 'success');
  location.hash = '#/login';
}
