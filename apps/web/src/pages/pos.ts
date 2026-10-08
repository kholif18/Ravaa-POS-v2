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
// berikutnya, F5 bersihkan, F6 diskon transaksi, F7 tahan, F8 modal Pending
// scan, F10 buka form bayar, F12 bayar pas, Enter bayar, Esc fokus ke scan.
// Swal terbuka (konfirmasi/pilihan cetak) menahan SEMUA pintasan; form bayar
// yang terbuka hanya mengizinkan F2/F10/F12.
//
// Data produk dibaca dari cache IndexedDB (store.ts) — bukan fetch per ketikan.
// Cache kasir hanya berisi is_active=1 (see AGENTS.md §3), jadi produk
// nonaktif tidak mungkin masuk keranjang.

import { apiGet, apiPost, uuid, HttpError, outboxCount } from '../api';
import {
  getCachedProducts, syncMaster, getHolds, saveHolds, getKeranjang, saveKeranjang,
  type Product,
} from '../store';
import { getCashier, getToko } from '../ui/user';
import { switchHtml } from '../ui/switch';
import { getAutoPrint, getPrintPause, setAutoPrint, setStrukLayout } from '../ui/print-pref';
import { kirimPrint, strukUntuk, bukaLaci, type Struk, type StrukBaris } from '../escpos';
import { cetakInvoice } from '../invoice';
import { choiceDialog, confirmDialog } from '../ui/confirm';
import { toast } from '../ui/toast';
import { openModal, type ModalHandle } from '../ui/modal';
import { icon, type IconName } from '../ui/icons';
import { AMBAT_EXPIRY, statusExpiry, tglExpiry } from '../ui/expiry';
import { dialogTutupShift, type ShiftRow } from './shift-tutup';
// cetakUlang = jalur Riwayat (Tahap 2 2026-10-06): tombol "Cetak ulang" di
// Aksi cepat memakai dialog + struk yang SAMA PERSIS — jangan ditulis ulang
// di pos.ts (AGENTS §5: bila kemiripan ≥80% → satu modul).
import { cetakUlang, type SaleRow } from './history';

/* ---------- tipe ---------- */

type Shift = {
  id: number; opened_at: string; closed_at: string | null;
  modal_awal: number; modal_akhir: number | null; cashier: string; status: string;
};

