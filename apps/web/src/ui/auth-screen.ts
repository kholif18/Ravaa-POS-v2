// Kerangka layar auth (login & ubah-sandi) — SATU sumber markup, pola sama
// dengan shift-tutup.ts (modul bersama antar-halaman). Dipanggil login.ts +
// ubah-sandi.ts; gaya .login-*/.auth-* ada di styles.css bagian "Layar auth".
//
// Layout 2026-10-17 (permintaan pemilik "layout halaman login jadi lebih
// responsif dan modern"):
// - `.page:has(.login-bg)` di styles.css membuang padding halaman → gradasi
//   biru FULL-BLEED (dulu tampak bingkai canvas 10-12px).
// - `.login-wrap` = grid 1 kolom di HP (brand ringkas di atas kartu) /
//   2 kolom di >=lg (brand kiri, kartu kanan), `m-auto` sehingga isi SELALU
//   center vertikal (kartu lama terukur mentok atas top≈28px).
import { icon } from './icons';

export function authLayarHtml(kartu: string): string {
  return `
  <div class="login-bg">
    <span class="login-orb login-orb-1" aria-hidden="true"></span>
    <span class="login-orb login-orb-2" aria-hidden="true"></span>
    <span class="login-orb login-orb-3" aria-hidden="true"></span>
    <div class="login-wrap">
      <aside class="min-w-0">
        <div class="flex items-center gap-3">
          <span class="login-logo size-12">${icon('pos')}</span>
          <div class="min-w-0">
            <p class="text-sm font-bold tracking-tight text-white">Ravaa POS</p>
            <p class="truncate text-xs text-white/60">Sistem kasir toko &amp; layanan</p>
          </div>
        </div>
        <div class="hidden lg:block">
          <h2 class="auth-judul mt-10 text-white">Jualan cepat, stok dan laporan tetap rapi.</h2>
          <p class="mt-3 max-w-md text-xs leading-relaxed text-white/70">
            ATK, cetak &amp; desain, jasa, topup/tarik, es krim, snack — keranjang,
            shift kasir, sampai struk thermal &amp; invoice A4 dalam satu aplikasi.
          </p>
          <ul class="mt-8 space-y-3">
            <li class="login-point">${icon('zap')}<span><b class="font-semibold text-white/90">Kasir cepat</b> — scan / ketik kode, bayar tunai, QRIS, atau transfer.</span></li>
            <li class="login-point">${icon('stock')}<span><b class="font-semibold text-white/90">Stok &amp; hutang rapi</b> — peringatan stok menipis, kadaluarsa, dan piutang pelanggan.</span></li>
            <li class="login-point">${icon('print')}<span><b class="font-semibold text-white/90">Cetak lengkap</b> — struk thermal 58mm, invoice A4, label harga, dan rekap shift.</span></li>
          </ul>
        </div>
        <p class="mt-8 hidden text-xs text-white/45 lg:block">Ravaa POS v2 — data tersimpan di perangkat toko &amp; bisa dicadangkan.</p>
      </aside>
      <div class="login-card-glass">${kartu}</div>
    </div>
  </div>`;
}
