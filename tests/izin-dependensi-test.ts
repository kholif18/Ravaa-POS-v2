// Test peta dependensi izin (apps/web/src/ui/izin.ts) — murni, tanpa browser.
// Jalankan: npx tsx tests/izin-dependensi-test.ts
//
// Yang dijaga: dependensi KERAS tidak boleh menghasilkan kombinasi centang yang
// mustahil dipakai (mis. `pos.jual` tanpa `shift.lihat` = POS berhenti di
// gerbang "Buka shift"), preset Standar/Ketat/Supervisor harus sehat, dan
// pengecualian yang SENGAJA (hutang.catat, retur.buat, pembelian→supplier)
// tidak boleh diam-diam ditambahkan orang lain tanpa keputusan.
import {
  IZIN_OPERASIONAL,
  IZIN_KASIR_STANDAR,
  IZIN_KASIR_KETAT,
  IZIN_KASIR_SUPERVISOR,
  DEPENDENSI_IZIN,
  GRUP_IZIN,
  LABEL_IZIN,
  dependenDari,
  rapikanDependensi,
  dependensiKurang,
  normalisasiIzin,
  izinEfektif,
  type Izin,
} from '../apps/web/src/ui/izin.ts';

let lolos = 0, gagal = 0;
const ok = (n: string, c: boolean, info: unknown = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n} ${info !== '' ? `| ${JSON.stringify(info)}` : ''}`); }
};
const eq = (n: string, a: unknown, b: unknown) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}\n         dapat : ${JSON.stringify(a)}\n         harap : ${JSON.stringify(b)}`); }
};
const canonical = (d: Iterable<string>): string[] => normalisasiIzin(d).slice().sort();

const SEMUA = new Set<string>(IZIN_OPERASIONAL);

console.log('=== A. Daftar izin & peta dependensi ===');
eq('36 izin operasional', IZIN_OPERASIONAL.length, 36);
ok('semua kunci dependensi = izin dikenal',
  Object.keys(DEPENDENSI_IZIN).every((k) => SEMUA.has(k)),
  Object.keys(DEPENDENSI_IZIN).filter((k) => !SEMUA.has(k)));
ok('semua nilai dependensi = izin dikenal',
  Object.values(DEPENDENSI_IZIN).flat().every((k) => SEMUA.has(k as string)),
  Object.values(DEPENDENSI_IZIN).flat().filter((k) => !SEMUA.has(k as string)));
ok('tidak ada izin bergantung pada dirinya sendiri',
  Object.entries(DEPENDENSI_IZIN).every(([k, v]) => !(v ?? []).includes(k as Izin)));

// Deteksi siklus: A -> B -> A akan membuat `rapikanDependensi` tak pernah stabil.
const siklus: string[] = [];
const kunjungi = (k: string, jalur: string[]): void => {
  if (jalur.includes(k)) { siklus.push([...jalur, k].join(' → ')); return; }
  for (const d of DEPENDENSI_IZIN[k as Izin] ?? []) kunjungi(d, [...jalur, k]);
};
for (const k of Object.keys(DEPENDENSI_IZIN)) kunjungi(k, []);
ok('peta dependensi asiklik', siklus.length === 0, siklus);

console.log('=== B. dependenDari (arah terbalik) ===');
eq('dependenDari(pos.jual) = 6 izin POS',
  canonical(dependenDari('pos.jual')),
  ['pos.diskon', 'pos.harga', 'pos.hold_semua', 'pos.item_manual', 'pos.tarik', 'pos.topup'].sort());
eq('dependenDari(shift.lihat) = POS + buka/tutup/kelola',
  canonical(dependenDari('shift.lihat')),
  ['pos.jual', 'shift.buka', 'shift.kelola', 'shift.tutup'].sort());
eq('dependenDari(riwayat.lihat) = riwayat.semua',
  canonical(dependenDari('riwayat.lihat')), ['riwayat.semua']);

console.log('=== C. rapikanDependensi (transitif) ===');
eq('pos.hold_semua menarik pos.jual + shift.lihat',
  canonical(rapikanDependensi(['pos.hold_semua'])),
  ['pos.hold_semua', 'pos.jual', 'shift.lihat']);