/** Baris keranjang. `product_id` null = item manual (jasa/cetak). */
type CartLine = {
  key: string;              // `<id produk>:<unit>`, atau — untuk produk harga
                            // khusus (price_dynamic) — `<id>:<unit>:<harga>`
                            // (harga ikut di key: beda harga = baris terpisah),
                            // atau 'manual:<n>' untuk item manual.
                            // TANPA unit di key, "Aqua btl" dan "Aqua dus" akan
                            // menumpuk jadi satu baris (fitur #3).
  product_id: number | null;
  name: string;
  sku: string;
  price: number;            // harga satuan yang sudah final (dinamis sudah ditanya)
  /** Snapshot `products.price_dynamic` saat masuk keranjang: 1 = kolom Harga
   *  baris ini dirender sebagai INPUT yang boleh diubah kasir (khusus produk
   *  "boleh ubah harga saat jual"); 0 = teks terkunci. */
  dyn: boolean;
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
/** Baris LAYANAN di keranjang (Opsi B hybrid — permintaan pemilik
 *  2026-10-07 *"bisa 2 mode dalam 1 transaksi"*, contoh: fotokopi 50 lembar +
 *  isi pulsa dalam satu nota & satu pembayaran). Array TERPISAH dari `cart`
 *  (baris produk/manual) supaya seluruh loop kartu keranjang — re-key,
 *  diskon, qty, catatan, payload `items[]` POST /api/sales — tidak perlu
 *  disentuh sama sekali: server TIDAK pernah menerima baris layanan (nominal
 *  topup BUKAN omzet, lihat AGENTS §1), hanya client yang menjumlahkannya ke
 *  total tagihan & merender barisnya di tabel. Bayar = `POST /api/sales`
 *  (produk saja) LALU `POST /api/topups` per baris — dua record terpisah,
 *  satu struk gabungan (lihat `pay()`). Baris tarik = uang keluar: nominalnya
 *  diserahkan tunai (BUKAN tagihan), yang ditagih hanya admin. */
type TopupLine = {
  /** uuid dibuat SAAT BARIS DIBUAT — dipakai sebagai `id` POST /api/topups,
   *  jadi retry setelah gagal/timeout tetap idempotent (server menolak dobel
   *  dan membalas `duplicate:true`, pola sama dengan id penjualan). */
  id: string;
  key: string;             // 'topup:<n>' — kunci hapus baris (tak pernah
                            // menabrak <idproduk>:<unit> / manual:<n>)
  jenis: TopupJenis;       // kunci jenis TOPUP_JENIS ('e-wallet'|'pulsa'|…)
  nomor: string;           // '' = tanpa nomor (jenis yang boleh tanpa nomor)
  token: string;           // nomor token PLN ('' bila bukan pln-token)
  nominal: number;         // mutasi modal — ikut tagihan, BUKAN omzet
  admin: number;           // pendapatan jasa — ikut tagihan
};
/** Baris layanan di keranjang + nomor urutnya (pola `manualSeq`). */
let cartTopup: TopupLine[] = [];
let topupSeq = 0;
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
// didaftarkan sekali per mount — state-nya (cart/shift) dibaca langsung
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
  /** Baris topup yang ikut ditahan (Opsi B) — OPSIONAL untuk hold lama. */
  topups?: TopupLine[];
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

/** Jalankan jam live (sekali per mount). */
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

/** Buka laci kasir OTOMATIS — Tahap 4a (keputusan pemilik 2026-10-06:
 *  "Buka Laci Kasir ... OTOMATIS tiap penjualan tunai, walau saklar cetak
 *  mati"). Kirim kick ESC/POS TERPISAH dari struk: `if (!autoPrint) return`
 *  di cetak() sengaja TIDAK dipakai di sini (laci = bagian transaksi tunai,
 *  bukan cetak). Gagal (agent mati / kabel lepas) hanya console.warn —
 *  penjualan tidak pernah dibatalkan, dan tanpa toast supaya kasir tidak
 *  dibanjiri peringatan tiap nota (jalur struk punya toast sendiri). */
async function bukaLaciOtomatis(): Promise<void> {
  // Jeda cetak (print-pref.ts): kick laci = kirim fisik juga — senyap saja,
  // JANGAN spam console.warn tiap penjualan selama pemilik belum perintah nyala.
  if (getPrintPause()) return;
  try {
    await kirimPrint(bukaLaci());
  } catch (e) {
    console.warn('[laci] kick gagal:', e instanceof Error ? e.message : e);
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
  /** Baris topup keranjang (Opsi B hybrid) — ditampilkan SETELAH daftar
   *  produk; nominal & admin tetap dua baris terpisah (aturan domain §1).
   *  Absen/[] = keluaran PERSIS seperti sebelum fitur (uji lama aman). */
  topups?: { label: string; nominal: number; admin: number; keluar?: boolean }[];
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
  // Baris topup (Opsi B): label + nominal, admin sebagai sub-baris abu
  // (dilewati bila 0) — mengikuti blok struk, jangan disatukan.
  const tops = (o.topups ?? [])
    .map(
      (t) =>
        `<div class="flex items-baseline justify-between gap-4"><span class="min-w-0 truncate">${t.keluar ? 'Tarik' : 'Topup'} ${esc(t.label)}</span><span class="tabular-nums shrink-0">${rp(t.nominal)}</span></div>` +
        (t.admin > 0
          ? `\n      <div class="flex items-baseline justify-between gap-4 pl-3 text-gray-500 dark:text-gray-400"><span>admin</span><span class="tabular-nums shrink-0">${rp(t.admin)}</span></div>`
          : ''),
    )
    .join('\n      ');
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
      ${baris.join('\n      ')}${tops ? `\n      ${tops}` : ''}
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
 *    [A4]      = invoice gaya Aronium via window.print() browser (CUPS) —
 *               **hanya bila `saleId` terisi**; layanan-saja (`saleId === null`,
 *               keranjang tanpa produk → tidak ada nota sale) memakai
 *               **strukA4 64 kolom via print-agent** (pref struk topup/tarik —
 *               AGENTS §escpos), sebab `cetakInvoice()` butuh GET /api/sales/:id.
 *    [Selesai] = tanpa cetak (fokus awal swal = tombol ini, Enter = selesai).
 *    Pilihan terakhir disimpan sebagai pref layout (struk topup/tarik).
 *    Posisi tombol swal TIDAK BERUBAH (confirm/deny/cancel) —
 *    tests/e2e-struk.mjs memakai selector itu. */
async function pilihCetakSelesai(
  saleId: string | null,
  struk: Struk,
  tot: number,
  kembalian: number,
  resume: { invoiceNo?: string | null; items: { qty: number; nama: string; net: number }[]; topups?: { label: string; nominal: number; admin: number; keluar?: boolean }[]; metode: PayMethod; uang: number; hutang?: number },
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
    // Baris topup (Opsi B hybrid) = 1 struk gabungan hanya di THERMAL.
    // Invoice A4 masih menarik nota dari server (`GET /api/sales/:id` — topup
    // tidak ada di `sale_items`), jadi pilihan A4 disembunyikan saat ada
    // topup PADA PENJUALAN — jangan mencetak invoice yang totalnya beda dari
    // yang dibayar. Layanan-saja (`saleId === null`) tetap menawarkan A4:
    // di sana A4 = strukA4 (bukan invoice), jadi tidak ada ketidakcocokan.
    // (Menyusul bila pemilik minta A4 gabungan.)
    choices: resume.topups?.length && saleId !== null
      ? [{ key: 'thermal', label: 'Thermal' }]
      : [
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
    'Cetak sedang mati — nyalakan saklar "Cetak struk otomatis" di bawah scan bar bila ingin mengirim ke printer.';
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
    if (saleId === null) {
      // Layanan-saja: tidak ada nota sale → A4 = strukA4 64 kolom lewat
      // print-agent (satu-satunya pemakai strukA4 sejak pilihan A4 penjualan
      // pindah ke invoice browser, AGENTS §escpos). `cetak()` sudah memegang
      // guard autoPrint dua kali — tak masalah, yang penting pesan mati tetap
      // tampil dari guard eksplisit di atas.
      void cetak(strukUntuk(struk, 'a4'));
      return;
    }
    try {
      await cetakInvoice(saleId);
    } catch (e) {
      toast(`Invoice A4 tidak tercetak: ${e instanceof Error ? e.message : 'gagal memuat nota'}. Penjualan tetap tersimpan.`, 'warning', 9000);
    }
  }
}

/** Layout mobile (Tahap 5, 2026-10-06 — pengganti P4 grid, keputusan pemilik
 *  "untuk mobile nanti buat layout sendiri … tambahkan layout untuk berpindah
 *  ke mode mobile saja"): true = semua grid POS dipaksa 1 kolom (info bar
 *  menumpuk, panel bayar di bawah selebar layar — preview layout HP di
 *  desktop; di HP asli <lg memang sudah menumpuk natural). Pref per-device
 *  `ravaa.mobile-layout` ('1'), toggle lewat tombol #pos-mobile di scan bar. */
let mobileMode = (() => {
  try {
    return localStorage.getItem('ravaa.mobile-layout') === '1';
  } catch {
    return false;
  }
})();

/** Class grid utama POS (keranjang+sidebar bayar / form topup+panel):
 *  `mobileMode` → 1 kolom penuh (panel ikut di bawah selebar layar — layout
 *  mobile, pengganti P4 grid); normal → sidebar 320px di ≥lg. */
function gridUtamaCls(): string {
  return mobileMode
    ? 'grid min-h-0 flex-1 gap-2 grid-cols-1'
    : 'grid min-h-0 flex-1 gap-2 lg:grid-cols-[1fr_350px]';
}

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
/** Baris TARIK di keranjang = uang KELUAR (diserahkan tunai ke pelanggan).
 *  `TopupLine.jenis` sudah mencakup kunci `TARIK_JENIS`, jadi tidak perlu
 *  tipe baris baru — cukup cabang di hitung/kirim/cetak (lihat isTarik). */
const isTarik = (t: Pick<TopupLine, 'jenis'>): boolean => TARIK_JENIS.some((j) => j.key === t.jenis);
/** Kunci jenis layanan yang boleh masuk keranjang (validasi restore
 *  muatKeranjang/muatHold — jangan pernah kirim `provider` ngawur). */
const isJenisLayanan = (jenis: string): boolean =>
  TOPUP_JENIS.some((j) => j.key === jenis) || TARIK_JENIS.some((j) => j.key === jenis);
/** Total TAGIHAN baris TOPUP (uang masuk) — nominal + admin per baris
 *  (aturan domain §1: `total = nominal + admin`). Ikut TOTAL TAGIHAN
 *  (bukan omzet — lihat `pay()` yang mengirimnya ke /api/topups terpisah). */
const topupTotal = () => cartTopup.filter((l) => !isTarik(l)).reduce((s, l) => s + l.nominal + l.admin, 0);
/** Total TAGIHAN baris TARIK (uang keluar) — HANYA admin; nominalnya
 *  diserahkan tunai ke pelanggan dan BUKAN bagian yang dibayar (aturan tarik
 *  tunai: uang boleh 0 karena mengalir keluar). */
const tarikTotal = () => cartTopup.filter(isTarik).reduce((s, l) => s + l.admin, 0);
/** Keranjang terisi = ADA baris produk/manual ATAU baris layanan.
 *  SATU sumber guard untuk Bayar/Bersihkan/F5/F2/Enter — tanpa ini baris
 *  layanan sendirian tidak bisa dibayar (guard `!cart.length` lama). */
const keranjangTerisi = () => !!(cart.length || cartTopup.length);
const change = () => Math.max(0, cashIn - totalBayar());

/** Total tagihan MODAL BAYAR = total keranjang + baris layanan (Opsi B:
 *  satu pelanggan, satu pembayaran; tarik hanya adminnya — nominalnya uang
 *  keluar, bukan tagihan). Satu sumber untuk judul modal, kartu
 *  "Total tagihan", barrier tunai, kembalian, dan angka TOTAL BELANJA. */
const totalBayar = () => total() + topupTotal() + tarikTotal();

/** Kembalian modal = uang diterima − total tagihan (0 bila uang belum diisi). */

/** Bolehkah tombol Bayar / Bayar pas aktif: keranjang terisi (produk/manual
 *  ATAU baris layanan — `keranjangTerisi()`, Opsi B). */
const bisaBayar = () => keranjangTerisi();

/** Kelas warna angka KEMBALIAN (hasil besar di form bayar: hijau = cukup/
 *  lebih, merah = kurang, abu = belum diisi). Dipakai lewat kelasPosChange()
 *  — SATU sumber untuk render awal (formBayarHtml) dan update live
 *  (paintCart) — dua tempat ini pernah punya kelas terpisah dan bisa berbeda
 *  saat dirawat. */
function kelasKembalian(): string {
  if (!(cashIn > 0)) return 'text-gray-900 dark:text-white';
  return cashIn < totalBayar()
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
  if (!(cashIn > 0) || !keranjangTerisi()) return '';
  if (cashIn < totalBayar()) return `Kurang ${rp(totalBayar() - cashIn)}`;
  if (cashIn === totalBayar()) return 'Uang pas. Tidak ada kembalian.';
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

/** Resolusi satuan jual → `{unit, factor, price}` FINAL untuk satu baris.
 *  Satuan dasar / kosong → `{p.unit, 1, p.price}`; alternatif dari
 *  `product_units`: `price` eksplisit bila diisi, ikut `products.price × factor`
 *  bila NULL (aturan kontrak GET /api/products `units[]`).
 *  Satuan tak dikenal jatuh ke dasar (pola addProduct lama — jangan dilempar
 *  error di sini; server tetap penjaga terakhir saat bayar).
 *  SATU sumber kebenaran untuk addProduct, gantiSatuan, dan muatKeranjang
 *  (AGENTS §5). */
function resolusiSatuan(
  p: Product,
  unitSlug?: string,
): { unit: string; factor: number; price: number } {
  const ru = unitSlug && unitSlug !== p.unit
    ? (p.units ?? []).find((u) => u.unit === unitSlug)
    : undefined;
  return ru
    ? { unit: ru.unit, factor: ru.factor, price: ru.price ?? Math.round(p.price * ru.factor) }
    : { unit: p.unit, factor: 1, price: p.price };
}

/** Daftar pilihan select satuan per baris: dasar + alternatif (bila kosong
 *  = produk hanya punya satu satuan → select TIDAK dirender). */
function daftarSatuan(p: Product): { unit: string; factor: number; price: number }[] {
  const list = [resolusiSatuan(p), ...(p.units ?? []).map((u) => resolusiSatuan(p, u.unit))];
  // Guard duplikat: satuan dasar kontrak sengaja bukan baris units[], tapi
  // cache lama / data import bisa saja memuatnya — select opsi dobel = bingung.
  return list.filter((o, i) => list.findIndex((x) => x.unit === o.unit) === i);
}

function addLine(p: Product, price: number, qty = 1, unit = p.unit, factor = 1): void {
  // Key menyertakan satuan: 2 pcs dan 2 pack adalah baris BERBEDA, bukan penambahan.
  // Produk harga khusus (price_dynamic) key-nya ikut memuat HARGA beli baris
  // ini — scan ulang dengan harga berbeda = baris BARU; harga sama = qty
  // bertambah (keputusan pemilik 2026-10-06).
  const key = p.price_dynamic ? `${p.id}:${unit}:${price}` : `${p.id}:${unit}`;
  // Prefill diskon permanen produk: '%'-nya dihitung ke rupiah per baris, jadi
  // kasir melihat angka jadi (bukan tebak-tebakan) dan tetap bisa mengubahnya.
  const prefill = p.discount > 0
    ? { type: p.discount_type === 'pct' ? ('pct' as const) : ('rp' as const), value: p.discount }
    : null;
  const found = cart.find((l) => l.key === key);
  if (found) {
    found.qty += qty;
    found.price = price; // harga terbaru — untuk dinamis key sudah memastikan ini harga yang SAMA
    // Diskon mengikuti qty ASALKAN belum diedit tangan — kalau kasir sudah
    // menyetel angka sendiri, menimpanya akan mengubah harga yang sudah
    // disepakati pelanggan di tengah transaksi.
    if (!found.discManual) found.discount = hitungPrefill(found);
  } else {
    const baris: CartLine = {
      key, product_id: p.id, name: p.name, sku: p.sku,
      price, qty, track_stock: p.track_stock,
      unit, baseUnit: p.unit, factor,
      dyn: !!p.price_dynamic,
      discount: 0, prefill, discManual: false,
      useNote: !!p.use_note, note: '',
    };
    baris.discount = hitungPrefill(baris);
    cart.push(baris);
  }
  simpanKeranjang();
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
  simpanKeranjang();
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
  simpanKeranjang();
  paintCart();
}

/** Setel harga satu baris dari input kolom Harga — HANYA untuk produk
 *  price_dynamic (`line.dyn`); kolom non-dinamis dirender teks terkunci.
 *  Baris di-RE-KEY ke `<id>:<unit>:<harga>` baru: bila baris lain sudah
 *  memakai harga itu, kuantitas DIGABUNG (aturan scan yang sama — "harga sama
 *  = qty tambah, beda = baris baru", keputusan pemilik 2026-10-06). */
function setHarga(key: string, nilai: number): void {
  const line = cart.find((l) => l.key === key);
  if (!line || !line.dyn || line.product_id === null) return;
  const bersih = Number.isFinite(nilai) ? Math.max(0, Math.round(nilai)) : 0;
  line.price = bersih;
  // Diskon prefill (%/Rp) dihitung ulang terhadap harga BARU selama kasir
  // belum mengeditnya sendiri, lalu dijepit ke jumlah baris yang baru.
  if (!line.discManual) line.discount = hitungPrefill(line);
  line.discount = Math.min(line.discount, jumlahBaris(line));
  const keyBaru = `${line.product_id}:${line.unit}:${bersih}`;
  if (keyBaru !== key) {
    const tabrakan = cart.find((l) => l.key === keyBaru);
    if (tabrakan) {
      tabrakan.qty += line.qty;
      if (!tabrakan.discManual) tabrakan.discount = hitungPrefill(tabrakan);
      tabrakan.discount = Math.min(tabrakan.discount, jumlahBaris(tabrakan));
      cart = cart.filter((l) => l.key !== key);
    } else line.key = keyBaru;
  }
  clampDiskonTransaksi();
  simpanKeranjang();
  paintCart();
}

/** Ganti satuan baris yang SUDAH ada di keranjang (Tahap 3, 2026-10-06).
 *  Keputusan FINAL pemilik: select/dropdown satuan PER BARIS; **qty ANGKA SAMA
 *  pindah satuan** (5 pcs → 5 pack); **diskon baris DI-RESET** (total uang
 *  berubah — diskon lama tidak relevan); harga diambil ulang dari
 *  `product_units` lewat `resolusiSatuan` (server tetap mengunci harga non-
 *  dinamis saat bayar). Re-key `<id>:<unit>` (+ `:<harga>` bila price_dynamic)
 *  — bila baris lain sudah memakai key itu, kuantitas DIGABUNG (aturan scan
 *  yang sama, lihat setHarga). */
function gantiSatuan(key: string, unitSlug: string): void {
  const line = cart.find((l) => l.key === key);
  if (!line || line.product_id === null || !unitSlug || unitSlug === line.unit) return;
  const p = products.find((x) => x.id === line.product_id);
  if (!p) return;
  const res = resolusiSatuan(p, unitSlug);
  // Satuan tak ada di master baris ini (cache basi) — resolusiSatuan jatuh ke
  // satuan dasar; kalau dasar pun bukan pilihan yang diklik, abaikan.
  if (res.unit !== unitSlug) return;
  const qty = line.qty; // angka qty TETAP — hanya satuan & harga yang berganti
  const keyBaru = p.price_dynamic ? `${p.id}:${res.unit}:${res.price}` : `${p.id}:${res.unit}`;
  if (keyBaru !== line.key) {
    const tabrakan = cart.find((l) => l.key === keyBaru);
    if (tabrakan) {
      // Baris tujuan sudah ada (satu produk+satuan[+harga]) — gabung kuantitas,
      // baris lama dibuang. Diskon baris tujuan TIDAK di-reset: ia milik baris
      // lain yang tidak ikut berganti.
      tabrakan.qty += qty;
      if (!tabrakan.discManual) tabrakan.discount = hitungPrefill(tabrakan);
      tabrakan.discount = Math.min(tabrakan.discount, jumlahBaris(tabrakan));
      cart = cart.filter((l) => l.key !== key);
    } else {
      line.key = keyBaru;
      line.unit = res.unit;
      line.factor = res.factor;
      line.price = res.price;
      // Diskon baris DI-RESET (keputusan pemilik 2026-10-06). discManual=true
      // supaya prefill produk TIDAK "bangkit" lagi saat qty berubah — kasir
      // melihat angka 0 dan boleh mengisi sendiri kalau memang mau.
      line.discount = 0;
      line.discManual = true;
    }
  }
  clampDiskonTransaksi();
  simpanKeranjang();
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

/* ---------- tutup shift dari POS (tombol merah info bar) ---------- */

/** Buka dialog tutup shift dari info bar POS (keputusan pemilik 2026-10-06:
 *  "tombol merah di pos seperti kula pos"). Baris shift diambil SEGAR dari
 *  `GET /api/shifts?status=open&cashier=` supaya angka agregat (omzet/tunai/
 *  topup) pada dialog selalu terkini — `shift` di memori POS tidak memuat
 *  kolom agregat. Setelah sukses: reload `shift` (null -> gate "Buka shift
 *  dulu" tampil lagi; keranjang TETAP di memori + localStorage). */
async function tutupShiftDariPos(): Promise<void> {
  if (!shift || busy) return;
  // Klik ganda / modal sudah terbuka = jangan menumpuk dialog kedua.
  if (document.querySelector('.modal-overlay:not(.is-closing)')) return;
  busy = true;
  try {
    const r = await apiGet<{ data: ShiftRow[] }>(
      `/api/shifts?status=open&cashier=${encodeURIComponent(getCashier())}&limit=10`,
    );
    const s = r.data.find((x) => x.id === shift!.id) ?? r.data[0];
    if (!s) {
      toast('Shift ini tidak ditemukan di server — muat ulang dulu', 'warning');
      return;
    }
    dialogTutupShift(s, async () => {
      await loadShift(); // null -> paint() menampilkan gate buka shift
      paint();
    });
  } catch (e) {
    toast(`Gagal memuat shift: ${e instanceof Error ? e.message : 'tidak diketahui'}`, 'error');
  } finally {
    busy = false;
  }
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

/** Notif ringkas di slot KANAN baris bawah scan bar (permintaan pemilik
 *  2026-10-07 *"notif stok barang habis atau dll"*, direvisi 2026-10-08
 *  *"buat agar lebih informatif, dan buat notif lain bukan hanya stok
 *  habis"*): pembungkus beraid **`#pos-notif`** supaya bisa digambar ulang
 *  `segNotifPos()` setelah stok berubah (pay() tidak menjalankan `paint()`
 *  penuh — itu akan membuang fokus kolom scan). Isi = `notifChips()`.
 *  Sumber data = cache lokal produk + `outboxCount()` + `getPrintPause()`
 *  (semua tanpa panggilan API; kesegaran ikut syncMaster & flush outbox). */
function notifModeRow(): string {
  return `<div id="pos-notif" class="ml-auto flex flex-wrap items-center gap-1.5">${notifChips()}</div>`;
}

/** Isi chip notif POS — enam jenis, urut prioritas:
 *
 *  1. **stok habis** (merah → `#/stock`)  2. **stok menipis** (kuning → `#/stock`)
 *  3. **lewat kadaluarsa** (merah → `#/products`)  4. **kadaluarsa ≤ 30 hari**
 *     (kuning → `#/products` — dulu hanya muncul di strip, chipnya tidak ada)
 *  5. **transaksi antre offline** (biru → `#/dashboard`) — `data-notif-outbox`,
 *     teks+visibilitas disegarkan `updateOutboxBadge()` (api.ts) tiap antrean
 *     berubah, jadi tidak menunggu repaint POS
 *  6. **cetak dijeda** (abu → `#/settings`) — saklar autoPrint boleh nyala tapi
 *     `ravaa.printpause` menahan SEMUA pengiriman printer; tanpa chip ini kasir
 *     hanya bisa menebak kenapa tidak ada struk keluar.
 *
 *  **Informatif** (revisi pemilik 2026-10-08 *"buat agar lebih informatif"*):
 *  tiap chip memuat nama produk PERTAMA (stok/tanggalnya) di teks + `title`
 *  memuat daftar penuh. Rincian menipis/kadaluarsa tetap di strip
 *  `stripStokMenipis()`/`stripKadaluarsa()` di bawah scan bar; untuk **stok
 *  habis TIDAK ada strip** — keputusan pemilik 2026-10-08 (strip merah yang
 *  sempat ditambah *"ini hapus saja karena sudah ada di atasnya di dalam
 *  card"*): chip + judulnya menampung info itu sendiri. Chip outbox SELALU
 *  dirender (bila 0 = kelas `hidden`) supaya elemennya ada untuk pembaruan
 *  langsung dari api.ts. */
function notifChips(): string {
  const habis = products.filter((p) => p.track_stock && p.stock <= 0);
  const menipis = products.filter((p) => p.track_stock && p.stock > 0 && p.min_stock > 0 && p.stock <= p.min_stock);
  const lewat = products.filter((p) => statusExpiry(p.expiry_date) === 'lewat');
  const dekat = products.filter((p) => statusExpiry(p.expiry_date) === 'dekat');
  const antre = outboxCount();
  const merah = '!border-red-300 !text-red-700 dark:!border-red-500/50 dark:!text-red-300 hover:!bg-red-50 dark:hover:!bg-red-500/10';
  const kuning = '!border-amber-300 !text-amber-700 dark:!border-amber-500/50 dark:!text-amber-300 hover:!bg-amber-50 dark:hover:!bg-amber-500/10';
  const biru = '!border-sky-300 !text-sky-700 dark:!border-sky-500/50 dark:!text-sky-300 hover:!bg-sky-50 dark:hover:!bg-sky-500/10';
  const abu = '!border-gray-300 !text-gray-600 dark:!border-gray-600 dark:!text-gray-300 hover:!bg-gray-50 dark:hover:!bg-gray-500/10';
  /** "Nama (angka)" bila cuma 1; "Nama +2 lain" bila banyak — teks chip jangan
   *  meledak, daftar penuh tetap di `title` & strip. MENTAH (belum di-esc):
   *  `chip()` yang men-esc sekali di akhir, kalau tidak dobel. */
  const satu = (daftar: string[]): string =>
    !daftar.length ? '' : daftar.length === 1 ? ` · ${daftar[0]}` : ` · ${daftar[0]} +${daftar.length - 1} lain`;
  const judul = (daftar: string[]): string => daftar.join('; ');
  const chip = (href: string, kelas: string, ikon: IconName, teks: string, teksJudul: string, extra = '') =>
    `<a href="${href}" class="chip ${kelas}" title="${esc(teksJudul)}"${extra}>${icon(ikon)}<span class="font-semibold">${esc(teks)}</span></a>`;
  return [
    habis.length
      ? chip('#/stock', merah, 'alert', `${habis.length} stok habis${satu(habis.map((p) => `${p.name} (${p.stock})`))}`,
          `Stok habis/minus: ${judul(habis.map((p) => `${p.name} sisa ${p.stock}`))} — buka halaman Stok`)
      : '',
    menipis.length
      ? chip('#/stock', kuning, 'alert', `${menipis.length} stok menipis${satu(menipis.map((p) => `${p.name} (${p.stock})`))}`,
          `Stok di bawah/equal stok minimum: ${judul(menipis.map((p) => `${p.name} sisa ${p.stock} (min ${p.min_stock})`))} — buka halaman Stok`)
      : '',
    lewat.length
      ? chip('#/products', merah, 'alert', `${lewat.length} lewat kadaluarsa${satu(lewat.map((p) => `${p.name}${p.expiry_date ? ` ${tglExpiry(p.expiry_date)}` : ''}`))}`,
          `Sudah lewat tanggal kadaluarsa: ${judul(lewat.map((p) => `${p.name}${p.expiry_date ? ` (${tglExpiry(p.expiry_date)})` : ''}`))} — buka halaman Produk`)
      : '',
    dekat.length
      ? chip('#/products', kuning, 'clock', `${dekat.length} kadaluarsa ${AMBAT_EXPIRY} hari${satu(dekat.map((p) => `${p.name}${p.expiry_date ? ` ${tglExpiry(p.expiry_date)}` : ''}`))}`,
          `Kadaluarsa ${AMBAT_EXPIRY} hari ke depan: ${judul(dekat.map((p) => `${p.name}${p.expiry_date ? ` (${tglExpiry(p.expiry_date)})` : ''}`))} — buka halaman Produk`)
      : '',
    // SELALU dirender (hidden saat 0) — lihat catatan di notifModeRow().
    chip('#/dashboard', antre ? biru : `${biru} hidden`, 'sync', `${antre} transaksi antre offline`,
      `${antre} penjualan/topup belum terkirim ke server (dicoba ulang otomatis tiap 5 detik) — buka Dashboard untuk rincian`,
      ' data-notif-outbox'),
    getPrintPause()
      ? chip('#/settings', abu, 'pause', 'Cetak dijeda',
          'Saklar "Jeda semua cetak" aktif (Sistem → Cetak struk) — struk, label, dan kick laci TIDAK dikirim ke printer')
      : '',
  ].filter(Boolean).join('');
}

/** Gambar ulang chip notif + strip peringatan SETELAH stok berubah
 *  (dipanggil `segarkanStokPos()` pasca-bayar). `paintCart()` sengaja tidak
 *  menyentuh area scan bar (dia hanya tbody + sidebar), sementara `paint()`
 *  penuh akan membuang fokus kolom scan — jadi pembaruan kecil ini jalan
 *  sendiri di sini. Elemen belum ada (shift gate) = no-op. */
function segNotifPos(): void {
  const n = host?.querySelector('#pos-notif');
  if (n) n.innerHTML = notifChips();
  const s = host?.querySelector('#pos-strips');
  if (s) {
    const isi = stripStokMenipis() + stripKadaluarsa();
    s.innerHTML = isi;
    // Wadah kosong HARUS `hidden`: anak display:none bukan flex item, jadi
    // gap-2 induk tidak menyisakan baris kosong.
    s.className = isi ? 'flex flex-col gap-2' : 'hidden';
  }
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
 *  (kiri), pemilih PELANGGAN (tengah), TOTAL BELANJA besar (kanan). */

/** Tombol kembali ke dashboard — shell POS TANPA header (permintaan pemilik
 *  "full hapus" 2026-10-04), jadi tombolnya hidup di konten: kiri info bar,
 *  supaya kasir tidak pernah terkunci di #/pos. */
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
  // Info bar: kiri = tombol kembali + Waktu/Kasir/Shift/Tutup shift,
  // tengah = Pelanggan + F9, kanan = Total belanja. mode mobile = semua
  // cell menumpuk 1 kolom.
  const gridCls = mobileMode
    ? 'grid gap-2'
    : 'grid items-center gap-2 lg:grid-cols-3 lg:gap-4';
  const batas = mobileMode
    ? 'border-t border-gray-200 pt-2 dark:border-gray-700'
    : 'border-t border-gray-200 pt-2 dark:border-gray-700 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0';
  return `
    <div class="card info-bar !p-3">
      <!-- Tiga kolom SAMA RATA (permintaan pemilik 2026-10-04 putaran 9:
           "buat kolomnya sama rata, jangan lebar di tengah, belum sama
           rata ukuran kolomnya") — lg:grid-cols-3. Revisi pemilik
           2026-10-06: tombol Tutup shift BUKAN track ke-4 di ujung baris,
           tapi "tetap di kolom [kiri ini] … cuma rata kanan, mepet ke
           kanan" — jadi track auto dibuang, tombol disisipkan di cell kiri
           dengan ml-auto. Jangan kembalikan [auto_1fr_auto] yang memberi
           sisa lebar ke kolom tengah.
           Kolom dipisah garis vertikal — border-l hanya >=lg (layar sempit
           kolom menumpuk, garis jadi noise). Kolom kanan = label+qty di
           KIRI, angka TOTAL di KANAN. -->
      <div class="${gridCls}">
        <div class="flex items-center gap-2 whitespace-nowrap text-xs text-gray-600 dark:text-gray-300">
          ${tombolKembaliHtml()}
          <div class="flex flex-col gap-y-0.5">
            <span class="flex items-center gap-1.5">${icon('clock')}<span class="font-semibold">Waktu:</span><span id="pos-jam" class="tabular-nums">${jamPos()}</span></span>
            <span class="flex items-center gap-1.5">${icon('users')}<span class="font-semibold">Kasir:</span><span>${esc(getCashier())}</span><span class="text-gray-400">· Shift #${shift?.id}</span></span>
          </div>
          <!-- Tombol MERAH tutup shift — revisi pemilik 2026-10-06: tetap di
               kolom ini (bukan kolom terpisah seperti versi track-auto),
               "cuma rata kanan, mepet ke kanan" → ml-auto menempelkan ke
               tepi kanan cell (sebelum border-l kolom Pelanggan). Dialog =
               modul bersama shift-tutup.ts (sama persis dengan halaman
               Shift); kula-07-pos-kasir.png taruh "Tutup Sesi Kas" di
               toolbar atas. -->
          <button type="button" id="pos-shift-tutup"
            class="btn btn-ghost ml-auto !min-h-[30px] !px-2.5 !py-1 text-xs !text-red-600 !border-red-300 hover:!border-red-400 hover:!bg-red-50 dark:!border-red-500/50 dark:!text-red-400 dark:hover:!bg-red-500/10"
            title="Tutup shift kasir (hitung laci dulu)" aria-label="Tutup shift">
            ${icon('logout')}<span>Tutup shift</span>
          </button>
        </div>
        <!-- Kolom tengah = blok Pelanggan + tombol cari F9. -->
        <div class="min-w-0 ${batas}">
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
        <div class="flex items-center justify-between gap-3 ${batas}">
          <div class="min-w-0 text-left">
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Total belanja</div>
            <div id="pos-owncount" class="text-xs text-gray-500 dark:text-gray-400">${keranjangTerisi() ? `${cart.length + cartTopup.length} item (${count()} Qty)` : '0 item'}</div>
          </div>
          <!-- text-[48px] ukuran KUSTOM (Tailwind arbitrary value) = 2x lipat
               text-2xl lama (24px) — permintaan pemilik 2026-10-04 "custom
               ukuran font, besarkan lagi 2x lipat". Total belanja = angka
               terpenting di layar kasir. -->
           <div id="pos-grand" class="shrink-0 text-right text-[48px] font-bold leading-tight tabular-nums text-primary">${rp(totalBayar())}</div>
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
                     title="Scan barcode, ketik nama/SKU, atau Qty*Kode (mis. 3*aqua). Fokus balik ke sini: F1 atau Esc" />
            </div>
            <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">${kbd('F1')}</span>
            <div id="pos-results" class="suggest hidden" role="listbox" aria-label="Hasil pencarian produk"></div>
          </div>
          <button type="button" id="pos-cari" class="btn btn-ghost" title="Cari produk penuh">${icon('search')}<span>Cari</span>${kbd('F3')}</button>
          <!-- Ukuran DISAMAKAN dengan tombol Cari/F3 di sebelahnya (permintaan
               pemilik 2026-10-04) — dulu kelas chip jadi lebih pendek/menempel. -->
          <button type="button" id="pos-qty" class="btn btn-ghost${qtyNext > 1 ? ' !border-primary !text-primary' : ''}" title="Qty untuk item BERIKUTNYA, dipakai sekali lalu kembali ke 1">Qty ${qtyNext}${kbd('F4')}</button>
          <!-- Tombol pindah LAYOUT MOBILE (Tahap 5, 2026-10-06 — keputusan
               pemilik: "tambahkan layout untuk berpindah ke mode mobile saja";
               posisi = KANAN chip Qty sesuai permintaan). Toggle mobileMode +
               persist ravaa.mobile-layout; listener di paint() (universal,
               seperti #pos-autoprint). -->
          <button type="button" id="pos-mobile" class="btn btn-ghost${mobileMode ? ' !border-primary !text-primary' : ''}" title="Pindah layout mobile / desktop (preview tampilan HP)" aria-pressed="${mobileMode}">${icon('smartphone')}<span>Mobile</span></button>
          ${products.length ? '' : `<a href="#/products" class="chip !border-amber-500 !text-amber-600 dark:!text-amber-400">${icon('alert')}<span>Cache produk kosong — sinkron dulu di Manage</span></a>`}
        </div>
        <!-- Baris saklar cetak + notif stok/kadaluarsa (pemilik 2026-10-07).
             Pilihan mode Penjualan/Topup/Tarik DIHAPUS 2026-10-08 — semua
             layanan masuk keranjang lewat tombol Topup/Tarik di Aksi cepat
             (dialog), jadi tidak ada mode untuk dipilih. -->
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
          <span class="rounded border border-gray-200 px-2 py-1 dark:border-gray-700">
            ${switchHtml('pos-autoprint', autoPrint, 'Cetak struk otomatis')}
          </span>
          ${notifModeRow()}
        </div>
      </div>`;
  // Layout 2 kolom: info bar tetap penuh di atas; di bawahnya grid
  // [kiri 1fr | sidebar 320px]. Kolom KIRI = scan bar + strip + keranjang,
  // kolom KANAN = sidebar bayar setinggi penuh.
  const isiKiri = cartKiriHtml();
  // Wadah beraid `#pos-strips` supaya `segNotifPos()` bisa menyegarkan strip
  // menipis/kadaluarsa tanpa `paint()` penuh. Wadah kosong = `hidden`.
  const strips = stripStokMenipis() + stripKadaluarsa();
  return `
  <div class="flex h-full min-h-0 flex-col gap-2">
    ${infoBarHtml()}
    <div class="${gridUtamaCls()}">
      <div class="flex min-h-0 flex-col gap-2">
        ${scanBar}
        <div id="pos-strips" class="${strips ? 'flex flex-col gap-2' : 'hidden'}">${strips}</div>
        ${isiKiri}
      </div>
      ${sidebarBayarHtml()}
    </div>
  </div>`;
}

/** Kartu KIRI: label baris (Keranjang/Bersihkan) + tabel keranjang.
 *  Panel bayar TERPISAH di sidebarBayarHtml(). */
function cartKiriHtml(): string {
  return `
      <div class="card-flush flex min-h-0 flex-1 flex-col overflow-hidden">
        <!-- Label keranjang di ATAS tabel (referensi KulaPOS: "Keranjang 2 item
             ... Bersihkan [F5]" kanan-atas). -->
        <div class="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span id="pos-count">${keranjangTerisi() ? `${count()} item` : 'Keranjang kosong'}</span>
          <button type="button" id="pos-clear" class="btn btn-ghost text-red-600 !min-h-[30px] !px-2.5 !py-1 text-xs" title="Kosongkan keranjang" aria-label="Kosongkan keranjang"${keranjangTerisi() ? '' : ' disabled'}>${icon('trash')}<span class="hidden sm:inline">Bersihkan</span>${kbd('F5')}</button>
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
                <th class="th th-sticky text-center w-8">No</th>
                <th class="th th-sticky w-20">Kode</th>
                <th class="th th-sticky w-auto">Nama barang</th>
                <th class="th th-sticky text-right w-16">Harga</th>
                <th class="th th-sticky text-center w-36">Qty</th>
                <th class="th th-sticky text-right w-16">Diskon</th>
                <th class="th th-sticky text-right w-16">Subtotal</th>
                <th class="th th-sticky text-right w-10">Aksi</th>
              </tr>
            </thead>
            <tbody id="pos-rows">${cartRows()}</tbody>
          </table>
        </div>
      </div>`;
}

/** Panel bayar SIDEBAR KANAN 320px. Riwayat layout: sidebar = keputusan pemilik
 *  2026-10-04 (footer horizontal KulaPOS ditolak); isian pembayaran pindah
 *  ke MODAL (bukaBayar()/formBayarHtml), `#pos-pay-pas` menempel di bawah
 *  `#pos-bayar`; baris "Grand total" dihapus (duplikat info bar). Isi =
 *  Aksi cepat (Tahan/Pending P5, Item manual, Diskon, Riwayat, Cetak ulang)
 *  -> Menu cepat -> Diskon item -> Diskon transaksi F6 -> DUA tombol bayar.
 *  Kondisi tombol: Bayar/Bayar pas = bisaBayar() (keranjang terisi). */
function sidebarBayarHtml(): string {
  const bayarMati = !bisaBayar() || busy;
  return `
      <div class="card flex min-h-0 flex-col gap-2.5 overflow-y-auto !p-3">
        <!-- 1. Aksi cepat (permintaan pemilik 2026-10-04) — kini di POSISI
             ATAS kartu (permintaan pemilik 2026-10-06: "diskon item pindah
             ke bawah menu cepat di atas diskon"). Tahan/Pending = fitur
             NYATA (IndexedDB per device, lihat tahanKeranjang/bukaTertahan);
             Item manual & Diskon memanggil aksi yang sudah ada; **Riwayat**
             = anchor hash ke #/history, MENGGANTIKAN slot Voucher (keputusan
             pemilik 2026-10-06 "tombol bisa di ubah ke history transaksi" —
             voucher & PPN ditutup permanen); **Cetak ulang** = nota TERAKHIR
             device ini (keputusan pemilik 2026-10-06 — id nota sukses disimpan
             di localStorage lalu dilewatkan ke cetakUlang() jalur Riwayat;
             dialog [Thermal][A4][Batal]). Pending kini ber-pintasan **F8**
             (keputusan 2026-10-06 — F8 dulu alias fokus scan, kini F1
             saja yang ke scan). -->
        <div>
          <span class="label">Aksi cepat</span>
          <div class="grid grid-cols-2 gap-2.5">
            <button type="button" id="pos-hold" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Bekukan keranjang, lanjutkan nanti lewat Pending (pintasan F7)"${keranjangTerisi() && !busy ? '' : ' disabled'}>${icon('pause')}<span>Tahan</span>${kbd('F7')}</button>
            <button type="button" id="pos-hold-open" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Buka daftar transaksi tertahan (pintasan F8)"${holds.length ? '' : ' disabled'}>${icon('clock')}<span>Pending (<span id="pos-hold-count">${holds.length}</span>)</span>${kbd('F8')}</button>
            <button type="button" id="pos-qa-manual" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm">${icon('pencil')}<span>Item manual</span></button>
            <!-- Tambah LAYANAN ke keranjang (Opsi B hybrid, 2026-10-07;
                 direvisi 2026-10-08: topup DAN tarik tunai): baris layanan +
                 produk dibayar SEKALI, catatan terpisah di /api/topups
                 (nominal = mutasi modal, BUKAN omzet — AGENTS §1; nominal
                 tarik = uang keluar). -->
            <button type="button" id="pos-qa-topup" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Tambah baris topup (pulsa/e-wallet/PLN) atau tarik tunai ke keranjang — dibayar bersama belanja">${icon('wallet')}<span>Topup/Tarik</span></button>
            <button type="button" id="pos-qa-disc" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm">Diskon${kbd('F6')}</button>
            <a href="#/history" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Riwayat transaksi — linimasa penjualan & topup/tarik per hari">${icon('receipt')}<span>Riwayat</span></a>
            <button type="button" id="pos-reprint" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Cetak ulang nota terakhir dari device ini" ${bacaNotaTerakhir() ? '' : 'disabled '}>${icon('print')}<span>Cetak ulang</span></button>
          </div>
        </div>
        <div class="border-t border-gray-100 dark:border-gray-700" role="separator"></div>
        <!-- 2. Menu cepat (permintaan pemilik 2026-10-06: "tambahkan tombol
             cepat ke produk dan stok juga") — anchor hash biasa, pola sama
             dengan strip-low stok yang sudah ada (shell.ts parseRoute). -->
        <div>
          <span class="label">Menu cepat</span>
          <div class="grid grid-cols-2 gap-2.5">
            <a href="#/products" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Buka halaman Produk">${icon('products')}<span>Produk</span></a>
            <a href="#/stock" class="btn btn-ghost !min-h-[32px] !px-2 !py-2.5 text-sm" title="Buka halaman Stok">${icon('stock')}<span>Stok</span></a>
          </div>
        </div>
        <div class="border-t border-gray-100 dark:border-gray-700" role="separator"></div>
        <!-- 3. Diskon item — DIPINDAH dari paling atas ke sini (permintaan
             pemilik 2026-10-06, lihat catatan Aksi cepat di atas): persis
             DI ATAS input diskon transaksi. Tetap tersembunyi bila 0. Dua
             baris lama sudah DIHAPUS: "Grand total" (2026-10-04 — duplikat
             TOTAL BELANJA di info bar) dan "Subtotal" (putaran 7 — satu
             angka satu tempat). -->
        <div class="space-y-1">
          <div class="flex items-baseline justify-between" id="pos-disc-item-row" ${diskonBaris() ? '' : 'hidden'}>
            <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Diskon item</span>
            <span id="pos-disc-item" class="text-sm font-semibold text-red-600 dark:text-red-400">-${rp(diskonBaris())}</span>
          </div>
        </div>
        <!-- 4. Diskon transaksi (alokasi F6). kelas space-y-1.5 = jarak baris
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
          <button type="button" id="pos-bayar" class="btn btn-primary w-full !py-3.5 text-sm"${bayarMati ? ' disabled' : ''}>${icon('check')}<span>Bayar</span>${kbd('F10')}</button>
          <!-- Revisi putaran 8b/8c (2026-10-04): outline sempat dipakai lalu
               diminta pemilik "style hilang yang tombol warna hijaunya" —
               class btn-outline MEMANG tidak ada di styles.css (no-op, jadi
               warnanya hilang). Gaya final: GRADASI hijau + shadow; hover
               hijau LEBIH GELAP (8c: "hover tombol F12 juga ubah ke hijau
               jangan biru, karena tombolnya warna hijau" — versi hover biru
               sempat dipakai 8b lalu dibatalkan). -->
          <button type="button" id="pos-pay-pas" class="btn w-full !py-4 text-base font-semibold text-white bg-linear-to-r from-emerald-500 to-emerald-600 shadow-md shadow-emerald-600/40 hover:from-emerald-600 hover:to-emerald-700 hover:shadow-lg hover:shadow-emerald-700/50 transition-all"${bayarMati ? ' disabled' : ''} title="Uang diterima = total, langsung bayar tanpa buka form (F12)">Bayar pas${kbd('F12')}</button>
          <p class="text-center text-xs text-gray-500 dark:text-gray-400">${kbd('F10')} form bayar · ${kbd('F12')} bayar pas</p>
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

/** Judul modal (`Bayar — Rp…`) ikut total tagihan TERKINI — dipanggil
 *  paintCart() — satu-satunya repaint (mode tunggal sejak Topup/Tarik
 *  dihapus 2026-10-08). */
function segarJudulBayar(): void {
  if (!formBayarTerbuka()) return;
  const judul = bayarApi!.el.querySelector('.modal-header h3');
  if (judul) judul.textContent = `Bayar — ${rp(totalBayar())}`;
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
  // Total tagihan & kembalian = keranjang + baris layanan (lihat
  // totalBayar()). Blok Pelanggan dan petunjuk HUTANG selalu tampil —
  // mode lain sudah dihapus, jadi tidak ada cabang lagi.
  const tot = totalBayar();
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
              cashIn > 0 && cashIn < tot ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
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
  // Refactor 1 layout (2026-10-07): modal bayar DIPAKAI KETIGA MODE —
  // topup/tarik kini lewat form ini juga (dulu punya kolom uang & tombol
  // Proses sendiri di panel kanan). Guard = shift + tidak sedang proses;
  // syarat isi transaksi = bisaBayar() (keranjang / nominal terisi).
  if (!shift || busy) return;
  if (formBayarTerbuka()) {
    bayarApi!.el.querySelector<HTMLInputElement>('#pos-cash')?.focus();
    return;
  }
  if (!bisaBayar()) return;
  // Putaran 10d (2026-10-05, "form uang diterima jangan langsung di isi uang
  // pas … jadi default 0"): auto-isi (P1) DIHAPUS — kolom SELALU dibuka
  // kosong, karena tujuannya memasukkan uang KURANG / LEBIH sesungguhnya.
  // Fokus `#pos-cash` saat buka TIDAK berubah (pemilik: "auto focus sudah
  // OK"); "uang pas" hanya lewat F12 `#pos-pay-pas`.
  cashIn = 0;
  cashTouched = false;
  bayarApi = openModal({
    title: `Bayar — ${rp(totalBayar())}`,
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
    // Kasir menyentuh kolom -> tandai `cashTouched` (sinkronisasi
    // paintCart berhenti menulis ulang isian).
    cashTouched = true;
    cashIn = Number((e.target as HTMLInputElement).value || 0);
    paintCart();
  });

  // Nominal cepat (4 pecahan; putaran 10c: tanpa chip "Uang pas" — sudah ada
  // F12 Bayar pas di side panel): satu klik mengisi kolom uang
  // diterima + kembalian, menghindari salah ketik nol saat kas menerima
  // pecahan besar. paintCart tidak merender ulang form, jadi input &
  // state aktif chip dijaga manual di sana. Fokus DIPERBALIKAN ke kolom uang
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

/** Layanan topup. Tidak ada pilih provider (DANA/OVO/…): kasir mau
 *  sedikit klik, jadi yang dipilih cuma jenis layanannya. Nilai `provider` yang
 *  dikirim ke API adalah kode jenis ini — kolomnya jadi label jenis layanan. */
/** Form per jenis (revisi pemilik 2026-10-06):
 *  - e-wallet/pulsa: *"untuk pencatatan saja tidak perlu nomor HP"* → cukup
 *    Nominal + Admin (`butuhNomor:false` = input nomor TIDAK dirender).
 *  - tarik tunai: *"hanya nominal saja dan admin"* → kedua jenis tarik tanpa
 *    nomor HP/rekening.
 *  - pln-token: No meter tetap + **Nomor Token baru** (`butuhToken`) — ikut
 *    dicetak di struk belanja.
 *  - pln-bill (tagihan): ID pelanggan/Nomor meter + nominal + admin (sudah
 *    sesuai — tidak diubah). */
const TOPUP_JENIS: Jenis[] = [
  { key: 'e-wallet', label: 'E-wallet', ringkas: 'E-wallet', hint: 'Isi saldo DANA/OVO/GoPay', nomorLabel: 'Nomor HP tujuan', nomorPh: '08xxxxxxxxxx', butuhNomor: false },
  { key: 'pulsa', label: 'Pulsa', ringkas: 'Pulsa', hint: 'Paket data & nelpon', nomorLabel: 'Nomor HP tujuan', nomorPh: '08xxxxxxxxxx', butuhNomor: false },
  { key: 'pln-token', label: 'Token PLN', ringkas: 'Token PLN', hint: 'Beli token listrik', nomorLabel: 'Nomor meter', nomorPh: 'Nomor meter', butuhToken: true },
  { key: 'pln-bill', label: 'Tagihan PLN', ringkas: 'Tagihan PLN', hint: 'Bayar listrik', nomorLabel: 'ID pelanggan / meter', nomorPh: 'ID pelanggan' },
];

/** Tarik tunai: uang keluar dari laci. Sumber dana bisa e-wallet (cash out) atau
 *  transfer rekening — bukan cuma bank. Keduanya tanpa nomor (pemilik: tarik
 *  tunai hanya nominal + admin). */
const TARIK_JENIS: Jenis[] = [
  { key: 'tarik-ewallet', label: 'Dari e-wallet', ringkas: 'e-wallet', hint: 'Cash out ke tunai', nomorLabel: 'Nomor HP pemilik e-wallet', nomorPh: '08xxxxxxxxxx', butuhNomor: false },
  { key: 'tarik-bank', label: 'Dari rekening', ringkas: 'rekening', hint: 'Tarik ke tunai', nomorLabel: 'Nomor rekening', nomorPh: 'Nomor rekening', butuhNomor: false },
];

/** `label` = judul di tile (cth. "Dari rekening"),
 *  `ringkas` = satu kata untuk toast/struk. */
interface Jenis {
  key: TopupJenis;
  label: string;
  ringkas: string;
  hint: string;
  nomorLabel: string;
  nomorPh: string;
  /** `false` = form TANPA input nomor (default: `true` = wajib diisi). */
  butuhNomor?: boolean;
  /** `true` = tampilkan input Nomor Token (PLN token) — ikut dicetak struk. */
  butuhToken?: boolean;
}

/** Label jenis topup untuk tampilan/struk: ambil dari TOPUP_JENIS (satu
 *  sumber) — key tak dikenal (data lama) jatuh ke fallback, jangan melempar. */
function jenisTopupLokal(key: TopupJenis | string): Pick<Jenis, 'label' | 'ringkas' | 'nomorLabel'> {
  return TOPUP_JENIS.find((j) => j.key === key)
    ?? TARIK_JENIS.find((j) => j.key === key)
    ?? { label: 'Topup', ringkas: 'Topup', nomorLabel: 'Nomor' };
}

/** Baris rincian struk untuk SATU baris layanan keranjang (Opsi B hybrid):
 *  nominal & admin SELALU dua baris terpisah (aturan domain — nominal =
 *  mutasi modal, admin = pendapatan jasa; jangan disatukan), nomor & token
 *  menyusul bila terisi. Baris tarik berlabel `Tarik` (uang keluar).
 *  Dipakai struk penjualan gabungan DAN struk layanan-saja (keranjang tanpa
 *  baris produk). */
function barisStrukTopup(t: TopupLine): StrukBaris[] {
  const j = jenisTopupLokal(t.jenis);
  const awal = isTarik(t) ? 'Tarik' : 'Topup';
  return [
    { kiri: `${awal} ${j.ringkas}`, kanan: rp(t.nominal) },
    ...(t.admin > 0 ? [{ kiri: 'Biaya admin', kanan: rp(t.admin) }] : []),
    ...(t.nomor ? [{ kiri: j.nomorLabel, kanan: t.nomor }] : []),
    ...(t.token ? [{ kiri: 'Token', kanan: t.token }] : []),
  ];
}

/** Satu baris layanan (topup/tarik) di tabel keranjang (Opsi B): colspan=8
 *  penuh — layanan bukan baris belanja (tanpa qty/diskon/harga per unit),
 *  jadi kolom No/Kode/dst. tidak berlaku. Angka kanan = kontribusi baris ke
 *  TOTAL BELANJA (topup: nominal+admin; tarik: admin saja — nominalnya uang
 *  keluar yang diserahkan tunai, bukan tagihan). */
function topupRowHtml(l: TopupLine): string {
  const j = jenisTopupLokal(l.jenis);
  const keluar = isTarik(l);
  const detail = [
    l.nomor ? esc(l.nomor) : '',
    l.token ? `token ${esc(l.token)}` : '',
  ].filter(Boolean).join(' · ');
  const badge = keluar
    ? '<span class="mr-1.5 rounded bg-amber-50 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">Tarik</span>'
    : '<span class="mr-1.5 rounded bg-emerald-50 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">Topup</span>';
  return `<tr data-key="${l.key}" class="topup-row hover:bg-primary-soft dark:hover:bg-primary/15 transition-colors">
      <td class="td" colspan="8">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="cell-strong">${badge}${esc(j.label)} ${rp(l.nominal)}${detail ? ` <span class="cell-sub">${detail}</span>` : ''}</div>
            <div class="cell-sub">admin ${rp(l.admin)} — ${keluar ? 'uang keluar diserahkan tunai' : 'topup, bukan stok'} (dibayar bersama nota ini)</div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="font-semibold tabular-nums text-gray-900 dark:text-white">${rp(keluar ? l.admin : l.nominal + l.admin)}</span>
            <button type="button" class="row-btn row-btn-danger" data-act="topup-del" data-key="${l.key}" title="Hapus baris ${keluar ? 'tarik' : 'topup'}" aria-label="Hapus baris ${keluar ? 'tarik' : 'topup'} ${esc(j.label)}">${icon('trash')}</button>
          </div>
        </div>
      </td>
    </tr>`;
}

function cartRows(): string {
  const rowsProduk = cart
    .map((l, i) => {
      const gross = jumlahBaris(l);
      const net = gross - l.discount;
      // Baris catatan (produk use_note=1): input satu baris DI BAWAH baris
      // produk, mis. Cetak Banner -> "ukuran 1 x 3 meter". colspan=3 = hanya
      // selebar kolom **No..Nama barang** (permintaan pemilik 2026-10-06:
      // "input untuk catatan ini misal di kurangi panjangnya selebar No -
      // Nama Barang saja" — dulu colspan=8 membentang penuh No..Aksi).
      // td TANPA class `.td` — padding kiri/kanan
      // (12px) datang dari `.table-compact td` (table-compact di cartKiriHtml);
      // tanpa itu preflight membuatnya 0px dan input menempel tepi.
      // Disimpan live lewat event `input` (tanpa paintCart, supaya fokus tidak
      // pindah saat kasir mengetik).
      const trCatatan = l.useNote ? `
      <tr data-key="${l.key}" class="note-row">
        <td colspan="3">
          <input class="input input-sm w-full" type="text" maxlength="200"
            data-act="note" data-key="${l.key}" value="${esc(l.note)}"
            placeholder="Catatan (mis. ukuran 1 x 3 meter)"
            aria-label="Catatan ${esc(l.name)}" />
        </td>
      </tr>` : '';
      // SELECT SATUAN per baris (Tahap 3, 2026-10-06 — keputusan FINAL pemilik
      // (a): dropdown satuan PER BARIS). Hanya untuk produk yang PUNYA satuan
      // alternatif (units[] tidak kosong) — tanpa alternatif memang tidak ada
      // yang bisa dipilih, teks lama "jual per X" tetap untuk kasus luar.
      // Ganti satuan → gantiSatuan(): qty ANGKA SAMA pindah satuan, diskon
      // baris di-reset, harga ulang dari product_units.
      const pAlt = l.product_id !== null ? products.find((x) => x.id === l.product_id) : undefined;
      const unitUi = pAlt && (pAlt.units?.length ?? 0) > 0
        ? `<select class="input input-sm !w-auto" data-act="unit" data-key="${l.key}"
             aria-label="Satuan ${esc(l.name)}"
             title="Ganti satuan jual — qty tetap, diskon baris di-reset">
            ${daftarSatuan(pAlt)
              .map((o) => `<option value="${esc(o.unit)}"${o.unit === l.unit ? ' selected' : ''}>${esc(o.unit)}${o.factor !== 1 ? ` ×${o.factor}` : ''}</option>`)
              .join('')}
          </select>`
        : l.unit && l.baseUnit && l.unit !== l.baseUnit ? ` · jual per ${l.unit}` : '';
      return `<tr data-key="${l.key}" class="hover:bg-primary-soft dark:hover:bg-primary/15 transition-colors">
      <td class="td td-num text-center text-gray-500">${i + 1}</td>
      <td class="td font-mono text-xs">${l.sku ? esc(l.sku) : '<span class="text-gray-400">—</span>'}</td>
      <td class="td">
        <div class="cell-strong">${esc(l.name)}</div>
        <div class="cell-sub">${l.product_id === null ? 'item manual' : l.track_stock ? '' : 'jasa'}${expBarisKeranjang(l.product_id)}</div>
        ${unitUi ? `<div class="mt-0.5 flex items-center gap-1">${unitUi}</div>` : ''}
      </td>
      <td class="td td-num">${l.dyn
        ? `<input class="input input-sm !w-24 !px-2 text-right" data-act="price" data-key="${l.key}" type="number"
             inputmode="numeric" min="0" step="500" value="${l.price}"
             aria-label="Harga ${esc(l.name)}" title="Harga jual (Rp) — boleh diubah (produk harga khusus)" />`
        : rp(l.price)}</td>
      <td class="td">
        <div class="flex items-center justify-center gap-1">
          <button type="button" class="row-btn" data-act="dec" data-key="${l.key}" title="Kurangi" aria-label="Kurangi qty">${icon('minus')}</button>
          <input class="input input-sm !w-20 !px-2 text-center font-semibold" data-act="qty" data-key="${l.key}" type="number" inputmode="numeric" min="0" value="${l.qty}" aria-label="Qty ${l.name}" />
          <button type="button" class="row-btn" data-act="inc" data-key="${l.key}" title="Tambah" aria-label="Tambah qty">${icon('plus')}</button>
        </div>
      </td>
      <td class="td td-num">
        <input class="input input-sm !w-24 !px-2 text-right" data-act="disc" data-key="${l.key}" type="number" inputmode="numeric"
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
  // Baris TOPUP (Opsi B hybrid) disusun SETELAH baris produk. colspan=8:
  // topup bukan baris belanja (tanpa qty/diskon) — diuji dari tagihan,
  // bukan dari kolom tabel.
  const rowsTopup = cartTopup.map(topupRowHtml).join('');
  if (!rowsProduk && !rowsTopup) {
    return `<tr><td colspan="8"><div class="empty">Scan barcode atau ketik nama produk, lalu tekan Enter — atau tombol Topup/Tarik untuk layanan pulsa, e-wallet, atau tarik tunai.</div></td></tr>`;
  }
  return rowsProduk + rowsTopup;
}

/* ---------- render ---------- */

/** Produk kategori `topup` (Topup & Tarik Tunai) = PINTASAN ke dialog
 *  layanan (bukan mode terpisah — mode Topup/Tarik dihapus 2026-10-08,
 *  semua lewat keranjang). Jenis dialog disarankan dari nama/SKU. */
const KATEGORI_LAYANAN = 'topup';

function isLayanan(p: Product): boolean {
  return p.category_slug === KATEGORI_LAYANAN;
}

/** Buka dialog layanan dari produk katalog (jenis disarankan dari nama/SKU —
 *  produk "tarik ..." membuka dialog dengan jenis tarik terpilih). */
function bukaModeLayanan(p: Product): void {
  openDialogTopupKeranjang(/tarik/i.test(p.name) || /tarik/i.test(p.sku) ? 'tarik-ewallet' : 'e-wallet');
  toast(`${p.name} — pilih jenis & isi nominal di dialog`, 'info');
}

function paint(): void {
  // `host` bisa sudah lepas dari DOM: mountPosPage async (syncMaster, loadShift)
  // masih jalan lalu kasir pindah halaman. Tanpa guard ini, POS menimpa halaman
  // lain yang baru dirender router.
  if (!host || !host.isConnected) return;
  host.innerHTML = shift ? cartHtml() : shiftGateHtml();
  // Saklar "Cetak struk otomatis" ikut diganti tiap paint() (host.innerHTML),
  // jadi listenernya WAJIB dipasang di sini — bukan di bindCart().
  host.querySelector('#pos-autoprint')?.addEventListener('change', (e) => {
    autoPrint = (e.target as HTMLInputElement).checked;
    setAutoPrint(autoPrint);
  });
  // Listener info bar & toggle layout mobile dipasang DI SINI (bukan di
  // bindCart) — sama alasan dengan #pos-autoprint di atas.
  host.querySelector('#pos-shift-tutup')?.addEventListener('click', () => void tutupShiftDariPos());
  host.querySelector('#pos-cust-cari')?.addEventListener('click', openCariPelanggan);
  // Pilih pelanggan di info bar — listener di paint() (UNIVERSAL, dulu di
  // bindCart saat info bar belum ada di semua tempat). Hanya menyimpan state
  // — id dikirim server saat pay() (snapshot sales.customer_name).
  host.querySelector('#pos-customer')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    customerId = v ? Number(v) : null;
    simpanKeranjang(); // ganti pelanggan tanpa repaint — tulis eksplisit
  });
  host.querySelector('#pos-mobile')?.addEventListener('click', () => {
    mobileMode = !mobileMode;
    try {
      localStorage.setItem('ravaa.mobile-layout', mobileMode ? '1' : '0');
    } catch { /* private mode: pref sesi ini saja */ }
    toast(mobileMode ? 'Layout MOBILE — kolom menumpuk, panel bayar di bawah' : 'Layout desktop — sidebar kanan 320px', 'info');
    paint();
  });
  if (!shift) {
    bindShiftGate();
    return;
  }
  bindCart();
  host.querySelector<HTMLInputElement>('#pos-q')?.focus();
}

function paintCart(): void {
  if (!host || !shift) return;
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
  // Layanan-saja (tanpa baris produk): Qty tetap 0 — tampilkan jumlah baris
  // layanan supaya label tidak berbohong "0 item" padahal keranjang berisi.
  const nQty = count();
  set('#pos-count', keranjangTerisi() ? (nQty > 0 ? `${nQty} item` : `${cartTopup.length} layanan`) : 'Keranjang kosong');
  // `#pos-subtotal` TIDAK diisi lagi — baris Subtotal sidebar dihapus putaran 7
  // 2026-04; subtotal terbaca dari TOTAL BELANJA (#pos-grand) di info bar.
  // Info bar (ala KulaPOS): TOTAL BELANJA besar + jumlah baris/Qty ikut
  // berubah tiap keranjang berubah — elemennya di luar area repaint tbody,
  // jadi disetel eksplisit di sini. Baris "Grand total" di sidebar sudah
  // DIHAPUS (duplikatnya; permintaan pemilik 2026-10-04) — #pos-grand
  // = SATU-SATUNYA angka total besar. TOTAL = keranjang + baris topup
  // (Opsi B — `totalBayar()`).
  set('#pos-grand', rp(totalBayar()));
  set('#pos-owncount', keranjangTerisi() ? `${cart.length + cartTopup.length} item (${count()} Qty)` : '0 item');
  // Placeholder "Uang diterima" menampilkan amount due (pola Aronium) — form
  // bayar tidak dirender ulang di paintCart, jadi placeholder harus diikut-
  // setiap total berubah (render awal selalu 0 karena keranjang masih kosong).
  const cashEl = document.querySelector<HTMLInputElement>('#pos-cash');
  if (cashEl) {
    cashEl.placeholder = String(totalBayar());
    // `cashIn` = sumber kebenaran; tulis ke input hanya kalau kasir belum
    // menyentuh kolom (mis. ganti metode me-reset `cashIn=0` lewat handler
    // data-pay). `.value =` TIDAK memicu event `input`, jadi `cashTouched`
    // tidak ikut berubah.
    if (!cashTouched) cashEl.value = cashIn ? String(cashIn) : '';
  }
  // Angka "Total tagihan" di kepala form bayar ikut total terkini.
  set('#bayar-total', rp(totalBayar()));
  segarJudulBayar();
  set('#pos-change', rp(change()));
  // P2: teks konteks di bawah angka KEMBALIAN ("Kurang Rp…" / "Uang pas. …").
  const ctx = document.querySelector('#pos-change-ctx');
  if (ctx) {
    const t = teksKembalian();
    const pendek = cashIn > 0 && cashIn < totalBayar();
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
  if (pay) pay.disabled = !keranjangTerisi() || busy;
  // Bayar pas ikut mati saat keranjang kosong / sedang proses (disable-nya
  // diperbarui bersama #pos-pay; keduanya kini di dalam form bayar).
  const payPas = document.querySelector<HTMLButtonElement>('#pos-pay-pas');
  if (payPas) payPas.disabled = !keranjangTerisi() || busy;
  // Tombol Bayar di sidebar = pembuka form bayar; mati saat keranjang kosong
  // atau sedang proses (sama aturan dengan #pos-pay dulu).
  const bayar = host!.querySelector<HTMLButtonElement>('#pos-bayar');
  if (bayar) bayar.disabled = !keranjangTerisi() || busy;
  const clr = host!.querySelector<HTMLButtonElement>('#pos-clear');
  if (clr) clr.disabled = !keranjangTerisi();
  // Aksi cepat (sidebar): Tahan mati saat keranjang kosong/sedang proses,
  // Pending mati saat tak ada yang tertahan; badge angkanya ikut jumlah holds
  // (dirender ulang hanya lewat paintCart — tombol panel tidak di-repaint penuh).
  const holdBtn = host!.querySelector<HTMLButtonElement>('#pos-hold');
  if (holdBtn) holdBtn.disabled = !keranjangTerisi() || busy;
  const holdOpen = host!.querySelector<HTMLButtonElement>('#pos-hold-open');
  if (holdOpen) holdOpen.disabled = holds.length === 0;
  set('#pos-hold-count', String(holds.length));
  // Cetak ulang: mati sampai device ini punya nota sukses (pola Pending —
  // tidak ada yang bisa dicetak = klik hanya membingungkan).
  const reprint = host!.querySelector<HTMLButtonElement>('#pos-reprint');
  if (reprint) reprint.disabled = !bacaNotaTerakhir();
  // Chip nominal cepat: sorot yang cocok dengan cashIn (putaran 10c: tanpa
  // cabang "Uang pas" — chip itu sudah dihapus, tersisa 4 pecahan angka).
  document.querySelectorAll<HTMLElement>('[data-cash]').forEach((b) => {
    const nilai = Number(b.dataset.cash ?? 0);
    const aktif = cashIn > 0 && cashIn === nilai;
    b.classList.toggle('!border-primary', aktif);
    b.classList.toggle('!text-primary', aktif);
  });
}

/** Repaint panel (satu-satunya mode sejak Topup/Tarik dihapus 2026-10-08).
 *  Dipanggil dari jalur yang–dulu–bisa berjalan di semua mode (finally bayar,
 *  bersihkan keranjang, muat hold). */
function paintAktif(): void {
  paintCart();
}

/* ---------- aksi keranjang ---------- */

/** Kosongkan keranjang + diskon (tombol hapus & pintasan F5 — P3).
 *  Dulu hanya tombol yang memanggil blok ini, dan kolom "Diskon transaksi"
 *  tidak ikut dikosongkan: state `discount` kembali 0 tapi angka di input
 *  masih tertinggal (setelah pembayaran kolom itu memang dibersihkan manual —
 *  lihat pemanggilan di `pay()`). Sekarang SATU fungsi untuk keduanya. */
function bersihkanKeranjang(): void {
  if (!keranjangTerisi()) return;
  cart = [];
  cartTopup = []; // baris topup ikut dibersihkan (F5/Bersihkan = seluruh nota)
  discount = 0;
  cashIn = 0;
  cashTouched = false;
  simpanKeranjang(); // "Bersihkan" ikut menulis localStorage — reload tidak boleh memulihkan baris yang sudah dibersihkan
  paintAktif();
  const disc = host?.querySelector<HTMLInputElement>('#pos-discount');
  if (disc) disc.value = '';
  host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
}

/* ---------- keranjang persisten (putaran 16, 2026-10-06) ---------- */

/** Snapshot keranjang untuk localStorage `ravaa.keranjang` (per device, tulis sinkron —
 *  tanpa endpoint API). Permintaan pemilik 2026-10-06: "produk yang berada di
 *  keranjang jika kasir pindah ke halaman dashboard atau tidak sengaja
 *  terrefresh barang tidak hilang/keranjang tidak kosong". Yang ikut
 *  dipersist hanya isi transaksi (baris + diskon + pelanggan); uang diterima
 *  TIDAK — kepemilikan uang berlaku per pembayaran, bukan
 *  per sesi. */
type SimpananKeranjang = {
  items: CartLine[];
  discount: number;
  customerId: number | null;
  /** Baris topup keranjang (Opsi B) — OPSIONAL: snapshot lama (sebelum fitur
   *  2026-10-07) tidak memuatnya, jadi pembaca wajib `?? []`. */
  topups?: TopupLine[];
};

/** Tulis snapshot keranjang ke localStorage `ravaa.keranjang`. SINKRON —
 *  store.saveKeranjang memakai localStorage.setItem, jadi tidak ada antrean
 *  yang bisa tertinggal saat kasir refresh tepat setelah mutasi (liputan
 *  kasus "refresh tak sengaja" yang memang jadi tujuan fitur ini; tulisan
 *  IndexedDB pernah terbukti terbuang oleh reload kilat — lihat catatan di
 *  store.ts). Gagal menyimpan TIDAK membuang keranjang dari memori (pola
 *  `simpanTertahan`): hanya dilaporkan SEKALI supaya localStorage yang
 *  penuh/ditolak tidak membanjiri toast tiap ketikan. */
let keranjangGagalLapor = false;
function simpanKeranjang(): void {
  try {
    saveKeranjang({
      items: cart.map((l) => ({ ...l })),
      discount,
      customerId,
      // Baris topup (Opsi B) ikut snapshot — tanpa ini refresh/pindah halaman
      // membuang baris topup sementara baris produk selamat (pincang).
      topups: cartTopup.map((l) => ({ ...l })),
    } satisfies SimpananKeranjang);
  } catch {
    if (!keranjangGagalLapor) {
      keranjangGagalLapor = true;
      toast('Gagal menyimpan keranjang — isi bisa hilang saat refresh', 'error');
    }
  }
}

/** Pulihkan isi localStorage `ravaa.keranjang` ke state POS saat mount
 *  (reload / perangkat baru). PANGGIL HANYA saat `cart` kosong — navigasi
 *  dalam-aplikasi mempertahankan isi memori apa adanya.
 *
 *  Validasi mengikuti pola `muatHold()` (key `manual:<n>` didorong melampaui
 *  seq tertinggi; diskon transaksi lewat `clampDiskonTransaksi()`). Tambahan
 *  khusus keranjang — bisa bertahan lama, bukan hitungan menit seperti hold:
 *  - baris produk yang sudah dihapus/ditombstone di server DIBUANG — kalau
 *    dibiarkan, `pay()` mentok 400 "produk tidak dikenal" pada baris yang
 *    tak bisa dijual lagi;
 *  - harga baris non-dinamis disamakan dengan cache master — harga
 *    non-dinamis DIKUNCI server, jadi tampilan harus sama dengan yang akan
 *    ditagih;
 *  - diskon baris dijepit ulang ke jumlah baris (harga mungkin berubah).
 *  Pelanggan TIDAK divalidasi di sini — `mountPosPage` melakukannya SETELAH
 *  master `customers` dimuat. Return true bila ada isi yang dipulihkan. */
function muatKeranjang(): boolean {
  const s = getKeranjang<SimpananKeranjang>();
  if (!s?.items?.length && !(s?.topups?.length)) return false;
  const byId = new Map(products.map((p) => [p.id, p]));
  const items: CartLine[] = [];
  let dibuang = 0;
  for (const l of s.items ?? []) {
    if (l.product_id !== null) {
      const p = byId.get(l.product_id);
      if (!p) {
        dibuang++;
        continue;
      }
      l.dyn = !!p.price_dynamic;
      if (p.price_dynamic) {
        // Re-key baris lama (format pre-2026-10-06 tanpa harga di key) ke
        // `<id>:<unit>:<harga>` — idempoten untuk format baru. Kalau ternyata
        // baris key itu sudah ada (keranjang tersimpan oleh versi berbeda),
        // kuantitas digabung supaya tidak ada dua <tr data-key> kembar.
        const k = `${p.id}:${l.unit}:${l.price}`;
        const dobel = k === l.key ? undefined : items.find((x) => x.key === k);
        if (dobel) {
          dobel.qty += l.qty;
          if (!dobel.discManual) dobel.discount = hitungPrefill(dobel);
          dobel.discount = Math.min(dobel.discount, jumlahBaris(dobel));
          continue;
        }
        l.key = k;
      } else {
        // Harga non-dinamis disamakan ke cache master — TAPI memakai harga
        // SATUAN BARIS (resolusiSatuan), bukan `p.price` dasar: baris "2 pack"
        // yang dipulihkan jangan jatuh ke harga per pcs (tampilan subtotal
        // salah walau server menghitung ulang saat bayar). Factor juga ikut
        // disinkronkan kalau master product_units berubah.
        const r = resolusiSatuan(p, l.unit);
        l.price = r.price;
        l.factor = r.factor;
        if (r.unit !== l.unit) {
          // Satuan baris sudah tidak dijual lagi di master (units berubah di
          // server) — jatuh ke satuan dasar + re-key; kalau key sudah ada,
          // gabung kuantitas (pola dobel di atas).
          l.unit = r.unit;
          const k2 = `${p.id}:${r.unit}`;
          const dobel2 = items.find((x) => x.key === k2);
          if (dobel2) {
            dobel2.qty += l.qty;
            if (!dobel2.discManual) dobel2.discount = hitungPrefill(dobel2);
            dobel2.discount = Math.min(dobel2.discount, jumlahBaris(dobel2));
            continue;
          }
          l.key = k2;
        }
      }
    } else l.dyn = false;
    l.note = (l.note ?? '').slice(0, 200);
    l.discount = Math.min(Math.max(0, Math.round(l.discount || 0)), jumlahBaris(l));
    items.push(l);
  }
  cart = items;
  // Baris topup (Opsi B) dipulihkan dengan validasi ringan: nominal wajib
  // angka > 0 (baris rusak dibuang — jangan menagih angka NaN), admin
  // dijepit >= 0, dan key dipaksa kembali ke pola `topup:<n>` (snapshot
  // bisa datang dari versi/format berbeda). Seq didorong seperti manualSeq.
  cartTopup = [];
  for (const t of s.topups ?? []) {
    const nominal = Math.round(Number(t.nominal));
    if (!(nominal > 0)) continue;
    // Jenis tak dikenal (snapshot korup / dari versi lain) dibuang — jangan
    // pernah mengirim `provider` ngawur ke POST /api/topups saat bayar.
    if (!isJenisLayanan(t.jenis)) continue;
    const admin = Math.max(0, Math.round(Number(t.admin) || 0));
    const m = /^topup:(\d+)$/.exec(t.key ?? '');
    if (m) topupSeq = Math.max(topupSeq, Number(m[1]));
    else t.key = `topup:${(topupSeq += 1)}`;
    cartTopup.push({
      id: t.id ?? uuid(),
      key: t.key,
      jenis: t.jenis,
      nomor: String(t.nomor ?? ''),
      token: String(t.token ?? ''),
      nominal,
      admin,
    });
  }
  discount = Math.max(0, Math.round(s.discount || 0));
  customerId = s.customerId ?? null;
  for (const l of cart) {
    const m = /^manual:(\d+)$/.exec(l.key);
    if (m) manualSeq = Math.max(manualSeq, Number(m[1]));
  }
  clampDiskonTransaksi(); // diskon transaksi > sisa subtotal (harga berubah) dijepit sebelum paint
  if (dibuang) toast(`${dibuang} baris dibuang — produknya sudah dihapus dari katalog`, 'info');
  if (keranjangTerisi()) {
    toast(`Keranjang dipulihkan — ${cart.length + cartTopup.length} baris`, 'success');
  }
  return keranjangTerisi();
}

/* ---------- tahan / pending (fitur P5) ---------- */

/** Total sebuah hold = subtotal baris − diskon per baris − diskon transaksi
 *  (rumus sama dengan `total()` keranjang aktif) + tagihan baris layanan:
 *  topup nominal+admin, tarik admin SAJA (lihat tarikTotal() — nominal tarik
 *  uang keluar, bukan tagihan). Dipakai kartu antrian, ringkasan preview,
 *  dan pesan hapus — angkanya harus persis totalBayar saat hold dibuat. */
const hitungHold = (h: Hold) =>
  Math.max(0, h.items.reduce((s, l) => s + Math.round(l.price * l.qty) - l.discount, 0) - h.discount) +
  (h.topups ?? []).reduce((s, l) => s + (TARIK_JENIS.some((j) => j.key === l.jenis) ? 0 : l.nominal) + l.admin, 0);

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
  if (busy || !keranjangTerisi()) return;
  holds.unshift({
    id: uuid(),
    waktu: new Date().toISOString(),
    kasir: getCashier(),
    customerId,
    customerName: customers.find((c) => c.id === customerId)?.name ?? 'Pelanggan Umum',
    discount,
    items: cart.map((l) => ({ ...l })),
    // Baris topup ikut ditahan (Opsi B) — pulihkan di muatHold().
    topups: cartTopup.map((l) => ({ ...l })),
  });
  await simpanTertahan();
  bersihkanKeranjang();
  customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
  const sel = host?.querySelector<HTMLSelectElement>('#pos-customer');
  if (sel) sel.value = customerId === null ? '' : String(customerId);
  simpanKeranjang(); // sinkronkan pelanggan bawaan (isi kosong sudah ditulis bersihkanKeranjang)
  paintAktif();
  toast(`Transaksi ditahan — ${holds.length} tertahan`, 'info');
}

/** Muat kembali isi hold ke keranjang ("Lanjutkan" di daftar Pending).
 *  Keranjang aktif tidak boleh hilang diam-diam: bila masih ada isinya,
 *  kasir dikonfirmasi dulu (SweetAlert2 — bukan confirm() native). */
async function muatHold(h: Hold): Promise<void> {
  if (busy) return;
  if (keranjangTerisi()) {
    const ok = await confirmDialog({
      title: 'Ganti keranjang saat ini?',
      message: `${cart.length + cartTopup.length} baris di keranjang akan dibuang dan diganti isi transaksi tertahan ini.`,
      okLabel: 'Ya, ganti',
      cancelLabel: 'Batal, jangan diganti',
    });
    if (!ok) return;
  }
  cart = h.items.map((l) => ({ ...l }));
  // Normalisasi baris hold seperti muatKeranjang: flag `dyn` + re-key format
  // key lama — hold bisa dibuat sebelum kolom Harga menjadi input (2026-10-06).
  const byIdHold = new Map(products.map((p) => [p.id, p]));
  for (const l of cart) {
    if (l.product_id === null) { l.dyn = false; continue; }
    const p = byIdHold.get(l.product_id);
    l.dyn = !!p?.price_dynamic;
    if (l.dyn) l.key = `${l.product_id}:${l.unit}:${l.price}`;
  }
  // Baris topup ikut hold (Opsi B) — divalidasi ringan saat dimuat (jenis
  // dikenal + nominal > 0; admin dijepit) supaya hold korup tidak meledak
  // di layar bayar. Key `topup:<n>` didorong seq-nya di bawah.
  cartTopup = (h.topups ?? [])
    .filter((t) => isJenisLayanan(t.jenis) && Math.round(Number(t.nominal)) > 0)
    .map((t) => ({
      ...t,
      admin: Math.max(0, Math.round(Number(t.admin) || 0)),
      nomor: String(t.nomor ?? ''),
      token: String(t.token ?? ''),
    }));
  discount = h.discount;
  // Pelanggan hold divalidasi terhadap master terkini — id lama yang sudah
  // tidak ada jatuh ke Pelanggan Umum, bukan ke select kosong.
  customerId = customers.some((c) => c.id === h.customerId)
    ? h.customerId
    : customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
  const sel = host?.querySelector<HTMLSelectElement>('#pos-customer');
  if (sel) sel.value = customerId === null ? '' : String(customerId);
  // Item manual hold memakai key `manual:<n>` — dorong seq melampaui angka
  // tertinggi supaya item manual BERIKUTNYA tidak menabrak key lama. Baris
  // topup (`topup:<n>`) didorong dari key yang sama di sini.
  for (const l of cart) {
    const m = /^manual:(\d+)$/.exec(l.key);
    if (m) manualSeq = Math.max(manualSeq, Number(m[1]));
  }
  for (const t of cartTopup) {
    const m = /^topup:(\d+)$/.exec(t.key);
    if (m) topupSeq = Math.max(topupSeq, Number(m[1]));
    else t.key = `topup:${(topupSeq += 1)}`;
  }
  simpanKeranjang(); // isi keranjang kini = isi hold — tulis ke localStorage (konfirmasi ganti sudah lewat)
  holds = holds.filter((x) => x.id !== h.id);
  await simpanTertahan();
  cashIn = 0;
  cashTouched = false;
  const disc = host?.querySelector<HTMLInputElement>('#pos-discount');
  if (disc) disc.value = discount ? String(discount) : '';
  const cash = document.querySelector<HTMLInputElement>('#pos-cash');
  if (cash) cash.value = '';
  // Hold = isi keranjang (satu-satunya mode). Muat ulang tampilan +
  // fokus scan supaya baris yang dimuat langsung terlihat.
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
    message: `${h.items.length + (h.topups ?? []).length} baris senilai ${rp(hitungHold(h))} akan dihapus permanen.`,
    okLabel: 'Ya, hapus',
    danger: true,
    cancelLabel: 'Batal, jangan dihapus',
  });
  if (!ok) return;
  holds = holds.filter((x) => x.id !== h.id);
  await simpanTertahan();
  paintAktif(); // badge Pending & disable tombol ikut keranjang
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
      <div class="mt-0.5 text-xs${aktif ? ' text-white/90' : ' text-gray-500 dark:text-gray-400'}">${h.items.length + (h.topups ?? []).length} baris (${qty} Qty)</div>
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
    // Baris layanan hold (Opsi B) — disusul di daftar produk; netto kanan =
    // tagihannya (topup: nominal + admin; tarik: admin saja — nominalnya uang
    // keluar). Tanpa baris layanan = keluaran PERSIS lama (uji §C3 aman).
    const tops = (h.topups ?? []).map((t, i) => {
      const j = jenisTopupLokal(t.jenis);
      const keluar = TARIK_JENIS.some((x) => x.key === t.jenis);
      const sub = [
        keluar ? 'Tarik tunai' : 'Topup',
        t.nomor ? esc(t.nomor) : '',
        t.token ? `token ${esc(t.token)}` : '',
        `admin ${rp(t.admin)}`,
      ].filter(Boolean).join(' · ');
      return `<li class="flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-3 dark:bg-gray-700/40">
        <div class="min-w-0">
          <div class="truncate text-sm font-bold text-gray-900 dark:text-white">${h.items.length + i + 1}. ${esc(j.label)} ${rp(t.nominal)}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">${sub}</div>
        </div>
        <div class="shrink-0 text-sm font-bold tabular-nums text-primary">${rp(keluar ? t.admin : t.nominal + t.admin)}</div>
      </li>`;
    }).join('');
    const subtotal = h.items.reduce(
      (s, l) => s + Math.round(l.price * l.qty) - (l.discount || 0), 0);
    const topupTot = (h.topups ?? []).reduce(
      (s, l) => s + (TARIK_JENIS.some((x) => x.key === l.jenis) ? 0 : l.nominal) + l.admin, 0);
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
        <div class="mb-3 text-[10px] font-semibold uppercase text-gray-500 dark:text-gray-400">Daftar produk (${h.items.length + (h.topups ?? []).length} item)</div>
        <ul class="flex flex-col gap-2">${produk}${tops}</ul>
        <div class="mt-4 rounded-lg bg-gray-100 p-4 dark:bg-gray-700/50">
          <div class="mb-2 flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Subtotal</span>
            <span class="font-bold tabular-nums">${rp(subtotal)}</span>
          </div>
          ${h.discount ? `<div class="mb-2 flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Diskon</span>
            <span class="font-bold tabular-nums text-red-600 dark:text-red-400">-${rp(h.discount)}</span>
          </div>` : ''}
          ${topupTot ? `<div class="mb-2 flex justify-between">
            <span class="text-gray-500 dark:text-gray-400">Layanan (${(h.topups ?? []).length} baris)</span>
            <span class="font-bold tabular-nums">+${rp(topupTot)}</span>
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
        // Klik Simpan harus MENUTUP seperti jalur Enter — sebelumnya hanya
        // resolve sehingga modal harga/QTY nyangkut terbuka setelah baris
        // sudah masuk (ditemukan saat uji E2E harga khusus 2026-10-06).
        api.ok.addEventListener('click', () => { done(); api.close(); });
        inp?.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
            api.close();
          }
        });
      },
    });
    // Batal / tutup -> null (pemanggil: preset dibiarkan); OK/Enter -> angka
    // dari kolom. Satu-satunya pemanggil kini = dialog Qty (F4) via setQtyNext
    // — dialog harga produk dinamis sudah DIHAPUS (lihat addProduct).
    m.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-x]') || t.closest('.modal-overlay') === t) {
        m.el.addEventListener('transitionend', () => resolve(null), { once: true });
        setTimeout(() => resolve(null), 300);
      }
    });
  });
}

/** Masukkan satu produk ke keranjang. SEMUA produk masuk LEWAT SATU JALUR
 *  yang sama — termasuk harga khusus (`price_dynamic`): harga default dari
 *  master langsung menjadi isi baris, kasir mengubahnya lewat kolom Harga di
 *  keranjang (keputusan pemilik 2026-10-06: *"karena harga bisa di ubah
 *  inline, modal dynamic harga tidak usah"* — dialog `askPrice` DIHAPUS).
 *  `items[].price` tetap ikut setiap penjualan, jadi kontrak server
 *  (AGENTS §1) tidak berubah.
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
  // Satuan + harga final lewat helper bersama (resolusiSatuan) — jalur yang
  // SAMA dipakai gantiSatuan & muatKeranjang.
  const { unit, factor, price: hargaTampil } = resolusiSatuan(p, unitSlug);

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
        simpanKeranjang(); // pilihan pelanggan tanpa repaint — tulis eksplisit
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
      // Guard anti-double-submit (bug yang sama dengan dialog topup
      // 2026-10-08: 1x Enter = handler el + handler bawaan modal.ts, dua
      // submit = dua baris). Disetel setelah validasi supaya input salah
      // tetap bisa dibetulkan.
      let terkirim = false;
      const submit = () => {
        if (terkirim) return;
        const n = (name?.value || '').trim();
        const pr = Number(price?.value || 0);
        const q = Math.max(1, Number(qty?.value || 1));
        if (!n || pr <= 0) {
          toast('Nama dan harga wajib diisi', 'error');
          return;
        }
        terkirim = true;
        manualSeq += 1;
        cart.push({
          key: `manual:${manualSeq}`, product_id: null, name: n, sku: 'MANUAL',
          price: pr, qty: q, track_stock: 0, unit: '', baseUnit: '', factor: 1,
          // Item manual tidak punya diskon permanen (bukan produk katalog),
          // tapi kolom Diskon tetap terisi 0 dan bisa diketik kasir. Harga
          // manual juga tidak lewat kolom input harga (bukan produk dinamis).
          dyn: false,
          discount: 0, prefill: null, discManual: false,
          // Tanpa input catatan: tidak ada produk use_note-nya (pemilik memang
          // menandai produk katalog, mis. Cetak Banner — bukan jasa dadakan).
          useNote: false, note: '',
        });
        simpanKeranjang();
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

/** Dialog "Tambah topup / tarik tunai" — SATU-SATUNYA jalur layanan sejak
 *  mode Topup/Tarik dihapus (2026-10-08): jenis topup + tarik, nomor/token
 *  sesuai jenis, nominal + biaya admin (saran tier `suggestAdmin`, berhenti
 *  menimpa setelah kasir mengedit sendiri). Baris tersimpan dengan `id`
 *  uuid STABIL — kunci idempotensi retry POST /api/topups di pay() (server
 *  membalas duplicate:true). `jenisAwal` = jenis terpilih saat dibuka
 *  (pintasan katalog `bukaModeLayanan()` menyarankan tarik untuk produk
 *  bernama "tarik ..."). Tombol dialog ~1.5x (permintaan pemilik 2026-10-08
 *  "tombol-tombol pada modal bisa di besarkan setengahnya lagi"). */
function openDialogTopupKeranjang(jenisAwal: TopupJenis = 'e-wallet'): void {
  openModal({
    title: 'Tambah topup / tarik tunai',
    okLabel: 'Tambah',
    // Isi meniru BAHASA VISUAL modal resume (putaran 11): judul blok huruf
    // besar terpusat, blok dipisah garis PUTUS-PUTUS, baris akhir label↔nilai
    // (pola baris Total resume), petunjuk di pusat bawah — revisi pemilik
    // 2026-10-08: "isi kontennya kurang proporsional, coba perhatikan modal
    // resume".
    // **Ukuran konten = ukuran STANDAR modal (pola modal Cari produk yang
    // dipegang pemilik "menurut saya rapi")**: input polos `.input` (33px),
    // tombol jenis = gaya TOMBOL SIDEBAR (`btn btn-ghost !min-h-[32px]
    // !px-2 !py-1.5 text-xs`, radius `rounded-lg` — BUKAN chip `rounded-full`
    // yang dikeluhkan "jangan full rounded"), lebar isi penuh seperti modal
    // cari (wrapper `max-w-md` dibuang). Tombol footer mengikuti gaya
    // sidebar juga — lihat onMount di bawah. ID/atribut lama TIDAK berubah —
    // suite e2e-topup-keranjang & e2e-struk menempel padanya.
    body: `<div class="space-y-3 text-sm text-gray-700 dark:text-gray-200">
      <div>
        <div class="mb-1.5 text-center text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Jenis topup</div>
        <div class="grid grid-cols-2 gap-2" id="ptk-jenis">
          ${TOPUP_JENIS.map((j) => `<button type="button" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs" data-ptk-jenis="${j.key}">${j.label}</button>`).join('')}
        </div>
      </div>
      <div class="border-t border-dashed border-gray-300 dark:border-gray-600"></div>
      <div>
        <div class="mb-1.5 text-center text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Tarik tunai (uang keluar)</div>
        <div class="grid grid-cols-2 gap-2" id="ptk-jenis-tarik">
          ${TARIK_JENIS.map((j) => `<button type="button" class="btn btn-ghost !min-h-[32px] !px-2 !py-1.5 text-xs" data-ptk-jenis="${j.key}">${j.label}</button>`).join('')}
        </div>
      </div>
      <div class="border-t border-dashed border-gray-300 dark:border-gray-600"></div>
      <div id="ptk-nomor-wrap" class="hidden space-y-1">
        <label class="label" for="ptk-nomor" id="ptk-nomor-label">Nomor HP tujuan</label>
        <input id="ptk-nomor" class="input" type="text" value="" />
      </div>
      <div id="ptk-token-wrap" class="hidden space-y-1">
        <label class="label" for="ptk-token">Nomor Token</label>
        <input id="ptk-token" class="input" type="text" inputmode="numeric" value="" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label class="label" for="ptk-nominal">Nominal (Rp)</label>
          <input id="ptk-nominal" class="input" type="number" inputmode="numeric" min="0" step="1000" value="" />
        </div>
        <div class="space-y-1">
          <label class="label" for="ptk-admin">Biaya admin (Rp)</label>
          <input id="ptk-admin" class="input" type="number" inputmode="numeric" min="0" step="500" value="" />
        </div>
      </div>
      <div class="border-t border-dashed border-gray-300 dark:border-gray-600"></div>
      <div class="flex items-baseline justify-between gap-4 font-bold text-gray-900 dark:text-white">
        <span id="ptk-total-label">Ditambah ke nota</span>
        <span id="ptk-total" class="shrink-0 tabular-nums">Rp0</span>
      </div>
      <p class="text-center text-xs leading-snug text-gray-500 dark:text-gray-400">Dibayar bersama belanja nota ini; tercatat terpisah di riwayat topup/tarik (nominal bukan omzet, admin = jasa; nominal tarik diserahkan tunai).</p>
    </div>`,
    onMount: (api) => {
      // Tombol footer = gaya TOMBOL SIDEBAR KANAN (Aksi cepat / Menu cepat:
      // `btn-ghost` border tipis utk Batal, `btn-primary` utk Tambah, badan
      // `!min-h-[32px] !px-2 !py-1.5 text-xs` + ikon) — revisi pemilik
      // 2026-10-08: "style tombol pada modal popup ganti seperti style di
      // sidebar kanan dan kecilkan lagi tombolnya di modal topup".
      // Ikon `check` meniru tombol Bayar sidebar; ukuran 32px/11px = persis
      // ukuran tombol sidebar (kini di bawah input 40px — "kecilkan lagi").
      // Footer modal bayar (#pos-pay 68px) TIDAK disentuh.
      const batalBtn = api.el.querySelector<HTMLElement>('.modal-footer [data-x]');
      for (const b of [api.ok, batalBtn]) {
        b?.classList.add('!min-h-[32px]', '!px-2', '!py-1.5', 'text-xs');
      }
      api.ok.innerHTML = `${icon('check')}<span>Tambah</span>`;
      let jenis: TopupJenis = TOPUP_JENIS.some((j) => j.key === jenisAwal) || TARIK_JENIS.some((j) => j.key === jenisAwal)
        ? jenisAwal
        : 'e-wallet';
      let adminTouched = false;
      const wrapJenis = api.el.querySelector<HTMLElement>('#ptk-jenis')!;
      const wrapTarik = api.el.querySelector<HTMLElement>('#ptk-jenis-tarik')!;
      const wrapNomor = api.el.querySelector<HTMLElement>('#ptk-nomor-wrap')!;
      const labelNomor = api.el.querySelector<HTMLElement>('#ptk-nomor-label')!;
      const inpNomor = api.el.querySelector<HTMLInputElement>('#ptk-nomor')!;
      const wrapToken = api.el.querySelector<HTMLElement>('#ptk-token-wrap')!;
      const inpToken = api.el.querySelector<HTMLInputElement>('#ptk-token')!;
      const inpNominal = api.el.querySelector<HTMLInputElement>('#ptk-nominal')!;
      const inpAdmin = api.el.querySelector<HTMLInputElement>('#ptk-admin')!;
      const elTotal = api.el.querySelector<HTMLElement>('#ptk-total')!;
      const elTotalLabel = api.el.querySelector<HTMLElement>('#ptk-total-label')!;
      /** Baris ringkasan bawah — pola baris Total modal resume (label kiri,
       *  angka kanan bold): topup ikut `nominal + admin`, tarik HANYA `admin`
       *  (rumus sama dengan `topupTotal()`/`tarikTotal()`, dihitung untuk
       *  SATU baris yang sedang diisi). Label ikut jenis supaya tarik tidak
       *  terbaca "Rp50.000 ditagih" padahal yang dibayar hanya adminnya. */
      const tampilTotal = () => {
        const nominal = Math.round(Number(inpNominal.value || 0));
        const admin = Math.max(0, Math.round(Number(inpAdmin.value || 0)));
        const tarik = jenis.startsWith('tarik');
        elTotalLabel.textContent = tarik ? 'Biaya admin ditagih' : 'Ditambah ke nota';
        elTotal.textContent = rp(tarik ? admin : nominal + admin);
      };
      const aktif = () =>
        TOPUP_JENIS.find((j) => j.key === jenis)
        ?? TARIK_JENIS.find((j) => j.key === jenis)
        ?? TOPUP_JENIS[0];
      const tampilJenis = () => {
        const j = aktif();
        for (const wrap of [wrapJenis, wrapTarik]) {
          wrap.querySelectorAll<HTMLElement>('[data-ptk-jenis]').forEach((b) => {
            const on = b.dataset.ptkJenis === jenis;
            b.classList.toggle('!border-primary', on);
            b.classList.toggle('!text-primary', on);
          });
        }
        const butuhNomor = j.butuhNomor !== false;
        // classList.toggle('hidden') — BUKAN `.hidden =` (property): wrapper
        // dirender dengan class Tailwind `hidden`, jadi properti saja tidak
        // pernah memunculkannya kembali (class display:none tetap menang).
        wrapNomor.classList.toggle('hidden', !butuhNomor);
        labelNomor.textContent = j.nomorLabel;
        inpNomor.placeholder = j.nomorPh;
        wrapToken.classList.toggle('hidden', !j.butuhToken);
        tampilTotal(); // label baris ringkasan ikut jenis (topup vs tarik)
      };
      const pilihJenis = (e: Event) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ptk-jenis]');
        if (!b?.dataset.ptkJenis) return;
        jenis = b.dataset.ptkJenis as TopupJenis;
        tampilJenis();
      };
      wrapJenis.addEventListener('click', pilihJenis);
      wrapTarik.addEventListener('click', pilihJenis);
      // Saran admin mengikuti tier form topup; berhenti menimpa begitu kasir
      // mengedit kolomnya sendiri (pola saran-admin form layanan).
      inpNominal.addEventListener('input', () => {
        if (!adminTouched) inpAdmin.value = String(suggestAdmin(Number(inpNominal.value || 0)) || '');
        tampilTotal();
      });
      inpAdmin.addEventListener('input', () => {
        adminTouched = true;
        tampilTotal();
      });
      tampilJenis();
      inpNominal.focus();
      // Guard anti-double-submit (bug nyata 2026-10-08: "tambah 1 topup
      // masuk 2 baris"): 1x Enter menembak DUA jalur — handler `keydown` di
      // bawah (api.el === overlay, terdaftar SETELAH milik modal.ts sehingga
      // jalan kedua) + handler bawaan modal.ts (`overlay keydown` Enter di
      // INPUT → ok.click() → submit, jalan pertama). Tanpa guard, submit
      // jalan 2x = 2 baris. Flag disetel SETELAH validasi lolos supaya
      // input salah tetap bisa dibetulkan + submit ulang. Pola yang sama
      // dipakai openManualItem.
      let terkirim = false;
      const submit = () => {
        if (terkirim) return;
        const j = aktif();
        const butuhNomor = j.butuhNomor !== false;
        const nominal = Math.round(Number(inpNominal.value || 0));
        const admin = Math.max(0, Math.round(Number(inpAdmin.value || 0)));
        const nomor = butuhNomor ? inpNomor.value.trim() : '';
        if (!(nominal > 0)) {
          toast('Nominal harus lebih dari 0', 'error');
          inpNominal.focus();
          return;
        }
        if (butuhNomor && !nomor) {
          toast(`${j.nomorLabel} wajib diisi`, 'error');
          inpNomor.focus();
          return;
        }
        terkirim = true;
        topupSeq += 1;
        cartTopup.push({
          id: uuid(),
          key: `topup:${topupSeq}`,
          jenis,
          nomor,
          token: wrapToken.classList.contains('hidden') ? '' : inpToken.value.trim(),
          nominal,
          admin,
        });
        simpanKeranjang();
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
  if (busy) return;
  if (!keranjangTerisi()) return;
  if (payMethod === 'tunai') {
    // Uang pas = persis TOTAL GABUNGAN (keranjang + baris layanan, Opsi B) —
    // satu-satunya jalur "tanpa kembalian" yang sah juga saat ada layanan.
    cashIn = totalBayar();
    cashTouched = true;
    paintCart();
  }
  void pay();
}

/* ---------- cetak ulang nota terakhir (Tahap 2, 2026-10-06) ---------- */

/** localStorage id nota sukses TERAKHIR device ini — sumber tombol
 *  "Cetak ulang" di Aksi cepat. Per device (bukan per shift/kasir): pref
 *  cetak juga per device, dan device A tidak boleh mencetak ulang nota
 *  yang belum pernah lewat sana. */
const LS_NOTA_TERAKHIR = 'ravaa.nota-terakhir';

/** Catat id nota sukses. Dipanggil di pay() SEBELUM cart di-reset — id
 *  didapat dari server (`res.data.sale.id`, uuid idempotent, jadi outbox /
 *  retry pun akan menunjuk id yang sama). Gagal tulis (private mode) diam —
 *  fitur reprint hanya mati sampai penjualan berikutnya tersimpan. */
function simpanNotaTerakhir(id: string): void {
  try {
    localStorage.setItem(LS_NOTA_TERAKHIR, id);
  } catch {
    /* localStorage penuh/terblokir — tombol tetap enabled, fetch nanti error sendiri */
  }
}

function bacaNotaTerakhir(): string {
  try {
    return localStorage.getItem(LS_NOTA_TERAKHIR) ?? '';
  } catch {
    return '';
  }
}

/** Aksi tombol "Cetak ulang" (Aksi cepat): ambil baris nota terakhir lewat
 *  GET /api/sales/:id (kontrak yang sama dengan detail Riwayat), lalu serahkan
 *  ke cetakUlang() — dialog [Thermal][A4][Batal] + susunan struk IDENTIK dengan
 *  cetak ulang dari halaman Riwayat (satu modul, AGENTS §5). Tanpa pratinjau
 *  "Lihat Struk" (keputusan pemilik 2026-10-06: menyusul / digabung bila jadi). */
async function cetakNotaTerakhir(): Promise<void> {
  const id = bacaNotaTerakhir();
  if (!id) {
    toast('Belum ada nota terakhir dari device ini', 'warning');
    return;
  }
  try {
    const j = await apiGet<{ data: { sale: SaleRow } }>(
      `/api/sales/${encodeURIComponent(id)}`,
    );
    await cetakUlang(j.data.sale);
  } catch (e) {
    // 404 = id tidak ada (DB diganti / nota belum masuk setelah offline),
    // status 0 = jaringan mati — dua-duanya jangan dibaca sebagai "tidak ada".
    toast(
      `Nota terakhir tidak bisa dimuat: ${e instanceof Error ? e.message : 'gagal'}`,
      'warning',
      9000,
    );
  }
}

/**
 * Segarkan cache produk POS SEGERA setelah penjualan sukses — permintaan
 * pemilik 2026-10-08: *"stok di bawah nama produk tidak terefresh sehingga
 * seolah-olah stok tidak berkurang"* (dropdown suggest `#pos-results` +
 * modal Cari produk `#pc-list` masih mempertunjukkan angka lama).
 *
 * Server SUDAH memotong stok (`POST /api/sales` → `UPDATE products SET
 * stock = stock − qty×factor` + `stock_moves`), tapi array `products` milik
 * POS dulu hanya dimuat ulang di `mountPosPage()` — jadi dalam satu sesi
 * panjang angka stok tidak pernah bergerak. Tarik delta `?since=` lalu baca
 * ulang cache; gagal (offline/server sibuk) = senyap, penjualan tidak pernah
 * dibatalkan oleh refresh ini (pola `try/catch` syncMaster saat mount).
 *
 * Cabang layanan-saja TIDAK memanggil ini (topup/tarik tidak menyentuh
 * stok); outbox offline menyusul saat mount berikutnya.
 */
async function segarkanStokPos(): Promise<void> {
  try {
    await syncMaster((since) => apiGet<{ data: Product[]; maxVersion: number }>(`/api/products?since=${since}`));
    products = await getCachedProducts();
    // Dropdown suggest masih terbuka saat pembayaran (isian kolom scan tidak
    // dikosongkan pay()): isi `results` masih memegang objek Product LAMA —
    // gambar ulang dari query yang sama supaya "sisa N" ikut menyegar, tanpa
    // membuka dropdown yang tadinya tertutup.
    const inp = host?.querySelector<HTMLInputElement>('#pos-q');
    const box = host?.querySelector('#pos-results');
    if (inp && box && !box.classList.contains('hidden') && inp.value.trim()) {
      const qtyKode = bacaQtyKode(inp.value);
      results = queryResults(qtyKode ? qtyKode.q : inp.value);
      active = 0;
      paintResults();
    }
    // Chip notif + strip peringatan ikut menyegar (stok habis/menipis baru
    // terbentuk / teratasi oleh penjualan ini) — lihat segNotifPos().
    segNotifPos();
  } catch {
    /* offline: pakai cache lama sampai sync di mount berikutnya */
  }
}

async function pay(opts?: { hutang?: boolean }): Promise<void> {
  if (!shift || busy) return;
  if (!keranjangTerisi()) return;
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
  //
  // (Opsi B hybrid) Threshold barrier = TOTAL GABUNGAN (`totalBayar()` =
  // keranjang + baris layanan) dan **baris layanan TIDAK BISA jadi hutang**:
  // uang kurang saat ada topup/tarik = tolak mutlak (buka form + fokus kolom
  // uang). Alasan: penanda `sisa_hutang` nota di server dihitung dari
  // `sales.total − cash_in` — porsi penjualan saja — sehingga utang porsi
  // layanan tidak bisa diwakilinya; nominal topup juga mutasi modal yang
  // sudah dibayar ke penyedia (pulsa/listrik), nominal tarik sudah diserahkan
  // tunai — bukan barang yang bisa ditalangi.
  const totBayar = totalBayar();
  if (payMethod === 'tunai' && !opts?.hutang && cashIn < totBayar) {
    if (cartTopup.length) {
      toast(`Uang diterima kurang dari total ${rp(totBayar)} — baris topup/tarik tidak bisa jadi hutang`, 'error');
      bukaBayar();
      document.querySelector<HTMLInputElement>('#pos-cash')?.focus();
      return;
    }
    const alasan = cekHutangDiperbolehkan();
    if (alasan) {
      if (!(cashIn > 0)) toast(`Uang diterima belum diisi — ${alasan}`, 'error');
      else toast(`Uang diterima kurang dari total ${rp(totBayar)} — ${alasan}`, 'error');
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
  // Tahap untuk pesan catch: topup dikirim lebih dulu, jadi kegagalan bisa
  // datang dari dua request berbeda — pesan jangan menyesatkan.
  let tahap: 'topup' | 'penjualan' = 'topup';
  try {
    // ---------- (Opsi B hybrid) baris LAYANAN dikirim DULU ----------
    // Urutan disepakati (TODO "Opsi B"): POST /api/topups per baris LALU baru
    // POST /api/sales — record tetap terpisah (nominal topup bukan omzet,
    // admin = jasa; agregat shift tetap benar), satu struk gabungan. Baris
    // tarik memakai `kind:'tarik'` (uang keluar) — providernya kode jenis
    // tarik (TARIK-EWALLET|TARIK-BANK, uppercase seperti topup).
    // `id` tiap baris STABIL (uuid dibuat saat baris dibuat, ikut persist
    // keranjang/hold) sehingga menekan Bayar lagi setelah gagal mengirim id
    // yang sama — server membalas `duplicate:true` tanpa menggandakan
    // (idempotent, kontrak POST /api/topups).
    for (const t of cartTopup) {
      const keluar = isTarik(t);
      await apiPost<{ data: unknown; duplicate?: boolean }>('/api/topups', {
        id: t.id,
        kind: keluar ? 'tarik' : 'topup',
        provider: t.jenis.toUpperCase(), // E-WALLET | PULSA | PLN-TOKEN | PLN-BILL | TARIK-*
        nomor: t.nomor, // '' = jenis tanpa nomor (server: nomor opsional)
        token: t.jenis === 'pln-token' ? t.token : '',
        nominal: t.nominal,
        admin: t.admin,
        pay_method: payMethod,
        shift_id: shift.id,
        cashier: getCashier(),
      });
    }
    // Snapshot SEBELUM apa pun direset — struk & modal resume tidak punya
    // sumber data lagi setelah cart/cashIn dibersihkan di bawah.
    const sub = subtotal();
    const discItem = diskonBaris();
    const tot = total();
    // Tagihan baris layanan: topup = nominal+admin, tarik = admin SAJA
    // (nominal tarik diserahkan tunai — lihat tarikTotal()). `topupTot` =
    // gabungan keduanya = porsi layanan dalam TOTAL yang dibayar.
    const tagihTopup = topupTotal();
    const tagihTarik = tarikTotal();
    const topupTot = tagihTopup + tagihTarik;
    const adaTarik = cartTopup.some(isTarik);
    const adaTopup = cartTopup.some((t) => !isTarik(t));
    const kembalian = payMethod === 'tunai' ? change() : 0;
    // SISA HUTANG — hanya bisa muncul lewat jalur `opts.hutang`; barrier di
    // atas sudah memvalidasi pelanggan DAN memblokir hutang saat ada baris
    // topup. Dicatat ke ledger /api/customer-debts SETELAH nota tersimpan.
    const sisaHutang = opts?.hutang && payMethod === 'tunai' && cashIn < tot ? tot - cashIn : 0;
    const namaHutang = customers.find((c) => c.id === customerId)?.name ?? '';

    // Keranjang hanya berisi baris LAYANAN (tanpa produk): POST /api/sales
    // tanpa items ditolak server, jadi cukup catat layanan + struknya —
    // **tanpa nota sale** (tidak ada invoice / rekam `ravaa.nota-terakhir`).
    // Nominal tarik TIDAK ikut TOTAL (uang keluar) — yang tercetak sebagai
    // TOTAL = tagihannya (admin saja).
    //
    // Modal resume (revisi pemilik 2026-10-08: "resume setelah bayar tidak
    // muncul, kemarin ada modal resume kembalian, dan ada tombol pilih cetak
    // thermal print atau inkjet dan selesai"): jalur ini kini ikut resume
    // yang SAMA dengan penjualan — hero KEMBALIAN + [Thermal][A4][Selesai].
    // Dulu struk langsung dikirim tanpa pilihan (pola lama submitTopup).
    // `saleId = null` = A4 memakai strukA4 (lihat cabang a4 di
    // pilihCetakSelesai), sebab layanan-saja tidak punya nota sale.
    // Snapshot argumen SEBELUM cartTopup di-reset.
    if (!cart.length) {
      const judulLayanan = adaTarik && !adaTopup ? 'Tarik' : adaTopup && adaTarik ? 'Layanan' : 'Topup';
      const strukTopOnly: Struk = {
        judul: getToko(),
        subjudul: adaTarik && !adaTopup ? 'TARIK TUNAI' : adaTopup && adaTarik ? 'TOPUP & TARIK' : 'TOPUP',
        meta: [
          `${waktuStruk()} · No. ${cartTopup[0].id.slice(0, 8)}`,
          `Kasir: ${getCashier()}`,
          `Shift: ${shift.id}`,
        ],
        items: [],
        baris: [
          ...cartTopup.flatMap(barisStrukTopup),
          { kiri: 'TOTAL', kanan: rp(topupTot), tebal: true },
          ...(payMethod === 'tunai' && cashIn > 0
            ? [
                { kiri: 'Tunai', kanan: rp(cashIn) },
                { kiri: 'Kembalian', kanan: rp(kembalian) },
              ]
            : [{ kiri: labelMetode(payMethod), kanan: rp(topupTot) }]),
        ],
        kaki: adaTarik && !adaTopup
          ? ['Cek kembali nominal sebelum meninggalkan loket']
          : ['Simpan struk ini sebagai bukti'],
      };
      tutupBayar();
      void pilihCetakSelesai(null, strukTopOnly, topupTot, kembalian, {
        invoiceNo: cartTopup[0].id.slice(0, 8),
        items: [],
        topups: cartTopup.map((t) => ({
          label: jenisTopupLokal(t.jenis).label,
          nominal: t.nominal,
          admin: t.admin,
          keluar: isTarik(t),
        })),
        metode: payMethod,
        uang: cashIn,
      });
      toast(
        `${judulLayanan} tercatat · ${rp(topupTot)}` +
          (kembalian > 0 ? ` · kembalian ${rp(kembalian)}` : ''),
        'success',
        5000,
      );
      cartTopup = [];
      discount = 0;
      cashIn = 0;
      cashTouched = false;
      customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
      const selCustTop = host?.querySelector<HTMLSelectElement>('#pos-customer');
      if (selCustTop) selCustTop.value = customerId === null ? '' : String(customerId);
      simpanKeranjang();
      const discTop = host?.querySelector<HTMLInputElement>('#pos-discount');
      if (discTop) discTop.value = '';
      const cashTop = document.querySelector<HTMLInputElement>('#pos-cash');
      if (cashTop) cashTop.value = '';
      paintCart();
      host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
      return;
    }

    tahap = 'penjualan';
    const res = await apiPost<{ data: { sale: { id: string; total: number; invoice_no?: string | null; customer_name?: string } ; duplicate: boolean } }>('/api/sales', {
      id: uuid(),
      shift_id: shift.id,
      pay_method: payMethod,
      discount,
      // Alokasi uang ke nota (Opsi B): kembalian diberikan atas TOTAL
      // GABUNGAN, jadi cash_in nota = total + kembalian — invarian server
      // `change = cash_in − total` tetap benar (porsi topup implisit dibayar
      // pas; kembalian tidak pernah tercatat sebagai kelebihan nota). Kasus
      // hutang mengirim uang fisik APA ADANYA karena server memakai
      // `total > cash_in` sebagai penanda `sisa_hutang`.
      cash_in: payMethod === 'tunai' ? (sisaHutang > 0 ? cashIn : tot + kembalian) : 0,
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
    // Stok di suggest/F3 ikut ter-refresh (server baru saja memotong stok) —
    // SEBELUM resume & paintCart berikutnya, supaya angka yang tampil sudah
    // sinkron. Lihat segarkanStokPos().
    await segarkanStokPos();
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
        // Blok topup (Opsi B hybrid): nominal & admin TETAP baris terpisah
        // (aturan domain — nominal = mutasi modal, admin = jasa), TOTAL =
        // gabungan yang benar-benar dibayar pelanggan. Tanpa baris topup
        // keluaran identik dengan struk lama (topupTot 0).
        ...cartTopup.flatMap(barisStrukTopup),
        { kiri: 'TOTAL', kanan: rp(tot + topupTot), tebal: true },
        // Tunai ditampilkan walau uang diterima 0 (transaksi hutang penuh
        // lewat form) — selain itu cabang lama menganggapnya metode biasa.
        ...(payMethod === 'tunai' && (cashIn > 0 || sisaHutang > 0)
          ? [
              { kiri: 'Tunai', kanan: rp(cashIn) },
              // Sisa yang jadi hutang ikut tercetak supaya struk ≠ "lunas".
              ...(sisaHutang > 0 ? [{ kiri: 'Hutang', kanan: rp(sisaHutang) }] : []),
              { kiri: 'Kembalian', kanan: rp(kembalian) },
            ]
          : [{ kiri: labelMetode(payMethod), kanan: rp(tot + topupTot) }]),
      ],
      kaki: adaTarik
        ? ['Terima kasih sudah berbelanja', 'Nominal tarik sudah diserahkan tunai']
        : ['Terima kasih sudah berbelanja'],
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
    // Nota terakhir device ini (sumber tombol "Cetak ulang" di Aksi cepat) —
    // disimpan SEBELUM snapshot resume & reset cart, saat server sudah
    // mengkonfirmasi id (uuid idempotent).
    simpanNotaTerakhir(res.data.sale.id);
    // Tahap 4a — BUKA LACI OTOMATIS (penjualan TUNAI saja, semua jalur bayar
    // F2/Enter/F10/F12 lewat sini): kick ESC/POS SEGERA saat server
    // konfirmasi, tanpa menunggu pilihan cetak modal resume, tanpa syarat
    // saklar autoPrint. QRIS/transfer TIDAK mengirim kick — laci hanya untuk
    // uang fisik masuk.
    if (payMethod === 'tunai') void bukaLaciOtomatis();
    void pilihCetakSelesai(res.data.sale.id, strukJual, tot + topupTot, kembalian, {
      invoiceNo: res.data.sale.invoice_no,
      items: cart.map((l) => ({ qty: l.qty, nama: l.name, net: jumlahBaris(l) - l.discount })),
      // Baris layanan ikut di resume (Opsi B) — nominal & admin tetap
      // terpisah (aturan domain); snapshot sebelum cartTopup di-reset.
      topups: cartTopup.map((t) => ({
        label: jenisTopupLokal(t.jenis).label,
        nominal: t.nominal,
        admin: t.admin,
        keluar: isTarik(t),
      })),
      metode: payMethod,
      uang: cashIn,
      // Baris HUTANG merah di resume (putaran 12) — sisa sudah tercatat ke
      // ledger beberapa baris di atas; snapshot sebelum cart/cashIn di-reset.
      hutang: sisaHutang,
    });
    cart = [];
    cartTopup = []; // baris topup ikut dikosongkan setelah nota sukses (Opsi B)
    discount = 0;
    cashIn = 0;
    cashTouched = false; // penjualan baru -> form berikutnya buka kolom kosong (10d)
    // Pelanggan kembali ke bawaan (Pelanggan Umum) — pilihan pelanggan berlaku
    // PER NOTA, jangan menempel ke transaksi kasir berikutnya diam-diam.
    customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
    const selCust = host?.querySelector<HTMLSelectElement>('#pos-customer');
    if (selCust) selCust.value = customerId === null ? '' : String(customerId);
    simpanKeranjang(); // penjualan sukses = keranjang kosong di localStorage (reload berikutnya tidak memulihkan nota ini)
    toast(
      `Terjual ${res.data.sale.invoice_no ?? res.data.sale.id.slice(0, 8)} · ${rp(res.data.sale.total)}` +
        (tagihTopup > 0 ? ` · topup ${rp(tagihTopup)}` : '') +
        (tagihTarik > 0 ? ` · tarik ${rp(tagihTarik)}` : '') +
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
    toast(`Gagal menyimpan ${tahap}: ${e instanceof Error ? e.message : 'tidak diketahui'}`, 'error', 6000);
  } finally {
    busy = false;
    paintAktif();
  }
}

/* ---------- topup / tarik ---------- */

/** Listener PANEL KANAN (sidebar bayar) — dipanggil dari bindCart. */
function bindSidebar(): void {
  // Diskon transaksi — batasnya sisa SETELAH diskon item.
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
    simpanKeranjang();
    paintAktif();
  });

  // Tombol Bayar (sidebar) = BUKA FORM BAYAR (modal) — permintaan pemilik
  // 2026-10-04. Listener isian bayar (#pos-cash, data-pay, data-cash,
  // #pos-pay) terpasang di bindFormBayar(), sekali tiap modal dibuka
  // (elemennya tidak ada di DOM selama modal tertutup).
  host!.querySelector('#pos-bayar')?.addEventListener('click', () => bukaBayar());

  // Bayar pas = DI SIDE PANEL, tepat di bawah Bayar F10 (permintaan pemilik
  // putaran kedua 2026-10-04). Tunai persis total dalam satu ketukan,
  // TANPA buka form — pakai jalur pay() yang sama (F12 memanggil fungsi ini).
  host!.querySelector('#pos-pay-pas')?.addEventListener('click', () => bayarPas());

  // Aksi cepat (sidebar) — Tahan/Pending = fitur P5, Item manual &
  // Topup/Tarik/Diskon memanggil aksinya dari satu tempat.
  host!.querySelector('#pos-hold')?.addEventListener('click', () => {
    void tahanKeranjang();
  });
  host!.querySelector('#pos-hold-open')?.addEventListener('click', () => bukaTertahan());
  host!.querySelector('#pos-qa-manual')?.addEventListener('click', () => {
    openManualItem();
  });
  // Tambah LAYANAN ke keranjang (Opsi B hybrid: topup + tarik tunai).
  host!.querySelector('#pos-qa-topup')?.addEventListener('click', () => {
    openDialogTopupKeranjang();
  });
  host!.querySelector('#pos-qa-disc')?.addEventListener('click', () => {
    host!.querySelector<HTMLInputElement>('#pos-discount')?.focus();
  });
  // Cetak ulang nota terakhir (Tahap 2) — dialog jalur Riwayat, tanpa
  // pratinjau Lihat Struk (keputusan pemilik 2026-10-06).
  host!.querySelector('#pos-reprint')?.addEventListener('click', () => void cetakNotaTerakhir());
  // Placeholder [data-soon]: tombol sudah dirender, fiturnya menyusul
  // (permintaan pemilik 2026-10-04 "placeholder/hardcode dulu tidak apa-apa").
  host!.querySelectorAll<HTMLElement>('[data-soon]').forEach((b) =>
    b.addEventListener('click', () => toast(`Fitur ${b.dataset.soon} — menyusul`, 'info')),
  );
}

/* ---------- events ---------- */

/** Pintasan keyboard LEVEL DOCUMENT — bukan `host`.
 *
 *  Dulu F2/Escape/Enter menempel di `host` (bindCart), jadi hanya
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
        // Layar cari produk penuh (alokasi Aronium F3) — butuh shift
        // (tanpa shift layar keranjang pun tidak ada).
        if (!shift) return;
        openCariProduk();
        return;
      }

      if (e.key === 'F4') {
        // Qty untuk item BERIKUTNYA (alokasi Aronium F4).
        if (!shift) return;
        void setQtyNext();
        return;
      }

      if (e.key === 'F5') {
        // P3: kosongkan keranjang (tombol "Bersihkan F5"). Tanpa preventDefault
        // Chrome me-reload halaman — sudah dijepit di baris guard atas.
        if (!shift || !keranjangTerisi()) return;
        bersihkanKeranjang();
        return;
      }

      if (e.key === 'F6') {
        // P3: lompat ke kolom "Diskon transaksi" (labelnya polos — <kbd>F6</kbd>
        // ada di tombol "Diskon F6" grid Aksi cepat, permintaan pemilik
        // putaran 7 2026-10-04).
        if (!shift) return;
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
        // persis dengan tombolnya (#pos-hold): shift + keranjang terisi;
        // kalau kosong biarkan saja (tombolnya juga disabled).
        if (!shift) return;
        if (!keranjangTerisi()) return;
        void tahanKeranjang();
        return;
      }

      if (e.key === 'F1') {
        // F1 = KulaPOS ("Jumlah Beli * Kode [F1/Cmd+K]" + fokus search).
        // Esc juga fokus scan tapi 2 langkah saat dropdown terbuka (Esc
        // pertama tutup dropdown). F1 = 1 tekan.
        e.preventDefault();
        if (!shift) return;
        focusScan();
        return;
      }

      if (e.key === 'F8') {
        // F8 = MODAL PENDING — keputusan pemilik 2026-10-06: "F8 sepertinya
        // belum dipakai dan bisa digunakan untuk membuka modal pending".
        // Kosong → toast dari bukaTertahan() ("Belum ada transaksi
        // tertahan"), sama dengan tombol #pos-hold-open yang disabled.
        e.preventDefault();
        if (!shift) return;
        bukaTertahan();
        return;
      }

      if (e.key === 'F9') {
        // Cari pelanggan (putaran 7 2026-10-04 + riset KulaPOS: F9 belum
        // standar, dipakai karena F1-F8 sudah terpakai). Mirip F3 layar cari
        // produk tapi untuk pelanggan — buka openCariPelanggan().
        e.preventDefault();
        if (!shift) return;
        openCariPelanggan();
        return;
      }

      if (e.key === 'F10') {
        // Buka FORM BAYAR (modal). Referensi Aronium (help.aronium.com,
        // artikel Workspace): "Payment (F10) Opens advanced payment form".
        // Syarat = bisaBayar() (keranjang terisi).
        e.preventDefault();
        if (!shift || !bisaBayar()) return;
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
        if (!shift || !bisaBayar()) return;
        if (payMethod === 'tunai') bayarPas();
        else void pay();
        return;
      }

      if (e.key === 'F2') {
        // Bayar cepat — boleh dari fokus mana pun, termasuk sambil mengetik
        // di kolom uang (alur Aronium: ketik -> F2).
        e.preventDefault();
        if (!shift) return;
        if (keranjangTerisi()) void pay();
        return;
      }

      if (e.key === 'Escape') {
        // Esc selalu kembalikan fokus ke scan.
        focusScan();
        return;
      }

      // ↑↓ navigasi baris keranjang (referensi KulaPOS "Navigasi Baris").
      // Guard ketat: HANYA saat fokus di dalam tbody tabel — panah di kolom
      // scan sudah jadi sorotan dropdown (listener #pos-q), dan di luar tabel
      // panah = gulir halaman yang tidak boleh dicuri.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!shift) return;
        if (!t?.closest('#pos-rows')) return;
        // Input catatan (use_note) dikecualikan: panah di kolom teks = gerak
        // kursor, bukan pindah baris.
        if (t?.closest('[data-act="note"]')) return;
        e.preventDefault();
        pindahBarisKeranjang(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (e.key !== 'Enter') return;

      {
        // #pos-q: Enter = masukkan hasil pencarian / scanner (handler sendiri
        // di bindCart) — jangan sampai ikut membayar.
        if (t?.id === 'pos-q' || diTombol) return;
        // Isian selain kolom uang (diskon, dll): biarkan. Kolom uang = alur
        // kas: ketik nominal -> Enter -> bayar (tanpa perlu klik tombol).
        if (diIsian && t?.id !== 'pos-cash') return;
        if (!shift || !keranjangTerisi()) return;
        e.preventDefault();
        void pay();
        return;
      }
    },
    { signal: posKeyAbort.signal },
  );
}

function bindCart(): void {
  posAbort?.abort();
  posAbort = new AbortController();
  const { signal } = posAbort;
  // Chip Qty (setel qty item berikutnya, F4) & tombol Cari (layar cari, F3).
  host!.querySelector('#pos-qty')?.addEventListener('click', () => void setQtyNext());
  host!.querySelector('#pos-cari')?.addEventListener('click', openCariProduk);
  // Info bar (#pos-cust-cari, #pos-shift-tutup) dipasang di paint().
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
    // Baris topup BUKAN baris `cart` (array terpisah, Opsi B hybrid) — hapus
    // di sini SEBELUM pencarian baris produk (tanpa cabang ini klik tong
    // sampah baris topup tidak menemukan key dan diam).
    if (btn.dataset.act === 'topup-del') {
      const i = cartTopup.findIndex((l) => l.key === key);
      if (i >= 0) {
        cartTopup.splice(i, 1);
        simpanKeranjang();
        paintCart();
      }
      return;
    }
    const line = cart.find((l) => l.key === key);
    if (!line) return;
    if (btn.dataset.act === 'inc') setQty(key, line.qty + 1);
    if (btn.dataset.act === 'dec') setQty(key, line.qty - 1);
    if (btn.dataset.act === 'del') setQty(key, 0);
  });

  host!.querySelector('#pos-rows')?.addEventListener('change', (e) => {
    const el = e.target as HTMLElement;
    // Kolom Harga (produk price_dynamic): di-commit via `change` seperti Diskon
    // — Enter/blur. Bisa memicu re-key + penggabungan baris (lihat setHarga).
    const hargaInp = el.closest<HTMLInputElement>('[data-act="price"]');
    if (hargaInp) {
      setHarga(hargaInp.dataset.key!, Number(hargaInp.value || 0));
      return;
    }
    // Kolom Diskon: ketikan kasir (boleh menghapus prefill = isi 0). Angka
    // dijepit ke jumlah baris di setDisc supaya server tidak menolak 400.
    const discInp = el.closest<HTMLInputElement>('[data-act="disc"]');
    if (discInp) {
      setDisc(discInp.dataset.key!, Number(discInp.value || 0));
      return;
    }
    const inp = el.closest<HTMLInputElement>('[data-act="qty"]');
    if (inp) { setQty(inp.dataset.key!, Number(inp.value || 0)); return; }
    // SELECT satuan per baris (Tahap 3): ganti satuan baris yang sudah ada —
    // qty angka sama, diskon baris reset, re-key + gabung (lihat gantiSatuan).
    const unitSel = el.closest<HTMLSelectElement>('[data-act="unit"]');
    if (unitSel) gantiSatuan(unitSel.dataset.key!, unitSel.value);
  });

  // Catatan per baris (produk use_note): `input` (live), BUKAN `change` —
  // kasir bisa langsung F2 bayar tanpa blur, dan tanpa event live catatannya
  // masih kosong di payload. Sengaja TANPA paintCart: paint merender ulang
  // tbody sehingga input kehilangan fokus di tengah ketikan.
  host!.querySelector('#pos-rows')?.addEventListener('input', (e) => {
    const inp = (e.target as HTMLElement).closest<HTMLInputElement>('[data-act="note"]');
    if (!inp) return;
    const line = cart.find((l) => l.key === inp.dataset.key);
    if (line) {
      line.note = inp.value.slice(0, 200);
      simpanKeranjang(); // tanpa repaint — tulis eksplisit supaya catatan ikut pulih
    }
  });

  host!.querySelector('#pos-clear')?.addEventListener('click', () => bersihkanKeranjang());

  // Panel kanan (diskon transaksi, Bayar, Bayar pas, Tahan/Pending, Item
  // manual, Cetak ulang, placeholder) — listener di bindSidebar().
  // Listener khusus keranjang di atas (#pos-rows, #pos-clear) tetap di sini.
  // Listener #pos-customer ada di paint().
  bindSidebar();

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
  results = [];
  // KERPERSISTEN (putaran 16, 2026-10-06 — permintaan pemilik: "produk yang
  // berada di keranjang jika kasir pindah ke halaman dashboard atau tidak
  // sengaja terrefresh barang tidak hilang/keranjang tidak kosong"):
  // keranjang TIDAK lagi direset mentah di sini. Navigasi dalam-aplikasi
  // (hash route TANPA reload dokumen) mempertahankan isi memori apa adanya;
  // bila kosong (reload / perangkat baru) isi dipulihkan dari localStorage lewat
  // muatKeranjang() setelah master pelanggan siap (validasi id butuh
  // `customers`). Uang diterima TIDAK ikut: form transaksi
  // berikutnya selalu buka kolom uang kosong (putaran 10d) — kepemilikan
  // uang berlaku per pembayaran, bukan per sesi.
  const keranjangAda = cart.length > 0;
  if (!keranjangAda) discount = 0;
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
  if (!keranjangAda) muatKeranjang(); // localStorage kosong = no-op; terisi = ganti cart/discount/customerId
  // Pelanggan terpilih wajib ada di master terkini: id lama (kontak dihapus
  // sejak mount terakhir / kv lama) jatuh ke Pelanggan Umum — pola muatHold.
  // null saat customers kosong dibiarkan (payload tanpa customer_id sah).
  if (!customers.some((c) => c.id === customerId)) {
    customerId = customers.find((c) => c.name === 'Pelanggan Umum')?.id ?? customers[0]?.id ?? null;
  }
  if (cart.length) simpanKeranjang(); // sinkronkan localStorage dengan state tervalidasi di atas
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
