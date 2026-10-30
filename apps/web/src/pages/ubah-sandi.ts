// Ganti sandi (#/ubah-sandi, 2026-10-11): layar penuh tanpa shell.
// Dipakai WAJIB saat akun baru/reset (must_change) dan sukarela lewat tombol
// "Ganti sandi" di modal profil. Sukses -> rute bawaan peran.
// Restyle 2026-10-17: memakai kerangka yang SAMA dengan login
// (authLayarHtml() ui/auth-screen.ts) — satu tampilan auth di kedua rute.
// ID #gs-form/#gs-lama/#gs-baru/#gs-ulang/#gs-err/#gs-ok tidak berubah.
import { apiPost } from '../api';
import { toast } from '../ui/toast';
import { akunTersimpan, ruteBawaan, type Akun } from '../ui/auth';
import { icon } from '../ui/icons';
import { authLayarHtml } from '../ui/auth-screen';
import { errMsg } from '../ui/http';

export function renderUbahSandiPage(el: HTMLElement): void {
  const tersimpan = akunTersimpan();
  const nama = tersimpan?.akun.name ?? tersimpan?.akun.username ?? '';
  const wajib = tersimpan?.wajib ?? true;
  const akun: Akun = tersimpan?.akun ?? { id: 0, username: '', name: '', role: 'kasir' };
  el.innerHTML = authLayarHtml(`
    <div class="flex items-center gap-3">
      <span class="login-logo size-11">${icon('shieldCheck')}</span>
      <div class="min-w-0">
        <h1 class="text-sm font-semibold text-white">Ganti sandi${nama ? ` — ${nama}` : ''}</h1>
        <p class="mt-0.5 text-xs text-white/70">${
          wajib
            ? 'Akun ini wajib ganti sandi dulu sebelum memakai aplikasi.'
            : 'Isi sandi baru di bawah.'
        }</p>
      </div>
    </div>
    <form id="gs-form" class="mt-5 space-y-3" autocomplete="off">
      <div class="field">
        <label class="label !text-white/75" for="gs-lama">Sandi lama</label>
        <div class="login-field">
          ${icon('lock')}
          <input id="gs-lama" class="input login-input pl-9" type="password" autocomplete="current-password" />
        </div>
      </div>
      <div class="field">
        <label class="label !text-white/75" for="gs-baru">Sandi baru (min. 8 karakter)</label>
        <div class="login-field">
          ${icon('lock')}
          <input id="gs-baru" class="input login-input pl-9" type="password" autocomplete="new-password" />
        </div>
      </div>
      <div class="field">
        <label class="label !text-white/75" for="gs-ulang">Ulangi sandi baru</label>
        <div class="login-field">
          ${icon('lock')}
          <input id="gs-ulang" class="input login-input pl-9" type="password" autocomplete="new-password" />
        </div>
      </div>
      <p id="gs-err" class="login-err hidden" role="alert"></p>
      <button type="submit" id="gs-ok" class="btn login-btn w-full">Simpan sandi baru</button>
    </form>`);
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
    if (baru.value.length < 8) return gagal('Sandi baru minimal 8 karakter.', baru);
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
      location.hash = ruteBawaan(akun);
    } catch (e2) {
      gagal(errMsg(e2), lama);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Simpan sandi baru';
    }
  });
}
