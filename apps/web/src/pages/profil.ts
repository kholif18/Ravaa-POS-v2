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
// {image: dataURL|""} · POST /api/users/password {old_password,password}.
// Avatar file di img/ sebelah DB; img tag membaca GET /api/users/:id/avatar
// (pengecualian token — sama dengan foto produk).

import { apiPost, HttpError } from '../api';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { akunTersimpan, profilSaya } from '../ui/auth';
import { initials } from '../ui/user';

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

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

export function renderProfilPage(el: HTMLElement): void {
  const akun = akunTersimpan()?.akun;
  const nama = akun?.name ?? '';
  const username = akun?.username ?? '';
  const email = akun?.email ?? '';
  const role = akun?.role === 'pemilik' ? 'Owner' : 'Kasir';
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

    <div class="card">
      <p class="form-sec">Avatar</p>
      <div class="flex items-center gap-4">
        ${avatarSrc
          ? `<img id="pf-avatar-img" src="${avatarSrc}" alt="Avatar ${nama}" class="size-20 rounded-full object-cover" />`
          : `<span id="pf-avatar-init" class="avatar avatar-lg !size-20 text-lg">${initials(nama)}</span>`}
        <div class="min-w-0 space-y-1.5">
          <input id="pf-avatar-file" class="input input-sm !w-auto text-sm" type="file" accept="image/jpeg,image/png,image/webp" />
          <p class="text-xs text-gray-500 dark:text-gray-400">
            JPG/PNG/WebP — dikecilkan otomatis ke 256px. Kosong = inisial nama.
          </p>
          ${avatarSrc ? `<button type="button" id="pf-avatar-hapus" class="btn btn-ghost !min-h-[30px] !px-2.5 text-xs">${icon('trash')}<span>Hapus avatar</span></button>` : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <p class="form-sec">Identitas</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="pf-name">Nama tampil *</label>
          <input id="pf-name" class="input" maxlength="32" value="${nama}" placeholder="cth: Budi Santoso" />
        </div>
        <div class="field">
          <label class="label" for="pf-username">Username</label>
          <input id="pf-username" class="input font-mono bg-gray-50 dark:bg-gray-900/40" value="${username}" readonly tabindex="-1" title="Username adalah kunci login — tidak bisa diganti" />
        </div>
      </div>
      <div class="field">
        <label class="label" for="pf-email">Email (opsional)</label>
        <input id="pf-email" class="input" type="email" maxlength="64" value="${email}" placeholder="cth: nama@email.com" inputmode="email" />
        <span class="text-xs text-gray-500 dark:text-gray-400">Identitas akun — belum dipakai kirim email.</span>
      </div>
      <button type="button" id="pf-simpan" class="btn btn-primary mt-2">${icon('check')}<span>Simpan profil</span></button>
    </div>

    <div class="card">
      <p class="form-sec">Keamanan</p>
      <button type="button" id="pf-toggle-sandi" class="btn btn-ghost">${icon('pencil')}<span>Ubah sandi</span></button>
      <div id="pf-sandi-blok" class="mt-3 hidden space-y-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
        <div class="field">
          <label class="label" for="pf-lama">Sandi lama *</label>
          <input id="pf-lama" class="input" type="password" autocomplete="current-password" />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="field">
            <label class="label" for="pf-baru">Sandi baru (min. 4 karakter) *</label>
            <input id="pf-baru" class="input" type="password" autocomplete="new-password" />
          </div>
          <div class="field">
            <label class="label" for="pf-ulang">Konfirmasi sandi baru *</label>
            <input id="pf-ulang" class="input" type="password" autocomplete="new-password" />
          </div>
        </div>
        <button type="button" id="pf-sandi-simpan" class="btn btn-primary">${icon('check')}<span>Simpan sandi baru</span></button>
      </div>
    </div>
  </div>`;

  /* ---------- avatar ---------- */
  const tampilAvatar = (src: string | null) => {
    const wadah = el.querySelector('.card .flex.items-center.gap-4')!;
    if (src) {
      wadah.innerHTML = `<img id="pf-avatar-img" src="${src}" alt="Avatar" class="size-20 rounded-full object-cover" />`;
    } else {
      wadah.innerHTML = `<span id="pf-avatar-init" class="avatar avatar-lg !size-20 text-lg">${initials(namaEl.value.trim() || nama)}</span>`;
    }
  };
  const fileEl = el.querySelector<HTMLInputElement>('#pf-avatar-file')!;
  fileEl?.addEventListener('change', async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await kecilkanAvatar(f);
      const r = await apiPost<{ data: { avatar: string | null } }>('/api/users/me/avatar', { image: dataUrl });
      toast('Avatar disimpan', 'success');
      await profilSaya(); // sinkron simpanan + header
      tampilAvatar(`/api/users/${idAkun}/avatar?${Date.now()}`);
      if (!el.querySelector('#pf-avatar-hapus')) {
        // tombol hapus baru relevan setelah ada avatar — muat ulang halaman
        // ringan: cukup reload render halaman ini.
        renderProfilPage(el);
      }
      void r;
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });
  el.querySelector('#pf-avatar-hapus')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/users/me/avatar', { image: '' });
      toast('Avatar dihapus — kembali ke inisial', 'success');
      await profilSaya();
      renderProfilPage(el);
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });

  /* ---------- identitas ---------- */
  const namaEl = el.querySelector<HTMLInputElement>('#pf-name')!;
  const emailEl = el.querySelector<HTMLInputElement>('#pf-email')!;
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
    if (baruEl.value.length < 4) { toast('Sandi baru minimal 4 karakter', 'warning'); baruEl.focus(); return; }
    if (baruEl.value !== ulangEl.value) { toast('Konfirmasi tidak sama dengan sandi baru', 'warning'); ulangEl.focus(); return; }
    try {
      await apiPost('/api/users/password', { old_password: lamaEl.value, password: baruEl.value });
      toast('Sandi baru tersimpan', 'success');
      lamaEl.value = '';
      baruEl.value = '';
      ulangEl.value = '';
      blokSandi.classList.add('hidden');
    } catch (e) {
      toast(`Gagal: ${errMsg(e)}`, 'error');
    }
  });
}
