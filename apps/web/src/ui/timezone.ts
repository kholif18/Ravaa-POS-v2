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

/** Parse waktu dari server. SQLite `datetime('now')` menyimpan UTC TANPA
 *  penanda zona ("YYYY-MM-DD HH:MM:SS"); `new Date()` membacanya sebagai
 *  waktu LOKAL perangkat sehingga tampilan selalu meleset sebesar offset.
 *  Tambahkan "Z" hanya untuk bentuk tanpa zona — string ISO ber-Z/offset
 *  dibiarkan apa adanya. */
function parseWaktu(iso: string): Date {
  const s = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return new Date(`${s.replace(' ', 'T')}Z`);
  }
  return new Date(s);
}

/** Format tanggal-waktu lengkap dengan zona waktu aktif.
 *  Contoh: "20 Oktober 2026 22:17". */
export function formatTanggalWaktu(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = parseWaktu(String(iso));
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

/** Format tanggal-waktu lengkap DENGAN DETIK, dipakai baris footer dokumen
 *  cetak ("Dicetak melalui Ravaa POS pada: 20 Oktober 2026 20:44:56"). Pemisah jam dipaksa
 *  titik dua supaya identik dengan contoh cetak pemilik. */
export function formatTanggalWaktuDetik(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = parseWaktu(String(iso));
    if (Number.isNaN(d.getTime())) return String(iso);
    const tz = getZonaWaktu();
    const tanggal = d.toLocaleDateString('id-ID', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
    });
    const jam = d.toLocaleTimeString('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: tz,
    }).replace(/\./g, ':');
    return `${tanggal} ${jam}`;
  } catch {
    return String(iso);
  }
}

/** Format tanggal saja dengan zona waktu aktif.
 *  Contoh: "20 Oktober 2026". */
export function formatTanggal(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const s = String(iso).trim();
    // Tanggal saja (YYYY-MM-DD) = tanggal kalender, bukan instant — jangan
    // digeser zona waktu.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
      ? new Date(`${s}T00:00:00Z`)
      : parseWaktu(s);
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
    const d = parseWaktu(String(iso));
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: getZonaWaktu(),
    }).replace(/\./g, ':');
  } catch {
    return String(iso);
  }
}

/** Apakah zona waktu aktif bukan UTC (artinya disesuaikan zona lokal). */
export function pakaiZonaLokal(): boolean {
  return getZonaWaktu() !== 'UTC';
}
