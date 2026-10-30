// Halaman Pengguna (#/users, 2026-10-11, khusus owner): akun kasir &
// owner — tambah, ubah peran/nama/status, reset sandi, hapus. Guard berat
// (diri sendiri, owner aktif terakhir) ditegakkan SERVER (400) — halaman
// ini hanya menampilkan pesannya. Daftar TIDAK PERNAH memuat hash sandi.
//
// Server: GET /api/users, POST /api/users (tanpa id = baru, id = update
// parsial), POST /api/users/:id/password (reset), DELETE /api/users/:id.
//
// Paket B4/B5 (2026-10-20): editor izin 36 izin operasional + preset, badge
// akses/PIN, dan reset PIN (DELETE /api/users/:id/pin). Empat izin core
// (Pengguna/Pengaturan/Backup/Audit) tidak pernah muncul di sini — tetap
// khusus owner dan ditegakkan `hanyaOwner` di server.

import { apiDelete, apiGet, apiPost } from '../api';
import { icon } from '../ui/icons';
import { confirmDialog } from '../ui/confirm';
import { openModal } from '../ui/modal';
import { toast } from '../ui/toast';
import { akunTersimpan, bersihSesi, type Peran } from '../ui/auth';
import { lupakanVerifier } from '../ui/lock';
import {
  GRUP_IZIN,
  IZIN_KASIR_KETAT,
  IZIN_KASIR_STANDAR,
  IZIN_KASIR_SUPERVISOR,
  IZIN_OPERASIONAL,
  LABEL_IZIN,
  dependenDari,
  dependensiKurang,
  normalisasiIzin,
  rapikanDependensi,
  type Izin,
} from '../ui/izin';
import { pasangAksiBaru } from '../ui/aksi-baru';
import { esc } from '../ui/html';
import { errMsg } from '../ui/http';

type UserRow = {
  id: number;
  username: string;
  name: string;
  role: Peran;
  is_active: number;
  must_change: number;
  created_at: string;
  permissions: string[];
  permissions_custom: boolean;
  pin_set: boolean;
  pin_updated_at: string | null;
};

const state = { items: [] as UserRow[], loading: true, error: '' };
let host: HTMLElement | null = null;

function badgePeran(role: string): string {
  return role === 'owner'
    ? `<span class="badge-dyn">Owner</span>`
    : `<span class="chip">Kasir</span>`;
}

function setIzinSama(a: Iterable<string>, b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size !== y.size) return false;
  for (const k of y) if (!x.has(k)) return false;
  return true;
}

/** Ringkasan akses untuk kolom tabel — cermin `permissions_custom` server. */
function badgeAkses(u: UserRow): string {
  if (u.role === 'owner') return `<span class="chip">Semua (owner)</span>`;
  if (!u.permissions_custom) return `<span class="chip">Standar</span>`;
  if (setIzinSama(u.permissions, IZIN_KASIR_KETAT)) return `<span class="chip">Ketat</span>`;
  if (setIzinSama(u.permissions, IZIN_KASIR_SUPERVISOR))
    return `<span class="chip bg-primary-soft text-primary dark:bg-primary/15 dark:text-[#6aa5ff]">Supervisor</span>`;
  if (!u.permissions.length) return `<span class="chip bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Tanpa izin</span>`;
  return `<span class="chip bg-primary-soft text-primary dark:bg-primary/15 dark:text-[#6aa5ff]">Custom · ${u.permissions.length}</span>`;
}

function badgePin(u: UserRow): string {
  return u.pin_set
    ? `<span class="chip bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">${icon('lock')} Aktif</span>`
    : `<span class="text-xs text-gray-400 dark:text-gray-500">—</span>`;
}

function renderPage(): string {
  return `
  <div class="space-y-3">
    <div class="card">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Pengguna</h2>
          <p class="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Akun kasir & owner. Owner mengatur izin tiap akun; layar kasir
            menyembunyikan aksi yang tidak diizinkan dan server tetap menolaknya.
          </p>
        </div>
        <button type="button" id="usr-new" class="btn btn-primary" title="Tambah pengguna baru (Alt+N)">${icon('plus')}<span>Tambah Pengguna</span><kbd class="kbd">Alt+N</kbd></button>
      </div>
    </div>
    <div id="usr-body"></div>
  </div>`;
}

