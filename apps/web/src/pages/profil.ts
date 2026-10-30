// Halaman Profil (#/profil, 2026-10-11): edit profil SENDIRI — semua peran.
//
// Isi (keputusan pemilik): **Avatar** (opsional; kosong = inisial / bawaan
// /avatar.png), **Nama**, **Username** (read-only — kunci login, tidak bisa
// diganti), **Email** (opsional), **Sandi** (blok MUNCUL HANYA bila tombol
// "Ubah sandi" diklik: lama + baru + konfirmasi; divalidasi server).
// Blok "Perangkat ini" DIHAPUS dari sini (nama toko/tema = bagian Sistem,
// menyusul) — data perangkat tetap tersimpan, hanya bukan di halaman ini.
//
// Server: POST /api/users/profile {name,email} · POST /api/users/me/avatar
// {image: dataURL|""} · POST /api/users/password {old_password,password} ·
// POST /api/users/pin {pin,old_pin?}.
//
// Paket B5 (2026-10-20): kartu **PIN cepat** + preferensi auto-lock perangkat.
// PIN disimpan server (scrypt); perangkat menyimpan verifier PBKDF2 agar layar
// bisa dibuka saat WiFi mati. Mengganti sandi menghapus PIN (keputusan server).

import { apiPost } from '../api';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { akunTersimpan, profilSaya, type Akun } from '../ui/auth';
import {
  AUTO_LOCK_PILIHAN,
  getAutoLockMenit,
  kunciLayar,
  lupakanVerifier,
  setAutoLockMenit,
  simpanVerifier,
  verifierTersedia,
} from '../ui/lock';
import { initials } from '../ui/user';
import { waktu } from '../ui/waktu';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';



/** Baca berkas gambar -> thumbnail JPEG maksimal 256px sebagai dataURL
 *  (pola kecilkanFoto() produk, ukuran avatar). */
async function kecilkanAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('gambar tidak bisa dibaca'));
      i.src = url;
    });
    const MAX = 256;
    const skala = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * skala));
    const h = Math.max(1, Math.round(img.naturalHeight * skala));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('canvas tidak tersedia');
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}



