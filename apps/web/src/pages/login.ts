// Layar Masuk (#/login, 2026-10-11): username + sandi -> token 30 hari.
// Dirender TANPA shell (layar penuh, seperti POS tanpa header). Sukses ->
// wajib-ganti ? #/ubah-sandi : rute bawaan peran (kasir #/pos, owner
// #/dashboard). Gagal = toast pesan server, tetap di sini.

import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { masuk, ruteBawaan } from '../ui/auth';

export function renderLoginPage(el: HTMLElement): void {
  // Gaya "Sandik" (2026-10-12): latar GRADASI BIRU modern 135deg + ornamen
  // lingkaran glassmorphism + kartu kaca putih/5. Kelas .login-bg/.login-card-glass
  // didefinisikan di styles.css (token tetap dari @theme — biru primary).
  el.innerHTML = `
  <div class="login-bg">
    <span class="login-orb login-orb-1" aria-hidden="true"></span>
    <span class="login-orb login-orb-2" aria-hidden="true"></span>
    <span class="login-orb login-orb-3" aria-hidden="true"></span>
    <div class="flex min-h-full items-center justify-center p-4">
      <div class="login-card-glass w-full max-w-sm">
        <div class="flex items-center gap-3">
          <span class="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white">
            ${icon('pos')}
          </span>
          <div class="min-w-0">
            <h1 class="text-sm font-semibold text-white">Masuk Ravaa POS</h1>
            <p class="text-xs text-white/70">Kasir & owner punya akun masing-masing.</p>
          </div>
        </div>
        <form id="login-form" class="mt-5 space-y-3" autocomplete="off">
          <div class="field">
            <label class="label !text-white/75" for="login-user">Username</label>
            <input id="login-user" class="input login-input" autocomplete="username" placeholder="cth: owner" />
          </div>
          <div class="field">
            <label class="label !text-white/75" for="login-pass">Sandi</label>
            <input id="login-pass" class="input login-input" type="password" autocomplete="current-password" placeholder="••••••" />
          </div>
          <p id="login-err" class="hidden text-xs font-medium text-amber-200"></p>
          <button type="submit" id="login-ok" class="btn btn-primary w-full !bg-white !text-primary hover:!bg-white/90 hover:!-translate-y-px">Masuk</button>
        </form>
        <p class="mt-4 text-center text-xs text-white/60">
          Akun bawaan: <span class="font-mono">owner</span> / <span class="font-mono">admin123</span> (wajib diganti saat masuk pertama).
        </p>
      </div>
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