function renderTable(): string {
  if (state.loading) {
    return `<div class="card"><div class="skel h-6 w-40"></div></div>`;
  }
  if (state.error) {
    return `<div class="card">
      <div class="empty">${icon('alert')}<span>Gagal memuat pengguna: ${esc(state.error)}</span></div>
    </div>`;
  }
  const rows = state.items
    .map(
      (u) => `
      <tr data-row="${u.id}">
        <td class="td">
          <div class="cell-strong">${esc(u.name)}${u.must_change ? ' <span class="text-xs font-medium text-amber-600 dark:text-amber-400">(wajib ganti sandi)</span>' : ''}</div>
          <div class="cell-sub"><span class="font-mono">${esc(u.username)}</span></div>
        </td>
        <td class="td">${badgePeran(u.role)}</td>
        <td class="td">${badgeAkses(u)}</td>
        <td class="td">${badgePin(u)}</td>
        <td class="td">${u.is_active ? '<span class="text-emerald-600 dark:text-emerald-400">Aktif</span>' : '<span class="text-gray-400">Nonaktif</span>'}</td>
        <td class="td">
          <div class="flex items-center justify-end gap-1">
            <button type="button" data-usr-edit="${u.id}" class="row-btn" title="Ubah pengguna & izin" aria-label="Ubah ${esc(u.username)}">${icon('pencil')}</button>
            <button type="button" data-usr-pin="${u.id}" class="row-btn" title="${u.pin_set ? 'Reset PIN (semua sesi diputus)' : 'Akun ini belum punya PIN'}" aria-label="Reset PIN ${esc(u.username)}"${u.pin_set ? '' : ' disabled'}>${icon('lock')}</button>
            <button type="button" data-usr-reset="${u.id}" class="row-btn" title="Reset sandi (target wajib ganti saat masuk)" aria-label="Reset sandi ${esc(u.username)}">${icon('sync')}</button>
            <button type="button" data-usr-del="${u.id}" class="row-btn row-btn-danger" title="Hapus pengguna" aria-label="Hapus ${esc(u.username)}">${icon('trash')}</button>
          </div>
        </td>
      </tr>`,
    )
    .join('');
  return `
  <div class="card-flush">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="th">Pengguna</th>
            <th class="th">Peran</th>
            <th class="th">Akses</th>
            <th class="th">PIN</th>
            <th class="th">Status</th>
            <th class="th text-right">Aksi</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
    Diri sendiri dan owner aktif terakhir dilindungi server — tidak bisa
    diubah perannya, dinonaktifkan, atau dihapus.
  </p>`;
}

function paint(): void {
  const body = host?.querySelector('#usr-body');
  if (body) body.innerHTML = renderTable();
  bindRows();
}

/** Editor izin: 6 grup, 36 kotak centang. Mode `default` = tidak mengirim
 *  `permissions` (server memakai preset role); `custom` = array eksplisit.
 *  Pemilihan disimpan di DOM saja (tidak ada re-render) supaya centang tidak
 *  hilang saat owner berpindah grup.
 *
 *  `ditambahkan` = izin pendukung yang dilengkapi otomatis saat membuka akun
 *  lama yang array izinnya belum memenuhi DEPENDENSI_IZIN. Ditampilkan
 *  terang-terangan — menambah hak akses tanpa memberi tahu owner itu haram. */
