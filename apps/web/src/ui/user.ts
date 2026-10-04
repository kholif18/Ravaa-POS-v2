// Menu user (avatar + dropdown): nama kasir, edit profil, keluar.
// Modul ini SENGAJA tidak meng-import shell.ts (reverse juga avoided) supaya
// tidak ada circular import. Perubahan disiarkan lewat CustomEvent
// ('ravaa:user' / 'ravaa:theme') dan shell.ts yang mengecat ulang header.
//
// CATATAN JUJUR: repo ini BELUM punya auth/session server. "Nama kasir" hanya
// disimpan di localStorage perangkat ini (ravaa.cashier) dan dipakai untuk
// shift + laporan. Jadi "Keluar" = lepas dari perangkat (hapus nama lokal),
// bukan mengakhiri session server. Jangan menyebutnya login/logout sungguhan.

import { openModal } from './modal';
import { confirmDialog } from './confirm';
import { toast } from './toast';
import { icon } from './icons';

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
  try {
    return localStorage.getItem(TOKO_KEY)?.trim() || 'RAVA POS';
  } catch {
    return 'RAVA POS';
  }
}
export function setToko(name: string): void {
  try {
    localStorage.setItem(TOKO_KEY, name);
  } catch {
    /* abaikan */
  }
}

/** Modal pengaturan akun: nama kasir (profil) + nama toko (kepala struk) + tema. */
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
          <p class="text-sm font-semibold text-gray-900 dark:text-white">Profil kasir</p>
          <p class="text-xs text-gray-500 dark:text-gray-400">Tersimpan di perangkat ini saja.</p>
        </div>
      </div>
      <div class="field mt-4">
        <label class="label" for="pf-name">Nama kasir</label>
        <input id="pf-name" class="input" maxlength="24" value="${esc(name)}" placeholder="cth: Budi" />
        <span class="text-xs text-gray-500 dark:text-gray-400" id="pf-hint">
          Dipakai untuk shift, laporan harian, dan struk. Berbeda per device.
        </span>
      </div>
      <div class="field">
        <label class="label" for="pf-toko">Nama toko (kepala struk)</label>
        <input id="pf-toko" class="input" maxlength="32" value="${esc(toko)}" placeholder="cth: Toko Maju Jaya" />
        <span class="text-xs text-gray-500 dark:text-gray-400">
          Tercetak paling atas di struk. Tersimpan di perangkat ini.
        </span>
      </div>
      <div class="field">
        <label class="label" for="pf-theme">Tampilan</label>
        <select id="pf-theme" class="input">
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Terang</option>
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Gelap</option>
        </select>
      </div>
      <p class="mt-3 text-xs text-gray-500 dark:text-gray-400">
        Belum ada akun/password di aplikasi ini — nama kasir hanya penanda perangkat,
        bukan login.
      </p>`,
    onMount: ({ el, ok, close }) => {
      const nameEl = el.querySelector('#pf-name') as HTMLInputElement;
      const avatarEl = el.querySelector('#pf-avatar') as HTMLElement;
      const themeEl = el.querySelector('#pf-theme') as HTMLSelectElement;
      const tokoEl = el.querySelector('#pf-toko') as HTMLInputElement;

      nameEl.addEventListener('input', () => {
        avatarEl.textContent = initials(nameEl.value);
      });
      nameEl.focus();
      nameEl.select();

      ok.addEventListener('click', () => {
        const v = nameEl.value.trim();
        if (!v) {
          toast('Nama kasir tidak boleh kosong', 'warning');
          return;
        }
        setCashier(v);
        setToko(tokoEl.value.trim() || 'RAVA POS');
        // Tema ikut diterapkan seketika supaya langsung terlihat hasilnya.
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

/** Keluar dari perangkat: hapus nama kasir lokal, kembali ke layar kasir. */
export async function logout(): Promise<void> {
  const name = getCashier();
  const yes = await confirmDialog({
    title: `Keluar dari "${name}"?`,
    message:
      'Nama kasir di perangkat ini akan dihapus. Keranjang yang belum dibayar akan hilang.',
    okLabel: 'Ya, keluar',
    cancelLabel: 'Batal, jangan keluar',
    danger: true,
  });
  if (!yes) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* abaikan */
  }
  document.dispatchEvent(new CustomEvent('ravaa:user'));
  toast('Sesi kasir di perangkat ini dihapus', 'success');
  location.hash = '#/pos';
}
