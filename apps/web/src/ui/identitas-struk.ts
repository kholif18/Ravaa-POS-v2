/// <reference types="vite/client" />

/**
 * identitas-struk.ts
 * Helper sinkronisasi nama toko untuk struk thermal dari server (Identitas toko)
 * Mengganti pola getToko/setToko berbasis localStorage per-device.
 */

const STORE_KEY = 'ravaa.store_name';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 menit
const OPSI_KEY = 'ravaa.opsi-cetak';

interface CacheRecord {
  value: string;
  ts: number;
}

/** Opsi dokumen & struk yang berlaku untuk SEMUA device (GET /api/settings).
 *  Disimpan di localStorage supaya jalur cetak yang tidak sempat fetch
 *  (mis. struk dari POS yang baru dibuka) tetap memakai pilihan pemilik. */
export interface OpsiCetak {
  invoice_title: string;
  invoice_footer: string;
  receipt_footer: string;
  /** CSV token `name,address,phone` — urutan = urutan baris struk. */
  receipt_customer: string;
  receipt_show_items: boolean;
  receipt_short_no: boolean;
  receipt_show_debt: boolean;
}

export const OPSI_CETAK_BAWAAN: OpsiCetak = {
  invoice_title: 'INVOICE',
  // Footer A4 = teks TAMBAHAN; baris "Dicetak melalui Ravaa POS pada: <tanggal>" selalu
  // dicetak builder dokumen (permintaan pemilik 2026-10-21).
  invoice_footer: '',
  receipt_footer: 'Terima kasih sudah berbelanja',
  receipt_customer: 'name',
  receipt_show_items: true,
  receipt_short_no: false,
  receipt_show_debt: true,
};

function now(): number { return Date.now(); }

function readCache(): CacheRecord | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as CacheRecord;
    if (typeof rec.value === 'string' && typeof rec.ts === 'number') return rec;
  } catch {}
  return null;
}

function writeCache(val: string) {
  try {
    const rec: CacheRecord = { value: val, ts: now() };
    localStorage.setItem(STORE_KEY, JSON.stringify(rec));
  } catch {}
}

/**
 * Ambil nama toko dari cache lokal, fallback 'RAVA POS'.
 * Tidak mengakses network.
 */
export function getStoreNameFromCache(): string {
  const rec = readCache();
  if (rec && now() - rec.ts < CACHE_TTL_MS) {
    return rec.value || 'RAVA POS';
  }
  return 'RAVA POS';
}

/**
 * Taruh nama toko ke cache lokal dengan timestamp.
 */
export function setStoreNameCache(val: string) {
  const cleaned = (val ?? '').trim();
  writeCache(cleaned || 'RAVA POS');
}

/**
 * Sync cache dari server settings (store_name).
 * Bisa dipanggil setelah GET /api/settings berhasil.
 */
export function syncStoreNameFromServer(storeName: string) {
  const cleaned = (storeName ?? '').trim() || 'RAVA POS';
  setStoreNameCache(cleaned);
}

let opsiMem: OpsiCetak | null = null;

function normalisasiOpsi(sumber: Partial<OpsiCetak> | null | undefined): OpsiCetak {
  const hasil: OpsiCetak = { ...OPSI_CETAK_BAWAAN };
  if (!sumber) return hasil;
  for (const k of ['invoice_title', 'invoice_footer', 'receipt_footer', 'receipt_customer'] as const) {
    const v = sumber[k];
    if (typeof v === 'string') hasil[k] = v;
  }
  for (const k of ['receipt_show_items', 'receipt_short_no', 'receipt_show_debt'] as const) {
    const v = sumber[k];
    if (typeof v === 'boolean') hasil[k] = v;
  }
  // CSV token dikenal saja; urutan dipertahankan. String kosong = tanpa baris
  // pelanggan (pemilik memang boleh mematikan seluruh detail). Token asing
  // (mis. 'email' dari cache lama) dibuang — server juga menolaknya.
  const token = hasil.receipt_customer.split(',').map((t) => t.trim()).filter(Boolean)
    .filter((t) => t === 'name' || t === 'address' || t === 'phone');
  hasil.receipt_customer = [...new Set(token)].join(',');
  return hasil;
}

/** Baca opsi cetak dari cache (tanpa network). */
export function getOpsiCetak(): OpsiCetak {
  if (opsiMem) return { ...opsiMem };
  try {
    const raw = localStorage.getItem(OPSI_KEY);
    if (raw) opsiMem = normalisasiOpsi(JSON.parse(raw) as Partial<OpsiCetak>);
  } catch {}
  opsiMem ??= { ...OPSI_CETAK_BAWAAN };
  return { ...opsiMem };
}

/** Tulis opsi cetak (parsial) ke cache localStorage + memori. Dipakai
 *  halaman Sistem setelah simpan dan sinkronisasi mount POS/Riwayat/Pesanan.
 *  Kunci yang tidak dikirim (undefined) TIDAK menimpa cache — respons server
 *  lama/parsial tidak boleh mengembalikan footer yang sudah diubah pemilik. */