eq('pesanan.bayar menarik pesanan.lihat',
  canonical(rapikanDependensi(['pesanan.bayar'])),
  ['pesanan.bayar', 'pesanan.lihat']);
eq('dependensiKurang(pos.jual) = butuh shift.lihat',
  dependensiKurang(['pos.jual']),
  [{ izin: 'pos.jual', butuh: ['shift.lihat'] }]);
eq('hasil rapikan selalu sehat',
  dependensiKurang(rapikanDependensi(['pos.hold_semua', 'pesanan.bayar', 'hutang.hapus'])), []);

console.log('=== D. Preset sehat ===');
eq('Standar 28 izin & dependensi lengkap',
  [IZIN_KASIR_STANDAR.length, dependensiKurang(IZIN_KASIR_STANDAR)], [28, []]);
eq('Ketat 5 izin & dependensi lengkap',
  [IZIN_KASIR_KETAT.length, dependensiKurang(IZIN_KASIR_KETAT)], [5, []]);
eq('Supervisor 33 izin & dependensi lengkap',
  [IZIN_KASIR_SUPERVISOR.length, dependensiKurang(IZIN_KASIR_SUPERVISOR)], [33, []]);
ok('Supervisor = Standar + laporan/hold/shift/pengeluaran/kas masuk',
  ['laporan.lihat', 'pos.hold_semua', 'shift.kelola', 'pengeluaran.kelola', 'kasmasuk.kelola']
    .every((k) => (IZIN_KASIR_SUPERVISOR as readonly string[]).includes(k))
  && (IZIN_KASIR_STANDAR as readonly string[]).every((k) => (IZIN_KASIR_SUPERVISOR as readonly string[]).includes(k)),
  IZIN_KASIR_SUPERVISOR.filter((k) => !(IZIN_KASIR_STANDAR as readonly string[]).includes(k)));
ok('Supervisor TIDAK memuat produk/supplier/pembelian',
  !['produk.kelola', 'supplier.kelola', 'pembelian.kelola']
    .some((k) => (IZIN_KASIR_SUPERVISOR as readonly string[]).includes(k)));

console.log('=== E. Pengecualian yang sengaja (jangan diubah tanpa keputusan) ===');
eq('hutang.catat tidak menuntut hutang.lihat (dipakai POS)', DEPENDENSI_IZIN['hutang.catat'], undefined);
eq('retur.buat tidak menuntut pintu tertentu (dua jalur masuk)', DEPENDENSI_IZIN['retur.buat'], undefined);
eq('pembelian.kelola tidak menuntut supplier.kelola (PO tanpa supplier sah)', DEPENDENSI_IZIN['pembelian.kelola'], undefined);

console.log('=== F. Normalisasi & izin efektif ===');
eq('normalisasiIzin: buang asing, dedup, urutan kanonik',
  normalisasiIzin(['shift.lihat', 'asing', 'pos.jual', 'pos.jual']),
  ['pos.jual', 'shift.lihat']);
eq('owner = seluruh izin operasional', izinEfektif({ role: 'owner' }).size, 36);
eq('kasir permissions null = preset Standar (cache lama)',
  izinEfektif({ role: 'kasir', permissions: null }).size, 28);
eq('kasir permissions [] = kosong (fail closed)', izinEfektif({ role: 'kasir', permissions: [] }).size, 0);
eq('kasir izin asing dibuang', [...izinEfektif({ role: 'kasir', permissions: ['pos.jual', 'asing'] })], ['pos.jual']);

console.log('=== G. Registry UI lengkap ===');
const dariGrup = GRUP_IZIN.flatMap((g) => g.items.map((i) => i.kode));
eq('GRUP_IZIN memuat tiap izin tepat sekali',
  [dariGrup.length, new Set(dariGrup).size, dariGrup.slice().sort()],
  [36, 36, IZIN_OPERASIONAL.slice().sort()]);
ok('LABEL_IZIN lengkap untuk semua izin',
  IZIN_OPERASIONAL.every((k) => typeof LABEL_IZIN[k] === 'string' && LABEL_IZIN[k].length > 0));

console.log(`\n=== ${gagal ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${lolos}, gagal: ${gagal})  [izin-dependensi-test.ts]`);
if (gagal) process.exit(1);
