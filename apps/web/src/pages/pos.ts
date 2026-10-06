// Layar Kasir (POS).
//
// SENGJAJA TIDAK ADA GRID PRODUK. Layar ini hanya keranjang; produk masuk lewat
// satu input scan/ketik (barcode -> SKU -> nama) — termasuk sintaks `Qty*Kode`
// ("3*PRD00001" = 3 pcs, lihat bacaQtyKode()) — karena di toko alat tulis
// kasir bekerja dengan scanner barcode yang memperlakukan dirinya sebagai
// keyboard, dan grid tile justru memperlambat input cepat.
//
// Alur:
//   1. Gate shift: kalau kasir ini belum punya shift open, form buka shift dulu
//      (POST /api/shifts/open). Server yang menolak dobel lewat UNIQUE INDEX,
//      jadi 409 itu jawaban normal, bukan bug.
//   2. Keranjang: tambah item, ubah qty, hapus; ↑↓ pindah antar baris
//      (pindahBarisKeranjang — baris catatan dilewati).
//   3. Bayar: POST /api/sales (idempotent per uuid). Isian bayar ada di
//      FORM BAYAR (modal, bukaBayar — putaran 10: layout 2 panel ala Ravaa
//      POS v1, lihat formBayarHtml()) — side panel hanya tombol Bayar F10 dan
//      Bayar pas F12 (tepat di bawahnya). Uang kurang / uang 0 = HUTANG
//      OTOMATIS (putaran 12) asal pelanggan terpilih bukan bawaan
//      "Pelanggan Umum" (lihat pay() + cekHutangDiperbolehkan()).
//
// Pintasan level document (bindPintasan): F2 bayar, F3 cari, F4 qty
// berikutnya, F5 bersihkan, F6 diskon transaksi, F7 tahan, F8 fokus kolom
// scan, F10 buka form bayar, F12 bayar pas, Enter bayar, Esc fokus ke scan.
// Swal terbuka (konfirmasi/pilihan cetak) menahan SEMUA pintasan; form bayar
// yang terbuka hanya mengizinkan F2/F10/F12.
//
// Data produk dibaca dari cache IndexedDB (store.ts) — bukan fetch per ketikan.
// Cache kasir hanya berisi is_active=1 (see AGENTS.md §3), jadi produk
// nonaktif tidak mungkin masuk keranjang.

import { apiGet, apiPost, uuid, HttpError } from '../api';
import { getCachedProducts, syncMaster, getHolds, saveHolds, type Product } from '../store';
import { getCashier, getToko } from '../ui/user';
import { switchHtml } from '../ui/switch';
import { getAutoPrint, setAutoPrint, setStrukLayout } from '../ui/print-pref';
import { kirimPrint, strukUntuk, type Struk } from '../escpos';
import { cetakInvoice } from '../invoice';
import { choiceDialog, confirmDialog } from '../ui/confirm';
import { toast } from '../ui/toast';
import { openModal, type ModalHandle } from '../ui/modal';
import { icon, type IconName } from '../ui/icons';
import { AMBAT_EXPIRY, statusExpiry, tglExpiry } from '../ui/expiry';

/* ---------- tipe ---------- */

type Shift = {
  id: number; opened_at: string; closed_at: string | null;
  modal_awal: number; modal_akhir: number | null; cashier: string; status: string;
};

/** Baris keranjang. `product_id` null = item manual (jasa/cetak). */
type CartLine = {
  key: string;              // `<id produk>:<unit>`, atau 'manual:<n>' untuk item manual.
                            // TANPA unit di key, "Aqua btl" dan "Aqua dus" akan
                            // menumpuk jadi satu baris (fitur #3).
  product_id: number | null;
  name: string;
  sku: string;
  price: number;            // harga satuan yang sudah final (dinamis sudah ditanya)
  qty: number;
  track_stock: number;      // 1 = stok dicek server, 0 = jasa
  /** Satuan yang dijual (item manual = ''). */
  unit: string;
  /** Satuan dasar produk — dipakai memutus apakah struk perlu mencantumkan unit. */
  baseUnit: string;
  /** 1 unit `unit` = berapa satuan dasar. Stok keluar = qty * factor. */
  factor: number;
  /** Diskon PER BARIS dalam rupiah (bukan persen). Dikirim ke server sebagai
   *  `items[].discount` dan di-snapshot di `sale_items.discount`. Bisa diubah
   *  kasir per baris lewat kolom Diskon di keranjang. */
  discount: number;
  /** Prefill dari diskon permanen produk (`products.discount_type/discount`).
   *  Dipakai MENGHITUNG ULANG saat qty berubah selama kasir belum mengedit
   *  manual — diskon % memang harus ikut bertambah saat qty bertambah. */
  prefill: { type: 'rp' | 'pct'; value: number } | null;
  /** true = kasir sudah mengubah sendiri -> jangan ditimpa lagi oleh prefill. */
  discManual: boolean;
  /** Snapshot `products.use_note` saat produk masuk keranjang: 1 = baris ini
   *  dirender dengan input catatan di bawahnya (mis. Cetak Banner -> ukuran). */
  useNote: boolean;
  /** Isi catatan per baris (maks 200 char). Dikirim sebagai `items[].note` dan
   *  di-snapshot server ke `sale_items.note` — sumber struk & riwayat. */
  note: string;
};

type PayMethod = 'tunai' | 'qris' | 'transfer';

/** Mode layar: penjualan biasa, topup, atau tarik tunai. */
type Mode = 'jual' | 'topup' | 'tarik';

/** Jenis layanan. Tidak ada provider terpisah: kasir pilih jenis, lalu nominal.
 *  Kode jenis ini yang mengisi kolom `provider` di /api/topups. */
type TopupJenis = 'e-wallet' | 'pulsa' | 'pln-token' | 'pln-bill' | 'tarik-ewallet' | 'tarik-bank';

/** Metode bayar + ikonnya. `icon` dipakai kartu metode di form bayar ala
 *  Ravaa POS v1 (putaran 10); form topup/tarik memakai `label` saja. */
const PAY_METHODS: { key: PayMethod; label: string; icon: IconName }[] = [
  { key: 'tunai', label: 'Tunai', icon: 'wallet' },
  { key: 'qris', label: 'QRIS', icon: 'qr' },
  { key: 'transfer', label: 'Transfer', icon: 'sync' },
];

/* ---------- topup / tarik (AGENTS.md §1) ----------
 * `nominal` = mutasi modal (saldo yang masuk ke pelanggan), `admin` = pendapatan
 * jasa. `total` = nominal + admin, itu yang dibayar pelanggan. */

/* ---------- state ---------- */

let host: HTMLElement | null = null;
let shift: Shift | null = null;
let products: Product[] = [];
let cart: CartLine[] = [];
let manualSeq = 0;
let discount = 0;
let payMethod: PayMethod = 'tunai';
let cashIn = 0;
/** Penanda "kasir sudah mengelola kolom uang sendiri" — mengetik di kolom,
 *  mengklik chip nominal, tombol ×, atau Bayar pas (F12). Selama `false`,
 *  sinkronisasi `paintCart()` boleh menulis ulang isian dari `cashIn`
 *  (mis. setelah ganti metode me-reset `cashIn=0`). Sejak putaran 10d
 *  (2026-10-05) TIDAK ADA lagi auto-isi "uang pas" — `bukaBayar()` selalu
 *  me-reset `cashIn=0` + `cashTouched=false` (default kolom = kosong;
 *  tujuannya memasukkan uang kurang/lebih sesungguhnya). Barrier `pay()`
 *  tetap pengaman terakhir: uang kosong / kurang tetap ditolak. */
let cashTouched = false;
let busy = false;
// host di-render ulang berkali-kali (ganti metode bayar, dsb). Tanpa abort,
// listener keydown F2/Escape akan menumpuk dan satu tekan memicu pay() berkali-kali.
let posAbort: AbortController | null = null;
// Pintasan keyboard level DOCUMENT (lihat bindPintasan): TERPISAH dari posAbort
// karena posAbort di-abort tiap paint()/bindCart, sedangkan pintasan cukup
// didaftarkan sekali per mount — state-nya (mode/cart/shift) dibaca langsung
// dari memori saat tombol ditekan, jadi selalu ikut terbaru.
let posKeyAbort: AbortController | null = null;
// Dropdown hasil pencarian: daftar + indeks yang sedang disorot.
let results: Product[] = [];
let active = 0;
// Qty untuk item BERIKUTNYA (chip "Qty" di scan bar / F4, ala Aronium
// "Change the quantity"): dipakai SEKALI lalu kembali ke 1, supaya scan
// berikutnya tidak ikut terpengaruh diam-diam.
let qtyNext = 1;
// Pelanggan terpilih di info bar POS (revisi pemilik 2026-10-04, ala KulaPOS).
// `customers` diambil dari GET /api/customers saat mount; `customerId` null =
// tanpa kontak (payload tanpa customer_id — client lama/offline tetap sah).
// `phone`/`note` = bahan cari di layar Cari pelanggan (openCariPelanggan) —
// filter lokal multi-kata pola sama dengan `?q=` API.
type Cust = { id: number; code: string; name: string; phone?: string; note?: string };
let customers: Cust[] = [];
let customerId: number | null = null;
/** Jam live di info bar — interval dijalankan sekali per mount, dihentikan di
 *  unmountPosPage (kalau tidak, interval menumpuk tiap pindah halaman). */
let jamTimer: ReturnType<typeof setInterval> | null = null;

/* ---------- transaksi tertahan / pending (fitur P5) ----------
 * `Tahan` menyimpan isi keranjang ke IndexedDB per device (kv 'holds' di
 * store.ts — tanpa endpoint API, sengaja client-only) lalu mengosongkan
 * keranjang, supaya kasir bisa melayani transaksi lain dan melanjutkan
 * yang tertahan lewat tombol `Pending (n)`. Baris hidup selama device ini —
 * bukan data toko, jadi tidak ikut sync antar device. */
type Hold = {
  id: string;               // uuid — kunci hapus/muat per baris
  waktu: string;            // ISO — jam pembekuan, dirender lokal saat dibuka
  kasir: string;
  customerId: number | null;
  customerName: string;
  discount: number;         // diskon transaksi (per baris ikut di items)
  items: CartLine[];
};
let holds: Hold[] = [];

/* ---------- cetak struk ---------- */

/** Cetak otomatis setelah tiap penjualan/topup. Pref-nya per device
 *  (localStorage lewat ui/print-pref.ts) — bisa juga diganti dari panel
 *  Sistem -> Cetak struk, jadi mountPosPage WAJIB membaca ulang tiap kali
 *  (nilai modul ini tidak usang walau kasir mengubah pref di halaman lain). */
let autoPrint = getAutoPrint();
/** Peringatan "printer tidak bisa dijangkau" cukup SEKALI per sesi — kalau
 *  setiap penjualan memunculkan toast yang sama, kasir jadi acuh dan justru
 *  kehilangan pesan penting. Reset tiap kali cetak berhasil. */
let printWarned = false;

const waktuStruk = () =>
  new Date().toLocaleString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

/** Jam live info bar: `04/10/2026 · 11:47:03`. MEMAKAI WAKTU LOKAL — sengaja
 *  konsisten dengan `waktuStruk()` (juga lokal) yang tercetak di struk, jadi
 *  jam di layar kasir dan jam di kertas selalu sama. BUKAN aritmetika hari
 *  (lihat ui/waktu.ts): ini jam dinding yang berdetik, bukan pemilih hari
 *  riwayat/laporan yang wajib UTC. */