function editorIzinHtml(awal: {
  role: Peran;
  izin: string[];
  custom: boolean;
  ditambahkan?: string[];
}): string {
  const terpilih = new Set(awal.izin);
  const grup = GRUP_IZIN.map(
    (g) => `
      <section class="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
        <div class="flex items-baseline justify-between gap-2">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">${esc(g.judul)}</h4>
          <span class="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">${g.items.length} izin</span>
        </div>
        <p class="mt-0.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">${esc(g.ket)}</p>
        <div class="mt-2 space-y-1">
          ${g.items
            .map(
              (i) => `
            <label class="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/40">
              <input type="checkbox" class="mt-0.5 size-4 accent-[var(--color-primary)]" data-izin-kode="${i.kode}"${terpilih.has(i.kode) ? ' checked' : ''} />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-gray-800 dark:text-gray-200">${esc(i.label)}</span>
                <span class="block text-[11px] leading-snug text-gray-500 dark:text-gray-400">${esc(i.ket)}</span>
              </span>
            </label>`,
            )
            .join('')}
        </div>
      </section>`,
  ).join('');
  return `
    <div class="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700" id="u-izin-wrap">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="label !mb-0">Izin akses</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400" id="u-izin-ringkas"></p>
        </div>
        <div class="flex flex-wrap gap-1" id="u-izin-preset">
          <button type="button" class="btn btn-ghost !min-h-[30px] !px-2.5 !py-1 text-xs" data-izin-preset="standar">Standar</button>
          <button type="button" class="btn btn-ghost !min-h-[30px] !px-2.5 !py-1 text-xs" data-izin-preset="ketat">Ketat</button>
          <button type="button" class="btn btn-ghost !min-h-[30px] !px-2.5 !py-1 text-xs" data-izin-preset="supervisor">Supervisor</button>
          <button type="button" class="btn btn-ghost !min-h-[30px] !px-2.5 !py-1 text-xs" data-izin-preset="semua">Semua</button>
          <button type="button" class="btn btn-ghost !min-h-[30px] !px-2.5 !py-1 text-xs" data-izin-preset="kosong">Kosong</button>
        </div>
      </div>
      <p class="mt-2 rounded-lg bg-primary-soft px-3 py-2 text-[11px] leading-relaxed text-primary dark:bg-primary/15 dark:text-[#6aa5ff]" id="u-izin-info">
        Owner selalu punya semua izin. Empat izin inti (Pengguna, Pengaturan,
        Backup, Audit) tetap khusus owner dan tidak bisa dicentang di sini.
        Izin pendukung ikut tercentang otomatis — melepasnya melepas turunannya.
      </p>
      ${awal.ditambahkan?.length
        ? `<p class="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" id="u-izin-repair">
            Data izin akun ini belum lengkap: ${awal.ditambahkan.length} izin pendukung
            (${awal.ditambahkan.map((k) => esc(LABEL_IZIN[k] ?? k)).join(', ')})
            ditambahkan otomatis saat editor dibuka. Periksa centangnya lalu simpan.
          </p>`
        : ''}
      <div class="mt-3 grid gap-2 sm:grid-cols-2" id="u-izin-grid">${grup}</div>
    </div>`;
}