export function setOpsiCetak(partial: Partial<OpsiCetak>): OpsiCetak {
  const gabung: OpsiCetak = { ...getOpsiCetak() };
  for (const k of ['invoice_title', 'invoice_footer', 'receipt_footer', 'receipt_customer'] as const) {
    const v = partial[k];
    if (typeof v === 'string') gabung[k] = v;
  }
  for (const k of ['receipt_show_items', 'receipt_short_no', 'receipt_show_debt'] as const) {
    const v = partial[k];
    if (typeof v === 'boolean') gabung[k] = v;
  }
  const baru = normalisasiOpsi(gabung);
  opsiMem = baru;
  try {
    localStorage.setItem(OPSI_KEY, JSON.stringify(baru));
  } catch {}
  return { ...baru };
}

/** Sinkron dari GET /api/settings — nama toko + opsi dokumen sekaligus. */
export function syncDariServerSettings(s: {
  store_name?: string;
  invoice_title?: string;
  invoice_footer?: string;
  receipt_footer?: string;
  receipt_customer?: string;
  receipt_show_items?: boolean;
  receipt_short_no?: boolean;
  receipt_show_debt?: boolean;
}): void {
  if (typeof s.store_name === 'string') syncStoreNameFromServer(s.store_name);
  setOpsiCetak({
    invoice_title: s.invoice_title,
    invoice_footer: s.invoice_footer,
    receipt_footer: s.receipt_footer,
    receipt_customer: s.receipt_customer,
    receipt_show_items: s.receipt_show_items,
    receipt_short_no: s.receipt_short_no,
    receipt_show_debt: s.receipt_show_debt,
  });
}

/** Nomor struk pendek ala Aronium: hanya urutan hariannya
 *  (`261020-000012` -> `000012`). Nilai non-invoice (uuid layanan) dipotong
 *  8 karakter seperti perilaku lama. */
export function nomorStrukPendek(nomor: string, pendek = getOpsiCetak().receipt_short_no): string {
  const n = (nomor ?? '').trim();
  if (!n) return '';
  if (!pendek) return n;
  const m = /^\d{6}-(\d+)$/.exec(n);
  return m ? m[1] : n.slice(0, 8);
}

export interface KontakStruk {
  name?: string;
  address?: string;
  phone?: string;
}

/** Pecah teks panjang jadi beberapa baris (kata dipertahankan; kata yang
 *  lebih panjang dari lebar dipotong per potongan). */
function bungkusTeks(teks: string, lebar: number): string[] {
  const bersih = (teks ?? '').replace(/\s+/g, ' ').trim();
  if (!bersih) return [];
  const out: string[] = [];
  let baris = '';
  for (const kata of bersih.split(' ')) {
    if (!baris) {
      if (kata.length <= lebar) baris = kata;
      else {
        for (let i = 0; i < kata.length; i += lebar) out.push(kata.slice(i, i + lebar));
        baris = '';
      }
    } else if (baris.length + 1 + kata.length <= lebar) {
      baris += ` ${kata}`;
    } else {
      out.push(baris);
      baris = kata.length <= lebar ? kata : '';
      if (kata.length > lebar) {
        for (let i = 0; i < kata.length; i += lebar) out.push(kata.slice(i, i + lebar));
      }
    }
  }
  if (baris) out.push(baris);
  return out;
}

function barisKontak(label: string, nilai: string | undefined, lebar: number): string[] {
  const isi = (nilai ?? '').trim();
  if (!isi) return [];
  const awalan = `${label}: `;
  const potong = bungkusTeks(isi, Math.max(8, lebar - awalan.length));
  return potong.map((b, i) => (i === 0 ? awalan + b : ' '.repeat(awalan.length) + b));
}

/** Baris meta pelanggan sesuai pilihan `receipt_customer` (urutan token =
 *  urutan baris). Mengembalikan [] bila tak ada yang dipilih / tak ada data. */
export function metaPelangganStruk(kontak: KontakStruk | null | undefined, lebar = 32): string[] {
  const opsi = getOpsiCetak();
  const token = opsi.receipt_customer.split(',').map((t) => t.trim()).filter(Boolean);
  if (!kontak || !token.length) return [];
  const hasil: string[] = [];
  for (const t of token) {
    if (t === 'name') hasil.push(...barisKontak('Pelanggan', kontak.name || 'Pelanggan Umum', lebar));
    else if (t === 'address') hasil.push(...barisKontak('Alamat', kontak.address, lebar));
    else if (t === 'phone') hasil.push(...barisKontak('Telp', kontak.phone, lebar));
  }
  return hasil;
}

/** Teks jumlah item untuk struk ('' bila opsi dimatikan). */
export function teksJumlahItem(jumlahBaris: number, totalQty: number): string {
  if (!getOpsiCetak().receipt_show_items) return '';
  // Baris item dan total qty bisa berbeda (mis. 2 pack + 1 pcs); tampilkan
  // keduanya hanya bila berbeda supaya struk tetap ringkas.
  const n = Math.max(0, Math.floor(jumlahBaris));
  if (!n) return '';
  const qty = Math.max(0, totalQty);
  return qty && qty !== n ? `Jumlah item: ${n} baris · ${qty} qty` : `Jumlah item: ${n}`;
}

/** Footer struk thermal dari pengaturan server ('') = tanpa footer. */
export function footerStruk(): string {
  return getOpsiCetak().receipt_footer.trim();
}

/**
 * Alias kompatibilitas lama: getToko/setToko
 */
export function getToko(): string {
  return getStoreNameFromCache();
}
export function setToko(val: string) {
  setStoreNameCache(val);
}

/**
 * Reset cache (digunakan di test).
 */
export function _resetCacheForTest() {
  opsiMem = null;
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(OPSI_KEY);
  } catch {}
}
