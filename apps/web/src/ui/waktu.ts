// Format waktu riwayat — dipakai halaman Stok (mutasi) dan Riwayat transaksi.
//
// Pindah dari `pages/stock.ts` 2026-09-30 saat halaman Riwayat transaksi dibuat:
// dua halaman yang menampilkan `datetime('now')` tidak boleh mengubah cara
// menafsirkannya sendiri-sendiri.

/** Waktu dari SQLite `datetime('now')` (UTC) ditampilkan APA ADANYA, tanpa
 *  dikonversi ke zona lokal. Konversi malah menipu: laporan harian juga memakai
 *  `date(created_at)` di sisi server, jadi angka tanggal di riwayat dan di
 *  laporan harus membaca jam yang sama. */
export function waktu(s: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s ?? ''));
  if (!m) return String(s ?? '—');
  const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${Number(m[3])} ${bulan[Number(m[2]) - 1]} ${m[1]} · ${m[4]}:${m[5]}`;
}

/** Jam saja ("14:03") untuk kolom Waktu di linimasa — tanggalnya sudah
 *  terkunci di pemilih hari di atas. String di luar pola tampil apa adanya. */
export function jam(s: unknown): string {
  const m = /[ T](\d{2}):(\d{2})/.exec(String(s ?? ''));
  return m ? `${m[1]}:${m[2]}` : '—';
}

/* ---------- pemilih hari (UTC) ----------
 *
 * Dipakai halaman Riwayat transaksi, Laporan, dan Dashboard. SATU implementasi
 * untuk ketiganya supaya aturan harinya tidak bisa menyeleweng diam-diam:
 * hari = UTC (`new Date().toISOString().slice(0,10)`, sama dengan default
 * `date` di server dan filter `date(created_at)=date(?)`), geser hari pakai
 * aritmetika UTC (tidak kena pergantian zona waktu lokal).
 * Pindah dari salinan per-halaman 2026-09-30 saat halaman Dashboard dibuat. */

/** Hari UTC hari ini — sama persis dengan default `date` di server. */
export function hariIni(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Geser satu hari (delta boleh negatif) dengan aritmetika UTC. */
export function geser(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return hariIni();
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** "30 September 2026" untuk judul pemilih hari. Input rusak dikembalikan apa adanya. */
export function tglPanjang(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "30/9" — label sumbu-X grafik yang lebarnya terbatas. */
export function tglPendek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
}

/** "Sen" — hari pendek untuk label grafik. */
export function hariPendek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('id-ID', { weekday: 'short', timeZone: 'UTC' });
}
