// Cache master di IndexedDB: produk + maxVersion.
// Semua pencarian/filter jalan lokal -> respons instan (<50ms), tanpa tunggu server.

export type Product = {
  id: number; category_id: number; sku: string; barcode: string | null;
  name: string; unit: string;
  price: number; price_dynamic: number; cost: number; markup: number;
  /** Modal rata-rata tertimbang dari restock (HPP). Bukan `cost` — lihat schema.sql. */
  avg_cost: number;
  stock: number; min_stock: number; is_active: number;
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

export type Category = { id: number; slug: string; name: string; track_stock: number; sort: number };

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
  return rows.map((p) => ({ ...p, units: p.units ?? [] }));
}
export async function getMaxVersion(): Promise<number> {
  return (await kvGet<number>('maxVersion')) ?? 0;
}

// Tarik delta dari server (?since=maxVersion), gabung per sku, simpan.
export async function syncMaster(
  fetchDelta: (since: number) => Promise<{ data: Product[]; maxVersion: number }>,
): Promise<{ added: number; total: number }> {
  const since = await getMaxVersion();
  const { data, maxVersion } = await fetchDelta(since);
  const cur = await getCachedProducts();
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
