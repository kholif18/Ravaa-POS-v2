// Layar Kasir (POS).
//
// SENGJAJA TIDAK ADA GRID PRODUK. Layar ini hanya keranjang; produk masuk lewat
// satu input scan/ketik (barcode -> SKU -> nama), karena di toko alat tulis
// kasir bekerja dengan scanner barcode yang memperlakukan dirinya sebagai
// keyboard, dan grid tile justru memperlambat input cepat.
//
// Alur:
//   1. Gate shift: kalau kasir ini belum punya shift open, form buka shift dulu
//      (POST /api/shifts/open). Server yang menolak dobel lewat UNIQUE INDEX,
//      jadi 409 itu jawaban normal, bukan bug.
//   2. Keranjang: tambah item, ubah qty, hapus.
//   3. Bayar: POST /api/sales (idempotent per uuid).
//
// Data produk dibaca dari cache IndexedDB (store.ts) — bukan fetch per ketikan.
// Cache kasir hanya berisi is_active=1 (see AGENTS.md §3), jadi produk
// nonaktif tidak mungkin masuk keranjang.

import { apiGet, apiPost, uuid, HttpError } from '../api';
import { getCachedProducts, syncMaster, type Product } from '../store';
import { getCashier, getToko } from '../ui/user';
import { switchHtml } from '../ui/switch';
import { getAutoPrint, setAutoPrint, setStrukLayout } from '../ui/print-pref';
import { kirimPrint, strukUntuk, type Struk } from '../escpos';
import { cetakInvoice } from '../invoice';
import { choiceDialog } from '../ui/confirm';
import { toast } from '../ui/toast';
import { openModal } from '../ui/modal';
import { icon } from '../ui/icons';
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