function jamPos(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Jalankan jam live (sekali per mount). Elemen `#pos-jam` ada hanya di mode
 *  Penjualan — tick saat mode topup cukup no-op (querySelector -> null). */
function mulaiJam(): void {
  stopJam();
  const tulis = () => {
    const el = host?.querySelector('#pos-jam');
    if (el) el.textContent = jamPos();
  };
  tulis();
  jamTimer = setInterval(tulis, 1000);
}

function stopJam(): void {
  if (jamTimer) clearInterval(jamTimer);
  jamTimer = null;
}

const labelMetode = (m: PayMethod) => PAY_METHODS.find((x) => x.key === m)?.label ?? m;

/** Label shortcut gaya `<kbd>` (P3) — SATU gaya untuk semua tombol POS
 *  (Cari F3, Qty F4, Bersihkan F5, Diskon F6, bayar F2/Enter). */
const kbd = (t: string) =>
  `<kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">${t}</kbd>`;

/** Kirim struk. Kegagalan cetak TIDAK PERNAH membatalkan penjualan — uang sudah
 *  tercatat, hanya kertasnya yang belum keluar. */
async function cetak(bytes: number[]): Promise<void> {
  if (!autoPrint) return;
  try {
    await kirimPrint(bytes);
    printWarned = false;
  } catch (e) {
    if (printWarned) return;
    printWarned = true;
    toast(
      `Struk tidak tercetak: ${e instanceof Error ? e.message : 'print-agent tidak jalan'}. Penjualan tetap tersimpan — matikan "Cetak struk" bila device ini memang tanpa printer.`,
      'warning',
      9000,
    );
  }
}

/** Isi badan "modal resume" pasca-bayar (putaran 11, 2026-10-05 — permintaan
 *  pemilik "setelah bayar tambahkan modal resume"): ringkasan compact di
 *  bawah judul hero KEMBALIAN — No. nota → daftar item (maks 5 baris +
 *  "… +N item lainnya") → Total (bold) → Tunai/ujian metode (pola baris
 *  rincian struk: tunai tampilkan uang diterima, non-tunai tampilkan
 *  label metode + total). Nama item di-esc (pola esc() wajib untuk teks
 *  user). Kelas Tailwind tertulis sebagai literal supaya di-scan build. */
function htmlResumePenjualan(o: {
  invoiceNo?: string | null;
  items: { qty: number; nama: string; net: number }[];
  metode: PayMethod;
  uang: number;
  tot: number;
  /** Sisa yang tercatat sebagai HUTANG (putaran 12) — tampil sebagai baris
   *  merah di bawah baris Tunai supaya kasir melihatnya tanpa buka halaman
   *  Hutang (pengganti info konfirmasi swal yang dihapus). 0/absen = tanpa
   *  baris. */
  hutang?: number;
}): string {
  const batas = 5;
  const baris = o.items
    .slice(0, batas)
    .map(
      (it) =>
        `<div class="flex items-baseline justify-between gap-4"><span class="min-w-0 truncate">${it.qty} × ${esc(it.nama)}</span><span class="tabular-nums shrink-0">${rp(it.net)}</span></div>`,
    );
  const sisa = o.items.length - batas;
  if (sisa > 0) {
    baris.push(
      `<div class="text-gray-500 dark:text-gray-400">… +${sisa} item lainnya</div>`,
    );
  }
  // Jam cetak lokal HH:MM + subtitle layan-berikutnya — riset KulaPOS
  // (2026-10-06, permintaan pemilik "ok 1 dulu"): sukses modal mereka memuat
  // subjudul "Transaksi tersimpan. Siap melayani pelanggan berikutnya." dan
  // no nota + jam berdampingan. Tanggal TIDAK ikut ditulis di sini karena
  // sudah terkandung di `invoice_no` (YYMMDD-NNNNNN).
  const d = new Date();
  const pj = (n: number) => String(n).padStart(2, '0');
  const jamCetak = `${pj(d.getHours())}:${pj(d.getMinutes())}`;
  return `<div class="mx-auto w-full max-w-xs space-y-1.5 text-left text-sm text-gray-700 dark:text-gray-200">
      <div class="text-center text-[11px] leading-snug text-gray-500 dark:text-gray-400">Transaksi tersimpan. Siap melayani pelanggan berikutnya.</div>
      <div class="text-center text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">No. ${esc(o.invoiceNo ?? '-')} · ${jamCetak}</div>
      <div class="border-t border-dashed border-gray-300 dark:border-gray-600"></div>
      ${baris.join('\n      ')}
      <div class="border-t border-dashed border-gray-300 dark:border-gray-600"></div>
      <div class="flex items-baseline justify-between gap-4 font-bold text-gray-900 dark:text-white"><span>Total</span><span class="tabular-nums shrink-0">${rp(o.tot)}</span></div>
      <div class="flex items-baseline justify-between gap-4"><span>${o.metode === 'tunai' ? 'Tunai' : labelMetode(o.metode)}</span><span class="tabular-nums shrink-0">${o.metode === 'tunai' ? rp(o.uang) : rp(o.tot)}</span></div>${
        o.hutang && o.hutang > 0
          ? `\n      <div class="flex items-baseline justify-between gap-4 font-semibold text-red-600 dark:text-red-400"><span>Hutang</span><span class="tabular-nums shrink-0">${rp(o.hutang)}</span></div>`
          : ''
      }
    </div>`;
}

/** Modal SELESAI penjualan (putaran 11, 2026-10-05 — revisi pemilik 1A:
 *  "setelah bayar tambahkan modal resume, dan pilihan print thermal atau
 *  A4, begitu juga pada bayar PAS F12"):
 *  - **SELALU tampil setelah SETIAP penjualan sukses** — semua jalur (tombol
 *    Bayar / F2 / Enter / F12 Bayar pas) lewat `pay()` dan memanggil fungsi
 *    ini TANPA guard `if (autoPrint)` lagi. "Cetak struk otomatis" kini hanya
 *    menentukan apakah tombol Thermal/A4 BENAR-BENAR mengirim ke printer
 *    (guard di cabang bawah + `cetak()`).
 *  - **Judul hero = KEMBALIAN** (revisi pemilik 2026-10-04 ala KulaPOS,
 *    tetap; **putaran 11b** mengangkat angkanya jadi 48px — lihat komentar
 *    di pemanggilan `choiceDialog` bawah) + **badan resume** lewat
 *    `htmlResumePenjualan()` (No. nota + jam, item, Total, metode, baris
 *    HUTANG bila ada sisa — putaran 12).
 *  - [Thermal] = struk ESC/POS via print-agent,
 *    [A4]      = invoice gaya Aronium via window.print() browser (CUPS),
 *    [Selesai] = tanpa cetak (fokus awal swal = tombol ini, Enter = selesai).
 *    Pilihan terakhir disimpan sebagai pref layout (struk topup/tarik).
 *    Posisi tombol swal TIDAK BERUBAH (confirm/deny/cancel) —
 *    tests/e2e-struk.mjs memakai selector itu. */
async function pilihCetakSelesai(
  saleId: string,
  struk: Struk,
  tot: number,
  kembalian: number,
  resume: { invoiceNo?: string | null; items: { qty: number; nama: string; net: number }[]; metode: PayMethod; uang: number; hutang?: number },
): Promise<void> {
  const pilihan = await choiceDialog({
    // Judul hero KEMBALIAN — putaran 11b (2026-10-05, permintaan pemilik
    // "kembalian kurang besar, agar kasir mudah melihat kembalian"):
    // label "Kembalian" kecil (uppercase) + ANGKA 48px (skala sama dengan
    // TOTAL BELANJA di info bar, revisi pemilik 2026-10-04) menggantikan
    // judul swal compact 13px. SweetAlert2 merender `title` sebagai HTML
    // (`parseHtmlToContainer`, beda dengan `titleText` yang innerText) jadi
    // span Tailwind di sini sah — `textContent` judul tetap "Kembalian RpX"
    // (spasi di antara span dipertahankan untuk test e2e-struk).
    // Kembalian 0 (bayar pas) tetap judul polos "Pembayaran berhasil".
    title:
      kembalian > 0
        ? `<span class="block text-xs font-bold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">Kembalian</span> <span class="block text-[48px] font-extrabold leading-tight text-gray-900 dark:text-white tabular-nums">${rp(kembalian)}</span>`
        : 'Pembayaran berhasil',
    html: htmlResumePenjualan({ ...resume, tot }),
    icon: kembalian > 0 ? 'success' : 'question',
    choices: [
      { key: 'thermal', label: 'Thermal' },
      { key: 'a4', label: 'A4' },
    ],
    cancelLabel: 'Selesai',
    // Esc = TUTUP LANGSUNG (putaran 11c, 2026-10-05 — permintaan pemilik
    // "jika di esc langsung close untuk mempercepat transaksi selanjutnya").
    // Fakta bug: `pay()` memfokus `#pos-q` tepat setelah dialog dibuka, tapi
    // listener keydown bawaan sweetalert2 menempel di POPUP (bukan document)
    // — Esc dari kolom scan tidak pernah sampai ke popup (terbukti empiris:
    // popup tetap terbuka). `keydownListenerCapture` memindahkan listener ke
    // window (capture) jadi Esc didengar dari mana pun fokus. `returnFocus:
    // false` supaya pengembalian fokus swal nanti tidak menimpa focusScan()
    // penutup di bawah.
    keydownListenerCapture: true,
    returnFocus: false,
  });
  // Tutup dengan cara apa pun (Esc / Selesai / Thermal / A4) -> FOKUS KEMBALI
  // ke kolom scan: kasir langsung bisa scan transaksi berikutnya tanpa klik.
  focusScan();
  // Saklar auto-print = IZIN kirim ke printer (bukan syarat tampil modal).
  // Klik eksplisit saat saklar mati -> beri tahu, jangan diam-diam no-op.
  const mati =
    'Cetak sedang mati — nyalakan saklar "Cetak struk otomatis" di baris Mode bila ingin mengirim ke printer.';
  if (pilihan === 'thermal') {
    setStrukLayout('thermal');
    if (!autoPrint) {
      toast(mati, 'info');
      return;
    }
    void cetak(strukUntuk(struk, 'thermal'));
  } else if (pilihan === 'a4') {
    setStrukLayout('a4');
    if (!autoPrint) {
      toast(mati, 'info');
      return;
    }
    try {
      await cetakInvoice(saleId);
    } catch (e) {
      toast(`Invoice A4 tidak tercetak: ${e instanceof Error ? e.message : 'gagal memuat nota'}. Penjualan tetap tersimpan.`, 'warning', 9000);
    }
  }
}

/* ---------- state topup / tarik ---------- */
let mode: Mode = 'jual';
let topJenis: TopupJenis | '' = '';  // jenis layanan yang dipilih
let topNomor = '';           // nomor HP / rekening
let topNominal = 0;
let topAdmin = 0;
let topAdminTouched = false; // setelah kasir ubah sendiri, jangan ditimpa lagi
let topTunai = 0;            // uang diterima (tidak relevan untuk QRIS/transfer)

/** Tier admin kasir. WAJIB sama dengan `GET /api/topups/suggest-admin`
 *  (apps/api/src/index.ts) supaya layar kasir tidak melenceng dari server. */
function suggestAdmin(nominal: number): number {
  if (!(nominal > 0)) return 0;
  if (nominal < 50000) return 3000;
  if (nominal < 200000) return 5000;
  return 7000;
}

const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

/** Nama produk bisa diketik sendiri oleh kasir (item manual, nama produk), jadi
 *  wajib di-escape sebelum masuk template — tanpa ini satu nama berisi `<b>`
 *  merusak seluruh baris tabel keranjang. */
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/* ---------- hitung ---------- */

const subtotal = () => cart.reduce((s, l) => s + l.price * l.qty, 0);
/** Jumlah seluruh diskon PER BARIS. Server memakai istilah sama (`totalDiscBaris`)
 *  dan menguranginya SEBELUM diskon transaksi — lihat POST /api/sales. */
const diskonBaris = () => cart.reduce((s, l) => s + l.discount, 0);
const total = () => Math.max(0, subtotal() - diskonBaris() - discount);
const count = () => cart.reduce((s, l) => s + l.qty, 0);
const change = () => Math.max(0, cashIn - total());

/** Kelas warna angka KEMBALIAN (hasil besar di form bayar: hijau = cukup/
 *  lebih, merah = kurang, abu = belum diisi). Dipakai lewat kelasPosChange()
 *  — SATU sumber untuk render awal (formBayarHtml) dan update live
 *  (paintCart) — dua tempat ini pernah punya kelas terpisah dan bisa berbeda
 *  saat dirawat. */
function kelasKembalian(): string {
  if (!(cashIn > 0)) return 'text-gray-900 dark:text-white';
  return cashIn < total()
    ? 'text-red-600 dark:text-red-400'
    : 'text-emerald-600 dark:text-emerald-400';
}

/** Kelas LENGKAP angka KEMBALIAN di form bayar (putaran 10: hasil besar ala
 *  `.result-value` Ravaa POS v1; putaran 10c pemilik: *"kembalian kurang
 *  besar, seukuran uang diterima"* -> 40px = sama dengan font `#pos-cash`).
 *  SATU sumber untuk render awal `formBayarHtml()` DAN update live
 *  `paintCart()` — ukuran + warna tidak boleh terpecah (pola kelasKembalian). */
function kelasPosChange(): string {
  return `text-[40px] font-extrabold tabular-nums ${kelasKembalian()}`;
}

/** Teks konteks KEMBALIAN (P2): angka "Rp0" saat uang masih kurang
 *  menyesatkan — kasir mengira tidak ada kembalian. Dua frasa sesuai
 *  permintaan pemilik; saat uang lebih, angka KEMBALIAN saja sudah menjelaskan,
 *  jadi teks kosong. SATU sumber untuk render awal & update live (paintCart). */
function teksKembalian(): string {
  if (!(cashIn > 0) || !cart.length) return '';
  if (cashIn < total()) return `Kurang ${rp(total() - cashIn)}`;
  if (cashIn === total()) return 'Uang pas. Tidak ada kembalian.';
  return '';
}

/** Jumlah baris (harga x qty) sebelum diskon. Server menyimpan angka kotor ini
 *  ke `sales.subtotal`, supaya `subtotal - total` = seluruh diskon. */
const jumlahBaris = (l: Pick<CartLine, 'price' | 'qty'>) => Math.round(l.price * l.qty);

/** Besar diskon satu baris BILA prefill-nya dihitung ulang dari qty saat ini.
 *  Selalu dijepit ke jumlah baris: server menolak `discount > amount` (400). */
function hitungPrefill(l: Pick<CartLine, 'prefill' | 'price' | 'qty'>): number {
  if (!l.prefill) return 0;
  const perUnit =
    l.prefill.type === 'pct'
      ? Math.round((l.price * l.prefill.value) / 100)
      : l.prefill.value;
  return Math.max(0, Math.min(Math.round(perUnit * l.qty), jumlahBaris(l)));
}

/* ---------- cari produk ---------- */

/** Hasil pencarian untuk dropdown.
 *  Scan barcode/SKU persis -> hanya 1 hasil (jalan cepat scanner: ketik + Enter
 *  langsung masuk, tanpa harus pilih). Selain itu -> daftar nama yang mengandung,
 *  yang diawali huruf query didahulukan. */
const MAX_RESULTS = 8;

/** `limit` default = dropdown scan bar (8). Layar cari F3 memakai limit besar
 *  supaya daftar tidak terpotong di 8 baris. */
function queryResults(q: string, limit = MAX_RESULTS): Product[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const exact =
    products.find((p) => p.barcode && p.barcode.toLowerCase() === t) ??
    products.find((p) => p.sku.toLowerCase() === t);
  if (exact) return [exact];
  // Kata dipisah: kasir mengetik "aqua 600" atau "kopi kapal" — harusnya tetap
  // ketemu. Semua kata wajib cocok (di nama/SKU/barcode), tidak harus berurutan
  // atau di field yang sama.
  const terms = t.split(/\s+/).filter(Boolean);
  const starts: Product[] = [];
  const has: Product[] = [];
  for (const p of products) {
    const n = p.name.toLowerCase();
    const s = p.sku.toLowerCase();
    const c = (p.barcode ?? '').toLowerCase();
    if (!terms.every((x) => n.includes(x) || s.includes(x) || c.includes(x))) continue;
    if (n.startsWith(t) || terms.some((x) => n.startsWith(x))) starts.push(p);
    else has.push(p);
    if (starts.length >= limit) break;
  }
  return [...starts, ...has].slice(0, limit);
}

/** Sintaks `Qty*Kode` di kolom scan (referensi KulaPOS "Jumlah Beli * Kode
 *  [F1/Cmd+K]" — kula-02-transaksi-pos.png): `3*PRD00001`, `2 * aqua` ->
 *  `{qty:3, q:"PRD00001"}`. Pola TIDAK cocok -> null (pencarian biasa), jadi
 *  barcode biasa tanpa `*` tidak pernah melewati parser ini.
 *
 *  `qty` dibatasi 1..9999 di pemanggil — di sini hanya diparse; qty 0 biar
 *  jadi pesan "Qty minimal 1", bukan diam-diam dianggap 1. */
function bacaQtyKode(v: string): { qty: number; q: string } | null {
  const m = /^(\d{1,4})\s*\*\s*(.+)$/.exec(v.trim());
  if (!m) return null;
  const q = m[2].trim();
  if (!q) return null;
  return { qty: Number(m[1]), q };
}

function addLine(p: Product, price: number, qty = 1, unit = p.unit, factor = 1): void {
  // Key menyertakan satuan: 2 pcs dan 2 pack adalah baris BERBEDA, bukan penambahan.
  const key = `${p.id}:${unit}`;
  // Prefill diskon permanen produk: '%'-nya dihitung ke rupiah per baris, jadi
  // kasir melihat angka jadi (bukan tebak-tebakan) dan tetap bisa mengubahnya.
  const prefill = p.discount > 0
    ? { type: p.discount_type === 'pct' ? ('pct' as const) : ('rp' as const), value: p.discount }
    : null;
  const found = cart.find((l) => l.key === key);
  if (found) {
    found.qty += qty;
    found.price = price; // harga terbaru untuk produk harga dinamis
    // Diskon mengikuti qty ASALKAN belum diedit tangan — kalau kasir sudah
    // menyetel angka sendiri, menimpanya akan mengubah harga yang sudah
    // disepakati pelanggan di tengah transaksi.
    if (!found.discManual) found.discount = hitungPrefill(found);
  } else {
    const baris: CartLine = {
      key, product_id: p.id, name: p.name, sku: p.sku,
      price, qty, track_stock: p.track_stock,
      unit, baseUnit: p.unit, factor,
      discount: 0, prefill, discManual: false,
      useNote: !!p.use_note, note: '',
    };
    baris.discount = hitungPrefill(baris);
    cart.push(baris);
  }
}

function setQty(key: string, qty: number): void {
  const line = cart.find((l) => l.key === key);
  if (!line) return;
  if (qty <= 0) cart = cart.filter((l) => l.key !== key);
  else {
    line.qty = qty;
    if (!line.discManual) line.discount = hitungPrefill(line);
  }
  clampDiskonTransaksi();
  paintCart();
}

/** Setel diskon satu baris dari input kolom Diskon. Angka dijepit ke jumlah
 *  baris supaya server tidak menolak dengan 400 "diskon baris melebihi". */
function setDisc(key: string, nilai: number): void {
  const line = cart.find((l) => l.key === key);
  if (!line) return;
  const bersih = Number.isFinite(nilai) ? Math.max(0, Math.round(nilai)) : 0;
  line.discount = Math.min(bersih, jumlahBaris(line));
  // Semua ketikan dianggap edit manual — termasuk mengosongkan ke 0 (kasir
  // sengaja membatalkan prefill, jadi jangan dikembalikan saat qty berubah).
  line.discManual = true;
  clampDiskonTransaksi();
  paintCart();
}

/** Diskon transaksi dijepit ke sisa subtotal SETELAH diskon item, dan nilai
 *  inputnya ikut ditulis ulang. Tanpa ini, kasir yang mengetik diskon besar
 *  lalu menambah diskon baris akan menghasilkan total negatif — server jelas
 *  menolaknya ("diskon melebihi subtotal") tepat di momen pembayaran. */
function clampDiskonTransaksi(): void {
  const maks = Math.max(0, subtotal() - diskonBaris());
  if (discount > maks) discount = maks;
  const inp = host?.querySelector<HTMLInputElement>('#pos-discount');
  if (inp && Number(inp.value || 0) !== discount) inp.value = discount ? String(discount) : '';
}

/* ---------- gate shift ---------- */

function shiftGateHtml(): string {
  return `
  <div class="mx-auto max-w-md space-y-4 py-5">
    <div class="card">
      <div class="flex items-start gap-3">
        <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15">
          ${icon('shifts')}
        </span>
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Buka shift dulu</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Kasir <span class="font-semibold text-gray-700 dark:text-gray-200">${getCashier()}</span>
            belum punya shift terbuka. Masukkan modal awal di laci sebelum mulai jualan.
          </p>
        </div>
      </div>
      <div class="mt-5 space-y-3">
        <div>
          <label class="label" for="pos-modal-awal">Modal awal (Rp)</label>
          <input id="pos-modal-awal" class="input" type="number" inputmode="numeric" min="0" step="1000" value="0" />
        </div>
        <div>
          <label class="label" for="pos-kasir">Nama kasir</label>
          <input id="pos-kasir" class="input" type="text" value="${getCashier()}" autocomplete="off" />
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Tiap device wajib nama kasir berbeda + shift sendiri.
          </p>
        </div>
        <button type="button" id="pos-open-shift" class="btn btn-primary w-full">Buka Shift</button>
      </div>
    </div>
  </div>`;
}

function bindShiftGate(): void {
  const btn = host!.querySelector<HTMLButtonElement>('#pos-open-shift');
  const modalAwal = host!.querySelector<HTMLInputElement>('#pos-modal-awal');
  const kasir = host!.querySelector<HTMLInputElement>('#pos-kasir');
  modalAwal?.focus();
  btn?.addEventListener('click', async () => {
    if (busy) return;
    const name = (kasir?.value || '').trim();
    if (!name) {
      toast('Nama kasir wajib diisi', 'error');
      kasir?.focus();
      return;
    }
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Membuka…';
    try {
      const res = await apiPost<{ data: Shift }>('/api/shifts/open', {
        modal_awal: Number(modalAwal?.value || 0),
        cashier: name,
      });
      shift = res.data;
      toast('Shift terbuka, kasir siap', 'success');
      paint();
    } catch (e) {
      // 409 = kasir ini masih punya shift open (UNIQUE INDEX di DB).
      if (e instanceof HttpError && e.status === 409) {
        toast(e.message, 'warning');
        await loadShift();
        paint();
      } else {
        toast(`Gagal buka shift: ${e instanceof Error ? e.message : 'tidak diketahui'}`, 'error');
      }
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Buka Shift';
    }
  });
}

/* ---------- layar keranjang ---------- */

/** Strip peringatan stok menipis di layar kasir (keputusan user: POS saja).
 *
 *  Hitungannya DIAMBIL DARI CACHE LOKAL — aturan yang sama dengan tabel Produk
 *  (`track_stock && min_stock > 0 && stock <= min_stock`), bukan panggilan API
 *  tambahan, supaya layar kasir tidak pernah menunggu jaringan hanya untuk
 *  peringatan. `min_stock = 0` = tanpa ambang, jadi tidak ikut dihitung (kalau
 *  tidak, semua produk pasti "menipis" karena stok 0 <= 0). */
function stripStokMenipis(): string {
  const menipis = products.filter((p) => p.track_stock && p.min_stock > 0 && p.stock <= p.min_stock);
  if (!menipis.length) return '';
  const tiga = menipis.slice(0, 3).map((p) => `${esc(p.name)} (${p.stock})`).join(', ');
  const sisa = menipis.length > 3 ? `, +${menipis.length - 3} lainnya` : '';
  // Class `strip-low` WAJIB: `icon()` tidak mengeluarkan lebar/tinggi (diatur
  // CSS wadahnya). Tanpa aturan `svg` di .strip-low, ikon segitiga meregang
  // setinggi panel dan menutupi seluruh keranjang.
  return `<a href="#/stock" class="strip-low flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20">
      ${icon('alert')}
      <span class="min-w-0 flex-1"><b>${menipis.length} produk stok menipis</b>: ${tiga}${sisa}</span>
      <span class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">Buka Stok ${icon('chevR')}</span>
    </a>`;
}

/** Strip peringatan kadaluarsa di layar kasir — teman `stripStokMenipis()`.
 *
 *  Diambil dari cache lokal (produk + `expiry_date`, lihat `ui/expiry.ts`),
 *  tanpa panggilan API, supaya layar kasir tidak pernah menunggu jaringan
 *  untuk peringatan — persis alasan yang sama dengan strip stok menipis.
 *  `lewat` (tanggal sudah dilewati) tampil MERAH dan didahulukan karena
 *  barangnya tidak boleh terjual sama sekali; `dekat` (<= 30 hari) KUNING,
 *  daftarnya urut begitu juga. Tanpa tanggal = tidak ikut dihitung. */
function stripKadaluarsa(): string {
  const daftar = products
    .map((p) => ({ p, iso: p.expiry_date, s: statusExpiry(p.expiry_date) }))
    .filter((x) => x.s === 'lewat' || x.s === 'dekat')
    .sort((a, b) => (a.s === b.s ? 0 : a.s === 'lewat' ? -1 : 1));
  if (!daftar.length) return '';
  const adaLewat = daftar.some((x) => x.s === 'lewat');
  const nLewat = daftar.filter((x) => x.s === 'lewat').length;
  const nDekat = daftar.length - nLewat;
  const tiga = daftar.slice(0, 3)
    .map((x) => `${esc(x.p.name)} (${x.iso ? tglExpiry(x.iso) : '-'})`).join(', ');
  const sisa = daftar.length > 3 ? `, +${daftar.length - 3} lainnya` : '';
  const kepala = adaLewat
    ? `<b>${nLewat} produk LEWAT kadaluarsa</b>${nDekat ? ` + ${nDekat} kadaluarsa ${AMBAT_EXPIRY} hari` : ''}`
    : `<b>${nDekat} produk kadaluarsa ${AMBAT_EXPIRY} hari ke depan</b>`;
  const warna = adaLewat
    ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20'
    : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20';
  // Class `strip-low` WAJIB: ikonnya diukur dari `.strip-low svg` (styles.css),
  // sama seperti strip stok menipis.
  return `<a href="#/products" class="strip-low flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold ${warna}">
      ${icon('alert')}
      <span class="min-w-0 flex-1">${kepala}: ${tiga}${sisa}</span>
      <span class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">Buka Produk ${icon('chevR')}</span>
    </a>`;
}

/** Badge kadaluarsa untuk SATU baris keranjang: kasir melihatnya tepat saat
 *  produk diambil, bukan setelah struk keluar. Item manual & produk tanpa
 *  tanggal tidak menghasilkan apa-apa. */
function expBarisKeranjang(product_id: number | null): string {
  if (product_id === null) return '';
  const p = products.find((x) => x.id === product_id);
  if (!p || !p.expiry_date) return '';
  const s = statusExpiry(p.expiry_date);
  if (s !== 'lewat' && s !== 'dekat') return '';
  return s === 'lewat'
    ? ` · <span class="font-semibold text-red-600 dark:text-red-400">lewat kadaluarsa ${tglExpiry(p.expiry_date)}</span>`
    : ` · <span class="font-semibold text-amber-600 dark:text-amber-400">kadaluarsa ${tglExpiry(p.expiry_date)}</span>`;
}

/** Chip nominal cepat di panel bayar tunai — gaya Kasir Pintar: satu klik
 *  mengisi "Uang diterima", hindari salah ketik nol. `pas` = persis total. */
// Putaran 10c (2026-10-05): chip "Uang pas" DIHAPUS dari modal bayar —
// permintaan pemilik "Jangan ada uang pas, karena sudah ada tombol F12 untuk
// uang pas, ganti 20.000". F12 = #pos-pay-pas di side panel tetap utuh.
const QUICK_CASH: number[] = [20000, 50000, 100000, 200000];

/** Info bar ala KulaPOS (revisi pemilik 2026-10-04): jam berjalan + kasir
 *  (kiri), pemilih PELANGGAN (tengah), TOTAL BELANJA besar (kanan). Hanya
 *  mode Penjualan — mode topup/tarik punya form totalnya sendiri. */

/** Tombol kembali ke dashboard — shell POS TANPA header (permintaan pemilik
 *  "full hapus" 2026-10-04), jadi tombolnya hidup di konten: kiri info bar
 *  (mode Penjualan) dan kiri baris Mode (topup/tarik, info bar tidak
 *  dirender) supaya kasir tidak pernah terkunci di #/pos. */
function tombolKembaliHtml(): string {
  return `<a href="#/dashboard" class="icon-btn shrink-0" aria-label="Kembali ke dashboard" title="Kembali ke dashboard">${icon('chevL')}</a>`;
}

function infoBarHtml(): string {
  const pilih = customers.length
    ? customers
        .map(
          (c) =>
            `<option value="${c.id}"${c.id === customerId ? ' selected' : ''}>${esc(c.name)}${c.code ? ` · ${esc(c.code)}` : ''}</option>`,
        )
        .join('')
    : `<option value="">Pelanggan Umum</option>`;
  return `
    <div class="card info-bar !p-3">
      <!-- Tiga kolom SAMA RATA (permintaan pemilik 2026-10-04 putaran 9:
           "buat kolomnya sama rata, jangan lebar di tengah, belum sama
           rata ukuran kolomnya") — lg:grid-cols-3 menggantikan
           [auto_1fr_auto] yang membuat kolom select pelanggan menyerap
           seluruh sisa lebar. lg:min-w-[340px] lama ikut DIBUANG: track
           sudah 1/3, dan min-width itu akan meluap di layar tepat 1024px.
           Kolom dipisah garis vertikal — border-l hanya >=lg (layar sempit
           kolom menumpuk, garis jadi noise). Kolom kanan = label+qty di
           KIRI, angka TOTAL di KANAN. -->
      <div class="grid items-center gap-2 lg:grid-cols-3 lg:gap-4">
        <div class="flex items-center gap-2 whitespace-nowrap text-xs text-gray-600 dark:text-gray-300">
          ${tombolKembaliHtml()}
          <div class="flex flex-col gap-y-0.5">
            <span class="flex items-center gap-1.5">${icon('clock')}<span class="font-semibold">Waktu:</span><span id="pos-jam" class="tabular-nums">${jamPos()}</span></span>
            <span class="flex items-center gap-1.5">${icon('users')}<span class="font-semibold">Kasir:</span><span>${esc(getCashier())}</span><span class="text-gray-400">· Shift #${shift?.id}</span></span>
          </div>
        </div>
        <div class="min-w-0 border-t border-gray-200 pt-2 dark:border-gray-700 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <!-- Select selebar form (permintaan pemilik 2026-10-04 — dulu
               dibatasi max-w-[520px]) + tombol CARI (putaran 7 2026-10-04,
               "tambahkan cari seperti cari produk F3"): layar cari penuh
               openCariPelanggan() — pola sama dengan F3 produk (input multi-
               kata, ↑↓ sorot, Enter pilih), buat pelanggan yang daftarnya
               sudah panjang (master kontak + hutang). -->
          <div class="w-full">
            <label class="label" for="pos-customer">Pelanggan</label>
            <!-- Revisi putaran 8b (2026-10-04): "tombol dan dropdown customer
                 tidak inline" — tombol KEMBALI sebaris dengan select (dulu
                 sempat dipindah ke baris label di atas). Bentuknya kini
                 KOMPAK: ikon search + teks "F9" polos TANPA teks "Cari"
                 (permintaan: "cukup pakai text label yang F9 dan ganti logo
                 kuncinya dengan search … space select jadi lebih besar") —
                 select tetap min-w-0 flex-1 menyerap sisa lebar. Layar cari
                 = openCariPelanggan() ala F3 produk (putaran 7). -->
            <div class="flex items-stretch gap-1.5">
              <select id="pos-customer" class="input input-sm min-w-0 flex-1">${pilih}</select>
              <button type="button" id="pos-cust-cari" class="btn btn-ghost !min-h-[34px] !px-2.5" title="Cari pelanggan (F9)" aria-label="Cari pelanggan (F9)">${icon('search')}<span class="text-xs font-semibold tracking-wide">F9</span></button>
            </div>
          </div>
        </div>
        <!-- Kolom total = track 1/3 (sama rata, lihat komentar grid di atas).
             justify-between tetap menempelkan label+n item ke KIRI kolom dan
             angka #pos-grand ke KANAN — tanpa min-w yang dulu dipakai untuk
             memberi ruang pada track auto. -->
        <div class="flex items-center justify-between gap-3 border-t border-gray-200 pt-2 dark:border-gray-700 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <div class="min-w-0 text-left">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Total belanja</div>
            <div id="pos-owncount" class="text-xs text-gray-500 dark:text-gray-400">${cart.length ? `${cart.length} item (${count()} Qty)` : '0 item'}</div>
          </div>
          <!-- text-[48px] ukuran KUSTOM (Tailwind arbitrary value) = 2x lipat
               text-2xl lama (24px) — permintaan pemilik 2026-10-04 "custom
               ukuran font, besarkan lagi 2x lipat". Total belanja = angka
               terpenting di layar kasir. -->
          <div id="pos-grand" class="shrink-0 text-right text-[48px] font-bold leading-tight tabular-nums text-primary">${rp(total())}</div>
        </div>
      </div>
    </div>`;
}

function cartHtml(): string {
  const scanBar = `
      <div class="card !p-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative min-w-[220px] flex-1">
            <div class="search-wrap">
              ${icon('search')}
              <input id="pos-q" class="input input-sm pr-14" type="search" autocomplete="off" role="combobox"
                     aria-expanded="false" aria-controls="pos-results" aria-autocomplete="list"
                     placeholder="Scan barcode / ketik nama atau SKU — Qty*Kode, mis. 3*PRD00001"
                     title="Scan barcode, ketik nama/SKU, atau Qty*Kode (mis. 3*aqua). Fokus balik ke sini: F1, F8, atau Esc" />
            </div>
            <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">${kbd('F1')}</span>
            <div id="pos-results" class="suggest hidden" role="listbox" aria-label="Hasil pencarian produk"></div>
          </div>
          ${mode === 'jual' ? `
          <button type="button" id="pos-cari" class="btn btn-ghost" title="Cari produk penuh">${icon('search')}<span>Cari</span>${kbd('F3')}</button>
          <!-- Ukuran DISAMAKAN dengan tombol Cari/F3 di sebelahnya (permintaan
               pemilik 2026-10-04) — dulu kelas chip jadi lebih pendek/menempel. -->
          <button type="button" id="pos-qty" class="btn btn-ghost${qtyNext > 1 ? ' !border-primary !text-primary' : ''}" title="Qty untuk item BERIKUTNYA, dipakai sekali lalu kembali ke 1">Qty ${qtyNext}${kbd('F4')}</button>` : ''}
          ${products.length ? '' : `<a href="#/products" class="chip !border-amber-500 !text-amber-600 dark:!text-amber-400">${icon('alert')}<span>Cache produk kosong — sinkron dulu di Manage</span></a>`}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          ${mode === 'jual' ? '' : tombolKembaliHtml()}
          <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Mode</span>
          <div id="pos-modes" class="flex flex-wrap gap-2">
            <button type="button" data-mode="jual" class="chip${mode === 'jual' ? ' !border-primary !text-primary' : ''}">Penjualan</button>
            <button type="button" data-mode="topup" class="chip${mode === 'topup' ? ' !border-primary !text-primary' : ''}">Topup</button>
            <button type="button" data-mode="tarik" class="chip${mode === 'tarik' ? ' !border-primary !text-primary' : ''}">Tarik</button>
          </div>
          <span class="rounded border border-gray-200 px-2 py-1 dark:border-gray-700">
            ${switchHtml('pos-autoprint', autoPrint, 'Cetak struk otomatis')}
          </span>
          ${mode !== 'jual' ? '<span class="ml-auto text-xs text-gray-500 dark:text-gray-400">Nomor HP / rekening + nominal, admin otomatis per tier toko</span>' : ''}
        </div>
      </div>`;
  // Ketiga mode memakai pembungkus yang sama: flex column setinggi halaman
  // (h-full dari main.page -> flex-1), supaya panel di bawahnya jadi
  // `flex-1 min-h-0` dan benar-benar mengisi layar, bukan tinggi isi konten.
  // Urut = referensi KulaPOS (kula-02-transaksi-pos.png): INFO BAR (Waktu/
  // Kasir/Pelanggan/Total) dulu, baru scan bar — kebalikan dari susunan lama.
  const body = mode === 'jual' ? cartGridHtml() : topupHtml();
  return `
  <div class="flex h-full min-h-0 flex-col gap-2">
    ${mode === 'jual' ? infoBarHtml() : ''}
    ${scanBar}
    ${mode === 'jual' ? stripStokMenipis() + stripKadaluarsa() : ''}
    ${body}
  </div>`;
}

/** Keranjang + panel bayar (mode Penjualan). */
function cartGridHtml(): string {
  // Ringkasan sidebar kini hanya "Diskon item" (putaran 7: baris Subtotal
  // DIHAPUS) — `sub`/`tot` lokal tidak dipakai lagi di dalam fungsi ini.
  // Panel bayar = SIDEBAR KANAN 320px (revisi pemilik 2026-10-04 putaran 4:
  // footer horizontal ala KulaPOS DITOLAK — "tidak usah, tetap jadi sidebar
  // kanan tadi"), isi = ringkasan -> **Aksi cepat (Tahan/Pending P5 + Item
  // manual/Diskon + placeholder Voucher/Cetak ulang)** -> diskon transaksi F6
  // -> DUA tombol bayar (permintaan pemilik 2026-10-04 putaran 5: isian
  // pembayaran PINDAH KE MODAL, lihat bukaBayar()/formBayarHtml(); putaran 6:
  // "bayar uang pas letakkan di sidepanel bawahnya Bayar F10" = `#pos-pay-pas`
  // menempel di bawah `#pos-bayar`). Baris "Grand total" DIHAPUS (duplikat
  // TOTAL BELANJA di info bar — permintaan pemilik 2026-10-04).
  return `
    <div class="grid min-h-0 flex-1 gap-2 lg:grid-cols-[1fr_320px]">
      <div class="card-flush flex min-h-0 flex-col overflow-hidden">
        <!-- Label keranjang di ATAS tabel (referensi KulaPOS: "Keranjang 2 item
             ... Bersihkan [F5]" kanan-atas). -->
        <div class="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span id="pos-count">${cart.length ? `${count()} item` : 'Keranjang kosong'}</span>
          <button type="button" id="pos-clear" class="btn btn-ghost text-red-600 !min-h-[30px] !px-2.5 !py-1 text-xs" title="Kosongkan keranjang" aria-label="Kosongkan keranjang"${cart.length ? '' : ' disabled'}>${icon('trash')}<span class="hidden sm:inline">Bersihkan</span>${kbd('F5')}</button>
        </div>
        <div class="table-wrap table-scroll flex-1">
          <!-- "table-compact" = pola yang sama dengan halaman Produk & Stok
               (th px-3 py-2, td px-3 py-1.5). Keranjang POS lalu dirapatkan
               LAGI lewat rule khusus #pos-cart di styles.css (permintaan pemilik
               2026-10-03) — hanya jarak, teks tetap 14/12px.
               td baris catatan (.note-row) tanpa class .td (padding preflight
               0px — input menempel tepi), jadi padding kiri/kanan 12px juga
               datang dari rule #pos-cart td ini. -->
          <table id="pos-cart" class="table table-compact">
            <thead>
              <tr>
                <th class="th th-sticky text-center w-10">No</th>
                <th class="th th-sticky w-24">Kode</th>
                <th class="th th-sticky w-auto">Nama barang</th>
                <th class="th th-sticky text-right w-24">Harga</th>
                <th class="th th-sticky text-center w-32">Qty</th>
                <th class="th th-sticky text-right w-24">Diskon</th>
                <th class="th th-sticky text-right w-24">Subtotal</th>
                <th class="th th-sticky text-right w-14">Aksi</th>
              </tr>
            </thead>
            <tbody id="pos-rows">${cartRows()}</tbody>
          </table>
        </div>
      </div>

      <div class="card flex min-h-0 flex-col gap-2.5 overflow-y-auto !p-3">
        <!-- 1. Ringkasan = HANYA "Diskon item" (tersembunyi bila 0). Dua baris
             sudah DIHAPUS: "Grand total" (permintaan pemilik 2026-10-04 —
             duplikat TOTAL BELANJA di info bar) dan **"Subtotal"** (putaran 7
             2026-10-04 "ini juga hapus saja" — subtotal sudah terbaca dari
             TOTAL BELANJA di info bar + kolom Subtotal per baris tabel, satu
             angka satu tempat). -->
        <div class="space-y-1">
          <div class="flex items-baseline justify-between" id="pos-disc-item-row" ${diskonBaris() ? '' : 'hidden'}>
            <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Diskon item</span>
            <span id="pos-disc-item" class="text-sm font-semibold text-red-600 dark:text-red-400">-${rp(diskonBaris())}</span>
          </div>
        </div>
        <!-- 2. Aksi cepat (permintaan pemilik 2026-10-04): tombol percepat
             transaksi. Tahan/Pending = fitur NYATA (IndexedDB per device,
             lihat tahanKeranjang/bukaTertahan); Item manual & Diskon memanggil
             aksi yang sudah ada; Voucher & Cetak ulang PLACEHOLDER — tombolnya
             sudah dulu, fiturnya menyusul ("placeholder/hardcode dulu
             tidak apa-apa", P6 & cetak ulang). -->
        <div>
          <span class="label">Aksi cepat</span>
          <div class="grid grid-cols-2 gap-1.5">
            <button type="button" id="pos-hold" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs" title="Bekukan keranjang, lanjutkan nanti lewat Pending (pintasan F7)"${cart.length ? '' : ' disabled'}>${icon('pause')}<span>Tahan</span>${kbd('F7')}</button>
            <button type="button" id="pos-hold-open" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs" title="Buka daftar transaksi tertahan"${holds.length ? '' : ' disabled'}>${icon('clock')}<span>Pending (<span id="pos-hold-count">${holds.length}</span>)</span></button>
            <button type="button" id="pos-qa-manual" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs">${icon('pencil')}<span>Item manual</span></button>
            <button type="button" id="pos-qa-disc" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs">Diskon${kbd('F6')}</button>
            <button type="button" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs" data-soon="Voucher">${icon('copy')}<span>Voucher</span></button>
            <button type="button" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs" data-soon="Cetak ulang">${icon('print')}<span>Cetak ulang</span></button>
          </div>
        </div>
        <!-- 3. Diskon transaksi (alokasi F6). kelas space-y-1.5 = jarak baris
             label ke input di bawahnya — dulu keduanya menempel langsung
             (permintaan pemilik 2026-10-04 "F6 rapikan, karena nempel dengan
             form bawahnya"). <kbd>F6</kbd> DIHAPUS dari baris label
             (permintaan pemilik putaran 7: "ghapus saja, di atasnya sudah ada
             label F6 ternyata di tombol diskon") — pintasan tetap tercantum di
             tombol **Diskon F6** di grid Aksi cepat. -->
        <div class="space-y-1.5">
          <label class="label" for="pos-discount">Diskon transaksi (Rp)</label>
          <input id="pos-discount" class="input input-sm" type="number" inputmode="numeric" min="0" step="500" value="${discount || ''}" placeholder="0" />
        </div>
        <!-- 4. Tombol Bayar = BUKA FORM BAYAR (modal), permintaan pemilik
             2026-10-04: metode bayar + uang diterima + chip nominal +
             kembalian pindah ke modal (ala payment screen Aronium F10),
             supaya sidebar tidak lagi penuh isian. SEMUA id lama ikut pindah
             ke dalam modal dan tetap berfungsi — #pos-cash, #pos-pay (tombol
             OK modal), data-pay, data-cash, #pos-change, #pos-change-ctx —
             supaya pintasan F2/Enter, barrier tunai (P1/P2), dan suite
             tests/e2e-struk.mjs tidak pecah.
             **#pos-pay-pas = PENGECUALIAN**: permintaan pemilik putaran
             kedua (2026-10-04) "bayar uang pas letakkan di sidepanel
             bawahnya Bayar F10" — tombol hijau ini tetap di sidebar langsung
             membayar tanpa form. Yang HANYA lewat form: uang lebih
             (kembalian), uang kurang (jadi HUTANG — wajib pelanggan terpilih
             selain "Pelanggan Umum"), dan metode pembayaran lain. -->
        <div class="mt-auto flex flex-col gap-1.5">
          <button type="button" id="pos-bayar" class="btn btn-primary w-full !py-3.5 text-sm"${cart.length ? '' : ' disabled'}>${icon('check')}<span>Bayar</span>${kbd('F10')}</button>
          <!-- Revisi putaran 8b/8c (2026-10-04): outline sempat dipakai lalu
               diminta pemilik "style hilang yang tombol warna hijaunya" —
               class btn-outline MEMANG tidak ada di styles.css (no-op, jadi
               warnanya hilang). Gaya final: GRADASI hijau + shadow; hover
               hijau LEBIH GELAP (8c: "hover tombol F12 juga ubah ke hijau
               jangan biru, karena tombolnya warna hijau" — versi hover biru
               sempat dipakai 8b lalu dibatalkan). -->
          <button type="button" id="pos-pay-pas" class="btn w-full !py-4 text-base font-semibold text-white bg-linear-to-r from-emerald-500 to-emerald-600 shadow-md shadow-emerald-600/40 hover:from-emerald-600 hover:to-emerald-700 hover:shadow-lg hover:shadow-emerald-700/50 transition-all"${cart.length ? '' : ' disabled'} title="Uang diterima = total, langsung bayar tanpa buka form (F12)">Bayar pas${kbd('F12')}</button>
          <p class="text-center text-xs text-gray-500 dark:text-gray-400">${kbd('F10')} form bayar · ${kbd('F12')} bayar pas</p>
        </div>
      </div>
    </div>`;
}

/* ---------- form bayar (modal) ---------- */

/** Handle modal form bayar yang sedang terbuka (null bila tertutup).
 *  Sumber kebenaran "sedang terbuka" = `el.isConnected`: tombol Batal/ESC/
 *  backdrop menutup modal lewat kode internal openModal(), jadi field ini
 *  bisa saja basi — setiap pembacaan memeriksa koneksi dulu. */
let bayarApi: ModalHandle | null = null;

const formBayarTerbuka = (): boolean => !!bayarApi?.el.isConnected;

/** Judul modal (`Bayar — Rp…`) ikut total terkini — dipanggil paintCart(). */
function segarJudulBayar(): void {
  if (!formBayarTerbuka()) return;
  const judul = bayarApi!.el.querySelector('.modal-header h3');
  if (judul) judul.textContent = `Bayar — ${rp(total())}`;
}

/** Validasi pelanggan untuk pembayaran UANG KURANG / UANG 0 (jadi HUTANG —
 *  otomatis sejak putaran 12). Permintaan pemilik 2026-10-04: "jadi Hutang
 *  dengan catatan harus ada customer yang terpilih dan tidak boleh customer
 *  default/umum"; 2026-10-06: "uang kurang / uang 0 akan otomatis masuk ke
 *  hutang dengan catatan harus terpilih customer".
 *  "" (string kosong) = boleh; selain itu = pesan penolakan untuk toast. */
function cekHutangDiperbolehkan(): string {
  if (customerId === null) {
    return 'Hutang butuh pelanggan — pilih dulu di baris "Pelanggan" (info bar), transaksi tanpa kontak tidak bisa dicatat hutang';
  }
  const p = customers.find((c) => c.id === customerId);
  if (!p) return 'Pelanggan terpilih tidak ada di master — pilih ulang di baris "Pelanggan"';
  if (p.name === 'Pelanggan Umum' || p.code === 'CUS-000001') {
    return '"Pelanggan Umum" adalah bawaan transaksi tanpa kontak — hutang harus atas nama pelanggan lain (pilih di baris "Pelanggan")';
  }
  return '';
}

/** Isi FORM BAYAR — modal (permintaan pemilik 2026-10-04: "pindahkan ke
 *  modal ketika klik bayar", ala payment screen Aronium F10).
 *
 *  **Putaran 10 (2026-10-05): layout dua panel ala Ravaa POS v1** —
 *  permintaan pemilik: "modal bayar silakan dengan referensi ravaapos v1 di
 *  directory tadi, pendekatan yang sama, tanpa mengurangi kecepatan dalam
 *  transaksi, mungkin layout bisa di benahi pada v2 ini". Referensi:
 *  `payment-modal.blade.php` + `.payment-layout-wrapper` (flex 5/7) di
 *  `pos-system.css`. Yang diterapkan —
 *  KIRI (flex-5, border kanan): kartu **Total tagihan** (border-2 primer,
 *  angka 36px extra-bold — putaran 10c "+setengah" dari 24px) → kotak
 *  **Pelanggan** (ikon + nama, penanda alur HUTANG) → **kartu metode**
 *  grid 2 kolom (ikon+label, aktif = primer, gaya `.btn-method-card`) →
 *  petunjuk pintasan;
 *  KANAN (flex-7, bg abu ala `#f8fafc`): **Uang diterima** input besar ala
 *  `.payment-input-huge` (prefix Rp + tombol × `#bayar-clear`) → **chip
 *  nominal 4 pecahan 20/50/100/200rb** (chip "Uang pas" DIHAPUS putaran
 *  10c — sudah ada F12 Bayar pas; chip kembali ukuran normal 1x) →
 *  **kotak hasil KEMBALIAN** putus-putus ala `.payment-section-result`
 *  (label + angka **40px** seukuran `#pos-cash` + teks konteks) →
 *  petunjuk hutang. Blok tunai/non-tunai tetap dirender SEKALIGUS lalu
 *  ditoggle `hidden`, supaya listener bindFormBayar() tidak dipasang ulang.
 *  **Kecepatan transaksi dijaga**: fokus `#pos-cash`
 *  saat buka, Enter-on-input -> ok.click() -> pay(), F2/F10/F12, chip satu
 *  klik + fokus balik ke kolom (siap Enter), semua id lama TANPA perubahan —
 *  #pos-cash, #pos-pay (tombol OK modal — di-set di bukaBayar), data-pay,
 *  data-cash, #pos-change, #pos-change-ctx, #bayar-tunai, #bayar-non-tunai.
 *  **Bayar pas (#pos-pay-pas) sengaja TIDAK ada di form** — tetap di side
 *  panel bawah Bayar (permintaan putaran kedua 2026-10-04).
 *
 *  **Putaran 10b (2026-10-05): tombol + uang diterima ~2x** — *"kurang besar
 *  untuk tombol-tombol dan uang diterima pada modal, silakan atur untuk lebih
 *  besar sekitar 2x lipat"*. Baseline terukur (Playwright, skala @theme repo
 *  yang memang lebih kecil: --text-2xl=20px, --text-sm=13px): kartu metode
 *  34px/13px, chip 25px/11px, #pos-cash 41px/20px, footer 34px/13px. Kini:
 *  kartu metode jadi layout KOLOM ala `.btn-method-card` v1 (ikon atas +
 *  label bawah, border-2) ±73px + font 24px — kolom wajib karena label
 *  horizontal @24px meluber dari kolom 137px; chip ±50px + font 22px;
 *  #pos-cash ±82px + font 40px (2x tepat) dengan prefix Rp 24px ala
 *  `.payment-input-huge` v1; tombol × 28 -> 56px; footer Batal/Bayar
 *  ±68px + font 24px (kelas dipasang di bukaBayar — modal lain normal).
 *
 *  **Putaran 10c (2026-10-05)** — permintaan pemilik: *"Jangan ada uang pas,
 *  karena sudah ada tombol F12 untuk uang pas, ganti 20.000, tapi tombol uang
 *  itu kecilkan 1xnya, kembalian kurang besar seukuran uang diterima, total
 *  tagihan di besarkan setengahnya"*:
 *  - chip **"Uang pas" DIHAPUS** dari modal, QUICK_CASH = [20k, 50k, 100k,
 *    200k] — `#pos-pay-pas` (F12 side panel) TIDAK tersentuh;
 *  - **chip uang kembali ukuran normal 1x** (kelas pembesaran 10b dibuang);
 *  - `#pos-change` font **40px** = seukuran `#pos-cash` (kelasPosChange);
 *  - `#bayar-total` font **36px** (+50% dari 24px).
 *
 *  **Putaran 10d (2026-10-05)** — permintaan pemilik: *"tombol nominalnya
 *  terlalu kecil kalau sekarang, form uang diterima jangan langsung di isi
 *  uang pas, karena tujuannya adalah untuk memasukkan nilai uang kurang atau
 *  uang lebih jadi default 0 dan auto focus sudah OK"*:
 *  - **chip pecahan diperbesar** dari 25px/11px (1x 10c) → ±**44px/17px**
 *    (`!min-h-[44px] !px-4 !py-2 !text-[17px]` — di antara 1x dan 2x);
 *  - **auto-isi "uang pas" (P1) DIHAPUS**: `isiUangOtomatis()` + semua
 *    pemanggilnya dibuang; `bukaBayar()` me-reset `cashIn=0`, jadi kolom
 *    SELALU default kosong — kasir mengisi sendiri uang kurang/lebihnya.
 *    Fokus `#pos-cash` saat buka TIDAK berubah; "uang pas" tetap hanya
 *    F12 `#pos-pay-pas` / chip pecahan. */
function formBayarHtml(): string {
  const tot = total();
  const tunai = payMethod === 'tunai';
  const sel = document.querySelector<HTMLSelectElement>('#pos-customer');
  const namaCust = sel?.selectedOptions[0]?.text.trim() || 'Pelanggan Umum';
  return `
    <div class="grid grid-cols-1 sm:grid-cols-[5fr_7fr]">
      <div class="border-b border-gray-200 p-3 sm:border-b-0 sm:border-r dark:border-gray-700">
        <!-- Putaran 10c (2026-10-05): "total tagihan di besarkan setengahnya"
             -> text-3xl (24px) menjadi text-[36px] (+50%). -->
        <div class="mb-3 rounded-lg border-2 border-primary bg-white p-3 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">Total tagihan</div>
          <div id="bayar-total" class="text-[36px] font-extrabold tabular-nums text-primary">${rp(tot)}</div>
        </div>
        <div class="mb-3 flex items-center gap-2.5">
          <span class="shrink-0 text-primary [&>svg]:size-7">${icon('users')}</span>
          <div class="min-w-0">
            <div class="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Pelanggan</div>
            <div id="bayar-cust" class="truncate text-sm font-bold text-gray-900 dark:text-white">${esc(namaCust)}</div>
          </div>
        </div>
        <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Metode pembayaran</div>
        <div class="grid grid-cols-2 gap-2">
          ${PAY_METHODS.map((m) => {
            const aktif = payMethod === m.key;
            // Putaran 10b (2026-10-05, "kurang besar … sekitar 2x lipat"):
            // kartu metode jadi ~2x — layout KOLOM ala .btn-method-card v1
            // (ikon atas, label bawah, center) supaya label besar muat di
            // kolom sempit (horizontal @24px meluber 137px), border-2 ala v1,
            // tinggi ±73px (baseline 34px), font 13px -> 24px.
            return `<button type="button" data-pay="${m.key}" class="btn w-full flex-col items-center justify-center gap-1 !min-h-[68px] !px-2 !py-1.5 !text-[24px] [&>svg]:size-6 border-2 border-gray-200 bg-white text-gray-700 hover:border-primary dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200${aktif ? ' !border-primary bg-primary-soft !text-primary dark:bg-primary/15' : ''}">${icon(m.icon)}<span>${m.label}</span></button>`;
          }).join('')}
        </div>
        <p class="mt-4 text-center text-xs text-gray-500 dark:text-gray-400">Tekan ${kbd('Enter')} atau ${kbd('F2')} untuk bayar · ${kbd('Esc')} untuk batal</p>
      </div>
      <div class="bg-gray-50 p-3 dark:bg-gray-800/40">
        <div id="bayar-tunai" class="space-y-3"${tunai ? '' : ' hidden'}>
          <div>
            <label class="label" for="pos-cash">Uang diterima</label>
            <!-- Putaran 10b (2026-10-05, "uang diterima … sekitar 2x lipat"):
                 baseline terukur 41px/20px -> ±82px/40px (2x). py-4 + text-[40px]
                 (angka 40px = 2x --text-2xl repo yang = 20px), prefix Rp ikut
                 24px ala .payment-input-huge v1 (1.5rem/800), tombol × 28 -> 56px
                 (2x) dengan ikon dibatasi size-7 supaya tidak raksasa. -->
            <div class="relative mt-1">
              <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[24px] font-extrabold text-gray-500 dark:text-gray-400">Rp</span>
              <input id="pos-cash" class="input !pr-[76px] pl-12 !text-right !text-[40px] !py-4 font-bold tabular-nums" type="number" inputmode="numeric" min="0" step="1000" value="${cashIn || ''}" placeholder="${tot}" />
              <button type="button" id="bayar-clear" aria-label="Kosongkan uang diterima" class="absolute right-2 top-1/2 flex size-14 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 [&>svg]:size-7">${icon('close')}</button>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <!-- Putaran 10d (2026-10-05, "tombol nominalnya terlalu kecil"):
                 chip 25px/11px (1x) -> ±44px/17px (di antara 1x dan 2x).
                 Spasi sebelum tanda kurung kurawal interpolasi WAJIB — kelas
                 arbitrary yang menempelnya tidak di-generate scanner
                 Tailwind v4. -->
            ${QUICK_CASH.map((c) => `<button type="button" data-cash="${c}" class="chip justify-center !min-h-[44px] !px-4 !py-2 !text-[17px] ${cashIn > 0 && cashIn === c ? ' !border-primary !text-primary' : ''}">${rp(c)}</button>`).join('')}
          </div>
          <div class="rounded-lg border border-dashed border-gray-300 bg-white p-3 text-center dark:border-gray-600 dark:bg-gray-800">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Kembalian</div>
            <div id="pos-change" class="${kelasPosChange()}">${rp(change())}</div>
            <p id="pos-change-ctx" class="text-xs font-medium ${teksKembalian() ? '' : 'hidden'} ${
              cashIn > 0 && cashIn < total() ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
            }">${teksKembalian()}</p>
          </div>
          <!-- Uang kurang / uang 0 = HUTANG OTOMATIS (putaran 12, instruksi
               pemilik 2026-10-06: "uang kurang / uang 0 akan otomatis masuk
               ke hutang dengan catatan harus terpilih customer") — tanpa
               konfirmasi swal; pelanggan tidak memenuhi syarat = penolakan
               barrier, lihat cekHutangDiperbolehkan() + pay(). -->
          <p class="text-xs text-gray-500 dark:text-gray-400">Uang kurang / uang 0 <b>otomatis</b> jadi <b>hutang</b> — asal pelanggan terpilih bukan "Pelanggan Umum".</p>
        </div>
        <p id="bayar-non-tunai" class="text-xs text-gray-500 dark:text-gray-400"${tunai ? ' hidden' : ''}>Tanpa uang diterima — transaksi ini tidak ada kembalian.</p>
      </div>
    </div>`;
}

/** Buka form bayar (modal). Klik tombol **Bayar** di sidebar / pintasan
 *  **F10** (referensi Aronium: "Payment (F10) opens payment form"). Sudah
 *  terbuka -> cukup fokus kolom uang, jangan ada dua modal ganda. */
function bukaBayar(): void {
  if (mode !== 'jual' || !shift || busy) return;
  if (formBayarTerbuka()) {
    bayarApi!.el.querySelector<HTMLInputElement>('#pos-cash')?.focus();
    return;
  }
  if (!cart.length) return;
  // Putaran 10d (2026-10-05, "form uang diterima jangan langsung di isi uang
  // pas … jadi default 0"): auto-isi (P1) DIHAPUS — kolom SELALU dibuka
  // kosong, karena tujuannya memasukkan uang KURANG / LEBIH sesungguhnya.
  // Fokus `#pos-cash` saat buka TIDAK berubah (pemilik: "auto focus sudah
  // OK"); "uang pas" hanya lewat F12 `#pos-pay-pas`.
  cashIn = 0;
  cashTouched = false;
  bayarApi = openModal({
    title: `Bayar — ${rp(total())}`,
    body: formBayarHtml(),
    wide: true, // putaran 10: panel 5/7 ala v1 butuh max-w-3xl (max-w-lg terlalu sempit)
    okLabel: 'Bayar',
    cancelLabel: 'Batal',
    onMount: (api) => {
      // Tombol OK footer = tombol Bayar yang selama ini dipakai test &
      // pemanggil lama — id-nya disematkan di sini supaya `#pos-pay`,
      // Enter-on-input (modal.ts -> ok.click()), dan F2 tetap satu aksi.
      api.ok.id = 'pos-pay';
      // Putaran 10b (2026-10-05, "tombol-tombol … sekitar 2x lipat"): footer
      // Batal + Bayar ikut diperbesar KHUSUS modal bayar (34px/13px ->
      // ±68px/24px). Modal lain (pending, cari produk, konfirmasi) tetap
      // ukuran normal — kelasnya dipasang di sini, bukan di modal.ts.
      for (const b of [api.ok, api.el.querySelector<HTMLElement>('.modal-footer [data-x]')]) {
        b?.classList.add('!min-h-[68px]', '!px-8', '!text-[24px]');
      }
      // Satu aksi sama dengan Enter-on-input (modal.ts -> ok.click()) dan F2:
      // semua masuk lewat pay() — validasi uang kurang (tawaran HUTANG) ada
      // di dalam barrier pay(), jadi satu sumber kebenaran.
      api.ok.addEventListener('click', () => void pay());
      bindFormBayar(api.el);
      (api.el.querySelector<HTMLInputElement>('#pos-cash') ?? api.ok).focus();
    },
  });
}

/** Tutup form bayar bila masih terbuka (dipanggil setelah bayar sukses dan
 *  saat meninggalkan halaman POS). */
function tutupBayar(): void {
  if (bayarApi?.el.isConnected) bayarApi.close();
  bayarApi = null;
}

/** Sinkronkan tampilan form bayar dengan state (dipanggil saat ganti metode):
 *  toggle blok tunai/non-tunai + sorot chip metode. */
function paintFormBayar(): void {
  if (!formBayarTerbuka()) return;
  const el = bayarApi!.el;
  const tunai = payMethod === 'tunai';
  const bTunai = el.querySelector<HTMLElement>('#bayar-tunai');
  if (bTunai) bTunai.hidden = !tunai;
  const bNon = el.querySelector<HTMLElement>('#bayar-non-tunai');
  if (bNon) bNon.hidden = tunai;
  el.querySelectorAll<HTMLElement>('[data-pay]').forEach((b) => {
    const aktif = b.dataset.pay === payMethod;
    // Kartu metode gaya .btn-method-card v1 (putaran 10): aktif = border +
    // isi primer muda + teks primer. Daftar kelas WAJIB sama persis dengan
    // render awal di formBayarHtml() supaya ganti metode tidak meninggalkan
    // sisa kelas dari keadaan sebelumnya.
    b.classList.toggle('!border-primary', aktif);
    b.classList.toggle('bg-primary-soft', aktif);
    b.classList.toggle('dark:bg-primary/15', aktif);
    b.classList.toggle('!text-primary', aktif);
  });
}

/** Pasang listener isi form bayar. Dipanggil SATU KALI tiap modal dibuka
 *  (isian tidak dirender ulang — lihat formBayarHtml). */
function bindFormBayar(overlay: HTMLElement): void {
  overlay.querySelectorAll<HTMLElement>('[data-pay]').forEach((b) =>
    b.addEventListener('click', () => {
      payMethod = (b.dataset.pay as PayMethod) || 'tunai';
      // Ganti metode = mulai lagi dari awal: kolom uang kosong (cashIn=0,
      // cashTouched=false) — paintCart menulis ulang isian lewat guard
      // `!cashTouched`. Sama persis dengan aturan lama di sidebar.
      cashIn = 0;
      cashTouched = false;
      paintCart();
      paintFormBayar();
      if (payMethod === 'tunai') overlay.querySelector<HTMLInputElement>('#pos-cash')?.focus();
    }),
  );

  overlay.querySelector('#pos-cash')?.addEventListener('input', (e) => {
    // Kasir menyentuh kolom -> tandai `cashTouched` (sinkronisasi paintCart
    // berhenti menulis ulang isian).
    cashTouched = true;
    cashIn = Number((e.target as HTMLInputElement).value || 0);
    paintCart();
  });

  // Nominal cepat (4 pecahan; putaran 10c: tanpa chip "Uang pas" — sudah ada
  // F12 Bayar pas di side panel): satu klik mengisi kolom uang
  // diterima + kembalian, menghindari salah ketik nol saat kas menerima
  // pecahan besar. paintCart tidak merender ulang form, jadi input & state
  // aktif chip dijaga manual di sana. Fokus DIPERBALIKAN ke kolom uang
  // setelah klik chip (putaran 10, "tanpa mengurangi kecepatan"): kasir
  // tinggal Enter untuk bayar — sebelumnya fokus tertinggal di chip dan
  // Enter menekan chip yang sama lagi.
  overlay.querySelectorAll<HTMLElement>('[data-cash]').forEach((b) =>
    b.addEventListener('click', () => {
      // Pilih pecahan = keputusan eksplisit -> tandai cashTouched.
      cashTouched = true;
      cashIn = Number(b.dataset.cash || 0);
      const inp = overlay.querySelector<HTMLInputElement>('#pos-cash');
      if (inp) inp.value = cashIn ? String(cashIn) : '';
      paintCart();
      inp?.focus();
    }),
  );

  // Tombol × di samping kolom uang (ala btn-clear-huge Ravaa POS v1):
  // salah ketik nominal dibersihkan satu klik lalu fokus balik — tanpa
  // harus select-all manual. Kolom yang sengaja dikosongkan ditandai
  // cashTouched supaya sinkronisasi paintCart tidak mengisi ulang.
  overlay.querySelector('#bayar-clear')?.addEventListener('click', () => {
    cashTouched = true;
    cashIn = 0;
    const inp = overlay.querySelector<HTMLInputElement>('#pos-cash');
    if (inp) inp.value = '';
    paintCart();
    inp?.focus();
  });
}

/* ---------- form topup / tarik ---------- */

const QUICK_NOMINAL = [10000, 20000, 50000, 100000, 200000, 500000];

/** Layanan dalam mode Topup. Tidak ada pilih provider (DANA/OVO/…): kasir mau
 *  sedikit klik, jadi yang dipilih cuma jenis layanannya. Nilai `provider` yang
 *  dikirim ke API adalah kode jenis ini — kolomnya jadi label jenis layanan. */
const TOPUP_JENIS: Jenis[] = [
  { key: 'e-wallet', label: 'E-wallet', ringkas: 'E-wallet', hint: 'Isi saldo DANA/OVO/GoPay', nomorLabel: 'Nomor HP tujuan', nomorPh: '08xxxxxxxxxx' },
  { key: 'pulsa', label: 'Pulsa', ringkas: 'Pulsa', hint: 'Paket data & nelpon', nomorLabel: 'Nomor HP tujuan', nomorPh: '08xxxxxxxxxx' },
  { key: 'pln-token', label: 'Token PLN', ringkas: 'Token PLN', hint: 'Beli token listrik', nomorLabel: 'Nomor meter', nomorPh: 'Nomor meter' },
  { key: 'pln-bill', label: 'Tagihan PLN', ringkas: 'Tagihan PLN', hint: 'Bayar listrik', nomorLabel: 'ID pelanggan / meter', nomorPh: 'ID pelanggan' },
];

/** Mode Tarik: uang keluar dari laci. Sumber dana bisa e-wallet (cash out) atau
 *  transfer rekening — bukan cuma bank. */
const TARIK_JENIS: Jenis[] = [
  { key: 'tarik-ewallet', label: 'Dari e-wallet', ringkas: 'e-wallet', hint: 'Cash out ke tunai', nomorLabel: 'Nomor HP pemilik e-wallet', nomorPh: '08xxxxxxxxxx' },
  { key: 'tarik-bank', label: 'Dari rekening', ringkas: 'rekening', hint: 'Tarik ke tunai', nomorLabel: 'Nomor rekening', nomorPh: 'Nomor rekening' },
];

/** Jenis bawaan tiap mode, supaya kasir tidak perlu klik tambahan saat
 *  baru masuk mode (satu jenis sudah paling sering dipakai). */
function defaultJenis(m: Mode): TopupJenis {
  return m === 'topup' ? 'e-wallet' : 'tarik-ewallet';
}

/** `label` = judul di tile (bisa "Dari rekening" karena ada konteks mode),
 *  `ringkas` = satu kata untuk toast/struk. */
interface Jenis {
  key: TopupJenis;
  label: string;
  ringkas: string;
  hint: string;
  nomorLabel: string;
  nomorPh: string;
}

function jenisList(): Jenis[] {
  return mode === 'topup' ? TOPUP_JENIS : TARIK_JENIS;
}

function jenisAktif() {
  return jenisList().find((j) => j.key === topJenis) ?? jenisList()[0];
}

/** Kode jenis yang dikirim sebagai `provider` ke /api/topups. Diambil dari
 *  `jenisAktif()` (bukan `topJenis` mentah) supaya state yang tertinggal dari
 *  mode lain tidak pernah mengirim pasangan kind/provider yang ngawur. */
function jenisKode(): string {
  return jenisAktif().key.toUpperCase();
}

function topupHtml(): string {
  const total = topNominal + topAdmin;
  const j = jenisAktif();
  const judul = mode === 'topup' ? 'Topup' : 'Tarik tunai';
  return `
  <div class="grid min-h-0 flex-1 gap-2 lg:grid-cols-[1fr_320px]">
    <div class="card min-h-0 space-y-3 overflow-y-auto !p-3">
      <div>
        <span class="label">Jenis layanan</span>
        <div class="grid grid-cols-2 gap-2" id="tp-jenis">
          ${jenisList()
            .map(
              (x) => `<button type="button" data-jenis="${x.key}" class="flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition ${j.key === x.key ? 'border-primary bg-primary/5' : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'}">
              <span class="text-sm font-semibold ${j.key === x.key ? 'text-primary' : 'text-gray-900 dark:text-white'}">${x.label}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">${x.hint}</span>
            </button>`,
            )
            .join('')}
        </div>
      </div>
      <div>
        <label class="label" for="tp-nomor">${j.nomorLabel}</label>
        <input id="tp-nomor" class="input" type="tel" inputmode="numeric" autocomplete="off" placeholder="${j.nomorPh}" value="${topNomor}" />
      </div>
      <div>
        <label class="label" for="tp-nominal">Nominal (Rp)</label>
        <input id="tp-nominal" class="input text-sm font-semibold" type="number" inputmode="numeric" min="0" step="1000" placeholder="0" value="${topNominal || ''}" />
        <div class="mt-2 flex flex-wrap gap-2">
          ${QUICK_NOMINAL.map((n) => `<button type="button" class="chip" data-quick="${n}">${rp(n)}</button>`).join('')}
        </div>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">Nominal adalah saldo yang diterima pelanggan, bukan omzet toko. Omzet toko dari layanan ini adalah biaya admin.</p>
    </div>

    <div class="card flex min-h-0 flex-col gap-2 overflow-y-auto !p-3">
      <div class="flex items-baseline justify-between border-b border-gray-200 pb-2 dark:border-gray-700">
        <span class="text-sm font-semibold text-gray-900 dark:text-white">${judul}</span>
        <span id="tp-kind" class="chip">${j.label}</span>
      </div>
      <div class="flex items-baseline justify-between">
        <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Nominal</span>
        <span id="tp-nominal-view" class="text-sm font-semibold text-gray-900 dark:text-white">${rp(topNominal)}</span>
      </div>
      <div>
        <label class="label" for="tp-admin">Biaya admin (Rp)</label>
        <input id="tp-admin" class="input input-sm" type="number" inputmode="numeric" min="0" step="500" value="${topAdmin || ''}" placeholder="0" />
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">Saran otomatis sesuai nominal, boleh diubah.</p>
      </div>
      <div class="flex items-baseline justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
        <span class="text-sm font-semibold text-gray-900 dark:text-white">Total dibayar</span>
        <span id="tp-total" class="text-sm font-bold text-primary">${rp(total)}</span>
      </div>
      <div>
        <span class="label">Pelanggan bayar dengan</span>
        <div class="flex flex-wrap gap-2">
          ${PAY_METHODS.map((m) => `<button type="button" data-pay="${m.key}" class="chip${payMethod === m.key ? ' !border-primary !text-primary' : ''}">${m.label}</button>`).join('')}
        </div>
      </div>
      ${
        payMethod === 'tunai'
          ? `<div>
               <label class="label" for="tp-tunai">Uang diterima (Rp)</label>
               <input id="tp-tunai" class="input input-sm" type="number" inputmode="numeric" min="0" step="1000" value="${topTunai || ''}" placeholder="0" />
             </div>
             <div class="flex items-baseline justify-between">
               <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Kembalian</span>
               <span id="tp-kembali" class="text-sm font-semibold ${topTunai > 0 && topTunai < total ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}">${rp(topTunai > 0 ? topTunai - total : 0)}</span>
             </div>`
          : ''
      }
      <button type="button" id="tp-submit" class="btn btn-primary mt-auto w-full !py-3 text-sm"${busy ? ' disabled' : ''}>${icon('check')}<span>Proses ${judul}</span></button>
      <p class="text-center text-xs text-gray-500 dark:text-gray-400">Tekan <kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">Enter</kbd> untuk proses, <kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">F2</kbd> untuk proses cepat</p>
    </div>
  </div>`;
}

function cartRows(): string {
  if (!cart.length) {
    return `<tr><td colspan="8"><div class="empty">Scan barcode atau ketik nama produk, lalu tekan Enter.</div></td></tr>`;
  }
  return cart
    .map((l, i) => {
      const gross = jumlahBaris(l);
      const net = gross - l.discount;
      // Baris catatan (produk use_note=1): input satu baris DI BAWAH baris
      // produk, mis. Cetak Banner -> "ukuran 1 x 3 meter". colspan=8 = seluruh
      // lebar tabel (No..Aksi). td TANPA class `.td` — padding kiri/kanan
      // (12px) datang dari `.table-compact td` (table-compact di cartGridHtml);
      // tanpa itu preflight membuatnya 0px dan input menempel tepi.
      // Disimpan live lewat event `input` (tanpa paintCart, supaya fokus tidak
      // pindah saat kasir mengetik).
      const trCatatan = l.useNote ? `
      <tr data-key="${l.key}" class="note-row">
        <td colspan="8">
          <input class="input input-sm w-full" type="text" maxlength="200"
            data-act="note" data-key="${l.key}" value="${esc(l.note)}"
            placeholder="Catatan (mis. ukuran 1 x 3 meter)"
            aria-label="Catatan ${esc(l.name)}" />
        </td>
      </tr>` : '';
      return `<tr data-key="${l.key}" class="hover:bg-primary-soft dark:hover:bg-primary/15 transition-colors">
      <td class="td td-num text-center text-gray-500">${i + 1}</td>
      <td class="td font-mono text-xs">${l.sku ? esc(l.sku) : '<span class="text-gray-400">—</span>'}</td>
      <td class="td">
        <div class="cell-strong">${esc(l.name)}</div>
        <div class="cell-sub">${l.product_id === null ? 'item manual' : l.track_stock ? '' : 'jasa'}${l.unit && l.baseUnit && l.unit !== l.baseUnit ? ` · jual per ${l.unit}` : ''}${expBarisKeranjang(l.product_id)}</div>
      </td>
      <td class="td td-num">${rp(l.price)}</td>
      <td class="td">
        <div class="flex items-center justify-center gap-1">
          <button type="button" class="row-btn" data-act="dec" data-key="${l.key}" title="Kurangi" aria-label="Kurangi qty">${icon('minus')}</button>
          <input class="input input-sm !w-20 text-center font-semibold" data-act="qty" data-key="${l.key}" type="number" inputmode="numeric" min="0" value="${l.qty}" aria-label="Qty ${l.name}" />
          <button type="button" class="row-btn" data-act="inc" data-key="${l.key}" title="Tambah" aria-label="Tambah qty">${icon('plus')}</button>
        </div>
      </td>
      <td class="td td-num">
        <input class="input input-sm !w-20 text-right" data-act="disc" data-key="${l.key}" type="number" inputmode="numeric"
          min="0" step="100" value="${l.discount || ''}" placeholder="0"
          aria-label="Diskon baris ${esc(l.name)}" title="Diskon baris (Rp) — maksimum ${rp(gross)}" />
      </td>
      <td class="td td-num">
        ${l.discount > 0 ? `<div class="text-xs text-gray-400 line-through tabular-nums">${rp(gross)}</div>` : ''}
        <div class="font-semibold text-gray-900 tabular-nums dark:text-white">${rp(net)}</div>
      </td>
      <td class="td text-right"><button type="button" class="row-btn row-btn-danger" data-act="del" data-key="${l.key}" title="Hapus" aria-label="Hapus ${esc(l.name)}">${icon('trash')}</button></td>
    </tr>${trCatatan}`;
    })
    .join('');
}

/* ---------- render ---------- */

/** Produk kategori `topup` (Topup & Tarik Tunai) BUKAN item jual.
 *
 *  Satu produk cuma punya SATU harga, sedangkan topup butuh dua angka:
 *  `nominal` (mutasi modal, bukan omzet) + `admin` (pendapatan jasa) — lihat
 *  AGENTS.md §1 dan tabel `topup_txns`. Kalau produk ini dibiarkan masuk
 *  keranjang, seluruh `total` masuk ke `SUM(sales.total)` = omzet dan laporan
 *  jadi，过 overstated. Jadi produknya jadi PINTASAN: scan/cari -> buka mode
 *  yang tepat, transaksi tetap tercatat di `topup_txns`. */
const KATEGORI_LAYANAN = 'topup';

function isLayanan(p: Product): boolean {
  return p.category_slug === KATEGORI_LAYANAN;
}

/** Buka mode topup/tarik dari produk katalog. */
function bukaModeLayanan(p: Product): void {
  mode = /tarik/i.test(p.name) || /tarik/i.test(p.sku) ? 'tarik' : 'topup';
  topJenis = defaultJenis(mode);
  topNomor = '';
  topNominal = 0;
  topAdmin = 0;
  topAdminTouched = false;
  topTunai = 0;
  paint();
  toast(`${p.name} — isi form ${mode === 'topup' ? 'topup' : 'tarik tunai'}`, 'info');
}

function paint(): void {
  // `host` bisa sudah lepas dari DOM: mountPosPage async (syncMaster, loadShift)
  // masih jalan lalu kasir pindah halaman. Tanpa guard ini, POS menimpa halaman
  // lain yang baru dirender router.
  if (!host || !host.isConnected) return;
  host.innerHTML = shift ? cartHtml() : shiftGateHtml();
  // Saklar "Cetak struk otomatis" ikut diganti tiap paint() (host.innerHTML),
  // jadi listenernya WAJIB dipasang di sini — bukan di bindCart(). bindCart()
  // hanya dipanggil saat mode 'jual'; kalau listenernya menetap di sana, saklar
  // di mode topup/tarik kelihatan berfungsi tapi MATEK: checkbox bergerak,
  // `autoPrint` tidak ikut, sehingga struk diam-diam tidak dicetak.
  host.querySelector('#pos-autoprint')?.addEventListener('change', (e) => {
    autoPrint = (e.target as HTMLInputElement).checked;
    setAutoPrint(autoPrint);
  });
  if (!shift) {
    bindShiftGate();
    return;
  }
  if (mode === 'jual') bindCart();
  else bindTopup();
  if (mode === 'jual') host.querySelector<HTMLInputElement>('#pos-q')?.focus();
  else host.querySelector<HTMLInputElement>('#tp-nomor')?.focus();
}

function paintCart(): void {
  if (!host || !shift || mode !== 'jual') return;
  // Cuma tbody + panel kanan, supaya fokus input scan tidak hilang.
  const rows = host.querySelector('#pos-rows');
  if (rows) rows.innerHTML = cartRows();
  // Pencarian pakai `document`, BUKAN `host`: isian pembayaran kini berada
  // di MODAL form bayar (openModal menempelkannya ke document.body), sementara
  // elemen sidebar tetap ada di dalam host — keduanya menemukan id masing-
  // masing karena id unik dan tiap selector sudah dijaga `if (el)`.
  const set = (sel: string, v: string) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = v;
  };
  set('#pos-count', cart.length ? `${count()} item` : 'Keranjang kosong');
  // `#pos-subtotal` TIDAK diisi lagi — baris Subtotal sidebar dihapus putaran 7
  // 2026-10-04; subtotal terbaca dari TOTAL BELANJA (#pos-grand) di info bar.
  // Info bar (ala KulaPOS): TOTAL BELANJA besar + jumlah baris/Qty ikut
  // berubah tiap keranjang berubah — elemennya di luar area repaint tbody,
  // jadi disetel eksplisit di sini. Baris "Grand total" di sidebar sudah
  // DIHAPUS (duplikatnya; permintaan pemilik 2026-10-04) — #pos-grand
  // = SATU-SATUNYA angka total besar.
  set('#pos-grand', rp(total()));
  set('#pos-owncount', cart.length ? `${cart.length} item (${count()} Qty)` : '0 item');
  // Placeholder "Uang diterima" menampilkan amount due (pola Aronium) — form
  // bayar tidak dirender ulang di paintCart, jadi placeholder harus diikut-
  // setiap total berubah (render awal selalu 0 karena keranjang masih kosong).
  const cashEl = document.querySelector<HTMLInputElement>('#pos-cash');
  if (cashEl) {
    cashEl.placeholder = String(total());
    // `cashIn` = sumber kebenaran; tulis ke input hanya kalau kasir belum
    // menyentuh kolom (mis. ganti metode me-reset `cashIn=0` lewat handler
    // data-pay). `.value =` TIDAK memicu event `input`, jadi `cashTouched`
    // tidak ikut berubah.
    if (!cashTouched) cashEl.value = cashIn ? String(cashIn) : '';
  }
  // Angka "Total tagihan" di kepala form bayar ikut total terkini.
  set('#bayar-total', rp(total()));
  segarJudulBayar();
  set('#pos-change', rp(change()));
  // P2: teks konteks di bawah angka KEMBALIAN ("Kurang Rp…" / "Uang pas. …").
  const ctx = document.querySelector('#pos-change-ctx');
  if (ctx) {
    const t = teksKembalian();
    const pendek = cashIn > 0 && cashIn < total();
    ctx.textContent = t;
    ctx.className =
      `text-xs font-medium ${pendek ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}` +
      (t ? '' : ' hidden');
  }
  // Baris "Diskon item" dirender sekali lalu ditampilkan/disembunyikan —
  // paintCart tidak mengganti sidebar, jadi barisnya harus bisa hidup mati
  // lewat atribut `hidden` tanpa merender ulang (fokus input tetap aman).
  const db = diskonBaris();
  set('#pos-disc-item', `-${rp(db)}`);
  const dbRow = host!.querySelector<HTMLElement>('#pos-disc-item-row');
  if (dbRow) dbRow.hidden = db === 0;
  const changeEl = document.querySelector('#pos-change');
  if (changeEl) {
    // Kelas diambil dari SATU sumber (kelasPosChange) — jangan ditulis ulang
    // di sini, render awal di formBayarHtml memakai fungsi yang sama.
    changeEl.className = kelasPosChange();
  }
  const pay = document.querySelector<HTMLButtonElement>('#pos-pay');
  if (pay) pay.disabled = cart.length === 0 || busy;
  // Bayar pas ikut mati saat keranjang kosong / sedang proses (disable-nya
  // diperbarui bersama #pos-pay; keduanya kini di dalam form bayar).
  const payPas = document.querySelector<HTMLButtonElement>('#pos-pay-pas');
  if (payPas) payPas.disabled = cart.length === 0 || busy;
  // Tombol Bayar di sidebar = pembuka form bayar; mati saat keranjang kosong
  // atau sedang proses (sama aturan dengan #pos-pay dulu).
  const bayar = host!.querySelector<HTMLButtonElement>('#pos-bayar');
  if (bayar) bayar.disabled = cart.length === 0 || busy;
  const clr = host!.querySelector<HTMLButtonElement>('#pos-clear');
  if (clr) clr.disabled = cart.length === 0;
  // Aksi cepat (sidebar): Tahan mati saat keranjang kosong/sedang proses,
  // Pending mati saat tak ada yang tertahan; badge angkanya ikut jumlah holds
  // (dirender ulang hanya lewat paintCart — tombol panel tidak di-repaint penuh).
  const holdBtn = host!.querySelector<HTMLButtonElement>('#pos-hold');
  if (holdBtn) holdBtn.disabled = cart.length === 0 || busy;
  const holdOpen = host!.querySelector<HTMLButtonElement>('#pos-hold-open');
  if (holdOpen) holdOpen.disabled = holds.length === 0;
  set('#pos-hold-count', String(holds.length));
  // Chip nominal cepat: sorot yang cocok dengan cashIn (putaran 10c: tanpa
  // cabang "Uang pas" — chip itu sudah dihapus, tersisa 4 pecahan angka).
  document.querySelectorAll<HTMLElement>('[data-cash]').forEach((b) => {
    const nilai = Number(b.dataset.cash ?? 0);
    const aktif = cashIn > 0 && cashIn === nilai;
    b.classList.toggle('!border-primary', aktif);
    b.classList.toggle('!text-primary', aktif);
  });
}

