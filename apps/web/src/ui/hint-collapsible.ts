/** hintCollapsible — pembungkus teks bantuan panjang di form produk.
 *
 *  Perilaku akhir (revisi 2026-10-31, permintaan pemilik):
 *  - Mobile (<1024px): seluruh blok DISembunyikan via CSS (components.css,
 *    media query) — "pada tampilan mobile tidak perlu banyak bacaan".
 *  - Desktop (>=1024px): tampil sebagai paragraf hint biasa (class `hint`
 *    dipasang di konten supaya selector test `.modal .hint` tetap menemukannya).
 *
 *  Catatan sejarah: versi pertama memakai <details>/<summary> yang bisa
 *  dilipat di mobile. Dibuang karena (1) isinya tidak pernah terlihat di
 *  desktop (trik display:block !important kalah oleh penyembunyian bawaan
 *  <details> tertutup di Chrome — 3 suite e2e merah), (2) baris ringkasan
 *  "? Label ▼" di mobile justru dianggap bacaan oleh pemilik. Struktur div
 *  polos + class lama dipertahankan agar CSS/test tidak perlu dirombak.
 *
 *  Usage: hintCollapsible({ label: 'Harga Grosir', children: 'Teks panjang...' })
 */

export interface HintCollapsibleProps {
  /** Nama seksi untuk aria-label (mis. 'Harga Grosir', 'Satuan Jual') */
  label: string;
  /** Isi hint (HTML string) */
  children: string;
  /** Kelas tambahan untuk container */
  className?: string;
}

/** Render hint sebagai string HTML. */
export function hintCollapsible({
  label,
  children,
  className = '',
}: HintCollapsibleProps): string {
  const cls = `hint-collapsible ${className}`.trim();
  return `<div class="${cls}" role="note" aria-label="Bantuan: ${escapeHtml(label)}">
  <div class="hint-collapsible-content hint">${children}</div>
</div>`;
}

/** Escape HTML sederhana untuk atribut. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#039;');
}
