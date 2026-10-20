// Izin operasional akun (Paket B4, 2026-10-20).
//
// SATU daftar izin untuk nav, guard rute, dan form Pengguna. Server tetap
// penjaga terakhir (wajibIzin di index.ts) — modul ini hanya cermin UI supaya
// kasir tidak menabrak 403 dan owner melihat centang yang benar.
//
// Empat izin CORE (pengguna/pengaturan/backup/audit) sengaja TIDAK ada di sini:
// semuanya tetap khusus role owner, bukan sesuatu yang bisa dicentang.

export const IZIN_OPERASIONAL = [
  // POS
  'pos.jual', 'pos.diskon', 'pos.harga', 'pos.item_manual', 'pos.topup', 'pos.tarik', 'pos.hold_semua',
  // Riwayat & retur
  'riwayat.lihat', 'riwayat.semua', 'retur.lihat', 'retur.buat', 'retur.batal',
  // Pelanggan & hutang
  'pelanggan.lihat', 'pelanggan.ubah', 'pelanggan.hapus',
  'hutang.lihat', 'hutang.catat', 'hutang.bayar', 'hutang.hapus',
  // Pesanan jasa
  'pesanan.lihat', 'pesanan.buat', 'pesanan.bayar', 'pesanan.batal',
  // Stok & shift
  'stok.lihat', 'stok.restock', 'stok.opname',
  'shift.lihat', 'shift.buka', 'shift.tutup', 'shift.kelola',
  // Manajemen
  'produk.kelola', 'supplier.kelola', 'pembelian.kelola', 'laporan.lihat',
  'pengeluaran.kelola', 'kasmasuk.kelola',
] as const;

export type Izin = (typeof IZIN_OPERASIONAL)[number];
const SET_IZIN = new Set<string>(IZIN_OPERASIONAL);

export const IZIN_KASIR_STANDAR: readonly Izin[] = IZIN_OPERASIONAL.filter(
  (i) =>
    i !== 'pos.hold_semua' &&
    i !== 'shift.kelola' &&
    i !== 'produk.kelola' &&
    i !== 'supplier.kelola' &&
    i !== 'pembelian.kelola' &&
    i !== 'laporan.lihat' &&
    i !== 'pengeluaran.kelola' &&
    i !== 'kasmasuk.kelola',
);

/** Preset "Ketat": hanya jual, lihat pelanggan, dan shift sendiri. */
export const IZIN_KASIR_KETAT: readonly Izin[] = [
  'pos.jual',
  'pelanggan.lihat',
  'shift.lihat',
  'shift.buka',
  'shift.tutup',
];

export type GrupIzin = {
  judul: string;
  ket: string;
  items: { kode: Izin; label: string; ket: string }[];
};