const PAY_METHODS: { key: PayMethod; label: string }[] = [
  { key: 'tunai', label: 'Tunai' },
  { key: 'qris', label: 'QRIS' },
  { key: 'transfer', label: 'Transfer' },
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

const labelMetode = (m: PayMethod) => PAY_METHODS.find((x) => x.key === m)?.label ?? m;

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

/** Pilihan cetak SELESAI transaksi (permintaan pemilik 2026-10-03):
 *  [Thermal] = struk ESC/POS via print-agent (perilaku lama),
 *  [A4]      = invoice gaya Aronium via window.print() browser (CUPS),
 *  [Tidak]   = tanpa cetak. Tampil hanya bila "Cetak struk otomatis" ON —
 *  device tanpa printer tidak pernah diganggu dialog. Pilihan terakhir juga
 *  disimpan sebagai pref layout (untuk struk topup/tarik berikutnya). */
async function pilihCetakSelesai(saleId: string, struk: Struk, tot: number, kembalian: number): Promise<void> {
  const pilihan = await choiceDialog({
    title: 'Cetak struk?',
    message: `Total ${rp(tot)}${kembalian > 0 ? ` · kembalian ${rp(kembalian)}` : ''}`,
    choices: [
      { key: 'thermal', label: 'Thermal' },
      { key: 'a4', label: 'A4' },
    ],
    cancelLabel: 'Tidak',
  });
  if (pilihan === 'thermal') {
    setStrukLayout('thermal');
    void cetak(strukUntuk(struk, 'thermal'));
  } else if (pilihan === 'a4') {
    setStrukLayout('a4');
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

/** Kelas warna angka KEMBALIAN (panel kanan ala Aronium: angka besar).
 *  SATU sumber untuk render awal (cartGridHtml) dan update live (paintCart) —
 *  dua tempat ini pernah punya kelas terpisah dan bisa berbeda saat dirawat.
 *  Merah = uang diterima kurang; hijau = cukup/lebih; abu = belum diisi. */
function kelasKembalian(): string {
  if (!(cashIn > 0)) return 'text-gray-900 dark:text-white';
  return cashIn < total()
    ? 'text-red-600 dark:text-red-400'
    : 'text-emerald-600 dark:text-emerald-400';
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
  <div class="mx-auto max-w-md space-y-5 py-6">
    <div class="card">
      <div class="flex items-start gap-4">
        <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15">
          ${icon('shifts')}
        </span>
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">Buka shift dulu</h2>
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
const QUICK_CASH: (number | 'pas')[] = ['pas', 50000, 100000, 200000];

function cartHtml(): string {
  const scanBar = `
      <div class="card !p-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative min-w-[220px] flex-1">
            <div class="search-wrap">
              ${icon('search')}
              <input id="pos-q" class="input input-sm" type="search" autocomplete="off" role="combobox"
                     aria-expanded="false" aria-controls="pos-results" aria-autocomplete="list"
                     placeholder="Scan barcode atau ketik nama / SKU" />
            </div>
            <div id="pos-results" class="suggest hidden" role="listbox" aria-label="Hasil pencarian produk"></div>
          </div>
          <button type="button" id="pos-manual" class="btn btn-ghost">${icon('pencil')}<span>Item manual</span></button>
          ${mode === 'jual' ? `
          <button type="button" id="pos-cari" class="btn btn-ghost" title="Cari produk penuh (F3)">${icon('search')}<span>Cari</span></button>
          <button type="button" id="pos-qty" class="chip${qtyNext > 1 ? ' !border-primary !text-primary' : ''}" title="Qty untuk item BERIKUTNYA, dipakai sekali lalu kembali ke 1 (F4)">Qty ${qtyNext}</button>` : ''}
          <span class="chip ml-auto" title="Shift kasir ini">${icon('clock')}<span>Shift #${shift?.id} · ${getCashier()}</span></span>
          ${products.length ? '' : `<a href="#/products" class="chip !border-amber-500 !text-amber-600 dark:!text-amber-400">${icon('alert')}<span>Cache produk kosong — sinkron dulu di Manage</span></a>`}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
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
  const body = mode === 'jual' ? cartGridHtml() : topupHtml();
  return `
  <div class="flex h-full min-h-0 flex-col gap-3">
    ${scanBar}
    ${mode === 'jual' ? stripStokMenipis() + stripKadaluarsa() : ''}
    ${body}
  </div>`;
}

/** Keranjang + panel bayar (mode Penjualan). */
function cartGridHtml(): string {
  const sub = subtotal();
  const tot = total();
  return `
    <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_320px]">
      <div class="card-flush flex min-h-0 flex-col overflow-hidden">
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
                <th class="th th-sticky">Item</th>
                <th class="th th-sticky text-right">Harga</th>
                <th class="th th-sticky text-center">Qty</th>
                <th class="th th-sticky text-right">Diskon</th>
                <th class="th th-sticky text-right">Subtotal</th>
                <th class="th th-sticky"></th>
              </tr>
            </thead>
            <tbody id="pos-rows">${cartRows()}</tbody>
          </table>
        </div>
        <div class="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span id="pos-count">${cart.length ? `${count()} item` : 'Keranjang kosong'}</span>
          <button type="button" id="pos-clear" class="row-btn row-btn-danger" title="Kosongkan keranjang" aria-label="Kosongkan keranjang"${cart.length ? '' : ' disabled'}>${icon('trash')}</button>
        </div>
      </div>

      <div class="card flex min-h-0 flex-col gap-3 overflow-y-auto !p-4">
        <div class="flex items-baseline justify-between">
          <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Subtotal</span>
          <span id="pos-subtotal" class="text-sm font-semibold text-gray-900 dark:text-white">${rp(sub)}</span>
        </div>
        <div class="flex items-baseline justify-between" id="pos-disc-item-row" ${diskonBaris() ? '' : 'hidden'}>
          <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Diskon item</span>
          <span id="pos-disc-item" class="text-sm font-semibold text-red-600 dark:text-red-400">-${rp(diskonBaris())}</span>
        </div>
        <div>
          <label class="label" for="pos-discount">Diskon transaksi (Rp)</label>
          <input id="pos-discount" class="input input-sm" type="number" inputmode="numeric" min="0" step="500" value="${discount || ''}" placeholder="0" />
        </div>
        <!-- Panel bayar disusun mengikuti payment screen Aronium (referensi
             help.aronium.com "Payment" + screenshot paid-amount): hierarki
             TOTAL besar -> UANG DITERIMA (input besar, placeholder = total,
             meniru "Paid" yang menampilkan amount due) -> KEMBALIAN angka
             besar otomatis. Perilaku kunci tetap milik Ravaa (quick cash,
             diskon transaksi, F2/Enter). -->
        <div class="flex items-baseline justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
          <span class="text-sm font-semibold text-gray-900 dark:text-white">Total</span>
          <span id="pos-total" class="text-2xl font-bold tabular-nums text-primary">${rp(tot)}</span>
        </div>
        <div>
          <span class="label">Metode bayar</span>
          <div class="flex flex-wrap gap-2">
            ${PAY_METHODS.map((m) => `<button type="button" data-pay="${m.key}" class="chip${payMethod === m.key ? ' !border-primary !text-primary' : ''}">${m.label}</button>`).join('')}
          </div>
        </div>
        ${
          payMethod === 'tunai'
            ? `<div>
                 <label class="label" for="pos-cash">Uang diterima (Rp)</label>
                 <input id="pos-cash" class="input text-right text-lg font-semibold tabular-nums" type="number" inputmode="numeric" min="0" step="1000" value="${cashIn || ''}" placeholder="${tot}" />
               </div>
               <div>
                 <span class="label">Nominal cepat</span>
                 <div class="flex flex-wrap gap-2">
                   ${QUICK_CASH.map((c) => `<button type="button" data-cash="${c}" class="chip${cashIn > 0 && cashIn === (c === 'pas' ? tot : c) ? ' !border-primary !text-primary' : ''}">${c === 'pas' ? 'Uang pas' : rp(c)}</button>`).join('')}
                 </div>
               </div>
               <div class="flex items-baseline justify-between">
                 <span class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Kembalian</span>
                 <span id="pos-change" class="text-xl font-bold tabular-nums ${kelasKembalian()}">${rp(change())}</span>
               </div>`
            : ''
        }
        <button type="button" id="pos-pay" class="btn btn-primary mt-auto w-full !py-3 text-base"${cart.length ? '' : ' disabled'}>${icon('check')}<span>Bayar</span></button>
        <p class="text-center text-xs text-gray-500 dark:text-gray-400">Tekan <kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">F2</kbd> atau <kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">Enter</kbd> untuk bayar cepat</p>
      </div>
    </div>`;
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
  <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_320px]">
    <div class="card min-h-0 space-y-4 overflow-y-auto !p-4">
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
        <input id="tp-nominal" class="input text-lg font-semibold" type="number" inputmode="numeric" min="0" step="1000" placeholder="0" value="${topNominal || ''}" />
        <div class="mt-2 flex flex-wrap gap-2">
          ${QUICK_NOMINAL.map((n) => `<button type="button" class="chip" data-quick="${n}">${rp(n)}</button>`).join('')}
        </div>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">Nominal adalah saldo yang diterima pelanggan, bukan omzet toko. Omzet toko dari layanan ini adalah biaya admin.</p>
    </div>

    <div class="card flex min-h-0 flex-col gap-3 overflow-y-auto !p-4">
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
        <span id="tp-total" class="text-xl font-bold text-primary">${rp(total)}</span>
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
      <button type="button" id="tp-submit" class="btn btn-primary mt-auto w-full !py-3 text-base"${busy ? ' disabled' : ''}>${icon('check')}<span>Proses ${judul}</span></button>
      <p class="text-center text-xs text-gray-500 dark:text-gray-400">Tekan <kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">Enter</kbd> untuk proses, <kbd class="rounded border border-gray-300 px-1 dark:border-gray-600">F2</kbd> untuk proses cepat</p>
    </div>
  </div>`;
}

function cartRows(): string {
  if (!cart.length) {
    return `<tr><td colspan="6"><div class="empty">Scan barcode atau ketik nama produk, lalu tekan Enter.</div></td></tr>`;
  }
  return cart
    .map((l) => {
      const gross = jumlahBaris(l);
      const net = gross - l.discount;
      // Baris catatan (produk use_note=1): input satu baris DI BAWAH baris
      // produk, mis. Cetak Banner -> "ukuran 1 x 3 meter". colspan=6 = seluruh
      // lebar tabel (Item..Hapus). td TANPA class `.td` — padding kiri/kanan
      // (12px) datang dari `.table-compact td` (table-compact di cartGridHtml);
      // tanpa itu preflight membuatnya 0px dan input menempel tepi.
      // Disimpan live lewat event `input` (tanpa paintCart, supaya fokus tidak
      // pindah saat kasir mengetik).
      const trCatatan = l.useNote ? `
      <tr data-key="${l.key}" class="note-row">
        <td colspan="6">
          <input class="input input-sm w-full" type="text" maxlength="200"
            data-act="note" data-key="${l.key}" value="${esc(l.note)}"
            placeholder="Catatan (mis. ukuran 1 x 3 meter)"
            aria-label="Catatan ${esc(l.name)}" />
        </td>
      </tr>` : '';
      return `<tr data-key="${l.key}">
      <td class="td">
        <div class="cell-strong">${esc(l.name)}</div>
        <div class="cell-sub">${l.sku}${l.product_id === null ? ' · item manual' : l.track_stock ? '' : ' · jasa'}${l.unit && l.baseUnit && l.unit !== l.baseUnit ? ` · jual per ${l.unit}` : ''}${expBarisKeranjang(l.product_id)}</div>
      </td>
      <td class="td td-num">${rp(l.price)}</td>
      <td class="td">
        <div class="flex items-center justify-center gap-1">
          <button type="button" class="row-btn" data-act="dec" data-key="${l.key}" title="Kurangi" aria-label="Kurangi qty">${icon('minus')}</button>
          <input class="input input-sm !w-16 text-center" data-act="qty" data-key="${l.key}" type="number" inputmode="numeric" min="0" value="${l.qty}" aria-label="Qty ${l.name}" />
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
      <td class="td"><button type="button" class="row-btn row-btn-danger" data-act="del" data-key="${l.key}" title="Hapus" aria-label="Hapus ${esc(l.name)}">${icon('trash')}</button></td>
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
  const set = (sel: string, v: string) => {
    const el = host!.querySelector(sel);
    if (el) el.textContent = v;
  };
  set('#pos-count', cart.length ? `${count()} item` : 'Keranjang kosong');
  set('#pos-subtotal', rp(subtotal()));
  set('#pos-total', rp(total()));
  // Placeholder "Uang diterima" menampilkan amount due (pola Aronium) — panel
  // kanan tidak dirender ulang di paintCart, jadi placeholder harus diikut-
  // setiap total berubah (render awal selalu 0 karena keranjang masih kosong).
  const cashEl = host!.querySelector<HTMLInputElement>('#pos-cash');
  if (cashEl) cashEl.placeholder = String(total());
  set('#pos-change', rp(change()));
  // Baris "Diskon item" dirender sekali lalu ditampilkan/disembunyikan —
  // paintCart tidak mengganti panel kanan, jadi barisnya harus bisa hidup mati
  // lewat atribut `hidden` tanpa merender ulang (fokus input tetap aman).
  const db = diskonBaris();
  set('#pos-disc-item', `-${rp(db)}`);
  const dbRow = host!.querySelector<HTMLElement>('#pos-disc-item-row');
  if (dbRow) dbRow.hidden = db === 0;
  const changeEl = host!.querySelector('#pos-change');
  if (changeEl) {
    // Kelas diambil dari SATU sumber (kelasKembalian) — jangan ditulis ulang di
    // sini, render awal di cartGridHtml memakai fungsi yang sama.
    changeEl.className = `text-xl font-bold tabular-nums ${kelasKembalian()}`;
  }
  const pay = host!.querySelector<HTMLButtonElement>('#pos-pay');
  if (pay) pay.disabled = cart.length === 0 || busy;
  const clr = host!.querySelector<HTMLButtonElement>('#pos-clear');
  if (clr) clr.disabled = cart.length === 0;
  // Chip nominal cepat: sorot yang cocok dengan cashIn ("Uang pas" = total).
  host!.querySelectorAll<HTMLElement>('[data-cash]').forEach((b) => {
    const raw = b.dataset.cash ?? '';
    const nilai = raw === 'pas' ? total() : Number(raw);
    const aktif = cashIn > 0 && cashIn === nilai;
    b.classList.toggle('!border-primary', aktif);
    b.classList.toggle('!text-primary', aktif);
  });
}

/* ---------- aksi keranjang ---------- */

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
function addProduct(p: Product, unitSlug?: string): void {
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
      addLine(p, price, pakaiQtyNext(), unit, factor);
      paintCart();
      focusScan();
    });
    return;
  }
  addLine(p, hargaTampil, pakaiQtyNext(), unit, factor);
  paintCart();
  focusScan();
}

/** Enter / klik pada item dropdown. `unitSlug` diisi bila yang diklik adalah
 *  chip satuan, bukan baris utamanya. */
function addActive(q: string, unitSlug?: string): void {
  const p = results[active];
  if (!p) {
    toast(`Produk "${q.trim()}" tidak ditemukan`, 'warning');
    return;
  }
  closeResults();
  const inp = host?.querySelector<HTMLInputElement>('#pos-q');
  if (inp) inp.value = '';
  results = [];
  addProduct(p, unitSlug);
}

function focusScan(): void {
  host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
}

/* ---------- qty item berikutnya (chip Qty / F4) + layar cari (F3) ---------- */

/** Segarkan chip Qty di scan bar TANPA paint penuh — scanBar ikut dirender
 *  oleh paint(), bukan paintCart(), jadi teksnya harus disegarkan manual. */
function refreshQtyChip(): void {
  const b = host?.querySelector<HTMLElement>('#pos-qty');
  if (!b) return;
  b.textContent = `Qty ${qtyNext}`;
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
        : '<div class="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">Tidak ada produk yang cocok</div>';
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

async function pay(): Promise<void> {
  if (!shift || busy || !cart.length) return;
  // BARRIER TUNAI (keluhan pemilik 2026-10-03): cek lama hanya menolak
  // `0 < cashIn < total`, jadi uang diterima KOSONG (0) lolos dan transaksi
  // selesai tanpa kasir menerima uang apa pun. Sekarang metode tunai WAJIB
  // punya uang diterima > 0 dan tidak kurang dari total — meniru payment
  // screen Aronium yang tak bisa konfirmasi sebelum Paid amount masuk.
  if (payMethod === 'tunai') {
    if (!(cashIn > 0)) {
      toast('Uang diterima belum diisi — ketik nominal atau tekan "Uang pas"', 'error');
      host?.querySelector<HTMLInputElement>('#pos-cash')?.focus();
      return;
    }
    if (cashIn < total()) {
      toast(`Uang diterima kurang dari total ${rp(total())}`, 'error');
      host?.querySelector<HTMLInputElement>('#pos-cash')?.focus();
      return;
    }
  }
  busy = true;
  paintCart();
  try {
    const res = await apiPost<{ data: { sale: { id: string; total: number }; duplicate: boolean } }>('/api/sales', {
      id: uuid(),
      shift_id: shift.id,
      pay_method: payMethod,
      discount,
      cash_in: payMethod === 'tunai' ? cashIn : 0,
      cashier: getCashier(),
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
    const strukJual: Struk = {
      judul: getToko(),
      meta: [
        `${waktuStruk()} · No. ${res.data.sale.id.slice(0, 8)}`,
        `Kasir: ${getCashier()}`,
        `Shift: ${shift.id}`,
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
        ...(payMethod === 'tunai' && cashIn > 0
          ? [
              { kiri: 'Tunai', kanan: rp(cashIn) },
              { kiri: 'Kembalian', kanan: rp(kembalian) },
            ]
          : [{ kiri: labelMetode(payMethod), kanan: rp(tot) }]),
      ],
      kaki: ['Terima kasih sudah berbelanja'],
    };
    // Pilihan cetak SELESAI transaksi — HANYA bila "Cetak struk otomatis" ON.
    // Device tanpa printer (saklar mati) tidak boleh diganggu dialog; tanpa
    // guard ini backdrop swal juga memblokir seluruh UI POS (terbukti di test).
    if (autoPrint) void pilihCetakSelesai(res.data.sale.id, strukJual, tot, kembalian);
    cart = [];
    discount = 0;
    cashIn = 0;
    toast(
      `Terjual ${res.data.sale.id.slice(0, 8)} · ${rp(res.data.sale.total)}` + (kembalian > 0 ? ` · kembalian ${rp(kembalian)}` : ''),
      'success',
      5000,
    );
    // Isi kolom diskon/uang diterima dikosongkan; nilainya sudah di-reset di atas.
    const disc = host?.querySelector<HTMLInputElement>('#pos-discount');
    if (disc) disc.value = '';
    const cash = host?.querySelector<HTMLInputElement>('#pos-cash');
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
      // F3/F4 = fitur POS (layar cari / qty berikutnya). preventDefault DULU
      // sebelum guard modal: walau modal sedang terbuka tombolnya jangan jatuh
      // ke browser (Chrome membuka find bar), tapi aksinya tetap dilewati di
      // baris guard di bawah.
      if (e.key === 'F3' || e.key === 'F4') e.preventDefault();
      if (document.querySelector('.modal-overlay:not(.is-closing)')) return;
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
  const q = host!.querySelector<HTMLInputElement>('#pos-q');
  const box = host!.querySelector<HTMLElement>('#pos-results');

  // Ketik -> isi dropdown. Barcode persis/SKU persis cuma 1 hasil, jadi scanner
  // (ketik cepat + Enter) tetap jalan tanpa harus memilih.
  q?.addEventListener('input', () => {
    results = queryResults(q.value);
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
      if (!results.length) results = queryResults(v);
      if (!results.length) {
        toast(`Produk "${v.trim()}" tidak ditemukan`, 'warning');
        return;
      }
      addActive(v);
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
    addActive(q?.value ?? '', unitBtn?.dataset.unit);
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

  host!.querySelector('#pos-manual')?.addEventListener('click', openManualItem);

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

  host!.querySelectorAll<HTMLElement>('[data-pay]').forEach((b) =>
    b.addEventListener('click', () => {
      payMethod = (b.dataset.pay as PayMethod) || 'tunai';
      cashIn = 0;
      paint();
    }),
  );

  host!.querySelector('#pos-cash')?.addEventListener('input', (e) => {
    cashIn = Number((e.target as HTMLInputElement).value || 0);
    paintCart();
  });

  // Nominal cepat (chip "Uang pas" + pecahan): satu klik mengisi kolom uang
  // diterima + kembalian, menghindari salah ketik nol saat kas menerima
  // pecahan besar. paintCart tidak merender ulang panel, jadi input & state
  // aktif chip dijaga manual di sana.
  host!.querySelectorAll<HTMLElement>('[data-cash]').forEach((b) =>
    b.addEventListener('click', () => {
      const raw = b.dataset.cash ?? '';
      cashIn = raw === 'pas' ? total() : Number(raw);
      const inp = host!.querySelector<HTMLInputElement>('#pos-cash');
      if (inp) inp.value = cashIn ? String(cashIn) : '';
      paintCart();
    }),
  );

  host!.querySelector('#pos-pay')?.addEventListener('click', () => void pay());

  host!.querySelector('#pos-clear')?.addEventListener('click', () => {
    if (!cart.length) return;
    cart = [];
    discount = 0;
    cashIn = 0;
    paintCart();
    host?.querySelector<HTMLInputElement>('#pos-q')?.focus();
  });

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
  if (!el.isConnected) return;
  bindPintasan(); // F2/Enter/Esc level document — didaftarkan sekali per mount
  paint();
}
