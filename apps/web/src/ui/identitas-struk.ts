/// <reference types="vite/client" />

/**
 * identitas-struk.ts
 * Helper sinkronisasi nama toko untuk struk thermal dari server (Identitas toko)
 * Mengganti pola getToko/setToko berbasis localStorage per-device.
 */

const STORE_KEY = 'ravaa.store_name';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 menit

interface CacheRecord {
  value: string;
  ts: number;
}

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
  try { localStorage.removeItem(STORE_KEY); } catch {}
}
