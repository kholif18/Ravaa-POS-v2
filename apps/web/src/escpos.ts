// ESC/POS — cetak label harga & struk. DUA layout struk (sejak 2026-10-02):
//
//   * `thermal` (bawaan) — 58mm, 32 kolom, diakhiri FEED + CUT. Perangkat
//     bawaan toko: printer termal dengan pisau potong.
//   * `a4` — Epson L3110 (inkjet A4), 64 kolom, diakhiri Form Feed (0x0C)
//     TANPA perintah potong. Inkjet tidak punya pisau; tanpa FF kertas tercetak
//     tapi tidak pernah keluar (bug nyata di L3110). Dipilih lewat panel
//     Sistem -> Cetak struk (lihat ui/print-pref.ts).
//
// Modul ini TIDAK ADA padahal tercatat di AGENTS §2 sejak lama (dibuat ulang
// 2026-09-27 bersama fitur label). Web tidak menulis device: cukup POST
// `{data_base64}` ke print-agent (:9100/print) — agent (nol-dep) yang menulis
// bytes ke PRINTER_PATH. Bila tak ada printer, agent menyimpannya sebagai file,
// jadi alur ini tetap bisa diuji tanpa hardware.
//
// Setiap baris WAJIB <= kolom layout-nya setelah `ascii()`, karena byte di luar
// 0x20-0x7E bisa menggeser posisi cetak di firmware printer.

import { getStrukLayout, type LayoutStruk } from './ui/print-pref';

export const COLS = 32;
/** Lebar struk layout A4 (Epson L3110) — 64 kolom aman jauh di bawah lebar
 *  baris printer (±80 kolom pada font bawaan), jadi tidak pernah wrap sendiri. */
export const COLS_A4 = 64;

/** ESC/POS dasar. INIT mengembalikan printer ke state bawaan — dikirim setiap
 *  kali supaya sisa perintah struk sebelumnya tidak mewarisi ukuran huruf/align. */
const INIT = [0x1b, 0x40];
/** Feed n baris lalu potong. GS V 0 = potong penuh (paling luas didukung). */
const CUT = [0x1d, 0x56, 0x00];
const FEED = (n: number) => [0x1b, 0x64, n];
/** Akhir baris. TANPA ini semua baris struk menempel jadi SATU baris memanjang:
 *  firmware thermal mencetak teks begitu diterima, pemisah barisnya adalah LF. */
const LF = [0x0a];
/** Form Feed — injeksikan halaman berikutnya. Untuk inkjet (L3110) inilah
 *  perintah EJECT: tanpa GS V (yang tidak ada gunanya di printer tanpa pisau)
 *  kertas menumpuk di dalam setelah baris terakhir tercetak. */
const FF = [0x0c];
/** Kolom uang di struk (subtotal/total/kembalian). Sama untuk dua-kolom & item
 *  supaya seluruh angka rata pada kolom yang sama. */
const KOL_UANG = 14;
const BOLD = (on: boolean) => [0x1b, 0x45, on ? 1 : 0];
/** ESC a n: 0 kiri, 1 tengah, 2 kanan. */
const ALIGN = (n: 0 | 1 | 2) => [0x1b, 0x61, n];
/** GS ! n: lebar = (n>>4)+1, tinggi = (n&0x0F)+1. 0x11 = 2x2. */
const SIZE = (w: number, h: number) => [0x1d, 0x21, ((w - 1) << 4) | (h - 1)];

/** Huruf besar/kecil tidak masalah di thermal, tapi AKSEN dan karakter non-Latin
 *  (é, ·, –, ₱, dsb.) tidak ada di halaman kode bawaan dan keluar sebagai sampah
 *  yang bisa menggeser kolom. Diterjemahkan dulu, sisanya dibuang. */
