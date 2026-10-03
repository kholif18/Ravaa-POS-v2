// Cache master di IndexedDB: produk + maxVersion.
// Semua pencarian/filter jalan lokal -> respons instan (<50ms), tanpa tunggu server.

export type Product = {
  id: number; category_id: number; sku: string; barcode: string | null;
  name: string; unit: string;
  price: number; price_dynamic: number; cost: number; markup: number;
  /** Modal rata-rata tertimbang dari restock (HPP). Bukan `cost` — lihat schema.sql. */
  avg_cost: number;
  stock: number; min_stock: number; is_active: number;
  /** Nama file foto (bukan dataURL, bukan path) — diambil lewat
   *  GET /api/products/:id/image. `undefined` di payload POST = tidak diubah. */
  image: string | null;
  /** Diskon permanen produk: 'rp' = potongan rupiah, 'pct' = persen harga jual.
   *  Dipakai POS sebagai pratinjau diskon per baris (boleh diubah kasir). */
  discount_type: 'rp' | 'pct';
  discount: number;
  /** Tanggal kadaluarsa YYYY-MM-DD (snack & es krim). */
  expiry_date: string | null;
  /** 1 = baris keranjang produk ini punya input catatan (mis. Cetak Banner ->
   *  "ukuran 1 x 3 meter") yang ikut tercetak di struk (kolom `use_note`). */
  use_note: number;
  /** Tombstone: diisi = produk sudah dihapus di server -> dibuang dari cache. */
  deleted_at: string | null;
  category_slug: string; category_name: string; track_stock: number; version: number;
  /** Satuan jual ALTERNATIF (fitur #3). Satuan dasar = `unit` + `price` di atas
   *  dan sengaja TIDAK jadi baris. Selalu ada (array kosong bila tidak ada). */
  units: { unit: string; factor: number; price: number | null }[];
};

/** Satuan jual sebuah baris keranjang. `unit` = satuan dasar (produk tanpa
 *  satuan alternatif) atau satuan yang dipilih dari chip. */
export type SaleUnit = { unit: string; factor: number; price: number | null };

/** `use_expiry` = 1: form produk kategori ini menampilkan "Tanggal kadaluarsa"
 *  (lihat kolom `categories.use_expiry`). Nilai lama yang belum punya kolom ini
 *  dibaca sebagai 0, jadi cache basi tidak perlu dinormalisasi. */
export type Category = { id: number; slug: string; name: string; track_stock: number; sort: number; use_expiry: number };

/** Master satuan. Tidak di-cache di IndexedDB (sama seperti kategori): diambil
 *  fresh dari server tiap buka halaman — daftarnya kecil dan jarang berubah. */
export type Unit = { id: number; slug: string; name: string; dipakai: number };

const DB = 'ravaa';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).get(key);
    q.onsuccess = () => resolve(q.result as T | undefined);
    q.onerror = () => reject(q.error);
  });
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedProducts(): Promise<Product[]> {
  const rows = (await kvGet<Product[]>('products')) ?? [];
  // Cache lama (sebelum fitur #3) tersimpan tanpa field `units`, dan produk itu
  // tidak ikut delta sync karena version-nya tidak berubah — jadi dinormalisasi
  // saat dibaca supaya POS tidak crash mencari `p.units` yang undefined.
  // Kondisi yang SAMA berlaku untuk field baru 2026-09-29 (foto/diskon/kadaluarsa):
  // produk yang tidak berubah tidak pernah dikirim ulang oleh ?since=, jadi baris
  // cache lama datang tanpa kolom itu dan harus diberi default saat dibaca.
  return rows.map((p) => ({
    ...p,
    units: p.units ?? [],
    image: p.image ?? null,
    discount_type: p.discount_type ?? 'rp',
    discount: p.discount ?? 0,
    expiry_date: p.expiry_date ?? null,
    use_note: p.use_note ?? 0,
  }));
}
export async function getMaxVersion(): Promise<number> {
  return (await kvGet<number>('maxVersion')) ?? 0;
}

// Tarik delta dari server (?since=maxVersion), gabung per sku, simpan.
// Bila versi server mundur di bawah `since` (fresh install / restore), otomatis
// tarik ulang dari nol dan ganti seluruh cache — lihat cabang di bawah.
export async function syncMaster(
  fetchDelta: (since: number) => Promise<{ data: Product[]; maxVersion: number }>,
): Promise<{ added: number; total: number }> {
  let since = await getMaxVersion();
  let delta = await fetchDelta(since);
  let gantiTotal = false;
  if (delta.maxVersion < since) {
    // Versi server MUNDUR di bawah `since`. Terjadi setelah fresh install /
    // restore backup / DB diganti — dan AGENTS §5 memang menyuruh `rm data.db`
    // + `npm run seed`, jadi kejadian ini pasti terulang tiap migrasi.
    // Akibatnya dua kali lipat: (1) delta sejak `since` tidak akan pernah berisi
    // apa pun karena server hanya punya version <= maxVersion, lalu
    // `Math.max(since, maxVersion)` di bawah mengunci `since` di angka lama
    // selamanya sehingga semua perubahan baru tak pernah sampai; (2) baris lama
    // (mis. SKU lama sebelum rename) tetap nempel di IndexedDB karena merge
    // tidak pernah menghapus key yang tidak dikirim ulang server.
    // Solusi: tarik ulang dari nol dan GANTI cache, bukan merge.
    since = 0;
    delta = await fetchDelta(0);
    gantiTotal = true;
  }
  const { data, maxVersion } = delta;
  // Cache hanya cerminan server, bukan sumber kebenaran — menggantinya dengan
  // isi server tidak pernah membuang data yang sah (outbox ada di localStorage,
  // terpisah dari IndexedDB ini).
  const cur = gantiTotal ? [] : await getCachedProducts();
  const map = new Map(cur.map((p) => [p.sku, p]));
  for (const p of data) {
    // Tombstone (deleted_at terisi): produk sudah dihapus di server -> BUANG dari
    // cache, jangan merge. Tanpa cabang ini produk yang dihapus di server tetap
    // nempel selamanya: delta sync hanya mengirim p.version > since, dan merge
    // map tidak pernah menghapus key. Lihat DELETE /api/products/:id.
    if (p.deleted_at) map.delete(p.sku);
    else map.set(p.sku, p);
  }
  const total = [...map.values()];
  await kvSet('products', total);
  await kvSet('maxVersion', Math.max(since, maxVersion));
  return { added: data.length, total: total.length };
}

export async function fullReset(): Promise<void> {
  await kvSet('products', []);
  await kvSet('maxVersion', 0);
}

// Produk yang dinonaktifkan TIDAK PERNAH dikembalikan API pada mode normal,
// jadi cache tidak bisa "tahu" kalau ia dimatikan. Caller (tombol Nonaktifkan)
// harus membuangnya lewat helper ini. Beda kasus dengan produk yang DIHAPUS:
// tombstone-nya dikirim API di mode delta dan otomatis dibuang syncMaster().
export async function removeProductBySku(sku: string): Promise<void> {
  const cur = await getCachedProducts();
  await kvSet('products', cur.filter((p) => p.sku !== sku));
}