/* ---------- aksi keranjang ---------- */

/** Kosongkan keranjang + diskon (tombol hapus & pintasan F5 — P3).
 *  Dulu hanya tombol yang memanggil blok ini, dan kolom "Diskon transaksi"
 *  tidak ikut dikosongkan: state `discount` kembali 0 tapi angka di input
 *  masih tertinggal (setelah pembayaran kolom itu memang dibersihkan manual —
 *  lihat pemanggilan di `pay()`). Sekarang SATU fungsi untuk keduanya. */
function bersihkanKeranjang(): void {
  if (!cart.length) return;
  cart = [];
  discount = 0;
  cashIn = 0;
  cashTouched = false;
  paintCart();
  const disc = host?.querySelector<HTMLInputElement>('#pos-discount');
  if (disc) disc.value = '';
  host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
}

/* ---------- tahan / pending (fitur P5) ---------- */

/** Total sebuah hold = subtotal baris − diskon per baris − diskon transaksi
 *  (rumus sama dengan `total()` keranjang aktif). */
const hitungHold = (h: Hold) =>
  Math.max(0, h.items.reduce((s, l) => s + Math.round(l.price * l.qty) - l.discount, 0) - h.discount);

/** Tulis daftar hold ke IndexedDB (kv 'holds'). Gagal menyimpan TIDAK
 *  membuang hold dari memori — kasir tetap bisa memakainya sesi ini; hanya
 *  dilaporkan supaya kehilangan setelah refresh tidak diam-diam. */
