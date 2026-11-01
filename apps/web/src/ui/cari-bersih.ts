// Tombol × hapus-pencarian lintas browser (2026-11-01, laporan pemilik:
// *"kenapa di Firefox tidak ada tombol x seperti di Chrome?"* — kolom cari
// halaman Produk; halaman Stok sama).
//
// Tombol × yang terlihat di Chrome pada `input[type=search]` BUKAN milik
// aplikasi: itu pseudo-element bawaan WebKit/Blink
// `::-webkit-search-cancel-button`, digambar sendiri oleh browser.
// Firefox/Gecko TIDAK PERNAH mengimplementasikannya — diuji 2026-11-01 dengan
// file HTML yang sama di Chrome headless dan Firefox (playwright firefox-1543):
// Chrome menampilkan ×, Firefox menampilkan input polos tanpa apa pun. Jadi di
// Firefox kolom cari cuma bisa dikosongkan hapus manual, sementara di Chrome
// × bawaannya juga tidak konsisten bentuk/tipenya antar browser.
//
// Karena itu × digambar aplikasi sendiri (pola `#set-cari-hapus` halaman
// Sistem) supaya sama di SEMUA browser; × bawaan Chrome disembunyikan CSS
// lewat kelas `has-clear` (lihat `styles/forms.css`) supaya tidak dobel.
//
// Pemakaian: panggil dari tempat yang SAMA dengan binding `input` halaman
// (biasanya `bind()`) — supaya ikut dipasang ulang bila toolbar di-render
// ulang seperti halaman Stok (paint tiap ketikan) / Laporan / Pesanan.
// IDEMPOTEN: input yang sudah dipasang ditandai, jadi dipanggil berulang pada
// DOM yang sama aman (tidak menumpuk tombol/listener).
//
// Sengaja TIDAK dipakai di POS (`#pos-q` scan, `#pc-q` cari produk F3,
// `#pcust-q` cari pelanggan F9, scan mobile): kolom scan memuat lapisan lain
// (badge <kbd>F1</kbd>, tombol kamera) dan kontrak id/kelasnya dijaga suite
// POS — cara mengosongkan scan di POS tetap Esc / F5 / hapus manual.
import { icon } from './icons';

/** Penanda per input supaya pemasangan kedua tidak menggandakan tombol. */
const TANDA = '__cariBersih';

type InputBertanda = HTMLInputElement & { [TANDA]?: boolean };

/**
 * Pasang tombol × pada SEMUA `input[type=search]` di dalam `root` yang belum
 * punya. Tombol muncul hanya saat kolom terisi, diklik = kosongkan + kirim
 * event `input` (supaya filter halaman jalan persis seperti ketik) + fokus
 * balik ke kolom cari.
 *
 * Urutan di handler: `focus()` SEBELUM dispatch — di halaman yang me-render
 * ulang toolbar saat filter (Stok), paint membaca `document.activeElement`
 * untuk memulihkan fokus; bila fokus sudah pindah ke tombol (atau tombol ikut
 * terbuang paint), kolom cari baru kehilangan fokus dan ketikan berikutnya
 * terbuang diam-diam.
 */
export function pasangCariBersih(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[type="search"]').forEach((input) => {
    const bertanda = input as InputBertanda;
    if (bertanda[TANDA]) return;
    const wrap = input.parentElement;
    if (!wrap) return;

    const tombol = document.createElement('button');
    tombol.type = 'button';
    tombol.className = 'cari-x';
    tombol.title = 'Hapus pencarian';
    tombol.setAttribute('aria-label', 'Hapus pencarian');
    tombol.innerHTML = icon('close');

    const sinkron = () => tombol.classList.toggle('hidden', input.value === '');
    input.addEventListener('input', sinkron);
    tombol.addEventListener('click', () => {
      input.value = '';
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    sinkron();
    wrap.appendChild(tombol);
    bertanda[TANDA] = true;
    input.classList.add('has-clear');
  });
}
