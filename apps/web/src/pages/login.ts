// Layar Masuk (#/login, 2026-10-11): username + sandi -> token 30 hari.
// Dirender TANPA shell (layar penuh, seperti POS tanpa header). Sukses ->
// wajib-ganti ? #/ubah-sandi : rute bawaan peran (kasir #/pos, owner
// #/dashboard). Gagal = pesan di kotak galat, tetap di sini.
//
// Restyle 2026-10-17 (permintaan pemilik "layout halaman login jadi lebih
// responsif dan modern"): kerangka dipindah ke authLayarHtml()
// (ui/auth-screen.ts, dibagi dengan ubah-sandi) — gradasi full-bleed,
// center vertikal, 2 kolom di desktop. ID #login-form/#login-user/
// #login-pass/#login-err/#login-ok dipertahankan (kontrak
// tests/login-test.mjs).
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { masuk, ruteBawaan } from '../ui/auth';
import { authLayarHtml } from '../ui/auth-screen';

export function renderLoginPage(el: HTMLElement): void {
  el.innerHTML = authLayarHtml(`
    <div class="min-w-0">
      <h1 class="text-sm font-semibold text-white">Masuk</h1>
      <p class="mt-0.5 text-xs text-white/70">Kasir &amp; owner punya akun masing-masing.</p>
    </div>
    <form id="login-form" class="mt-5 space-y-3" autocomplete="off">
      <div class="field">
        <label class="label !text-white/75" for="login-user">Username</label>
        <div class="login-field">
          ${icon('user')}
          <input id="login-user" class="input login-input pl-9" autocomplete="username" placeholder="cth: owner" spellcheck="false" autocapitalize="off" autocorrect="off" />
        </div>
      </div>
      <div class="field">
        <label class="label !text-white/75" for="login-pass">Sandi</label>
        <div class="login-field">
          ${icon('lock')}
          <input id="login-pass" class="input login-input pl-9 pr-10" type="password" autocomplete="current-password" placeholder="••••••" />
          <button type="button" id="login-pass-toggle" class="login-toggle" aria-label="Tampilkan sandi" aria-pressed="false">${icon('eye')}</button>
        </div>
      </div>
      <p id="login-err" class="login-err hidden" role="alert"></p>
      <button type="submit" id="login-ok" class="btn login-btn w-full">Masuk</button>
    </form>
    ${import.meta.env.VITE_DEMO_MODE === 'true'
      ? `<p class="mt-4 border-t border-white/10 pt-3 text-center text-xs leading-relaxed text-white/60">
          Akun demo: <span class="font-mono text-white/85">demo</span> / <span class="font-mono text-white/85">demo</span>
        </p>`
      : ''}
`);
  const form = el.querySelector<HTMLFormElement>('#login-form')!;
  const user = el.querySelector<HTMLInputElement>('#login-user')!;
  const pass = el.querySelector<HTMLInputElement>('#login-pass')!;
  const err = el.querySelector<HTMLElement>('#login-err')!;
  const btn = el.querySelector<HTMLButtonElement>('#login-ok')!;
  // Tombol lihat sandi: tipe/ikon/aria berubah, fokus balik ke input supaya
  // alur keyboard (tab → ketik → Enter) tidak terputus.
  const toggle = el.querySelector<HTMLButtonElement>('#login-pass-toggle')!;
  toggle.addEventListener('click', () => {
    const tampil = pass.type === 'password';
    pass.type = tampil ? 'text' : 'password';
    toggle.innerHTML = icon(tampil ? 'eyeOff' : 'eye');
    toggle.setAttribute('aria-label', tampil ? 'Sembunyikan sandi' : 'Tampilkan sandi');
    toggle.setAttribute('aria-pressed', String(tampil));
    pass.focus();
  });
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
      location.hash = wajib ? '#/ubah-sandi' : ruteBawaan(akun);
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