async function simpanTertahan(): Promise<void> {
  try {
    await saveHolds(holds);
  } catch {
    toast('Gagal menyimpan daftar transaksi tertahan', 'error');
  }
}

/** Bekukan keranjang (tombol "Tahan"): snapshot isi keranjang + pelanggan +
 *  diskon ke hold, simpan ke IndexedDB, lalu kosongkan keranjang lewat
 *  jalur `bersihkanKeranjang()` yang sama (F5/Bersihkan). Pelanggan di
 *  select kembali bawaan — pilihan ikut tertahan, divalidasi ulang saat
 *  `muatHold()` (id bisa saja sudah tidak ada di master). */
async function tahanKeranjang(): Promise<void> {
  if (busy || !cart.length) return;
  holds.unshift({
    id: uuid(),
    waktu: new Date().toISOString(),
    kasir: getCashier(),
    customerId,
    customerName: customers.find((c) => c.id === customerId)?.name ?? 'Pelanggan Umum',
    discount,
    items: cart.map((l) => ({ ...l })),
  });
  await simpanTertahan();
  bersihkanKeranjang();
  customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
  const sel = host?.querySelector<HTMLSelectElement>('#pos-customer');
  if (sel) sel.value = customerId === null ? '' : String(customerId);
  paintCart();
  toast(`Transaksi ditahan — ${holds.length} tertahan`, 'info');
}