export const GRUP_IZIN: GrupIzin[] = [
  {
    judul: 'POS / kasir',
    ket: 'Aksi di layar kasir. Tanpa pos.jual akun tidak bisa membuka POS.',
    items: [
      { kode: 'pos.jual', label: 'Jual / buka POS', ket: 'Membuat nota penjualan dan membuka layar kasir.' },
      { kode: 'pos.diskon', label: 'Diskon', ket: 'Diskon per baris & diskon transaksi, termasuk harga borongan otomatis.' },
      { kode: 'pos.harga', label: 'Ubah harga', ket: 'Mengubah harga produk price_dynamic langsung di kolom Harga keranjang.' },
      { kode: 'pos.item_manual', label: 'Item manual', ket: 'Menambah baris jasa/teks bebas tanpa produk master.' },
      { kode: 'pos.topup', label: 'Topup', ket: 'Baris topup pulsa/e-wallet/PLN di keranjang.' },
      { kode: 'pos.tarik', label: 'Tarik tunai', ket: 'Baris tarik tunai di keranjang (hanya biaya admin yang ditagih).' },
      { kode: 'pos.hold_semua', label: 'Lihat semua transaksi tertahan', ket: 'Tanpa ini kasir hanya melihat transaksi tertahan miliknya sendiri.' },
    ],
  },
  {
    judul: 'Riwayat & retur',
    ket: 'Membaca nota lama dan mengembalikan barang/uang.',
    items: [
      { kode: 'riwayat.lihat', label: 'Lihat riwayat', ket: 'Membuka menu Riwayat transaksi.' },
      { kode: 'riwayat.semua', label: 'Lihat semua kasir', ket: 'Melihat nota kasir lain. Tanpa ini hanya nota sendiri.' },
      { kode: 'retur.lihat', label: 'Lihat retur', ket: 'Membuka menu Retur.' },
      { kode: 'retur.buat', label: 'Buat retur', ket: 'Mengembalikan barang & uang dari nota.' },
      { kode: 'retur.batal', label: 'Batalkan retur', ket: 'Membatalkan retur salah input (stok keluar lagi).' },
    ],
  },
  {
    judul: 'Pelanggan & hutang',
    ket: 'Master kontak dan buku piutang.',
    items: [
      { kode: 'pelanggan.lihat', label: 'Lihat pelanggan', ket: 'Membuka menu Pelanggan dan memilih pelanggan di POS.' },
      { kode: 'pelanggan.ubah', label: 'Tambah/ubah pelanggan', ket: 'Menyimpan kontak pelanggan.' },
      { kode: 'pelanggan.hapus', label: 'Hapus pelanggan', ket: 'Menghapus kontak (ditolak server bila masih punya hutang/pesanan).' },
      { kode: 'hutang.lihat', label: 'Lihat hutang', ket: 'Membuka buku piutang.' },
      { kode: 'hutang.catat', label: 'Catat hutang', ket: 'Mencatat charge baru — termasuk sisa bayar POS.' },
      { kode: 'hutang.bayar', label: 'Catat pembayaran hutang', ket: 'Mencatat pembayaran piutang.' },
      { kode: 'hutang.hapus', label: 'Hapus mutasi hutang', ket: 'Menghapus baris charge/payment salah input.' },
    ],
  },
  {
    judul: 'Pesanan jasa',
    ket: 'Pesanan cetak/desain/service: dikerjakan, lalu diserahkan.',
    items: [
      { kode: 'pesanan.lihat', label: 'Lihat pesanan', ket: 'Membuka menu Pesanan.' },
      { kode: 'pesanan.buat', label: 'Buat/ubah pesanan', ket: 'Membuat pesanan dan mengubah status dikerjakan/selesai.' },
      { kode: 'pesanan.bayar', label: 'DP & serahkan', ket: 'Menerima DP dan menyerahkan pesanan (membuat nota penjualan).' },
      { kode: 'pesanan.batal', label: 'Batalkan pesanan', ket: 'Membatalkan pesanan dan merefund DP.' },
    ],
  },
  {
    judul: 'Stok & shift',
    ket: 'Operasional barang dan sesi kasir.',
    items: [
      { kode: 'stok.lihat', label: 'Lihat stok', ket: 'Membuka halaman Stok.' },
      { kode: 'stok.restock', label: 'Restock', ket: 'Menambah stok masuk (harga beli memperbarui HPP).' },
      { kode: 'stok.opname', label: 'Opname', ket: 'Mengganti stok dengan hitungan fisik.' },
      { kode: 'shift.lihat', label: 'Lihat shift', ket: 'Melihat shift sendiri & membuka POS.' },
      { kode: 'shift.buka', label: 'Buka shift', ket: 'Membuka shift baru dengan modal awal.' },
      { kode: 'shift.tutup', label: 'Tutup shift', ket: 'Menutup shift & melihat selisih laci.' },
      { kode: 'shift.kelola', label: 'Kelola semua shift', ket: 'Melihat/menutup shift kasir lain. Default hanya shift sendiri.' },
    ],
  },
  {
    judul: 'Manajemen',
    ket: 'Master dan laporan yang mengubah/membaca seluruh toko.',
    items: [
      { kode: 'produk.kelola', label: 'Produk & label', ket: 'Tambah/ubah produk, kategori, impor, dan cetak label.' },
      { kode: 'supplier.kelola', label: 'Supplier', ket: 'Master pemasok.' },
      { kode: 'pembelian.kelola', label: 'Pembelian (PO)', ket: 'Nota kulakan: order, terima, bayar.' },
      { kode: 'laporan.lihat', label: 'Laporan & dashboard', ket: 'Omzet, laba, HPP, produk, kasir, piutang, stok, analitik.' },
      { kode: 'pengeluaran.kelola', label: 'Pengeluaran', ket: 'Kas keluar operasional.' },
      { kode: 'kasmasuk.kelola', label: 'Kas masuk', ket: 'Kas masuk non-penjualan (injeksi modal/koreksi laci).' },
    ],
  },
];

export const LABEL_IZIN: Record<string, string> = Object.fromEntries(
  GRUP_IZIN.flatMap((g) => g.items.map((i) => [i.kode, i.label])),
);

export type AkunIzin = { role: 'owner' | 'kasir'; permissions?: string[] | null };

/** Izin efektif akun. Owner = semua izin operasional. Kasir tanpa array
 *  permissions (cache lama) memakai preset Standar supaya UI offline tidak
 *  mendadak mengunci POS; server tetap memakai aturan DB yang sebenarnya. */
export function izinEfektif(akun: AkunIzin | null | undefined): Set<string> {
  if (!akun) return new Set();
  if (akun.role === 'owner') return new Set<string>(IZIN_OPERASIONAL);
  if (Array.isArray(akun.permissions)) {
    return new Set(akun.permissions.map(String).filter((x) => SET_IZIN.has(x)));
  }
  return new Set<string>(IZIN_KASIR_STANDAR);
}

export function punyaIzinAkun(akun: AkunIzin | null | undefined, kode: string): boolean {
  return izinEfektif(akun).has(kode);
}

/** Normalisasi kiriman form: buang kode asing/duplikat, urut sesuai daftar. */
export function normalisasiIzin(daftar: Iterable<string>): Izin[] {
  const set = new Set(daftar);
  return IZIN_OPERASIONAL.filter((k) => set.has(k));
}
