// Ganti sandi (#/ubah-sandi, 2026-10-11): layar penuh tanpa shell.
// Dipakai WAJIB saat akun baru/reset (must_change) dan sukarela lewat tombol
// "Ganti sandi" di modal profil. Sukses -> rute bawaan peran.
import { apiPost, HttpError } from '../api';
import { toast } from '../ui/toast';
import { akunTersimpan, ruteBawaan, type Peran } from '../ui/auth';

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

export function renderUbahSandiPage(el: HTMLElement): void {
  const tersimpan = akunTersimpan();
  const nama = tersimpan?.akun.name ?? tersimpan?.akun.username ?? '';
  const wajib = tersimpan?.wajib ?? true;
  const peran: Peran = tersimpan?.akun.role ?? 'kasir';
  el.innerHTML = `
  <div class="flex min-h-full items-center justify-center p-4">
    <div class="card w-full max-w-sm">
      <h1 class="text-sm font-semibold text-gray-900 dark:text-white">Ganti sandi${nama ? ` — ${nama}` : ''}</h1>
      <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${
        wajib
          ? 'Akun ini wajib ganti sandi dulu sebelum memakai aplikasi.'
          : 'Isi sandi baru di bawah.'
      }</p>
      <form id="gs-form" class="mt-4 space-y-3" autocomplete="off">
        <div class="field">
          <label class="label" for="gs-lama">Sandi lama</label>
          <input id="gs-lama" class="input" type="password" autocomplete="current-password" />
        </div>
        <div class="field">
          <label class="label" for="gs-baru">Sandi baru (min. 4 karakter)</label>
          <input id="gs-baru" class="input" type="password" autocomplete="new-password" />
        </div>
        <div class="field">
          <label class="label" for="gs-ulang">Ulangi sandi baru</label>
          <input id="gs-ulang" class="input" type="password" autocomplete="new-password" />
        </div>
        <p id="gs-err" class="hidden text-xs font-medium text-red-600 dark:text-red-400"></p>
        <button type="submit" id="gs-ok" class="btn btn-primary w-full">Simpan sandi baru</button>
      </form>
    </div>
  </div>`;
  const form = el.querySelector<HTMLFormElement>('#gs-form')!;
  const lama = el.querySelector<HTMLInputElement>('#gs-lama')!;
  const baru = el.querySelector<HTMLInputElement>('#gs-baru')!;
  const ulang = el.querySelector<HTMLInputElement>('#gs-ulang')!;
  const err = el.querySelector<HTMLElement>('#gs-err')!;
  const btn = el.querySelector<HTMLButtonElement>('#gs-ok')!;
  const gagal = (pesan: string, fokus?: HTMLElement) => {
    err.textContent = pesan;
    err.classList.remove('hidden');
    fokus?.focus();
  };
  lama.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!lama.value) return gagal('Sandi lama wajib diisi.', lama);
    if (baru.value.length < 4) return gagal('Sandi baru minimal 4 karakter.', baru);
    if (baru.value !== ulang.value) return gagal('Ulangi tidak sama dengan sandi baru.', ulang);
    btn.disabled = true;
    btn.textContent = 'Menyimpan…';
    try {
      await apiPost('/api/users/password', { old_password: lama.value, password: baru.value });
      try {
        localStorage.setItem('ravaa.wajib-ganti', '0');
      } catch {
        /* abaikan */
      }
      toast('Sandi baru tersimpan', 'success');
      location.hash = ruteBawaan(peran);
    } catch (e2) {
      gagal(errMsg(e2), lama);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Simpan sandi baru';
    }
  });
}