/** Muat kembali isi hold ke keranjang ("Lanjutkan" di daftar Pending).
 *  Keranjang aktif tidak boleh hilang diam-diam: bila masih ada isinya,
 *  kasir dikonfirmasi dulu (SweetAlert2 — bukan confirm() native). */
async function muatHold(h: Hold): Promise<void> {
  if (busy) return;
  if (cart.length) {
    const ok = await confirmDialog({
      title: 'Ganti keranjang saat ini?',
      message: `${cart.length} baris di keranjang akan dibuang dan diganti isi transaksi tertahan ini.`,
      okLabel: 'Ya, ganti',
      cancelLabel: 'Batal, jangan diganti',
    });
    if (!ok) return;
  }
  cart = h.items.map((l) => ({ ...l }));
  discount = h.discount;
  // Pelanggan hold divalidasi terhadap master terkini — id lama yang sudah
  // tidak ada jatuh ke Pelanggan Umum, bukan ke select kosong.
  customerId = customers.some((c) => c.id === h.customerId)
    ? h.customerId
    : customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
  const sel = host?.querySelector<HTMLSelectElement>('#pos-customer');
  if (sel) sel.value = customerId === null ? '' : String(customerId);
  // Item manual hold memakai key `manual:<n>` — dorong seq melampaui angka
  // tertinggi supaya item manual BERIKUTNYA tidak menabrak key lama.
  for (const l of cart) {
    const m = /^manual:(\d+)$/.exec(l.key);
    if (m) manualSeq = Math.max(manualSeq, Number(m[1]));
  }
  holds = holds.filter((x) => x.id !== h.id);
  await simpanTertahan();
  cashIn = 0;
  cashTouched = false;
  const disc = host?.querySelector<HTMLInputElement>('#pos-discount');
  if (disc) disc.value = discount ? String(discount) : '';
  const cash = document.querySelector<HTMLInputElement>('#pos-cash');
  if (cash) cash.value = '';
  paintCart();
  host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
  toast('Transaksi tertahan dilanjutkan', 'success');
}

/** Hapus satu hold dari daftar (dipanggil dari modal Pending). Konfirmasi
 *  swal dulu; `tampil()` me-render ulang daftar antrian + panel preview
 *  (bila yang terhapus sedang dibuka, pemindahan otomatis ke antrian
 *  berikutnya), dan modal ditutup sendiri bila tinggal terakhir. */
async function hapusHold(h: Hold, api: ModalHandle, tampil: () => void): Promise<void> {
  const ok = await confirmDialog({
    title: 'Hapus transaksi tertahan?',
    message: `${h.items.length} baris senilai ${rp(hitungHold(h))} akan dihapus permanen.`,
    okLabel: 'Ya, hapus',
    danger: true,
    cancelLabel: 'Batal, jangan dihapus',
  });
  if (!ok) return;
  holds = holds.filter((x) => x.id !== h.id);
  await simpanTertahan();
  paintCart();
  if (!holds.length) {
    api.close();
    return;
  }
  tampil();
}

/** Daftar transaksi tertahan (tombol "Pending (n)") — **MODAL SPLIT ala
 *  Ravaa POS v1** (permintaan pemilik 2026-10-05: "sebagai referensi lihat
 *  layout di ravaa POS versi 1 … coba di terapkan pada modal pending di
 *  ravaaPOS v2"): referensi `hold-modal.blade.php` + `.modal-split` di
 *  `src/RPOS/public/assets/css/pos-system.css` (flex 3/7, split-header,
 *  `.split-item.active` solid primer) dan `showHoldDetail()` di
 *  `src/RPOS/public/assets/js/pos/index.js` (struktur detail `detailHtml`).
 *  Yang diterapkan: proporsi 30% / 70% (`grid-cols-[3fr_7fr]`), header bar
 *  "DAFTAR ANTRIAN" ala `.split-header`, kartu antrian hover biru + aktif
 *  SOLID primer/teks putih/shadow, dan panel kanan persis struktur v1:
 *  header-info Pelanggan|Waktu simpan (garis dashed) → "Daftar Produk
 *  (N item)" kartu abu-abu → kotak ringkasan Subtotal/Diskon/Total → dua
 *  tombol aksi [Hapus outline] [Lanjutkan primer] di BAWAH detail (bukan
 *  per kartu, seperti v1). Urutan kolom TETAP kiri=antrian / kanan=detail
 *  sesuai instruksi pemilik sebelumnya (v1 menaruh daftar di kanan — kita
 *  mirror sisanya). Tinggi fix 60vh per kolom + gulir sendiri (permintaan
 *  "tinggi fix misal 60% … buat scrollable"). Selector test
 *  pos-qtykode-test.mjs §C3 dipertahankan: `#hold-list li[data-hold-row]`
 *  (kartu memuat teks `3 baris (7 Qty)`), `[data-hold-act="lanjut"]` (kini
 *  SATU kecocokan di panel detail), `#hold-preview` (60vh + overflow auto).
 *  Modal memakai openModal `wider` (max-w-5xl ≈ 900px modal-lg v1) dengan
 *  OK disembunyikan — cukup satu tombol "Tutup". */
function bukaTertahan(): void {
  if (!holds.length) {
    toast('Belum ada transaksi tertahan', 'info');
    return;
  }
  let terpilih = holds[0].id; // antrian terbaru (unshift) = yang dibuka pertama

  const stempel = (h: Hold): string =>
    new Date(h.waktu).toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });

  /** Kartu antrian (kiri) — gaya `.split-item` v1: margin + border + radius,
   *  hover `#eff6ff` (≈ blue-50) + border primer, dan aktif = **bg primer
   *  SOLID + teks putih + shadow** (v1 `.split-item.active`, menggantikan
   *  bg-soft sebelumnya). Isi ringkas ala v1: nama pelanggan + total,
   *  baris/Qty (dipertahankan untuk test §C3), stempel waktu. */
  const baris = (h: Hold, aktif: boolean): string => {
    const qty = h.items.reduce((s, l) => s + l.qty, 0);
    return `<li class="m-2 cursor-pointer rounded-lg border px-3 py-2.5 transition-all${aktif
        ? ' border-primary bg-primary text-white shadow-md'
        : ' border-gray-200 bg-white hover:border-primary hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-primary/10'}"
      data-hold-row="${h.id}"${aktif ? ' aria-current="true"' : ''}>
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-sm font-bold">${esc(h.customerName)}</span>
        <span class="shrink-0 text-xs font-bold tabular-nums${aktif ? ' text-white' : ' text-primary'}">${rp(hitungHold(h))}</span>
      </div>
      <div class="mt-0.5 text-xs${aktif ? ' text-white/90' : ' text-gray-500 dark:text-gray-400'}">${h.items.length} baris (${qty} Qty)</div>
      <div class="text-[10px]${aktif ? ' text-white/75' : ' text-gray-400 dark:text-gray-500'}">${stempel(h)}</div>
    </li>`;
  };

  /** Panel kanan: detail terpilih persis struktur `detailHtml` v1 —
   *  header-info 2 kolom (Pelanggan | Waktu simpan, garis dashed), label
   *  "Daftar Produk (N item)", kartu produk abu-abu (nama + qty × harga di
   *  kiri, netto primer tebal di kanan), kotak ringkasan Subtotal/Diskon/
   *  Total (garis dashed, angka Total primer text-xl), lalu dua tombol aksi
   *  [Hapus outline merah] [Lanjutkan primer]. SKU tetap ditampilkan di
   *  baris info (tambahan kecil di luar v1, dipakai test §C3). */
  const preview = (h: Hold | null): string => {
    if (!h) {
      return `<div class="flex h-full flex-col items-center justify-center p-8 text-center text-gray-500 dark:text-gray-400">
        <span class="mb-3 opacity-30 [&>svg]:size-12">${icon('info')}</span>
        <p class="text-sm">Pilih salah satu antrian di kiri untuk melihat detail.</p>
      </div>`;
    }
    const produk = h.items.map((l, i) => {
      const gross = Math.round(l.price * l.qty);
      const net = gross - (l.discount || 0);
      const per =
        l.unit && l.baseUnit && l.unit !== l.baseUnit ? ` / ${esc(l.unit)}` : '';
      const sub = `${l.sku ? `${esc(l.sku)} · ` : ''}${l.qty} × ${rp(l.price)}${per}` +
        (l.discount ? ` · <span class="text-red-600 dark:text-red-400">diskon -${rp(l.discount)}</span>` : '') +
        (l.note ? `<br>${esc(l.note)}` : '');
      return `<li class="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-3 dark:bg-gray-700/40">
        <div class="min-w-0">
          <div class="truncate text-sm font-bold text-gray-900 dark:text-white">${i + 1}. ${esc(l.name)}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">${sub}</div>
        </div>
        <div class="shrink-0 text-sm font-bold tabular-nums text-primary">${rp(net)}</div>
      </li>`;
    }).join('');
    const subtotal = h.items.reduce(
      (s, l) => s + Math.round(l.price * l.qty) - (l.discount || 0), 0);
    return `
      <div class="p-4">
        <div class="mb-4 grid grid-cols-2 gap-4 border-b border-dashed border-gray-200 pb-4 dark:border-gray-700">
          <div>
            <div class="mb-1 text-[10px] font-semibold uppercase text-gray-500 dark:text-gray-400">Pelanggan</div>
            <div class="text-sm font-bold text-gray-900 dark:text-white">${esc(h.customerName)}</div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">Kasir ${esc(h.kasir)}</div>
          </div>
          <div>
            <div class="mb-1 text-[10px] font-semibold uppercase text-gray-500 dark:text-gray-400">Waktu simpan</div>
            <div class="text-sm font-bold text-gray-900 dark:text-white">${stempel(h)}</div>
          </div>
        </div>
        <div class="mb-3 text-[10px] font-semibold uppercase text-gray-500 dark:text-gray-400">Daftar produk (${h.items.length} item)</div>
        <ul class="flex flex-col gap-2">${produk}</ul>
        <div class="mt-4 rounded-lg bg-gray-100 p-4 dark:bg-gray-700/50">
          <div class="mb-2 flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Subtotal</span>
            <span class="font-bold tabular-nums">${rp(subtotal)}</span>
          </div>
          ${h.discount ? `<div class="mb-2 flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Diskon</span>
            <span class="font-bold tabular-nums text-red-600 dark:text-red-400">-${rp(h.discount)}</span>
          </div>` : ''}
          <div class="flex items-center justify-between border-t border-dashed border-gray-300 pt-2 dark:border-gray-500">
            <span class="font-bold">Total</span>
            <span class="text-xl font-bold tabular-nums text-primary">${rp(hitungHold(h))}</span>
          </div>
        </div>
        <div class="mt-6 flex gap-3">
          <button type="button" class="btn flex-1 border border-red-500 bg-white text-red-600 hover:bg-red-50 dark:bg-transparent dark:hover:bg-red-900/20" data-hold-act="hapus" data-hold-id="${h.id}">${icon('trash')}<span>Hapus</span></button>
          <button type="button" class="btn btn-primary flex-1" data-hold-act="lanjut" data-hold-id="${h.id}">${icon('sync')}<span>Lanjutkan</span></button>
        </div>
      </div>`;
  };

  /** Render ulang KEDUA kolom + judul. Pemindahan pemilihan dilakukan di
   *  sini: id yang sudah tidak ada (habis dihapus) jatuh ke antrian pertama. */
  const tampil = (api: ModalHandle): void => {
    if (!holds.some((x) => x.id === terpilih)) terpilih = holds[0]?.id ?? '';
    const ul = api.el.querySelector<HTMLElement>('#hold-list');
    if (ul) ul.innerHTML = holds.map((h) => baris(h, h.id === terpilih)).join('');
    const pv = api.el.querySelector<HTMLElement>('#hold-preview');
    if (pv) pv.innerHTML = preview(holds.find((x) => x.id === terpilih) ?? null);
    const antrian = api.el.querySelector('#hold-antrian-count');
    if (antrian) antrian.textContent = String(holds.length);
    const judul = api.el.querySelector('.modal-header h3');
    if (judul) judul.textContent = `Transaksi tertahan (${holds.length})`;
  };

  openModal({
    title: `Transaksi tertahan (${holds.length})`,
    wider: true, // max-w-5xl — mendekati modal-lg 900px v1; 30/70 butuh ruang detail
    body: `
      <!-- .modal-split v1 (proporsi flex 3/7) → grid 3fr/7fr; pemisah =
           border KANAN kolom kiri (v1: border-LEFT kolom daftar). Tiap kolom
           tinggi FIX 60vh (permintaan pemilik 2026-10-05: "tinggi fix, misal
           60% dari screen … buat scrollable") dan menggulir sendiri. -->
      <div class="grid grid-cols-1 sm:grid-cols-[3fr_7fr]">
        <div class="flex h-[60vh] min-h-0 flex-col border-b border-gray-200 sm:border-b-0 sm:border-r dark:border-gray-700">
          <!-- split-header ala v1: bar label uppercase kecil di atas daftar -->
          <div class="shrink-0 border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-700/40 dark:text-gray-400">Daftar antrian (<span id="hold-antrian-count">${holds.length}</span>)</div>
          <ul id="hold-list" class="min-h-0 flex-1 overflow-y-auto pb-1">${holds.map((h) => baris(h, h.id === terpilih)).join('')}</ul>
        </div>
        <div class="h-[60vh] min-h-0">
          <div id="hold-preview" class="h-full overflow-y-auto">${preview(holds[0] ?? null)}</div>
        </div>
      </div>`,
    cancelLabel: 'Tutup',
    onMount: (api) => {
      api.ok.style.display = 'none'; // daftar tidak butuh tombol OK
      // SATU listener di root modal: tombol aksi [data-hold-act] kini berada
      // di panel detail KANAN (alaa v1, bukan per kartu), sedangkan klik baris
      // antrian KIRI = pindah pemilihan — keduanya ditangkap dari `api.el`.
      api.el.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-hold-act]');
        if (b) {
          const h = holds.find((x) => x.id === b.dataset.holdId);
          if (!h) return;
          if (b.dataset.holdAct === 'lanjut') {
            // Tutup modal dulu — confirmDialog("Ganti keranjang?") di muatHold
            // jadi satu-satunya dialog di layar (swal di atas modal-overlay
            // membuat ESC menutup keduanya sekaligus).
            api.close();
            void muatHold(h);
          } else {
            void hapusHold(h, api, () => tampil(api)); // modal tetap terbuka, render ulang
          }
          return;
        }
        // Klik kartu antrian (bukan tombol) = pindah fokus detail ke hold itu
        const li = (e.target as HTMLElement).closest<HTMLElement>('#hold-list [data-hold-row]');
        if (!li?.dataset.holdRow || li.dataset.holdRow === terpilih) return;
        terpilih = li.dataset.holdRow;
        tampil(api);
      });
    },
  });
}

