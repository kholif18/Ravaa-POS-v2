// Pintasan Alt+N "buat baru" (2026-10-18, permintaan pemilik: "tambahkan
// shortcut setiap halaman yang ada buat baru ... menggunakan Alt + N untuk
// membuka modal buat baru atau masuk ke halaman buat baru pada masing-masing
// tampilan guna mempercepat kinerja").
//
// Registry, BUKAN listener per halaman: hanya SATU aksi aktif — halaman yang
// sedang tampil mendaftarkan aksinya lewat pasangAksiBaru() dari mount-nya,
// dan router (main.ts) memanggil resetAksiBaru() setiap navigasi supaya aksi
// halaman lama tidak bocor ke halaman baru. Listener keydown dipasang SEKALI
// di sini (capture) — halaman TIDAK boleh menambah listener Alt+N sendiri.
//
// Guard dialog: modal repo (.modal-overlay) / SweetAlert terbuka = abaikan,
// supaya Alt+N saat form buat baru sedang tampil tidak menumpuk modal kedua.

let aksiAktif: (() => void) | null = null;

/** Daftarkan aksi "buat baru" halaman ini — panggil dari mountXPage, tepat di
 *  samping binding tombol buat barunya supaya perilakunya identik. */
export function pasangAksiBaru(fn: () => void): void {
  aksiAktif = fn;
}

/** Buang aksi — dipanggil router tiap navigasi (main.ts render()). */
export function resetAksiBaru(): void {
  aksiAktif = null;
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // `code` sebagai cadangan: sebagian layout mengubah `key` jadi karakter
    // lain saat Alt ditahan (mis. Option di macOS) — KeyN tetap 'KeyN'.
    if (e.key.toLowerCase() !== 'n' && e.code !== 'KeyN') return;
    if (e.repeat) return;
    if (document.querySelector('.modal-overlay:not(.is-closing)')) return;
    if (document.querySelector('.swal2-popup')) return;
    if (!aksiAktif) return;
    e.preventDefault();
    aksiAktif();
  },
  true,
);
