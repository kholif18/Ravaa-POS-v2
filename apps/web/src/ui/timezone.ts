// Zona waktu PER DEVICE — disimpan di localStorage browser ini, BUKAN di server.
//
// Setiap device kasir bisa di zona waktu yang berbeda (meskipun toko satu,
// device lain mungkin di cabang atau zona berbeda). Database menyimpan semua
// waktu sebagai UTC (`datetime('now')`); zona waktu hanya memengaruhi TAMPILAN
// di layar dan cetak, bukan data yang tersimpan.
//
// Opsi zona waktu Indonesia (WIB/WITA/WIT) + UTC sebagai fallback.
export type ZonaWaktu = 'Asia/Jakarta' | 'Asia/Makassar' | 'Asia/Jayapura' | 'UTC';

export const KEY_ZONA_WAKTU = 'ravaa.timezone';

export const ZONA_WAKTU_PILIHAN: readonly { nilai: ZonaWaktu; label: string }[] = [
  { nilai: 'Asia/Jakarta', label: 'WIB — Jakarta (UTC+7)' },
  { nilai: 'Asia/Makassar', label: 'WITA — Makassar (UTC+8)' },
  { nilai: 'Asia/Jayapura', label: 'WIT — Jayapura (UTC+9)' },
  { nilai: 'UTC', label: 'UTC (bukan zona lokal)' },
];

export const ZONA_WAKTU_BAWAAN: ZonaWaktu = 'Asia/Jakarta';

/** Zona waktu aktif device ini. Default Asia/Jakarta (WIB). */
export function getZonaWaktu(): ZonaWaktu {
  try {
    const v = localStorage.getItem(KEY_ZONA_WAKTU);
    if (v && ZONA_WAKTU_PILIHAN.some((z) => z.nilai === v)) return v as ZonaWaktu;
  } catch {
    /* private mode: fallback ke bawaan */
  }
  return ZONA_WAKTU_BAWAAN;
}

export function setZonaWaktu(z: ZonaWaktu): void {
  try {
    localStorage.setItem(KEY_ZONA_WAKTU, z);
  } catch {
    /* private mode: preferensi tetap berlaku sesi ini via memori pemanggil */
  }
}

/** Format tanggal-waktu lengkap dengan zona waktu aktif.
 *  Contoh: "20 Oktober 2026 22:17". */
export function formatTanggalWaktu(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: getZonaWaktu(),
    });
  } catch {
    return String(iso);
  }
}

/** Format tanggal saja dengan zona waktu aktif.
 *  Contoh: "20 Oktober 2026". */
export function formatTanggal(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: getZonaWaktu(),
    });
  } catch {
    return String(iso);
  }
}

/** Format jam saja dengan zona waktu aktif.
 *  Contoh: "22:17". */
export function formatJam(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const m = /[ T](\d{2}):(\d{2})/.exec(String(iso));
    if (m) return `${m[1]}:${m[2]}`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: getZonaWaktu(),
    });
  } catch {
    return String(iso);
  }
}

/** Apakah zona waktu aktif bukan UTC (artinya disesuaikan zona lokal). */
export function pakaiZonaLokal(): boolean {
  return getZonaWaktu() !== 'UTC';
}