function askNumber(title: string, label: string, value: number, step = 500): Promise<number | null> {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<div><label class="label" for="pos-ask">${label}</label>
        <input id="pos-ask" class="input" type="number" inputmode="numeric" min="0" step="${step}" value="${value || ''}" /></div>`,
      okLabel: 'Simpan',
      onMount: (api) => {
        const inp = api.el.querySelector<HTMLInputElement>('#pos-ask');
        inp?.focus();
        inp?.select();
        const done = () => resolve(Number(inp?.value || 0));
        api.ok.addEventListener('click', done);
        inp?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
            api.close();
          }
        });
      },
    });
    // Batal / tutup -> null (tidak menambahkan apa pun).
    m.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-x]') || t.closest('.modal-overlay') === t) {
        m.el.addEventListener('transitionend', () => resolve(null), { once: true });
        setTimeout(() => resolve(null), 300);
      }
    });
  });
}

/** Harga dinamis wajib per transaksi (AGENTS.md §1) — jadi selalu ditanyakan.
 *  `unit` diisi bila satuan terpilih bukan satuan dasar, supaya kasir tahu
 *  harga yang diketik itu untuk pack/dus, bukan untuk 1 pcs. */
function askPrice(p: Product, unit?: string): Promise<number | null> {
  return askNumber(`Harga: ${p.name}${unit ? ` (per ${unit})` : ''}`, 'Harga jual (Rp)', 0);
}

/** Masukkan satu produk ke keranjang. Harga dinamis selalu ditanyakan
 *  (AGENTS.md §1: price_dynamic=1 wajib harga per transaksi).
 *
 *  `unitSlug` dipilih lewat chip satuan di dropdown (fitur #3). Angka harga di
 *  sini hanya untuk TAMPILAN awal baris — harga final tetap ditentukan server
 *  di POST /api/sales, jadi client tidak bisa memanipulasinya. */
function addProduct(p: Product, unitSlug?: string, qtyOverride?: number): void {
  // Qty eksplisit dari sintaks `Qty*Kode` (bacaQtyKode) MENANG atas chip
  // Qty/F4 — dan sengaja TIDAK mengosongkan qtyNext: preset kasir untuk item
  // berikutnya tetap berlaku, angka `3*` hanya berlaku untuk baris ini.
  const qtyPakai = () => qtyOverride ?? pakaiQtyNext();
  // Pintasan layanan: kategori topup -> form, bukan baris keranjang.
  if (isLayanan(p)) {
    bukaModeLayanan(p);
    return;
  }
  const ru = unitSlug && unitSlug !== p.unit
    ? (p.units ?? []).find((u) => u.unit === unitSlug)
    : undefined;
  const unit = ru ? ru.unit : p.unit;
  const factor = ru ? ru.factor : 1;
  // price di baris satuan = harga grosir eksplisit; NULL = ikut rumus.
  const hargaTampil = ru ? (ru.price ?? Math.round(p.price * factor)) : p.price;

  if (p.price_dynamic) {
    void askPrice(p, ru ? unit : undefined).then((price) => {
      if (!price || price <= 0) return;
      // qtyNext baru dipakai kalau benar-benar masuk keranjang — batal dialog
      // harga = preset tidak hilang.
      addLine(p, price, qtyPakai(), unit, factor);
      paintCart();
      focusScan();
    });
    return;
  }
  addLine(p, hargaTampil, qtyPakai(), unit, factor);
  paintCart();
  focusScan();
}

/** Enter / klik pada item dropdown. `unitSlug` diisi bila yang diklik adalah
 *  chip satuan, bukan baris utamanya. `qtyOverride` = qty dari sintaks
 *  `Qty*Kode` (lihat bacaQtyKode). */
function addActive(q: string, unitSlug?: string, qtyOverride?: number): void {
  const p = results[active];
  if (!p) {
    toast(`Produk "${q.trim()}" tidak ditemukan`, 'warning');
    return;
  }
  closeResults();
  const inp = host?.querySelector<HTMLInputElement>('#pos-q');
  if (inp) inp.value = '';
  results = [];
  addProduct(p, unitSlug, qtyOverride);
}

function focusScan(): void {
  host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
}

/** ↑↓ pindah antar baris keranjang (referensi KulaPOS "↑↓ Navigasi Baris" —
 *  kula-02-transaksi-pos.png). Fokus jatuh ke input Qty baris tujuan lalu
 *  isinya di-select, jadi ketikan angka berikutnya langsung mengganti.
 *
 *  Baris catatan (produk use_note) dilewati: baris itu bukan baris barang dan
 *  tidak punya input qty. Di ujung daftar arahnya di-clamp (tidak wrap), supaya
 *  kasir tidak "lolos" ke luar tabel tanpa sadar. */
function pindahBarisKeranjang(delta: number): void {
  const rows = [...(host?.querySelectorAll<HTMLElement>('#pos-rows tr') ?? [])]
    .filter((tr) => tr.querySelector('input[data-act="qty"]'));
  if (rows.length < 2) return;
  const sekarang = document.activeElement instanceof HTMLElement ? document.activeElement.closest('tr') : null;
  const i = sekarang ? rows.indexOf(sekarang) : -1;
  const tujuan = i < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, i + delta));
  const inp = rows[tujuan].querySelector<HTMLInputElement>('input[data-act="qty"]');
  if (!inp) return;
  inp.focus();
  inp.select();
}

/* ---------- qty item berikutnya (chip Qty / F4) + layar cari (F3) ---------- */

/** Segarkan chip Qty di scan bar TANPA paint penuh — scanBar ikut dirender
 *  oleh paint(), bukan paintCart(), jadi teksnya harus disegarkan manual. */
function refreshQtyChip(): void {
  const b = host?.querySelector<HTMLElement>('#pos-qty');
  if (!b) return;
  // innerHTML (bukan textContent): `<kbd>F4</kbd>` harus ikut disegarkan —
  // textContent dulu menghapus label shortcut begitu qty dipakai sekali,
  // padahal tombol Cari/F3 di sebelahnya selalu menampilkannya.
  b.innerHTML = `Qty ${qtyNext}${kbd('F4')}`;
  b.classList.toggle('!border-primary', qtyNext > 1);
  b.classList.toggle('!text-primary', qtyNext > 1);
}

/** Pakai qtyNext SEKALI lalu kembalikan ke 1 — dipanggil addProduct tepat
 *  sebelum addLine, jadi preset hilang begitu item masuk (aturan Aronium). */
function pakaiQtyNext(): number {
  const q = qtyNext;
  qtyNext = 1;
  refreshQtyChip();
  return q;
}

/** F4 / klik chip Qty: setel qty untuk item berikutnya. */
async function setQtyNext(): Promise<void> {
  const q = await askNumber('Qty untuk item berikutnya', 'Qty produk berikutnya', qtyNext, 1);
  if (q === null) return; // batal
  if (!Number.isFinite(q) || q < 1) {
    toast('Qty minimal 1', 'warning');
    return;
  }
  qtyNext = Math.floor(q);
  refreshQtyChip();
  focusScan();
}

/** Batas baris di layar cari (F3). 100 cukup untuk katalog toko kecil; kalau
 *  lebih, ketik untuk mempersempit — jangan buang hasil diam-diam. */
const BATAS_CARI = 100;

function barisCari(p: Product, i: number, aktif: boolean): string {
  const meta = p.track_stock
    ? p.stock > 0
      ? `sisa ${p.stock}`
      : '<span class="text-red-600 dark:text-red-400">stok habis</span>'
    : 'tanpa stok';
  return `<button type="button" class="suggest-item${aktif ? ' is-active' : ''}" data-i="${i}">
    <span class="min-w-0 flex-1">
      <span class="cell-strong block truncate">${p.name}</span>
      <span class="cell-sub block truncate">${p.sku} · ${meta}</span>
    </span>
    <span class="shrink-0 text-sm font-semibold text-gray-900 dark:text-white">${rp(p.price)}</span>
  </button>`;
}

/** Layar cari produk penuh (F3 / tombol "Cari") — versi layar-lebar dari
 *  dropdown scan bar, ala Aronium "Adding a product: F3". Filter bebas
 *  (nama/SKU/barcode, semua kata wajib cocok), ↑↓ + Enter = tambah. */
function openCariProduk(): void {
  if (mode !== 'jual') return;
  let daftar: Product[] = [];
  let idx = 0;
  let inp: HTMLInputElement | null = null;
  let list: HTMLElement | null = null;
  let info: HTMLElement | null = null;

  const render = () => {
    const q = inp?.value.trim() ?? '';
    daftar = q ? queryResults(q, BATAS_CARI) : products.slice(0, BATAS_CARI);
    if (idx >= daftar.length) idx = Math.max(0, daftar.length - 1);
    if (list) {
      list.innerHTML = daftar.length
        ? daftar.map((p, i) => barisCari(p, i, i === idx)).join('')
        : '<div class="px-3 py-3 text-center text-sm text-gray-500 dark:text-gray-400">Tidak ada produk yang cocok</div>';
      list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    }
    if (info) {
      info.textContent = q
        ? `${daftar.length} hasil${daftar.length >= BATAS_CARI ? ` (terbatas ${BATAS_CARI} — ketik lebih spesifik)` : ''}`
        : `${daftar.length} produk ditampilkan${products.length > daftar.length ? ` dari ${products.length} — ketik untuk mempersempit` : ''}`;
    }
  };

  openModal({
    title: 'Cari produk',
    wide: true,
    okLabel: 'Tambah',
    body: `
      <div class="space-y-3">
        <div class="search-wrap">${icon('search')}
          <input id="pc-q" class="input" type="search" autocomplete="off"
                 placeholder="Nama / SKU / barcode — ↑↓ pilih, Enter tambah" />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">Shortcut: ${kbd('F3')}</p>
        <p id="pc-info" class="text-xs text-gray-500 dark:text-gray-400"></p>
        <div id="pc-list" class="max-h-[60vh] overflow-y-auto rounded-xl border border-gray-200 py-1 dark:border-gray-700"></div>
      </div>`,
    onMount: (api) => {
      inp = api.el.querySelector<HTMLInputElement>('#pc-q');
      list = api.el.querySelector<HTMLElement>('#pc-list');
      info = api.el.querySelector<HTMLElement>('#pc-info');
      const pilih = () => {
        const p = daftar[idx];
        if (!p) return;
        api.close();
        addProduct(p); // focusScan ikut jalan dari addProduct
      };
      inp?.addEventListener('input', () => { idx = 0; render(); });
      inp?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (daftar.length) { idx = (idx + 1) % daftar.length; render(); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (daftar.length) { idx = (idx - 1 + daftar.length) % daftar.length; render(); }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation(); // modal punya handler Enter->ok; biar pilih() tak jalan 2x
          pilih();
        }
      });
      // Klik baris = pilih (pointer/touch).
      list?.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
        if (!b) return;
        idx = Number(b.dataset.i);
        pilih();
      });
      // Tombol OK modal = "Tambah" baris yang disorot.
      api.ok.addEventListener('click', pilih);
      inp?.focus();
      render();
    },
  });
}

/** Baris daftar di layar Cari pelanggan — pola `barisCari()` (produk):
 *  nama kuat di atas, nomor kontak/nomor urut/catatannya di bawah, sorot saat
 *  ↑↓. Chip "aktif" = pelanggan yang sedang dipilih di info bar. */
function barisCust(c: Cust, i: number, aktif: boolean): string {
  const bawah = [c.code, c.phone].filter(Boolean).map(esc).join(' · ') || 'tanpa no. HP';
  return `<button type="button" class="suggest-item${aktif ? ' is-active' : ''}" data-i="${i}">
    <span class="min-w-0 flex-1">
      <span class="cell-strong block truncate">${esc(c.name)}</span>
      <span class="cell-sub block truncate">${bawah}${c.note ? ` · ${esc(c.note)}` : ''}</span>
    </span>
    ${c.id === customerId ? '<span class="shrink-0 text-xs font-semibold text-primary">aktif</span>' : ''}
  </button>`;
}

/** Layar cari PELANGGAN — permintaan pemilik putaran 7 2026-10-04:
 *  "tambahkan cari seperti cari produk F3". Pola persis `openCariProduk()`:
 *  input bebas multi-kata (SEMUA kata harus cocok — pola search produk dan
 *  `?q=` API pelanggan: nama/no.kontak/nomor urut/catatan), ↑↓ sorot,
 *  Enter/klik baris/tombol OK = pilih. Memilih menyetel `customerId` +
 *  nilai `#pos-customer` lalu fokus balik ke kolom scan. */
function openCariPelanggan(): void {
  if (mode !== 'jual') return;
  let daftar: Cust[] = [];
  let idx = 0;
  let inp: HTMLInputElement | null = null;
  let list: HTMLElement | null = null;
  let info: HTMLElement | null = null;

  const render = () => {
    const kata = (inp?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    daftar = kata.length
      ? customers.filter((c) => {
          const hay = `${c.name} ${c.code ?? ''} ${c.phone ?? ''} ${c.note ?? ''}`.toLowerCase();
          return kata.every((k) => hay.includes(k));
        })
      : [...customers];
    if (idx >= daftar.length) idx = Math.max(0, daftar.length - 1);
    if (list) {
      list.innerHTML = daftar.length
        ? daftar.map((c, i) => barisCust(c, i, i === idx)).join('')
        : '<div class="px-3 py-3 text-center text-sm text-gray-500 dark:text-gray-400">Tidak ada pelanggan yang cocok</div>';
      list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    }
    if (info) {
      info.textContent = kata.length
        ? `${daftar.length} hasil`
        : `${daftar.length} pelanggan ditampilkan${customers.length > daftar.length ? ` dari ${customers.length} — ketik untuk mempersempit` : ''}`;
    }
  };

  openModal({
    title: 'Cari pelanggan',
    wide: true,
    okLabel: 'Pilih',
    body: `
      <div class="space-y-3">
        <div class="search-wrap">${icon('search')}
          <input id="pcust-q" class="input" type="search" autocomplete="off"
                 placeholder="Nama / nomor HP / nomor urut / catatan — ↑↓ pilih, Enter pilih" />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">Shortcut: ${kbd('F9')}</p>
        <p id="pcust-info" class="text-xs text-gray-500 dark:text-gray-400"></p>
        <div id="pcust-list" class="max-h-[60vh] overflow-y-auto rounded-xl border border-gray-200 py-1 dark:border-gray-700"></div>
      </div>`,
    onMount: (api) => {
      inp = api.el.querySelector<HTMLInputElement>('#pcust-q');
      list = api.el.querySelector<HTMLElement>('#pcust-list');
      info = api.el.querySelector<HTMLElement>('#pcust-info');
      const pilih = () => {
        const c = daftar[idx];
        if (!c) return;
        customerId = c.id;
        const sel = host?.querySelector<HTMLSelectElement>('#pos-customer');
        if (sel) sel.value = String(c.id);
        api.close();
        focusScan(); // pola addProduct: kembali ke kolom scan utk transaksi
      };
      inp?.addEventListener('input', () => { idx = 0; render(); });
      inp?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (daftar.length) { idx = (idx + 1) % daftar.length; render(); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (daftar.length) { idx = (idx - 1 + daftar.length) % daftar.length; render(); }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation(); // modal punya handler Enter->ok; biar pilih() tak jalan 2x
          pilih();
        }
      });
      // Klik baris = pilih (pointer/touch).
      list?.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
        if (!b) return;
        idx = Number(b.dataset.i);
        pilih();
      });
      // Tombol OK modal = "Pilih" baris yang disorot.
      api.ok.addEventListener('click', pilih);
      inp?.focus();
      render();
    },
  });
}

/* ---------- dropdown hasil pencarian ---------- */

function resultRow(p: Product, i: number): string {
  const meta = p.track_stock
    ? p.stock > 0
      ? `sisa ${p.stock}`
      : '<span class="text-red-600 dark:text-red-400">stok habis</span>'
    : 'tanpa stok';
  // Chip satuan alternatif (fitur #3). Baris utama tetap satuan DASAR — kebiasaan
  // lama kasir tidak berubah; yang mau pack/dus tinggal mengetuk chipnya.
  // Harga di chip hanya perkiraan tampilan; harga final dihitung server.
  const chips = (p.units ?? [])
    .map((u) => {
      const h = u.price ?? Math.round(p.price * u.factor);
      return `<button type="button" class="suggest-unit" data-unit="${u.unit}"
        title="1 ${u.unit} = ${u.factor} ${p.unit}">${u.unit} · ${rp(h)}</button>`;
    })
    .join('');
  return `<div class="suggest-group" data-idx="${i}">
      <button type="button" class="suggest-item${i === active ? ' is-active' : ''}" data-idx="${i}" role="option" aria-selected="${i === active}">
        <span class="min-w-0 flex-1">
          <span class="cell-strong block truncate">${p.name}</span>
          <span class="cell-sub block truncate">${p.sku} · ${meta}</span>
        </span>
        <span class="shrink-0 text-right">
          <span class="block text-sm font-semibold text-gray-900 dark:text-white">${rp(p.price)}</span>
          ${isLayanan(p)
            ? '<span class="block text-[11px] text-primary">buka form layanan</span>'
            : p.price_dynamic
              ? '<span class="block text-[11px] text-amber-600 dark:text-amber-400">harga khusus</span>'
              : ''}
        </span>
      </button>
      ${chips ? `<div class="suggest-units">${chips}</div>` : ''}
    </div>`;
}