function formSimpan(id: number | null, awal?: UserRow): void {
  const isNew = id === null;
  const roleAwal: Peran = awal?.role ?? 'kasir';
  const izinMentah: Izin[] =
    roleAwal === 'owner'
      ? [...IZIN_OPERASIONAL]
      : awal?.permissions_custom
        ? normalisasiIzin(awal.permissions ?? [])
        : [...IZIN_KASIR_STANDAR];
  // Akun lama bisa menyimpan array yang belum memenuhi dependensi keras
  // (dibuat sebelum peta ini ada). Lengkapi di editor + tampilkan catatan.
  const izinAwal = rapikanDependensi(izinMentah);
  const izinTambahan = izinAwal.filter((k) => !izinMentah.includes(k));
  openModal({
    title: isNew ? 'Tambah Pengguna' : `Ubah Pengguna: ${awal?.username ?? ''}`,
    okLabel: isNew ? 'Tambah' : 'Simpan',
    wider: true,
    body: `
      ${isNew ? `
      <div class="field">
        <label class="label" for="u-username">Username *</label>
        <input id="u-username" class="input font-mono" autocomplete="off" placeholder="cth: kasir1" />
      </div>` : ''}
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="field">
          <label class="label" for="u-name">Nama tampil (nama kasir) *</label>
          <input id="u-name" class="input" value="${esc(awal?.name ?? '')}" placeholder="cth: Budi" />
        </div>
        <div class="field">
          <label class="label" for="u-role">Peran *</label>
          <select id="u-role" class="input">
            <option value="kasir"${roleAwal === 'kasir' ? ' selected' : ''}>Kasir</option>
            <option value="owner"${roleAwal === 'owner' ? ' selected' : ''}>Owner</option>
          </select>
        </div>
      </div>
      ${isNew ? '' : `
      <div class="field">
        <label class="label" for="u-active">Status</label>
        <select id="u-active" class="input">
          <option value="1"${awal?.is_active ? ' selected' : ''}>Aktif</option>
          <option value="0"${awal?.is_active ? '' : ' selected'}>Nonaktif</option>
        </select>
      </div>`}
      <div class="field">
        <label class="label" for="u-pass">Sandi${isNew ? ' * (min. 8 karakter)' : ' (kosongkan bila tidak diganti)'}</label>
        <input id="u-pass" class="input" type="password" autocomplete="new-password" />
      </div>
      ${editorIzinHtml({
        role: roleAwal,
        izin: izinAwal,
        custom: Boolean(awal?.permissions_custom),
        ditambahkan: izinTambahan,
      })}`,
    onMount: ({ el, ok, close }) => {
      const first = el.querySelector<HTMLInputElement>(isNew ? '#u-username' : '#u-name');
      first?.focus();
      const roleEl = el.querySelector<HTMLSelectElement>('#u-role')!;
      const grid = el.querySelector<HTMLElement>('#u-izin-grid')!;
      const ringkas = el.querySelector<HTMLElement>('#u-izin-ringkas')!;
      const preset = el.querySelector<HTMLElement>('#u-izin-preset')!;
      const info = el.querySelector<HTMLElement>('#u-izin-info')!;
      const checks = () => [...grid.querySelectorAll<HTMLInputElement>('input[data-izin-kode]')];
      // `false` = biarkan server memakai default role; `true` = kirim array.
      let custom = Boolean(awal?.permissions_custom) && roleAwal === 'kasir';

      const bacaCentang = (): Izin[] =>
        normalisasiIzin(
          checks()
            .filter((c) => c.checked)
            .map((c) => c.dataset.izinKode ?? ''),
        );
      const tulisCentang = (daftar: readonly string[]): void => {
        const set = new Set(daftar);
        for (const c of checks()) c.checked = set.has(c.dataset.izinKode ?? '');
      };
      const paintRingkas = (): void => {
        const owner = roleEl.value === 'owner';
        grid.querySelectorAll<HTMLInputElement>('input[data-izin-kode]').forEach((c) => {
          c.disabled = owner;
        });
        preset.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
          b.disabled = owner;
        });
        const daftar = bacaCentang();
        const n = daftar.length;
        if (owner) {
          ringkas.textContent = 'Owner — semua izin operasional + seluruh izin inti.';
          info.textContent =
            'Owner selalu punya semua izin. Empat izin inti (Pengguna, Pengaturan, Backup, Audit) tetap khusus owner.';
          return;
        }
        const namaPreset = setIzinSama(daftar, IZIN_KASIR_SUPERVISOR)
          ? 'Supervisor'
          : setIzinSama(daftar, IZIN_KASIR_KETAT)
            ? 'Ketat'
            : null;
        ringkas.textContent = custom
          ? `${namaPreset ? `${namaPreset} — ` : 'Custom — '}${n} dari ${IZIN_OPERASIONAL.length} izin operasional.`
          : `Default role Kasir Standar — ${IZIN_KASIR_STANDAR.length} izin.`;
        info.textContent =
          'Owner selalu punya semua izin. Empat izin inti (Pengguna, Pengaturan, Backup, Audit) tetap khusus owner dan tidak bisa dicentang di sini. Izin pendukung ikut tercentang otomatis — melepasnya melepas turunannya.';
      };

      /** Centang satu izin = seluruh dependensi kerasnya ikut. */
      const centangDenganDependensi = (kode: string): void => {
        if (!kode) return;
        const perlu = new Set<string>(rapikanDependensi([kode]));
        for (const c of checks()) {
          if (perlu.has(c.dataset.izinKode ?? '')) c.checked = true;
        }
      };
      /** Lepas satu izin = seluruh izin yang (langsung/tidak langsung)
       *  membutuhkannya ikut lepas, supaya tak tersisa kombinasi mustahil. */
      const lepasDenganTurunan = (kode: string): void => {
        if (!kode) return;
        const lepas = new Set<string>([kode]);
        const antre = [kode];
        while (antre.length) {
          const k = antre.pop()!;
          for (const d of dependenDari(k)) {
            if (!lepas.has(d)) {
              lepas.add(d);
              antre.push(d);
            }
          }
        }
        for (const c of checks()) {
          if (lepas.has(c.dataset.izinKode ?? '')) c.checked = false;
        }
      };

      checks().forEach((c) =>
        c.addEventListener('change', () => {
          custom = true;
          const kode = c.dataset.izinKode ?? '';
          if (c.checked) centangDenganDependensi(kode);
          else lepasDenganTurunan(kode);
          paintRingkas();
        }),
      );
      preset.querySelectorAll<HTMLButtonElement>('[data-izin-preset]').forEach((b) =>
        b.addEventListener('click', () => {
          if (roleEl.value === 'owner') return;
          const jenis = b.dataset.izinPreset;
          if (jenis === 'standar') {
            custom = false;
            tulisCentang(IZIN_KASIR_STANDAR);
          } else if (jenis === 'ketat') {
            custom = true;
            tulisCentang(IZIN_KASIR_KETAT);
          } else if (jenis === 'supervisor') {
            custom = true;
            tulisCentang(IZIN_KASIR_SUPERVISOR);
          } else if (jenis === 'semua') {
            custom = true;
            tulisCentang(IZIN_OPERASIONAL);
          } else {
            custom = true;
            tulisCentang([]);
          }
          paintRingkas();
        }),
      );
      // Ganti peran kasir -> owner: visual langsung dikunci. Owner -> kasir:
      // kembali ke default Standar (izin lama owner tidak diwariskan diam-diam).
      roleEl.addEventListener('change', () => {
        if (roleEl.value === 'owner') {
          tulisCentang(IZIN_OPERASIONAL);
        } else {
          custom = false;
          tulisCentang(IZIN_KASIR_STANDAR);
        }
        paintRingkas();
      });
      paintRingkas();

      ok.addEventListener('click', async () => {
        try {
          const role = roleEl.value as Peran;
          const payload: Record<string, unknown> = {
            ...(id === null ? {} : { id }),
            ...(isNew ? { username: (el.querySelector('#u-username') as HTMLInputElement).value.trim() } : {}),
            name: (el.querySelector('#u-name') as HTMLInputElement).value.trim(),
            role,
            ...(!isNew ? { is_active: (el.querySelector('#u-active') as HTMLSelectElement).value === '1' ? 1 : 0 } : {}),
          };
          if (role === 'kasir') {
            // Default = null (server memakai preset role); custom = array.
            if (!custom) {
              payload.permissions = null;
            } else {
              const dipilih = rapikanDependensi(bacaCentang());
              const kurang = dependensiKurang(dipilih);
              if (kurang.length) {
                const k = kurang[0];
                toast(
                  `Izin ${LABEL_IZIN[k.izin] ?? k.izin} butuh ${k.butuh.map((x) => LABEL_IZIN[x] ?? x).join(', ')}`,
                  'warning',
                );
                return;
              }
              payload.permissions = dipilih;
            }
          } else {
            payload.permissions = null;
          }
          const pw = (el.querySelector('#u-pass') as HTMLInputElement).value;
          if (isNew || pw) payload.password = pw;
          await apiPost('/api/users', payload);
          close();
          toast(isNew ? 'Pengguna ditambahkan (wajib ganti sandi saat masuk pertama)' : 'Pengguna disimpan', 'success');
          await load();
        } catch (e) {
          toast(`Gagal: ${errMsg(e)}`, 'error');
        }
      });
    },
  });
}

