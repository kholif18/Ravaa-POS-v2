// Layar Masuk (#/login, 2026-10-11): username + sandi -> token 30 hari.
// Dirender TANPA shell (layar penuh, seperti POS tanpa header). Sukses ->
// wajib-ganti ? #/ubah-sandi : rute bawaan peran (kasir #/pos, pemilik
// #/dashboard). Gagal = toast pesan server, tetap di sini.

import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { masuk, ruteBawaan } from '../ui/auth';

export function renderLoginPage(el: HTMLElement): void {
  el.innerHTML = `
  <div class="flex min-h-full items-center justify-center p-4">
    <div class="card w-full max-w-sm">
      <div class="flex items-center gap-3">
        <img class="brand-logo" src="/logo.png" alt="Logo Ravaa" />
        <div class="min-w-0">
          <h1 class="text-sm font-semibold text-gray-900 dark:text-white">Masuk Ravaa POS</h1>
          <p class="text-xs text-gray-500 dark:text-gray-400">Kasir & pemilik punya akun masing-masing.</p>
        </div>
      </div>
      <form id="login-form" class="mt-4 space-y-3" autocomplete="off">
        <div class="field">
          <label class="label" for="login-user">Username</label>
          <input id="login-user" class="input" autocomplete="username" placeholder="cth: pemilik" />
        </div>
        <div class="field">
          <label class="label" for="login-pass">Sandi</label>
          <input id="login-pass" class="input" type="password" autocomplete="current-password" placeholder="••••••" />
        </div>
        <p id="login-err" class="hidden text-xs font-medium text-red-600 dark:text-red-400"></p>
        <button type="submit" id="login-ok" class="btn btn-primary w-full">Masuk</button>
      </form>
      <p class="mt-3 text-center text-xs text-gray-500 dark:text-gray-400">
        Akun bawaan: <span class="font-mono">pemilik</span> / <span class="font-mono">admin123</span> (wajib diganti saat masuk pertama).
      </p>
    </div>
  </div>`;
  const form = el.querySelector<HTMLFormElement>('#login-form')!;
  const user = el.querySelector<HTMLInputElement>('#login-user')!;
  const pass = el.querySelector<HTMLInputElement>('#login-pass')!;
  const err = el.querySelector<HTMLElement>('#login-err')!;
  const btn = el.querySelector<HTMLButtonElement>('#login-ok')!;
  user.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = user.value.trim();
    const p = pass.value;
    if (!u || !p) {
      err.textContent = 'Username dan sandi wajib diisi.';
      err.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Memeriksa…';
    try {
      const { akun, wajib } = await masuk(u, p);
      toast(`Selamat datang, ${akun.name}`, 'success');
      location.hash = wajib ? '#/ubah-sandi' : ruteBawaan(akun.role);
    } catch (e2) {
      err.textContent = e2 instanceof Error ? e2.message : 'gagal masuk';
      err.classList.remove('hidden');
      pass.value = '';
      pass.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Masuk';
    }
  });
}