function paintResults(): void {
  const box = host?.querySelector('#pos-results');
  if (!box) return;
  if (!results.length) {
    box.innerHTML = '<div class="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400">Tidak ada produk yang cocok</div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = results.map(resultRow).join('');
  box.classList.remove('hidden');
  box.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

function closeResults(): void {
  host?.querySelector('#pos-results')?.classList.add('hidden');
}

function moveActive(step: number): void {
  if (!results.length) return;
  active = (active + step + results.length) % results.length;
  paintResults();
}

function openManualItem(): void {
  const m = openModal({
    title: 'Item manual (jasa / cetak)',
    body: `<div class="space-y-3">
      <div><label class="label" for="pm-name">Nama</label><input id="pm-name" class="input" type="text" placeholder="mis. Jasa ketik 1 halaman" /></div>
      <div><label class="label" for="pm-price">Harga (Rp)</label><input id="pm-price" class="input" type="number" inputmode="numeric" min="0" step="500" value="" /></div>
      <div><label class="label" for="pm-qty">Qty</label><input id="pm-qty" class="input" type="number" inputmode="numeric" min="1" step="1" value="1" /></div>
      <p class="text-xs text-gray-500 dark:text-gray-400">Item manual tidak mengurangi stok dan tidak muncul di Manage Produk.</p>
    </div>`,
    okLabel: 'Tambah',
    onMount: (api) => {
      const name = api.el.querySelector<HTMLInputElement>('#pm-name');
      const price = api.el.querySelector<HTMLInputElement>('#pm-price');
      const qty = api.el.querySelector<HTMLInputElement>('#pm-qty');
      name?.focus();
      const submit = () => {
        const n = (name?.value || '').trim();
        const pr = Number(price?.value || 0);
        const q = Math.max(1, Number(qty?.value || 1));
        if (!n || pr <= 0) {
          toast('Nama dan harga wajib diisi', 'error');
          return;
        }
        manualSeq += 1;
        cart.push({
          key: `manual:${manualSeq}`, product_id: null, name: n, sku: 'MANUAL',
          price: pr, qty: q, track_stock: 0, unit: '', baseUnit: '', factor: 1,
          // Item manual tidak punya diskon permanen (bukan produk katalog),
          // tapi kolom Diskon tetap terisi 0 dan bisa diketik kasir.
          discount: 0, prefill: null, discManual: false,
          // Tanpa input catatan: tidak ada produk use_note-nya (pemilik memang
          // menandai produk katalog, mis. Cetak Banner — bukan jasa dadakan).
          useNote: false, note: '',
        });
        api.close();
        paintCart();
        host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
      };
      api.ok.addEventListener('click', submit);
      api.el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
    },
  });
}

/* ---------- bayar ---------- */

/** Bayar pas (tombol footer, revisi pemilik 2026-10-04): uang diterima =
 *  persis total, lalu bayar — satu klik untuk transaksi tunai tanpa kelebihan.
 *  Menjalankan JALUR YANG SAMA dengan Bayar/F2 (pay()), bukan jalur terpisah:
 *  `cashIn` disetel + `cashTouched` ditandai (pilihan "pas" = keputusan
 *  eksplisit; sejak putaran 10d tidak ada auto-isi yang bisa menimpa), lalu
 *  paintCart menyinkronkan chip/kembalian sebelum pay() membaca `cashIn`. */
function bayarPas(): void {
  if (!cart.length || busy) return;
  if (payMethod === 'tunai') {
    cashIn = total();
    cashTouched = true;
    paintCart();
  }
  void pay();
}

async function pay(opts?: { hutang?: boolean }): Promise<void> {
  if (!shift || busy || !cart.length) return;
  // BARRIER TUNAI (keluhan pemilik 2026-10-03): uang diterima WAJIB diisi
  // dan tidak kurang dari total — meniru payment screen Aronium yang tak bisa
  // konfirmasi sebelum Paid amount masuk.
  //
  // UANG KURANG / UANG 0 = HUTANG OTOMATIS (putaran 12, instruksi pemilik
  // 2026-10-06: "jika uang kurang / uang 0 akan otomatis masuk ke hutang
  // dengan catatan harus terpilih customer"): bila pelanggan terpilih MEMENUHI
  // syarat (ada, bukan bawaan "Pelanggan Umum" — cekHutangDiperbolehkan()),
  // penjualan langsung diteruskan `pay({hutang:true})` TANPA konfirmasi swal
  // (konfirmasi lama "Uang kurang — catat jadi hutang?" DIHAPUS). Sisa
  // dicatat ke ledger SETELAH nota tersimpan; kasir tahu dari toast
  // `· hutang RpX` + baris HUTANG di modal resume + struk.
  //
  // Pelanggan TIDAK memenuhi syarat = penolakan barrier PERSIS perilaku lama
  // (pesan + buka form + fokus kolom uang) — uang kurang tidak pernah lolos
  // diam-diam tanpa kontak yang bisa menampung hutangnya.
  // `opts.hutang` = sudah lewat jalur otomatis ini; F2/Enter/F12 tidak pernah
  // membawa opsi itu.
  if (payMethod === 'tunai' && !opts?.hutang && cashIn < total()) {
    const alasan = cekHutangDiperbolehkan();
    if (alasan) {
      if (!(cashIn > 0)) toast(`Uang diterima belum diisi — ${alasan}`, 'error');
      else toast(`Uang diterima kurang dari total ${rp(total())} — ${alasan}`, 'error');
      // Form bayar dibuka kalau belum (F2 dari layar utama = bayar cepat):
      // tanpa ini kasir hanya melihat toast tanpa kolom untuk membetulkannya.
      bukaBayar();
      document.querySelector<HTMLInputElement>('#pos-cash')?.focus();
      return;
    }
    void pay({ hutang: true });
    return;
  }
  busy = true;
  paintCart();
  try {
    const res = await apiPost<{ data: { sale: { id: string; total: number; invoice_no?: string | null; customer_name?: string } ; duplicate: boolean } }>('/api/sales', {
      id: uuid(),
      shift_id: shift.id,
      pay_method: payMethod,
      discount,
      cash_in: payMethod === 'tunai' ? cashIn : 0,
      cashier: getCashier(),
      // Pelanggan terpilih di info bar (revisi 2026-10-04). Server memvalidasi
      // id + men-SNAPSHOT nama ke sales.customer_name — absen = transaksi
      // tanpa kontak (payload client lama/offline tetap sah).
      ...(customerId !== null ? { customer_id: customerId } : {}),
      items: cart.map((l) => ({
        ...(l.product_id !== null ? { product_id: l.product_id } : {}),
        name: l.name,
        qty: l.qty,
        price: l.price,
        // Satuan terjual. Server memakai ini untuk mengambil faktor & harga
        // final — harga di sini hanya rujukan bila produknya price_dynamic.
        ...(l.product_id !== null && l.unit ? { unit: l.unit } : {}),
        // Diskon baris dalam RUPIAH (bukan persen) — server menghitung ulang
        // totalnya sendiri dan menolak bila melebihi jumlah baris.
        discount: l.discount,
        // Catatan per baris (produk use_note) — server trim + snapshot ke
        // sale_items.note; '' = tanpa catatan (server menerima apa adanya).
        note: l.note,
      })),
    });
    const kembalian = payMethod === 'tunai' ? change() : 0;
    // WAJIB dihitung sebelum `cart`/`discount`/`cashIn` di-reset di bawah —
    // begitu direset, struk tidak punya sumber data lagi.
    const sub = subtotal();
    const discItem = diskonBaris();
    const tot = total();
    // SISA HUTANG (permintaan pemilik 2026-10-04: "uang kurang = jadi Hutang
    // dengan catatan harus ada customer yang terpilih, bukan default/umum";
    // otomatis tanpa konfirmasi sejak putaran 12, 2026-10-06). Angka ini
    // hanya bisa muncul lewat jalur `opts.hutang` — barrier di atas sudah
    // memvalidasi pelanggan. Dicatat ke ledger
    // /api/customer-debts (type=charge) SETELAH penjualan tersimpan supaya
    // catatannya menyebut nomor nota; gagal = tetap jadi nota sukses + toast
    // penunjuk halaman Hutang (penjualan TIDAK dibatalkan, pola gagal cetak).
    const sisaHutang = opts?.hutang && payMethod === 'tunai' && cashIn < tot ? tot - cashIn : 0;
    const namaHutang = customers.find((c) => c.id === customerId)?.name ?? '';
    let catatanHutang = '';
    if (sisaHutang > 0 && customerId !== null) {
      try {
        await apiPost<{ data: { id: number } }>('/api/customer-debts', {
          customer_id: customerId,
          type: 'charge',
          amount: sisaHutang,
          note: `Nota ${res.data.sale.invoice_no ?? res.data.sale.id.slice(0, 8)} — sisa bayar POS`,
        });
        catatanHutang = ` · hutang ${rp(sisaHutang)} (${namaHutang})`;
      } catch (e2) {
        toast(
          `Penjualan tersimpan, tetapi sisa ${rp(sisaHutang)} GAGAL dicatat hutang — catat manual di halaman Hutang (${e2 instanceof Error ? e2.message : 'gagal'})`,
          'error',
          9000,
        );
      }
    }
    const strukJual: Struk = {
      judul: getToko(),
      meta: [
        // Nomor struk = nomor invoice (YYMMDD-NNNNNN, tanggal + urut harian
        // dari server) — bukan lagi 8 digit uuid yang terlihat "random"
        // (revisi pemilik 2026-10-04). Waktu dan No. SUKA BERADA DI BARIS
        // TERPISAH: digabung jadi 40 kolom kena `potong(m, COLS)` dan nomornya
        // terpotong di 32. Fallback id hanya untuk baris lama tanpa invoice.
        waktuStruk(),
        `No. ${res.data.sale.invoice_no ?? res.data.sale.id.slice(0, 8)}`,
        `Kasir: ${getCashier()}`,
        `Shift: ${shift.id}`,
        // Pelanggan dari SNAPSHOT server (customer_name), bukan label select —
        // struk ulang di Riwayat memakai sumber yang sama. Baris lama tanpa
        // kontak tampil "Pelanggan Umum" (default toko).
        `Pelanggan: ${res.data.sale.customer_name || 'Pelanggan Umum'}`,
      ],
      items: cart.map((l) => ({
        name: l.name, qty: l.qty, price: l.price,
        // Cetak unit hanya bila bukan satuan dasar (lihat StrukItem.unit).
        ...(l.unit && l.baseUnit && l.unit !== l.baseUnit ? { unit: l.unit } : {}),
        // Catatan per baris (cth "ukuran 1 x 3 meter") — tercetak di baris
        // bawah item dengan indent, baik layout thermal maupun A4.
        ...(l.note.trim() ? { note: l.note.trim() } : {}),
      })),
      baris: [
        { kiri: 'Subtotal', kanan: rp(sub) },
        // Dua jenis diskon diurutkan persis seperti rumus server:
        // total = subtotal - diskon item - diskon transaksi.
        ...(discItem > 0 ? [{ kiri: 'Diskon item', kanan: `-${rp(discItem)}` }] : []),
        ...(discount > 0 ? [{ kiri: 'Diskon', kanan: `-${rp(discount)}` }] : []),
        { kiri: 'TOTAL', kanan: rp(tot), tebal: true },
        // Tunai ditampilkan walau uang diterima 0 (transaksi hutang penuh
        // lewat form) — selain itu cabang lama menganggapnya metode biasa.
        ...(payMethod === 'tunai' && (cashIn > 0 || sisaHutang > 0)
          ? [
              { kiri: 'Tunai', kanan: rp(cashIn) },
              // Sisa yang jadi hutang ikut tercetak supaya struk ≠ "lunas".
              ...(sisaHutang > 0 ? [{ kiri: 'Hutang', kanan: rp(sisaHutang) }] : []),
              { kiri: 'Kembalian', kanan: rp(kembalian) },
            ]
          : [{ kiri: labelMetode(payMethod), kanan: rp(tot) }]),
      ],
      kaki: ['Terima kasih sudah berbelanja'],
    };
    // Form bayar DITUTUP lebih dulu: modal resume (swal) dan fokus kembali ke
    // kolom scan jangan berdiri di atas modal yang isinya sudah tidak berlaku.
    tutupBayar();
    // Modal resume SELESAI transaksi (putaran 11, 2026-10-05 / permintaan 1A):
    // tampil SETELAH SETIAP penjualan sukses — semua jalur (tombol Bayar,
    // F2, Enter, F12 Bayar pas) lewat pay() ini — TANPA syarat saklar
    // auto-print. Saklar hanya menentukan apakah tombol Thermal/A4 benar-benar
    // mengirim ke printer. Snapshot data resume WAJIB diambil SEBELUM
    // cart/cashIn di-reset beberapa baris di bawah.
    void pilihCetakSelesai(res.data.sale.id, strukJual, tot, kembalian, {
      invoiceNo: res.data.sale.invoice_no,
      items: cart.map((l) => ({ qty: l.qty, nama: l.name, net: jumlahBaris(l) - l.discount })),
      metode: payMethod,
      uang: cashIn,
      // Baris HUTANG merah di resume (putaran 12) — sisa sudah tercatat ke
      // ledger beberapa baris di atas; snapshot sebelum cart/cashIn di-reset.
      hutang: sisaHutang,
    });
    cart = [];
    discount = 0;
    cashIn = 0;
    cashTouched = false; // penjualan baru -> form berikutnya buka kolom kosong (10d)
    // Pelanggan kembali ke bawaan (Pelanggan Umum) — pilihan pelanggan berlaku
    // PER NOTA, jangan menempel ke transaksi kasir berikutnya diam-diam.
    customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
    const selCust = host?.querySelector<HTMLSelectElement>('#pos-customer');
    if (selCust) selCust.value = customerId === null ? '' : String(customerId);
    toast(
      `Terjual ${res.data.sale.invoice_no ?? res.data.sale.id.slice(0, 8)} · ${rp(res.data.sale.total)}` +
        (kembalian > 0 ? ` · kembalian ${rp(kembalian)}` : '') +
        catatanHutang,
      'success',
      5000,
    );
    // Isi kolom diskon/uang diterima dikosongkan; nilainya sudah di-reset di atas.
    const disc = host?.querySelector<HTMLInputElement>('#pos-discount');
    if (disc) disc.value = '';
    const cash = document.querySelector<HTMLInputElement>('#pos-cash');
    if (cash) cash.value = '';
    paintCart();
    host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
  } catch (e) {
    toast(`Gagal menyimpan penjualan: ${e instanceof Error ? e.message : 'tidak diketahui'}`, 'error', 6000);
  } finally {
    busy = false;
    paintCart();
  }
}

/* ---------- topup / tarik ---------- */

/** Panel kanan penuh repaint tanpa kehilangan isi form. */
function paintTopup(): void {
  if (!host || !shift) return;
  const set = (sel: string, v: string) => {
    const el = host!.querySelector(sel);
    if (el) el.textContent = v;
  };
  set('#tp-nominal-view', rp(topNominal));
  set('#tp-total', rp(topNominal + topAdmin));
  const kembali = topTunai > 0 ? topTunai - (topNominal + topAdmin) : 0;
  set('#tp-kembali', rp(kembali));
  const k = host.querySelector('#tp-kembali');
  if (k) k.className = `text-sm font-semibold ${topTunai > 0 && kembali < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`;
}

async function submitTopup(): Promise<void> {
  if (!host || !shift || busy) return;
  const nomor = topNomor.trim();
  const total = topNominal + topAdmin;
  const j = jenisAktif();
  if (!nomor) {
    toast(`${j.nomorLabel} wajib diisi`, 'error');
    host.querySelector<HTMLInputElement>('#tp-nomor')?.focus();
    return;
  }
  if (!(topNominal > 0)) {
    toast('Nominal harus lebih dari 0', 'error');
    host.querySelector<HTMLInputElement>('#tp-nominal')?.focus();
    return;
  }
  if (topAdmin < 0) {
    toast('Biaya admin tidak boleh negatif', 'error');
    return;
  }
  // BARRIER TUNAI topup (sama dengan pay()): uang diterima kasir WAJIB terisi
  // & cukup. Mode TARIK sengaja dikecualikan — di sana uang MENGALIR KELUAR,
  // jadi "uang diterima" memang tidak selalu diisi; cek lama (kurang dari
  // total -> tolak) tetap berlaku untuk keduanya.
  if (payMethod === 'tunai' && mode === 'topup') {
    if (!(topTunai > 0)) {
      toast('Uang diterima belum diisi — ketik nominal uang dari pelanggan', 'error');
      host.querySelector<HTMLInputElement>('#tp-tunai')?.focus();
      return;
    }
    if (topTunai < total) {
      toast(`Uang diterima kurang dari total ${rp(total)}`, 'error');
      host.querySelector<HTMLInputElement>('#tp-tunai')?.focus();
      return;
    }
  }
  if (payMethod === 'tunai' && topTunai > 0 && topTunai < total) {
    toast(`Uang diterima kurang dari total ${rp(total)}`, 'error');
    host.querySelector<HTMLInputElement>('#tp-tunai')?.focus();
    return;
  }
  busy = true;
  const btn = host.querySelector<HTMLButtonElement>('#tp-submit');
  if (btn) btn.disabled = true;
  try {
    const res = await apiPost<{ data: { id: string; kind: string; provider: string; nomor: string; nominal: number; admin: number; total: number }; duplicate: boolean }>(
      '/api/topups',
      {
        id: uuid(),
        kind: mode,
        provider: jenisKode(),
        nomor,
        nominal: topNominal,
        admin: topAdmin,
        pay_method: payMethod,
        shift_id: shift.id,
        cashier: getCashier(),
      },
    );
    const kembali = payMethod === 'tunai' && topTunai > 0 ? topTunai - total : 0;
    // Ditangkap sebelum state topup di-reset di bawah.
    const strukTop: Struk = {
      judul: getToko(),
      subjudul: `${mode === 'topup' ? 'TOPUP' : 'TARIK TUNAI'} ${j.ringkas}`.trim(),
      meta: [
        `${waktuStruk()} · No. ${res.data.id.slice(0, 8)}`,
        `Kasir: ${getCashier()}`,
        `Shift: ${shift.id}`,
      ],
      items: [],
      baris: [
        { kiri: j.nomorLabel, kanan: nomor },
        { kiri: 'Nominal', kanan: rp(topNominal) },
        ...(topAdmin > 0 ? [{ kiri: 'Admin', kanan: rp(topAdmin) }] : []),
        { kiri: 'TOTAL', kanan: rp(total), tebal: true },
        ...(payMethod === 'tunai' && topTunai > 0
          ? [
              { kiri: 'Tunai', kanan: rp(topTunai) },
              { kiri: 'Kembalian', kanan: rp(kembali) },
            ]
          : [{ kiri: labelMetode(payMethod), kanan: rp(total) }]),
      ],
      kaki: [mode === 'topup' ? 'Simpan struk ini sebagai bukti' : 'Cek kembali nominal sebelum meninggalkan loket'],
    };
    void cetak(strukUntuk(strukTop));
    toast(
      `${res.duplicate ? 'Sudah tercatat' : mode === 'topup' ? 'Topup' : 'Tarik'} ${j.ringkas} · ${nomor} · ${rp(total)}` +
        (kembali > 0 ? ` · kembalian ${rp(kembali)}` : ''),
      'success',
      5000,
    );
    // Sisa nominal jadi modal, jadi kembalikan ke kasir. Sisakan jenis supaya
    // transaksi berikutnya (mis. 3x pulsa) tinggal ganti nominal.
    topNomor = '';
    topNominal = 0;
    topAdmin = 0;
    topAdminTouched = false;
    topTunai = 0;
    paint();
  } catch (e) {
    toast(`Gagal menyimpan ${mode}: ${e instanceof Error ? e.message : 'tidak diketahui'}`, 'error', 6000);
  } finally {
    busy = false;
    const b = host?.querySelector<HTMLButtonElement>('#tp-submit');
    if (b) b.disabled = false;
  }
}

/** Bilah mode (Penjualan / Topup / Tarik) ada di semua mode, jadi cukup satu
 *  fungsi yang dipasang baik di bindCart maupun bindTopup. `posAbort` sudah
 *  dibuat pemanggilnya, jadi listener ikut ikut dibersihkan. */
function bindModeBar(): void {
  host!.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = b.dataset.mode as Mode;
      if (next === mode) return;
      mode = next;
      results = [];
      topTunai = 0;
      cashIn = 0;
      cashTouched = false;
      topJenis = defaultJenis(next);
      topNomor = '';
      paint();
    }),
  );
}

function bindTopup(): void {
  posAbort?.abort();
  posAbort = new AbortController();
  const { signal } = posAbort;
  bindModeBar();

  host!.querySelectorAll<HTMLElement>('[data-jenis]').forEach((b) =>
    b.addEventListener('click', () => {
      const next = b.dataset.jenis as TopupJenis;
      if (next === topJenis) return;
      topJenis = next;
      // Nomor yang sudah diketik (HP vs rekening vs meter) tidak berlaku untuk jenis lain.
      topNomor = '';
      paint();
    }),
  );

  host!.querySelectorAll<HTMLElement>('[data-quick]').forEach((b) =>
    b.addEventListener('click', () => {
      topNominal = Number(b.dataset.quick || 0);
      if (!topAdminTouched) topAdmin = suggestAdmin(topNominal);
      paint();
    }),
  );

  host!.querySelector('#tp-nomor')?.addEventListener('input', (e) => {
    topNomor = (e.target as HTMLInputElement).value;
  });

  // Nominal berubah -> admin ikut saran selama kasir belum ubah sendiri.
  host!.querySelector('#tp-nominal')?.addEventListener('input', (e) => {
    topNominal = Math.max(0, Number((e.target as HTMLInputElement).value || 0));
    if (!topAdminTouched) {
      topAdmin = suggestAdmin(topNominal);
      const a = host!.querySelector<HTMLInputElement>('#tp-admin');
      if (a) a.value = topAdmin ? String(topAdmin) : '';
    }
    paintTopup();
  });

  host!.querySelector('#tp-admin')?.addEventListener('input', (e) => {
    topAdmin = Math.max(0, Number((e.target as HTMLInputElement).value || 0));
    topAdminTouched = true;
    paintTopup();
  });

  host!.querySelector('#tp-tunai')?.addEventListener('input', (e) => {
    topTunai = Math.max(0, Number((e.target as HTMLInputElement).value || 0));
    paintTopup();
  });

  host!.querySelectorAll<HTMLElement>('[data-pay]').forEach((b) =>
    b.addEventListener('click', () => {
      payMethod = (b.dataset.pay as PayMethod) || 'tunai';
      topTunai = 0;
      paint();
    }),
  );

  host!.querySelector('#tp-submit')?.addEventListener('click', () => void submitTopup());

  // Enter/F2 diproses bindPintasan() di level document — dulu menempel di host
  // sehingga mati saat fokus keluar dari halaman POS.
}

