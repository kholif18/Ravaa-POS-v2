// Halaman Profil (#/profil, 2026-10-11): edit profil SENDIRI — nama tampil
// (akun, disimpan ke server lewat POST /api/users/profile), nama toko +
// tampilan (device), dan pintasan ganti sandi. Semua peran; dirender TANPA
// shell? TIDAK — di dalam shell biasa (menu dropdown "Edit Profil").
// Nama disimpan di AKUN (bukan lagi localStorage): header/shift/laporan
// mengikuti lewat profilSaya() + event ravaa:user.

import { apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { akunTersimpan } from '../ui/auth';
import { getToko, initials, setToko } from '../ui/user';

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

export function renderProfilPage(el: HTMLElement): void {
  const akun = akunTersimpan()?.akun;
  const nama = akun?.name ?? '';
  const username = akun?.username ?? '';
  const role = akun?.role === 'pemilik' ? 'Owner' : 'Kasir';
  const toko = getToko();
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  el.innerHTML = `
  <div class="space-y-3">
    <div class="card">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Edit Profil</h2>
      <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
        Nama tampil dipakai di header, shift, laporan, dan struk.
      </p>
    </div>
    <div class="card">
      <div class="flex items-center gap-3">
        <span class="avatar avatar-lg" id="pf-avatar">${initials(nama)}</span>
        <div class="min-w-0">
          <p class="text-sm font-semibold text-gray-900 dark:text-white">${nama || '—'}</p>
          <p class="text-xs text-gray-500 dark:text-gray-400"><span class="font-mono">${username}</span> · ${role}</p>
        </div>
      </div>
      <div class="field mt-4">
        <label class="label" for="pf-name">Nama tampil *</label>
        <input id="pf-name" class="input" maxlength="32" value="${nama}" placeholder="cth: Budi Santoso" />
        <span class="text-xs text-gray-500 dark:text-gray-400">
          Nama inilah yang tercatat sebagai kasir pada shift & transaksi berikutnya.
        </span>
      </div>
      <button type="button" id="pf-simpan" class="btn btn-primary mt-2">Simpan profil</button>
    </div>
    <div class="card">
      <p class="form-sec">Perangkat ini</p>
      <div class="field">
        <label class="label" for="pf-toko">Nama toko (kepala struk)</label>
        <input id="pf-toko" class="input" maxlength="32" value="${toko}" placeholder="cth: Toko Maju Jaya" />
        <span class="text-xs text-gray-500 dark:text-gray-400">
          Tersimpan di perangkat ini — printer memang milik device kasir.
        </span>
      </div>
      <div class="field">
        <label class="label" for="pf-theme">Tampilan</label>
        <select id="pf-theme" class="input">
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Terang</option>
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Gelap</option>
        </select>
      </div>
      <button type="button" id="pf-simpan-device" class="btn btn-ghost mt-2">Simpan tampilan perangkat</button>
    </div>
    <div class="card">
      <p class="form-sec">Keamanan</p>
      <a href="#/ubah-sandi" class="btn btn-ghost w-full justify-center">${icon('sync')}<span>Ganti sandi</span></a>
    </div>
  </div>`;

  const namaEl = el.querySelector<HTMLInputElement>('#pf-name')!;
  const avatarEl = el.querySelector<HTMLElement>('#pf-avatar')!;
  namaEl.addEventListener('input', () => {
    avatarEl.textContent = initials(namaEl.value);
  });

  el.querySelector('#pf-simpan')?.addEventListener('click', async () => {
    const v = namaEl.value.trim();
    if (!v) {
      toast('Nama tidak boleh kosong', 'warning');
      namaEl.focus();
      return;
    }
    try {
      await apiPost('/api/users/profile', { name: v });
      toast('Profil disimpan', 'success');
      // Sinkronkan simpanan perangkat + cat ulang header (nama/avatar ikut).
      const { profilSaya } = await import('../ui/auth');
      await profilSaya();
      document.dispatchEvent(new CustomEvent('ravaa:user'));
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  el.querySelector('#pf-simpan-device')?.addEventListener('click', () => {
    setToko((el.querySelector('#pf-toko') as HTMLInputElement).value.trim() || 'RAVA POS');
    const t = (el.querySelector('#pf-theme') as HTMLSelectElement).value === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('ravaa.theme', t);
    } catch {
      /* abaikan */
    }
    document.dispatchEvent(new CustomEvent('ravaa:theme'));
    toast('Tampilan perangkat disimpan', 'success');
  });
}