function bindRows(): void {
  host!.querySelectorAll<HTMLElement>('[data-usr-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrEdit));
      if (u) formSimpan(u.id, u);
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-usr-reset]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrReset));
      if (!u) return;
      openModal({
        title: `Reset sandi: ${u.username}`,
        okLabel: 'Reset',
        body: `
          <div class="field">
            <label class="label" for="u-newpass">Sandi baru (min. 8 karakter)</label>
            <input id="u-newpass" class="input" type="password" autocomplete="new-password" />
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Semua sesi perangkat akun ini diputus — yang bersangkutan masuk ulang lalu wajib menggantinya lagi.
          </p>`,
        onMount: ({ el, ok, close }) => {
          const inp = el.querySelector<HTMLInputElement>('#u-newpass')!;
          inp.focus();
          ok.addEventListener('click', async () => {
            try {
              await apiPost(`/api/users/${u.id}/password`, { password: inp.value });
              close();
              lupakanVerifier(u.id);
              if (akunTersimpan()?.akun.id === u.id) {
                toast('Sandi direset — sesi ini ikut berakhir. Silakan masuk ulang.', 'success');
                bersihSesi();
                location.hash = '#/login';
                return;
              }
              toast(`Sandi ${u.username} di-reset`, 'success');
              await load();
            } catch (e) {
              toast(`Gagal: ${errMsg(e)}`, 'error');
            }
          });
        },
      });
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-usr-pin]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrPin));
      if (!u || !u.pin_set) return;
      const saya = akunTersimpan()?.akun;
      const diri = saya?.id === u.id;
      const yes = await confirmDialog({
        title: `Reset PIN ${u.username}?`,
        message: diri
          ? 'PIN Anda dihapus dan SEMUA sesi akun ini diputus, termasuk perangkat yang sedang dipakai. Anda harus masuk ulang dengan sandi.'
          : 'PIN dihapus dan semua sesi akun ini diputus. Yang bersangkutan harus masuk ulang dengan sandi, lalu bisa membuat PIN baru di Profil.',
        okLabel: 'Reset PIN',
        cancelLabel: 'Batal',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/users/${u.id}/pin`);
        lupakanVerifier(u.id);
        if (diri) {
          toast('PIN dihapus — sesi ini ikut berakhir. Silakan masuk ulang.', 'success');
          bersihSesi();
          location.hash = '#/login';
          return;
        }
        toast(`PIN ${u.username} direset — sesi akun itu diputus`, 'success');
        await load();
      } catch (e) {
        toast(`Gagal reset PIN: ${errMsg(e)}`, 'error');
      }
    }),
  );
  host!.querySelectorAll<HTMLElement>('[data-usr-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = state.items.find((x) => x.id === Number(b.dataset.usrDel));
      if (!u) return;
      const yes = await confirmDialog({
        title: `Hapus pengguna "${u.username}"?`,
        message: 'Sesi di semua device ikut diputus. Riwayat shift/laporan atas nama ini tetap tersimpan.',
        okLabel: 'Hapus',
        cancelLabel: 'Batal, jangan dihapus',
        danger: true,
      });
      if (!yes) return;
      try {
        await apiDelete(`/api/users/${u.id}`);
        toast(`Pengguna "${u.username}" dihapus`, 'success');
        await load();
      } catch (e) {
        toast(`Gagal hapus: ${errMsg(e)}`, 'error');
      }
    }),
  );
}

/** Muat ulang daftar + segarkan header bila AKUN SENDIRI diubah (nama/peran):
 *  header (avatar/nama) membaca simpanan perangkat, bukan server langsung —
 *  `profilSaya()` menyinkronkan + event `ravaa:user` mengecat ulang header. */
async function load(): Promise<void> {
  const sebelum = akunTersimpan()?.akun;
  paint();
  try {
    const r = await apiGet<{ data: UserRow[] }>('/api/users');
    state.items = r.data;
  } catch (e) {
    state.error = errMsg(e);
  }
  state.loading = false;
  if (host?.isConnected) paint();
  const sesudah = akunTersimpan()?.akun;
  if (sesudah && sebelum && (sesudah.name !== sebelum.name || sesudah.role !== sebelum.role)) {
    const { profilSaya } = await import('../ui/auth');
    await profilSaya();
    document.dispatchEvent(new CustomEvent('ravaa:user'));
  }
}

export async function mountUsersPage(el: HTMLElement): Promise<void> {
  host = el;
  el.innerHTML = renderPage();
  paint();
  const bukaBaru = () => formSimpan(null);
  el.querySelector('#usr-new')?.addEventListener('click', bukaBaru);
  // Alt+N = pintasan tombol yang sama (ui/aksi-baru.ts).
  pasangAksiBaru(bukaBaru);
  await load();
}