/* ---------- events ---------- */

/** Pintasan keyboard LEVEL DOCUMENT — bukan `host`.
 *
 *  Dulu F2/Escape/Enter menempel di `host` (bindCart/bindTopup), jadi hanya
 *  hidup selama fokus berADA di dalam halaman POS. Fokus gampang keluar:
 *  klik area kosong kartu, tutup modal, selesai dari halaman lain — begitu
 *  fokus jatuh ke `body`, "Tekan F2 untuk bayar cepat" jadi huruf mati.
 *  Listener di document + dibuang saat unmount (posKeyAbort) = pintasan hidup
 *  di mana pun fokus, selama route POS masih aktif.
 *
 *  Guard: modal terbuka = lepas (modal punya aturan Enter/Esc sendiri);
 *  tombol/link = biarkan aktivasi native (Enter pada tombol Bayar yang fokus
 *  sudah memicu klik — memanggil pay() lagi cuma diblokir `busy`, tapi alurnya
 *  jadi kabur); isian teks = aturan per-field seperti perilaku lama. */
function bindPintasan(): void {
  posKeyAbort?.abort();
  posKeyAbort = new AbortController();
  document.addEventListener(
    'keydown',
    (e) => {
      // F1–F9, F10, F12 = fitur POS (fokus scan / layar cari / qty / bersihkan
      // keranjang / diskon / tahan / fokus scan / cari pelanggan / form bayar /
      // bayar pas). F1 = KulaPOS ("Jumlah Beli * Kode [F1/Cmd+K]") = fokus
      // scan; F9 = cari pelanggan (slot kosong, KulaPOS belum mendefinisinya).
      // preventDefault DULU sebelum guard modal: walau modal sedang terbuka
      // tombolnya jangan jatuh ke browser (Chrome membuka find bar, F5
      // me-reload halaman), tapi aksinya tetap dilewati di baris guard di
      // bawah.
      if (e.key === 'F1' || e.key === 'F3' || e.key === 'F4' || e.key === 'F5' || e.key === 'F6' ||
          e.key === 'F7' || e.key === 'F8' || e.key === 'F9' || e.key === 'F10' || e.key === 'F12') e.preventDefault();
      // Swal terbuka (pilihan cetak, hapus, dll.) = ambil
      // alih keyboard UTUH. Penting untuk kasus ganda form-bayar + swal:
      // selector `.modal-overlay` menemukan form bayar yang ada di bawah
      // swal, sehingga tanpa guard ini F12 masih membayar lewat belakang
      // dialog yang sedang terbuka.
      // Popup non-toast saja — container sweetalert2 dihapus dari DOM saat
      // ditutup (lihat sweetalert2: `container.remove()`), jadi keberadaannya
      // = dialog sedang tampil. Toast repo memakai #toast-root sendiri.
      if (document.querySelector('.swal2-container .swal2-popup:not(.swal2-toast)')) return;
      // Guard modal: modal LAIN (Pending, layar cari, konfirmasi, …) = semua
      // pintasan POS dilepas — modal punya aturan Enter/Esc sendiri.
      // PENGECUALIAN = FORM BAYAR (dikenali dari tombol OK-nya, #pos-pay):
      // di dalamnya F2/F10/F12 harus tetap hidup (alur kas: ketik uang ->
      // F2; F12 = bayar pas; F10 = fokus kolom uang), sedangkan pintasan lain
      // (F3–F8, panah, Enter) diblokir supaya tidak berebut dengan isian —
      // Enter sudah ditangani modal.ts (INPUT -> klik tombol OK = Bayar).
      const overlay = document.querySelector('.modal-overlay:not(.is-closing)');
      const diFormBayar = !!overlay?.querySelector('#pos-pay');
      if (overlay && !diFormBayar) return;
      if (diFormBayar && !(e.key === 'F2' || e.key === 'F10' || e.key === 'F12')) return;
      const t = e.target as HTMLElement | null;
      const diIsian =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const diTombol = !!t && t.closest('button, a[href]') !== null;

      if (e.key === 'F3') {
        // Layar cari produk penuh (alokasi Aronium F3) — mode jual + shift saja
        // (tanpa shift layar keranjang pun tidak ada).
        if (mode !== 'jual' || !shift) return;
        openCariProduk();
        return;
      }

      if (e.key === 'F4') {
        // Qty untuk item BERIKUTNYA (alokasi Aronium F4).
        if (mode !== 'jual' || !shift) return;
        void setQtyNext();
        return;
      }

      if (e.key === 'F5') {
        // P3: kosongkan keranjang (tombol "Bersihkan F5"). Tanpa preventDefault
        // Chrome me-reload halaman — sudah dijepit di baris guard atas.
        if (mode !== 'jual' || !shift || !cart.length) return;
        bersihkanKeranjang();
        return;
      }

      if (e.key === 'F6') {
        // P3: lompat ke kolom "Diskon transaksi" (labelnya polos — <kbd>F6</kbd>
        // ada di tombol "Diskon F6" grid Aksi cepat, permintaan pemilik
        // putaran 7 2026-10-04).
        if (mode !== 'jual' || !shift) return;
        const d = host?.querySelector<HTMLInputElement>('#pos-discount');
        if (d) {
          d.focus();
          d.select();
        }
        return;
      }

      if (e.key === 'F7') {
        // Tahan transaksi (P5). Alokasi F7 — F2/F3 sudah dipakai Bayar/Layar
        // cari, jadi Tahan tidak bisa memakai F3 seperti KulaPOS. Guard sama
        // persis dengan tombolnya (#pos-hold): mode jual + shift + keranjang
        // terisi; kalau kosong biarkan saja (tombolnya juga disabled).
        if (mode !== 'jual' || !shift || !cart.length) return;
        void tahanKeranjang();
        return;
      }

      if (e.key === 'F1' || e.key === 'F8') {
        // F1 = KulaPOS ("Jumlah Beli * Kode [F1/Cmd+K]" + fokus search);
        // F8 = jalan pendek pemilik 2026-10-04 ("tambahkan shortcut untuk
        // mengarah ke form ini"). Esc juga fokus scan tapi 2 langkah saat
        // dropdown terbuka (Esc pertama tutup dropdown). F1/F8 = 1 tekan.
        e.preventDefault();
        if (mode !== 'jual' || !shift) return;
        focusScan();
        return;
      }

      if (e.key === 'F9') {
        // Cari pelanggan (putaran 7 2026-10-04 + riset KulaPOS: F9 belum
        // standar, dipakai karena F1-F8 sudah terpakai). Mirip F3 layar cari
        // produk tapi untuk pelanggan — buka openCariPelanggan().
        e.preventDefault();
        if (mode !== 'jual' || !shift) return;
        openCariPelanggan();
        return;
      }

      if (e.key === 'F10') {
        // Buka FORM BAYAR (modal). Referensi Aronium (help.aronium.com,
        // artikel Workspace): "Payment (F10) Opens advanced payment form".
        e.preventDefault();
        if (mode !== 'jual' || !shift || !cart.length) return;
        bukaBayar();
        return;
      }

      if (e.key === 'F12') {
        // Bayar pas / bayar cepat. Referensi Aronium (artikel yang sama):
        // "Default payment can be accessed using F12 key — hitting any of
        // quick payment buttons will automatically close current order" =
        // pembayaran cepat TANPA form. Di Ravaa: metode tunai = uang persis
        // total (sama dengan tombol hijau "Bayar pas"), metode lain = bayar
        // dengan metode aktif.
        e.preventDefault();
        if (mode !== 'jual' || !shift || !cart.length) return;
        if (payMethod === 'tunai') bayarPas();
        else void pay();
        return;
      }

      if (e.key === 'F2') {
        // Bayar cepat (mode jual) / proses topup — boleh dari fokus mana pun,
        // termasuk sambil mengetik di kolom uang (alur Aronium: ketik -> F2).
        e.preventDefault();
        if (!shift) return;
        if (mode === 'jual') {
          if (cart.length) void pay();
        } else {
          void submitTopup();
        }
        return;
      }

      if (e.key === 'Escape') {
        // Mode jual: Esc selalu kembalikan fokus ke scan (aturan lama, kini
        // global). Mode topup/tarik: jangan mencuri fokus dari isian yang
        // sedang diketik — dulu memang tidak ada handler Esc di sana.
        if (mode !== 'jual' && diIsian) return;
        focusScan();
        return;
      }

      // ↑↓ navigasi baris keranjang (referensi KulaPOS "Navigasi Baris").
      // Guard ketat: HANYA saat fokus di dalam tbody tabel — panah di kolom
      // scan sudah jadi sorotan dropdown (listener #pos-q), dan di luar tabel
      // panah = gulir halaman yang tidak boleh dicuri.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (mode !== 'jual' || !shift) return;
        if (!t?.closest('#pos-rows')) return;
        // Input catatan (use_note) dikecualikan: panah di kolom teks = gerak
        // kursor, bukan pindah baris.
        if (t?.closest('[data-act="note"]')) return;
        e.preventDefault();
        pindahBarisKeranjang(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (e.key !== 'Enter') return;

      if (mode === 'jual') {
        // #pos-q: Enter = masukkan hasil pencarian / scanner (handler sendiri
        // di bindCart) — jangan sampai ikut membayar.
        if (t?.id === 'pos-q' || diTombol) return;
        // Isian selain kolom uang (diskon, dll): biarkan. Kolom uang = alur
        // kas: ketik nominal -> Enter -> bayar (tanpa perlu klik tombol).
        if (diIsian && t?.id !== 'pos-cash') return;
        if (!shift || !cart.length) return;
        e.preventDefault();
        void pay();
        return;
      }

      // Mode topup/tarik: aturan lama dipindahkan utuh — nominal & admin adalah
      // "input tuner" yang angkanya masih diketik, jadi Enter-nya jangan submit;
      // nomor HP / tunai dibiarkan (Enter = proses, seperti sebelumnya).
      if (t?.id === 'tp-admin' || t?.id === 'tp-nominal' || diTombol) return;
      if (!shift) return;
      e.preventDefault();
      void submitTopup();
    },
    { signal: posKeyAbort.signal },
  );
}

function bindCart(): void {
  posAbort?.abort();
  posAbort = new AbortController();
  const { signal } = posAbort;
  bindModeBar();
  // Chip Qty (setel qty item berikutnya, F4) & tombol Cari (layar cari, F3).
  // Keduanya hanya dirender di mode jual — `?.` supaya mode lain aman.
  host!.querySelector('#pos-qty')?.addEventListener('click', () => void setQtyNext());
  host!.querySelector('#pos-cari')?.addEventListener('click', openCariProduk);
  // Cari pelanggan di info bar (putaran 7 2026-10-04) — layar cari ala F3.
  host!.querySelector('#pos-cust-cari')?.addEventListener('click', openCariPelanggan);
  const q = host!.querySelector<HTMLInputElement>('#pos-q');
  const box = host!.querySelector<HTMLElement>('#pos-results');

  // Ketik -> isi dropdown. Barcode persis/SKU persis cuma 1 hasil, jadi scanner
  // (ketik cepat + Enter) tetap jalan tanpa harus memilih.
  // Sintaks `Qty*Kode` ("3*PRD00001") dicopot dulu sebelum dicari, supaya
  // dropdown tetap menampilkan produknya saat kasir mengetik angka qty —
  // angka qty-nya sendiri tidak dihapus dari kolom.
  q?.addEventListener('input', () => {
    const qtyKode = bacaQtyKode(q.value);
    results = queryResults(qtyKode ? qtyKode.q : q.value);
    active = 0;
    q.setAttribute('aria-expanded', results.length ? 'true' : 'false');
    if (q.value.trim()) paintResults();
    else closeResults();
  });

  // ArrowUp/ArrowDown menyorot, Enter masukkan yang disorot, Escape menutup.
  q?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!results.length) {
        results = queryResults(q.value);
        active = 0;
        if (results.length) paintResults();
        return;
      }
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const v = q.value;
      if (!v.trim()) return;
      // `3*PRD00001` = qty 3 untuk produk sesudah `*` (bacaQtyKode); tanpa `*`
      // perilaku lama dipertahankan utuh.
      const qtyKode = bacaQtyKode(v);
      const cari = (qtyKode ? qtyKode.q : v).trim();
      if (!results.length) results = queryResults(cari);
      if (!results.length) {
        toast(`Produk "${cari}" tidak ditemukan`, 'warning');
        return;
      }
      if (qtyKode && !(qtyKode.qty >= 1)) {
        toast('Qty minimal 1', 'warning');
        return;
      }
      addActive(cari, undefined, qtyKode ? qtyKode.qty : undefined);
    } else if (e.key === 'Escape') {
      if (box && !box.classList.contains('hidden')) {
        e.preventDefault();
        results = [];
        closeResults();
        q.setAttribute('aria-expanded', 'false');
      } else {
        q.value = '';
      }
    }
  });

  // Klik hasil. mousedown + preventDefault supaya input tidak kehilangan fokus
  // (kalau blur duluan, dropdown sudah tertutup sebelum click-nya jalan).
  box?.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    // Chip satuan dicek DULUAN: chip tidak punya data-idx sendiri, jadi kalau
    // hanya mencari [data-idx], klik chip akan terangkat ke pembungkusnya dan
    // diam-diam menambahkan satuan DASAR — persis bug "Aqua btl/dus menumpuk".
    const unitBtn = t.closest<HTMLElement>('[data-unit]');
    const btn = t.closest<HTMLElement>('[data-idx]');
    if (!btn) return;
    e.preventDefault();
    active = Number(btn.dataset.idx);
    // Klik baris sambil mengetik `2*aqua` = qty 2 juga (Enter & klik satu aturan);
    // qty 0 ditolak sama seperti jalur Enter.
    const qtyKode = bacaQtyKode(q?.value ?? '');
    if (qtyKode && !(qtyKode.qty >= 1)) {
      toast('Qty minimal 1', 'warning');
      return;
    }
    addActive(q?.value ?? '', unitBtn?.dataset.unit, qtyKode ? qtyKode.qty : undefined);
  });

  // Klik di luar = tutup dropdown. Listener di document (bukan host) karena top
  // bar & sidebar shell berada di luar elemen halaman, jadi klik ke sana tidak
  // akan melewati host.
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.('#pos-results') || t.closest?.('#pos-q')) return;
    results = [];
    closeResults();
  }, { signal });

  host!.querySelector('#pos-rows')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const key = btn.dataset.key!;
    const line = cart.find((l) => l.key === key);
    if (!line) return;
    if (btn.dataset.act === 'inc') setQty(key, line.qty + 1);
    if (btn.dataset.act === 'dec') setQty(key, line.qty - 1);
    if (btn.dataset.act === 'del') setQty(key, 0);
  });

  host!.querySelector('#pos-rows')?.addEventListener('change', (e) => {
    const el = e.target as HTMLElement;
    // Kolom Diskon: ketikan kasir (boleh menghapus prefill = isi 0). Angka
    // dijepit ke jumlah baris di setDisc supaya server tidak menolak 400.
    const discInp = el.closest<HTMLInputElement>('[data-act="disc"]');
    if (discInp) {
      setDisc(discInp.dataset.key!, Number(discInp.value || 0));
      return;
    }
    const inp = el.closest<HTMLInputElement>('[data-act="qty"]');
    if (inp) setQty(inp.dataset.key!, Number(inp.value || 0));
  });

  // Catatan per baris (produk use_note): `input` (live), BUKAN `change` —
  // kasir bisa langsung F2 bayar tanpa blur, dan tanpa event live catatannya
  // masih kosong di payload. Sengaja TANPA paintCart: paint merender ulang
  // tbody sehingga input kehilangan fokus di tengah ketikan.
  host!.querySelector('#pos-rows')?.addEventListener('input', (e) => {
    const inp = (e.target as HTMLElement).closest<HTMLInputElement>('[data-act="note"]');
    if (!inp) return;
    const line = cart.find((l) => l.key === inp.dataset.key);
    if (line) line.note = inp.value.slice(0, 200);
  });

  host!.querySelector('#pos-discount')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value || 0);
    discount = Math.max(0, v);
    // Batasnya sisa SETELAH diskon item: total tidak boleh < 0, dan server
    // juga menolak "diskon melebihi subtotal".
    const maks = Math.max(0, subtotal() - diskonBaris());
    if (discount > maks) {
      discount = maks;
      (e.target as HTMLInputElement).value = String(discount);
    }
    paintCart();
  });

  // Tombol Bayar (sidebar) = BUKA FORM BAYAR (modal) — permintaan pemilik
  // 2026-10-04. Listener isian bayar (#pos-cash, data-pay, data-cash,
  // #pos-pay) kini terpasang di bindFormBayar(), sekali tiap modal dibuka,
  // karena elemennya tidak ada di DOM selama modal tertutup.
  host!.querySelector('#pos-bayar')?.addEventListener('click', () => bukaBayar());

  // Bayar pas = DI SIDE PANEL, tepat di bawah Bayar F10 (permintaan pemilik
  // putaran kedua 2026-10-04). Tunai persis total dalam satu ketukan,
  // TANPA buka form — pakai jalur pay() yang sama (F12 memanggil fungsi ini).
  host!.querySelector('#pos-pay-pas')?.addEventListener('click', () => bayarPas());

  // Pilih pelanggan di info bar (revisi 2026-10-04): hanya menyimpan state —
  // id-nya dikirim server saat pay() dan di-SNAPSHOT jadi sales.customer_name.
  host!.querySelector('#pos-customer')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    customerId = v ? Number(v) : null;
  });

  host!.querySelector('#pos-clear')?.addEventListener('click', () => bersihkanKeranjang());

  // Aksi cepat (sidebar) — Tahan/Pending = fitur P5, Item manual & Diskon
  // memanggil aksi lama (openManualItem / fokus kolom F6) dari satu tempat.
  host!.querySelector('#pos-hold')?.addEventListener('click', () => void tahanKeranjang());
  host!.querySelector('#pos-hold-open')?.addEventListener('click', () => bukaTertahan());
  host!.querySelector('#pos-qa-manual')?.addEventListener('click', () => openManualItem());
  host!.querySelector('#pos-qa-disc')?.addEventListener('click', () =>
    host!.querySelector<HTMLInputElement>('#pos-discount')?.focus(),
  );
  // Placeholder [data-soon]: tombol sudah dirender, fiturnya menyusul
  // (permintaan pemilik 2026-10-04 "placeholder/hardcode dulu tidak apa-apa").
  host!.querySelectorAll<HTMLElement>('[data-soon]').forEach((b) =>
    b.addEventListener('click', () => toast(`Fitur ${b.dataset.soon} — menyusul`, 'info')),
  );

  // F2 = bayar cepat, Esc = fokus input scan: lihat bindPintasan() (document).
}

/* ---------- load ---------- */

async function loadShift(): Promise<void> {
  try {
    const res = await apiGet<{ data: Shift | null }>(`/api/shifts/open?cashier=${encodeURIComponent(getCashier())}`);
    shift = res.data;
  } catch {
    shift = null; // offline: tetap bisa layar keranjang, bayar nanti masuk outbox
  }
}

/** Router memanggil ini saat meninggalkan route `pos`, supaya listener yang
 *  menempel ke `document` ikut dibuang. */
export function unmountPosPage(): void {
  posAbort?.abort();
  posAbort = null;
  posKeyAbort?.abort();
  posKeyAbort = null;
  stopJam();
  // Form bayar menempel di document.body (bukan di host) — tanpa ditutup di
  // sini ia ikut tertinggal menutupi halaman berikutnya.
  tutupBayar();
  results = [];
  host = null;
  shift = null;
}

/** Dipanggil router untuk route `pos`. */
export async function mountPosPage(el: HTMLElement): Promise<void> {
  host = el;
  // Pref cetak per device bisa saja diubah di panel Sistem sejak mount
  // terakhir — baca ulang supaya saklar scan bar & perilaku cetak ikut.
  autoPrint = getAutoPrint();
  // Kasir tidak boleh bergantung pada halaman Manage: perangkat baru wajib punya
  // cache produk. Tarik delta dari server (?since=maxVersion), lalu baca cache.
  // Kalau gagal (offline) tetap jalan dengan cache terakhir.
  try {
    await syncMaster((since) => apiGet<{ data: Product[]; maxVersion: number }>(`/api/products?since=${since}`));
  } catch {
    /* offline: pakai cache yang ada */
  }
  products = await getCachedProducts();
  if (!el.isConnected) return; // kasir sudah pindah halaman saat sinkron
  mode = 'jual';
  topJenis = defaultJenis('jual');
  topNomor = '';
  topNominal = 0;
  topAdmin = 0;
  topAdminTouched = false;
  topTunai = 0;
  results = [];
  cart = [];
  discount = 0;
  cashIn = 0;
  busy = false;
  await loadShift();
  // Master pelanggan untuk info bar (revisi 2026-10-04). Gagal/ offline =
  // daftar kosong -> select hanya placeholder, payload tanpa customer_id
  // (client lama) tetap sah. Bawaan = "Pelanggan Umum".
  customers = [];
  try {
    const r = await apiGet<{ data: Cust[] }>('/api/customers');
    customers = r.data;
  } catch {
    customers = [];
  }
  customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
  // Daftar transaksi tertahan (P5) dari IndexedDB per device. Gagal/IDB
  // rusak = daftar kosong — fitur hold tetap bisa dipakai dari kosong.
  try {
    holds = await getHolds<Hold>();
  } catch {
    holds = [];
  }
  if (!el.isConnected) return;
  bindPintasan(); // F2/Enter/Esc level document — didaftarkan sekali per mount
  mulaiJam();     // jam live info bar — dihentikan di unmountPosPage
  paint();
}