export function ascii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[·•]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/Rp/gi, 'Rp')
    .replace(/[^\x20-\x7E]/g, '')
    // Karakter yang dibuang tadi bisa meninggalkan SPASI GANDA ("Pulpen  n"):
    // satu spasi, bukan bekas lubang karakter yang tidak ada di printer.
    .replace(/ {2,}/g, ' ')
    .trim();
}

export const rp = (n: number) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;

export const potong = (s: string, n: number = COLS) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`).replace(/…$/, '.');
const sp = (n: number) => ' '.repeat(Math.max(0, n));
export const kiri = (s: string, n: number = COLS) => potong(s, n) + sp(n - potong(s, n).length);
export const kanan = (s: string, n: number = COLS) => sp(n - potong(s, n).length) + potong(s, n);
export const tengah = (s: string, n: number = COLS) => {
  const t = potong(s, n);
  const kiriPad = Math.floor((n - t.length) / 2);
  return sp(kiriPad) + t + sp(n - t.length - kiriPad);
};

/** Teks jadi bytes latin-1. Setelah `ascii()` semuanya 1 byte = 1 kolom. */
function teks(s: string): number[] {
  const out: number[] = [];
  for (const ch of ascii(s)) out.push(ch.charCodeAt(0));
  return out;
}

/** Blok barcode ESC/POS (function B: GS k m n d..). HANYA untuk barcode yang
 *  bentuknya bisa divalidasi murni angka — EAN13/UPC-A/EAN8.
 *
 *  Sengaja TIDAK memakai CODE128: perintahnya butuh pemilih code-set (`{B`)
 *  yang caranya beda antar firmware, dan salah satu byte = barcode yang tidak
 *  bisa discan tanpa pemberitahuan. Kode yang tidak cocok pola di bawah akan
 *  dicetak sebagai ANGKA BIASA — tetap terbaca, cuma tidak discan. */
function blokBarcode(kode: string): number[] | null {
  const k = ascii(kode).replace(/\s+/g, '').toUpperCase();
  if (!/^\d+$/.test(k)) return null;
  const panjang = k.length;
  let m: number;
  if (panjang === 13 || panjang === 12) m = 67; // EAN13 (12 digit = tanpa check digit)
  else if (panjang === 11) m = 65; // UPC-A (11 digit = tanpa check digit)
  else if (panjang === 8 || panjang === 7) m = 68; // EAN8
  else return null;
  const tinggi = [0x1d, 0x68, 60]; // GS h 60 ~ 8mm
  const lebar = [0x1d, 0x77, 3]; // GS w 3
  const fungsiB = [0x1d, 0x6b, m, panjang, ...k.split('').map((c) => c.charCodeAt(0))];
  return [...tinggi, ...lebar, ...fungsiB];
}

export interface ProdukLabel {
  name: string;
  sku: string;
  price: number;
  unit?: string | null;
  barcode?: string | null;
}

/** Satu label harga: nama, SKU/satuan, harga besar, barcode bila valid.
 *  Potong per label (GS V 0) supaya label terpisah — bukan satu gulungan
 *  panjang yang harus dicabik manual. */
export function labelHarga(p: ProdukLabel): number[] {
  const out: number[] = [...INIT];
  const barcode = blokBarcode(p.barcode ?? '');

  out.push(...ALIGN(1), ...BOLD(true), ...teks(tengah(potong(p.name, COLS))));
  out.push(...BOLD(false), ...teks(tengah(kolomSub(p))));
  out.push(...FEED(1));
  // Harga 2x2 — angka harga adalah yang paling harus terbaca dari jarak jauh.
  out.push(...SIZE(2, 2), ...ALIGN(2), ...teks(kanan(rp(p.price), COLS / 2)), ...SIZE(1, 1));
  out.push(...FEED(1));

  if (barcode) {
    out.push(...ALIGN(1), ...barcode, ...ALIGN(1), ...teks(tengah(ascii(p.barcode ?? ''))));
  } else if (p.barcode) {
    out.push(...ALIGN(1), ...teks(tengah(`[${ascii(p.barcode)}]`)));
  }
  out.push(...FEED(3), ...CUT);
  return out;
}

function kolomSub(p: ProdukLabel): string {
  const bagian = [p.sku, p.unit && p.unit !== '-' ? p.unit : ''].filter(Boolean).join(' · ');
  return potong(bagian, COLS);
}

/** Pratinjau teks label (32 kolom) untuk dialog.
 *  Memakai helper YANG SAMA dengan `labelHarga` (tengah/kanan/kolomSub/rp)
 *  supaya isi yang dilihat kasir = isi yang keluar di kertas. Baris harga
 *  ditandai `<2x>` karena di kertas ia dicetak dua kali lebar/tinggi —
 *  menampilkan 32 kolom biasa akan berpura-pura beda dari kenyataan. */
export function teksLabel(p: ProdukLabel): string[] {
  const barcode = blokBarcode(p.barcode ?? '');
  const baris = [
    tengah(potong(p.name, COLS)),
    tengah(kolomSub(p)),
    '',
    `${kanan(rp(p.price), COLS / 2)}   <2x>`,
    '',
  ];
  if (barcode) baris.push('[barcode]', tengah(ascii(p.barcode ?? '')));
  else if (p.barcode) baris.push(tengah(`[${ascii(p.barcode)}]`));
  baris.push('', '--- potong ---');
  return baris;
}

/* ---------- struk ---------- */

export interface StrukItem {
  name: string; qty: number; price: number;
  /** Satuan jual bila BUKAN satuan dasar produk (fitur #3). Dibiarkan undefined
   *  untuk penjualan satuan dasar supaya format struk lama tidak berubah:
   *  "1 x Aqua 600ml" tetap "1 x Aqua 600ml", sedangkan "2 pack" jadi
   *  "2 pack x Pulpen Hitam". */
  unit?: string;
  /** Catatan per baris dari keranjang POS (produk use_note=1), mis.
   *  "ukuran 1 x 3 meter" untuk Cetak Banner. Tercetak di baris bawah item
   *  dengan indent "  - ". undefined/' ' = tanpa catatan (baris lama tidak
   *  berubah). */
  note?: string;
}
/** Satu baris rincian: kiri label, kanan angka. `tebal` untuk TOTAL. */
export interface StrukBaris { kiri: string; kanan: string; tebal?: boolean }

export interface Struk {
  /** Nama toko (baris paling atas, tebal, rata tengah). */
  judul: string;
  subjudul?: string;
  /** Baris info transaksi (tanggal, no, kasir, shift) — rata tengah, satu per baris. */
  meta: string[];
  items: StrukItem[];
  /** Subtotal / Diskon / TOTAL / Tunai / Kembalian — sudah berpasangan. */
  baris: StrukBaris[];
  kaki?: string[];
}

const garis = () => '-'.repeat(COLS);

/** Baris catatan item (fitur catatan per baris): "  - <teks>".
 *  `ascii()` dijalankan pada ISI dulu, indent ditambahkan BELAKANGAN — kalau
 *  dilewatkan lewat teks()/baris() biasa, ascii() menjalankan
 *  `.replace(/ {2,}/g,' ') + .trim()` (lihat ascii()) dan kedua spasi indent
 *  ikut terbuang sehingga catatan nempel rata kiri dengan baris item. */
function byteCatatan(note: string, lebar: number): number[] {
  const isi = '  - ' + potong(ascii(note.trim()), lebar - 4);
  return [...isi].map((ch) => ch.charCodeAt(0));
}

/** Baris dua kolom: kanan (angka uang) selalu utuh menempel di tepi kanan,
 *  kiri dipotong lebih dulu. Tanpa urutan ini, nama panjang menelan kolom uang
 *  dan struk jadi tidak terbaca. */
function duaKiriKanan(kiri: string, kanan: string): string {
  const r = potong(kanan, KOL_UANG);
  const l = potong(kiri, COLS - r.length - 1);
  return l + sp(COLS - l.length - r.length) + r;
}

/** Struk 32 kolom: INIT -> header -> item -> rincian (TOTAL tebal) -> kaki -> FEED -> CUT.
 *  Layout di sini PANDUAN, bukan spesifikasi cetak: yang mengisi `baris` adalah
 *  pemanggil (POS tahu subtotal/diskon/kembalian), escpos hanya menyusun. */
export function struk(s: Struk): number[] {
  const out: number[] = [...INIT, ...ALIGN(1)];

  const baris = (teksBaris: string) => out.push(...teks(teksBaris), ...LF);

  baris(tengah(potong(s.judul, COLS)));
  if (s.subjudul) baris(tengah(potong(s.subjudul, COLS)));
  for (const m of s.meta) baris(tengah(potong(m, COLS)));

  // Struk topup/tarik tidak punya item: blok item beserta dua garisnya dilewati
  // seluruhnya, supaya tidak tercetak "(tanpa item)" atau garis dua kali.
  if (s.items.length) {
    out.push(...teks(garis()), ...LF);
    for (const it of s.items) {
      const qty = `${it.qty}${it.unit ? ` ${it.unit}` : ''} x `;
      // nama = COLS - KOL_UANG - 1 (satu spasi pemisah) -> tepat 32 kolom.
      // Sebelumnya salah hitung jadi 33, kolom terakhir meluber ke baris berikutnya.
      const nama = potong(qty + it.name, COLS - KOL_UANG - 1);
      baris(kanan(nama, COLS - KOL_UANG - 1) + ' ' + kanan(rp(it.qty * it.price), KOL_UANG));
      // Catatan baris (mis. "ukuran 1 x 3 meter") — indent "  - " di bawah item.
      if (it.note?.trim()) out.push(...byteCatatan(it.note, COLS), ...LF);
    }
  }
  out.push(...teks(garis()), ...LF);

  for (const b of s.baris) {
    out.push(...BOLD(!!b.tebal));
    baris(duaKiriKanan(b.kiri, b.kanan));
    out.push(...BOLD(false));
  }

  out.push(...teks(garis()), ...LF);
  for (const k of s.kaki ?? []) baris(tengah(potong(k, COLS)));

  out.push(...FEED(4), ...CUT);
  return out;
}

const garisA4 = () => '-'.repeat(COLS_A4);

/** Baris dua kolom versi A4 — urutan yang sama dengan `duaKiriKanan`:
 *  uang dipotong dulu lalu menempel di tepi kanan kolom 64. */
function duaKiriKananA4(kiri: string, kanan_: string): string {
  const r = potong(kanan_, KOL_UANG);
  const l = potong(kiri, COLS_A4 - r.length - 1);
  return l + sp(COLS_A4 - l.length - r.length) + r;
}

/** Struk layout A4 (Epson L3110): INIT -> judul dobel-lebar -> item ->
 *  rincian (TOTAL tebal) -> kaki -> FEED -> Form Feed. TANPA perintah potong —
 *  inkjet tidak punya pisau, dan barisnya 64 kolom (lihat header berkas).
 *  Menerima Struk yang SAMA dengan `struk()`; hanya penyajiannya berbeda. */
export function strukA4(s: Struk): number[] {
  const out: number[] = [...INIT, ...ALIGN(1)];

  const baris = (teksBaris: string) => out.push(...teks(teksBaris), ...LF);

  // Judul dobel lebar (GS ! 0x10) + tebal: kertas A4 lega. Padding dihitung
  // setengah lebar (32) karena tiap karakter tercetak 2 kolom — kalau dipakai
  // tengah(64) barisnya akan meluber dua baris dan tidak lagi rata tengah.
  out.push(
    ...SIZE(2, 1), ...BOLD(true),
    ...teks(tengah(potong(s.judul, COLS_A4 / 2), COLS_A4 / 2)), ...LF,
    ...SIZE(1, 1), ...BOLD(false),
  );
  if (s.subjudul) baris(tengah(potong(s.subjudul, COLS_A4)));
  for (const m of s.meta) baris(tengah(potong(m, COLS_A4)));

  // Struk topup/tarik tanpa item: blok item + dua garisnya dilewati (aturan
  // yang sama dengan struk thermal — tidak ada "(tanpa item)"/garis ganda).
  if (s.items.length) {
    out.push(...teks(garisA4()), ...LF);
    for (const it of s.items) {
      const qty = `${it.qty}${it.unit ? ` ${it.unit}` : ''} x `;
      const nama = potong(qty + it.name, COLS_A4 - KOL_UANG - 1);
      baris(kanan(nama, COLS_A4 - KOL_UANG - 1) + ' ' + kanan(rp(it.qty * it.price), KOL_UANG));
      // Aturan sama dengan struk thermal: indent "  - ", dipotong ke 64 kolom.
      if (it.note?.trim()) out.push(...byteCatatan(it.note, COLS_A4), ...LF);
    }
  }
  out.push(...teks(garisA4()), ...LF);

  for (const b of s.baris) {
    out.push(...BOLD(!!b.tebal));
    baris(duaKiriKananA4(b.kiri, b.kanan));
    out.push(...BOLD(false));
  }

  out.push(...teks(garisA4()), ...LF);
  for (const k of s.kaki ?? []) baris(tengah(potong(k, COLS_A4)));

  // Akhir: feed 3 baris (margin bawah) + Form Feed. BUKAN CUT.
  out.push(...FEED(3), ...FF);
  return out;
}

/** Pilih layout struk sesuai preferensi device ini (panel Sistem -> Cetak).
 *  Parameter `layout` bisa ditimpa untuk test unit tanpa localStorage. */
export function strukUntuk(s: Struk, layout: LayoutStruk = getStrukLayout()): number[] {
  return layout === 'a4' ? strukA4(s) : struk(s);
}

/** Sesuaikan stream NON-struk (label harga dsb.) dengan printer aktif:
 *  thermal = apa adanya; a4 = buang SEMUA perintah potong (inkjet tanpa pisau)
 *  lalu tutup dengan Form Feed, supaya kertas keluar setelah batch selesai. */
export function sesuaikanPrinter(bytes: number[], layout: LayoutStruk = getStrukLayout()): number[] {
  if (layout !== 'a4') return bytes;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x1d && bytes[i + 1] === 0x56 && bytes[i + 2] === 0x00) {
      i += 2; // lompati GS V 0x00
      continue;
    }
    out.push(bytes[i]);
  }
  return [...out, ...FEED(2), ...FF];
}

/** Gabung beberapa label jadi SATU stream (dipotong per label di dalamnya). */
export function gabungLabel(list: ProdukLabel[]): number[] {
  return list.flatMap(labelHarga);
}

export function keBase64(bytes: number[]): string {
  // Chunked: String.fromCharCode(...besar) bikin stack overflow di ribuan byte.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(bin);
}

/** URL print-agent per device (bisa beda tiap PC kasir). Disimpan di localStorage
 *  karena host web bisa jalan di server sementara agent di PC kasir. */
export const AGENT_KEY = 'ravaa.printagent';
export function urlAgent(): string {
  try {
    return localStorage.getItem(AGENT_KEY) || 'http://localhost:9100';
  } catch {
    return 'http://localhost:9100';
  }
}

/** Kirim bytes ke print-agent. Melempar Error dengan pesan yang bisa ditampilkan
 *  ke kasir (agent tidak jalan / printer tidak ketemu / CORS). */
export async function kirimPrint(bytes: number[]): Promise<string> {
  const res = await fetch(`${urlAgent()}/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data_base64: keBase64(bytes) }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; via?: string };
  if (!res.ok || j.error) throw new Error(j.error ?? `print-agent tidak menjawab (HTTP ${res.status})`);
  return j.via ?? '';
}