function kartuPinHtml(akun: Akun | undefined): string {
  const id = akun?.id ?? 0;
  const pinSet = akun?.pin_set === true;
  const auto = getAutoLockMenit();
  const opsi = AUTO_LOCK_PILIHAN.map(
    (o) => `<option value="${o.menit}"${o.menit === auto ? ' selected' : ''}>${o.label}</option>`,
  ).join('');
  const offline = pinSet && verifierTersedia(id);
  return `
      <div class="card" id="pf-pin-card">
        <div class="flex items-start gap-3">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('lock')}</span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">PIN cepat</h3>
              ${
                pinSet
                  ? `<span class="chip bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Aktif</span>`
                  : `<span class="chip">Belum diatur</span>`
              }
            </div>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Kunci layar tanpa keluar akun.${
                akun?.pin_updated_at ? ` Diperbarui ${esc(waktu(akun.pin_updated_at))}.` : ''
              }
            </p>
          </div>
        </div>

        <div class="mt-3 space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
          ${
            pinSet
              ? `<div class="field">
            <label class="label" for="pf-pin-lama">PIN lama *</label>
            <input id="pf-pin-lama" class="input font-mono tracking-[0.35em]" type="password" inputmode="numeric" maxlength="6" autocomplete="off" />
          </div>`
              : ''
          }
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="field">
              <label class="label" for="pf-pin-baru">PIN baru (6 digit) *</label>
              <input id="pf-pin-baru" class="input font-mono tracking-[0.35em]" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" />
            </div>
            <div class="field">
              <label class="label" for="pf-pin-ulang">Ulangi PIN *</label>
              <input id="pf-pin-ulang" class="input font-mono tracking-[0.35em]" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" />
            </div>
          </div>
          <button type="button" id="pf-pin-simpan" class="btn btn-primary w-full">${icon('check')}<span>${pinSet ? 'Ganti PIN' : 'Aktifkan PIN'}</span></button>
        </div>

        <div class="mt-3 field">
          <label class="label" for="pf-autolock">Kunci otomatis perangkat ini</label>
          <select id="pf-autolock" class="input">${opsi}</select>
          <span class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            Layar terkunci setelah tidak ada aktivitas. Berlaku di browser ini saja.
            ${
              pinSet
                ? offline
                  ? ' Kunci offline siap dipakai.'
                  : ' Perangkat ini belum punya kunci offline — buka kunci sekali saat online.'
                : ' Aktifkan PIN dulu agar kunci otomatis berjalan.'
            }
          </span>
        </div>
        <button type="button" id="pf-kunci-sekarang" class="btn btn-outline mt-2 w-full"${pinSet ? '' : ' disabled'}>${icon('lock')}<span>Kunci layar sekarang</span></button>
        <p class="mt-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
          Lupa PIN? Keluar dari layar kunci lalu masuk memakai sandi. Owner juga bisa mereset PIN di halaman Pengguna.
        </p>
      </div>`;
}

export function renderProfilPage(el: HTMLElement): void {
  const akun = akunTersimpan()?.akun;
  const nama = akun?.name ?? '';
  const username = akun?.username ?? '';
  const email = akun?.email ?? '';
  const role = akun?.role === 'owner' ? 'Owner' : 'Kasir';
  const idAkun = akun?.id ?? 0;
  // Avatar tampil: file server bila ada, kalau tidak inisial nama.
  const avatarSrc = akun?.avatar ? `/api/users/${idAkun}/avatar?${Date.now()}` : '';

  el.innerHTML = `
  <div class="space-y-3">
    <div class="card">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Profil Saya</h2>
      <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
        Nama tampil dipakai di header, shift, laporan, dan struk.
      </p>
    </div>

    <div class="grid items-start gap-3 lg:grid-cols-3">
      <div class="card lg:col-span-2">
        <div class="flex flex-wrap items-start gap-4">
          <div id="pf-avatar-wadah" class="shrink-0">
            ${avatarSrc
              ? `<img id="pf-avatar-img" src="${avatarSrc}" alt="Avatar ${esc(nama)}" class="size-20 rounded-full object-cover" />`
              : `<span id="pf-avatar-init" class="avatar avatar-lg !size-20 text-lg">${initials(nama)}</span>`}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">${esc(nama)}</h3>
              <span class="chip">${role}</span>
            </div>
            <p class="mt-0.5 font-mono text-sm text-gray-500 dark:text-gray-400">@${esc(username)}</p>
            <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
              <label class="btn btn-ghost btn-sm relative" for="pf-avatar-file">
                ${icon('upload')}<span>Ganti foto</span>
                <input id="pf-avatar-file" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" />
              </label>
              <button type="button" id="pf-avatar-hapus" class="btn btn-ghost btn-sm !text-red-600 dark:!text-red-400 ${avatarSrc ? '' : 'hidden'}">${icon('trash')}<span>Hapus foto</span></button>
            </div>
            <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
              JPG/PNG/WebP — dikecilkan otomatis ke 256px. Kosong = inisial nama.
            </p>
          </div>
        </div>

        <div class="mt-4 grid gap-3 border-t border-gray-100 pt-3.5 dark:border-gray-700/60 sm:grid-cols-2">
          <div class="field">
            <label class="label" for="pf-name">Nama tampil *</label>
            <input id="pf-name" class="input" maxlength="32" value="${esc(nama)}" placeholder="cth: Budi Santoso" />
          </div>
          <div class="field">
            <label class="label" for="pf-username">Username</label>
            <input id="pf-username" class="input bg-gray-50 font-mono dark:bg-gray-900/40" value="${esc(username)}" readonly tabindex="-1" title="Username adalah kunci login — tidak bisa diganti" />
          </div>
          <div class="field sm:col-span-2">
            <label class="label" for="pf-email">Email (opsional)</label>
            <input id="pf-email" class="input" type="email" maxlength="64" value="${esc(email)}" placeholder="cth: nama@email.com" inputmode="email" />
            <span class="text-xs text-gray-500 dark:text-gray-400">Identitas akun — belum dipakai kirim email.</span>
          </div>
        </div>
        <div class="mt-3 flex justify-end">
          <button type="button" id="pf-simpan" class="btn btn-primary">${icon('check')}<span>Simpan profil</span></button>
        </div>
      </div>

      <div class="space-y-3">
        <div class="card">
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('shieldCheck')}</span>
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Keamanan</h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Sandi login akun ini — username tidak bisa diganti karena jadi kunci login.
              </p>
            </div>
          </div>
          <button type="button" id="pf-toggle-sandi" class="btn btn-outline mt-3 w-full">${icon('pencil')}<span>Ubah sandi</span></button>
          <div id="pf-sandi-blok" class="mt-3 hidden space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
            <div class="field">
              <label class="label" for="pf-lama">Sandi lama *</label>
              <input id="pf-lama" class="input" type="password" autocomplete="current-password" />
            </div>
            <div class="field">
              <label class="label" for="pf-baru">Sandi baru (min. 8 karakter) *</label>
              <input id="pf-baru" class="input" type="password" autocomplete="new-password" />
            </div>
            <div class="field">
              <label class="label" for="pf-ulang">Konfirmasi sandi baru *</label>
              <input id="pf-ulang" class="input" type="password" autocomplete="new-password" />
            </div>
            <button type="button" id="pf-sandi-simpan" class="btn btn-primary w-full">${icon('check')}<span>Simpan sandi baru</span></button>
          </div>
        </div>
        ${kartuPinHtml(akun)}
      </div>
    </div>
  </div>`;

  /* ---------- elemen ---------- */
  const fileEl = el.querySelector<HTMLInputElement>('#pf-avatar-file')!;
  const namaEl = el.querySelector<HTMLInputElement>('#pf-name')!;
  const emailEl = el.querySelector<HTMLInputElement>('#pf-email')!;

  /* ---------- avatar ---------- */
  // Upload/hapus TIDAK me-render ulang halaman: cukup ganti isi
  // #pf-avatar-wadah + tampilkan/sembunyikan tombol hapus, jadi isian form
  // yang sedang diketik tidak terganggu.
  const tampilAvatar = (src: string | null) => {
    const wadah = el.querySelector<HTMLElement>('#pf-avatar-wadah')!;
    wadah.innerHTML = src
      ? `<img id="pf-avatar-img" src="${src}" alt="Avatar" class="size-20 rounded-full object-cover" />`
      : `<span id="pf-avatar-init" class="avatar avatar-lg !size-20 text-lg">${esc(initials(namaEl.value.trim() || nama))}</span>`;
    el.querySelector('#pf-avatar-hapus')?.classList.toggle('hidden', !src);
  };
  fileEl.addEventListener('change', async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await kecilkanAvatar(f);
      await apiPost('/api/users/me/avatar', { image: dataUrl });
      toast('Avatar disimpan', 'success');
      await profilSaya(); // sinkron simpanan + header
      tampilAvatar(`/api/users/${idAkun}/avatar?${Date.now()}`);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    } finally {
      fileEl.value = ''; // file yang sama boleh dipilih ulang
    }
  });
  el.querySelector('#pf-avatar-hapus')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/users/me/avatar', { image: '' });
      toast('Avatar dihapus — kembali ke inisial', 'success');
      await profilSaya();
      tampilAvatar(null);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  /* ---------- PIN cepat & auto-lock (B5) ---------- */
  const pinBaruEl = el.querySelector<HTMLInputElement>('#pf-pin-baru');
  const pinUlangEl = el.querySelector<HTMLInputElement>('#pf-pin-ulang');
  const pinLamaEl = el.querySelector<HTMLInputElement>('#pf-pin-lama');
  const hanyaAngka = (ev: Event): void => {
    const inp = ev.currentTarget as HTMLInputElement;
    inp.value = inp.value.replace(/\D/g, '').slice(0, 6);
  };
  [pinLamaEl, pinBaruEl, pinUlangEl].forEach((inp) => inp?.addEventListener('input', hanyaAngka));
  el.querySelector('#pf-pin-simpan')?.addEventListener('click', async () => {
    const baru = pinBaruEl?.value ?? '';
    const ulang = pinUlangEl?.value ?? '';
    if (!/^\d{6}$/.test(baru)) {
      toast('PIN harus 6 digit angka', 'warning');
      pinBaruEl?.focus();
      return;
    }
    if (baru !== ulang) {
      toast('Ulangi PIN tidak sama', 'warning');
      pinUlangEl?.focus();
      return;
    }
    if (akun?.pin_set && !/^\d{6}$/.test(pinLamaEl?.value ?? '')) {
      toast('PIN lama wajib diisi untuk mengganti PIN', 'warning');
      pinLamaEl?.focus();
      return;
    }
    try {
      const r = await apiPost<{ data: { pin_set: boolean; pin_updated_at: string } }>('/api/users/pin', {
        pin: baru,
        ...(akun?.pin_set ? { old_pin: pinLamaEl?.value ?? '' } : {}),
      });
      await simpanVerifier(idAkun, baru, r.data.pin_updated_at);
      await profilSaya();
      toast(akun?.pin_set ? 'PIN diperbarui' : 'PIN aktif — layar bisa dikunci', 'success');
      renderProfilPage(el);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });
  el.querySelector<HTMLSelectElement>('#pf-autolock')?.addEventListener('change', (ev) => {
    const menit = Number((ev.currentTarget as HTMLSelectElement).value);
    setAutoLockMenit(menit);
    toast(
      menit > 0 ? `Layar terkunci otomatis setelah ${menit} menit tanpa aktivitas` : 'Kunci otomatis dimatikan',
      'info',
    );
  });
  el.querySelector('#pf-kunci-sekarang')?.addEventListener('click', () => kunciLayar());

  /* ---------- identitas ---------- */
  el.querySelector('#pf-simpan')?.addEventListener('click', async () => {
    const v = namaEl.value.trim();
    if (!v) {
      toast('Nama tidak boleh kosong', 'warning');
      namaEl.focus();
      return;
    }
    const emailV = emailEl.value.trim();
    if (emailV && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailV)) {
      toast('Email tidak valid', 'warning');
      emailEl.focus();
      return;
    }
    try {
      await apiPost('/api/users/profile', { name: v, email: emailV });
      await profilSaya(); // nama header ikut (setCashier di dalamnya)
      document.dispatchEvent(new CustomEvent('ravaa:user'));
      toast('Profil disimpan', 'success');
      renderProfilPage(el); // nama/avatar di hero ikut diperbarui
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  /* ---------- sandi (kondisional) ---------- */
  const blokSandi = el.querySelector<HTMLElement>('#pf-sandi-blok')!;
  const lamaEl = el.querySelector<HTMLInputElement>('#pf-lama')!;
  const baruEl = el.querySelector<HTMLInputElement>('#pf-baru')!;
  const ulangEl = el.querySelector<HTMLInputElement>('#pf-ulang')!;
  el.querySelector('#pf-toggle-sandi')?.addEventListener('click', () => {
    blokSandi.classList.toggle('hidden');
    if (!blokSandi.classList.contains('hidden')) lamaEl.focus();
  });
  el.querySelector('#pf-sandi-simpan')?.addEventListener('click', async () => {
    if (!lamaEl.value) { toast('Sandi lama wajib diisi', 'warning'); lamaEl.focus(); return; }
    if (baruEl.value.length < 8) { toast('Sandi baru minimal 8 karakter', 'warning'); baruEl.focus(); return; }
    if (baruEl.value !== ulangEl.value) { toast('Konfirmasi tidak sama dengan sandi baru', 'warning'); ulangEl.focus(); return; }
    try {
      await apiPost('/api/users/password', { old_password: lamaEl.value, password: baruEl.value });
      lupakanVerifier(idAkun);
      await profilSaya(); // PIN server ikut dicabut — kartu PIN harus segar
      toast('Sandi baru tersimpan — PIN cepat ikut dihapus, atur lagi bila perlu', 'success');
      renderProfilPage(el);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });
}
