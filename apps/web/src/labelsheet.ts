// LABEL HARGA — dokumen lembar mm + barcode SVG (refactor 2026-10-17).
//
// Keputusan pemilik: printer label toko = Epson L3110 & L1210 (inkjet
// lembar), kertas A4 + Folio (215×330 mm) — bukan printer thermal 58 mm.
// Karena itu label TIDAK lewat print-agent ESC/POS, melainkan dokumen HTML
// ber-`@page` mm yang dicetak browser (`window.print()` -> driver printer),
// POLA YANG SAMA dengan invoice A4 / laporan / rekap shift di `invoice.ts`
// ("Dicetak lewat window.print() browser (Chrome -> CUPS -> printer A4,
// contoh: Epson L3110), BUKAN lewat print-agent").
//
// Modul ini MURNI (tanpa DOM app / fetch / store): setelan halaman, tata
// letak grid, encoder barcode SVG (EAN-13 & EAN-8 + Code 128, checksum
// dihitung), dan
// builder HTML lembar. Halaman `#/labels` memakai builder yang SAMA untuk
// pratinjau sehingga layar = hasil cetak (WYSIWYG), dan `tests/labelsheet-test.ts`
// menguji semuanya tanpa browser.
//
// Token/warna: label adalah DOKUMEN CETAK — warna di sini sengaja literal
// hitam/putih (bukan token UI) supaya hasil cetak tidak bergantung tema web.

/** Preset kertas (mm) — `custom` memakai angka manual di setelan. */
export type Kertas = 'a4' | 'folio' | 'custom';

export interface IsiLabel {
  nama: boolean;
  harga: boolean;
  barcode: boolean;
  border: boolean;
}

export interface SetelanLabel {
  kertas: Kertas;
  /** Ukuran kertas manual (mm) — hanya dipakai saat `kertas = 'custom'`. */
  lebarMm: number;
  tinggiMm: number;
  marginAtas: number;
  marginBawah: number;
  marginKiri: number;
  marginKanan: number;
  /** Jumlah kolom label per baris kertas (2–6). */
  kolom: number;
  tinggiLabelMm: number;
  jarakX: number;
  jarakY: number;
  isi: IsiLabel;
  /** Tampilkan harga coret + harga diskon bila produk punya diskon (opsional, default mati). */
  hargaPromo: boolean;
  fontNamaPt: number;
  fontHargaPt: number;
  barcodeTinggiMm: number;
  /** Salinan tiap label (mis. 2 utk rak + gudang). */
  salinan: number;
}

/** Produk yang siap dicetak — pemanggil memetakan dari tipe Product store. */
export interface ProdukCetak {
  name: string;
  sku: string;
  price: number;
  unit: string;
  barcode: string | null;
  discount_type: 'rp' | 'pct';
  discount: number;
}

export interface TataLetak {
  lebarKertasMm: number;
  tinggiKertasMm: number;
  /** Lebar tiap label (mm) — otomatis dari margin & kolom, bukan input manual. */
  lebarLabelMm: number;
  barisPerLembar: number;
  perLembar: number;
  /** Masalah setelan ('' = sehat) — pemanggil menampilkan + mematikan tombol cetak. */
  pesan: string;
}

export const KERTAS_PRESET: Record<'a4' | 'folio', { label: string; lebarMm: number; tinggiMm: number }> = {
  a4: { label: 'A4 (210 × 297 mm)', lebarMm: 210, tinggiMm: 297 },
  folio: { label: 'Folio (215 × 330 mm)', lebarMm: 215, tinggiMm: 330 },
};

export const SETELAN_AWAL: SetelanLabel = {
  kertas: 'a4',
  lebarMm: 210,
  tinggiMm: 297,
  marginAtas: 10,
  marginBawah: 10,
  marginKiri: 10,
  marginKanan: 10,
  kolom: 3,
  tinggiLabelMm: 30,
  jarakX: 2,
  jarakY: 2,
  isi: { nama: true, harga: true, barcode: true, border: true },
  hargaPromo: false,
  fontNamaPt: 9,
  fontHargaPt: 14,
  barcodeTinggiMm: 10,
  salinan: 1,
};

export const KEY_SETELAN_LABEL = 'ravaa.label';

export function setelanAwal(): SetelanLabel {
  return { ...SETELAN_AWAL, isi: { ...SETELAN_AWAL.isi } };
}

// ---------------------------------------------------------------------------
// Setelan per device (localStorage) — printer & kertas tiap PC kasir berbeda,
// sengaja TIDAK disimpan di server (pola ui/print-pref.ts).

function clampAngka(nilai: unknown, min: number, max: number, awalan: number): number {
  const x = typeof nilai === 'number' ? nilai : Number(nilai);
  if (!Number.isFinite(x)) return awalan;
  return Math.min(max, Math.max(min, x));
}

function normalisasiIsi(raw: unknown): IsiLabel {
  const r = (raw ?? {}) as Partial<IsiLabel>;
  const b = (v: unknown, awalan: boolean): boolean => (typeof v === 'boolean' ? v : awalan);
  return {
    nama: b(r.nama, SETELAN_AWAL.isi.nama),
    harga: b(r.harga, SETELAN_AWAL.isi.harga),
    barcode: b(r.barcode, SETELAN_AWAL.isi.barcode),
    border: b(r.border, SETELAN_AWAL.isi.border),
  };
}

/** Setelan dari JSON mentah (localStorage lama/rusak) — selalu balik valid. */
export function normalisasiSetelan(raw: unknown): SetelanLabel {
  const r = (raw ?? {}) as Partial<SetelanLabel>;
  const kertas: Kertas = r.kertas === 'folio' || r.kertas === 'custom' ? r.kertas : 'a4';
  return {
    kertas,
    lebarMm: clampAngka(r.lebarMm, 50, 600, SETELAN_AWAL.lebarMm),
    tinggiMm: clampAngka(r.tinggiMm, 50, 600, SETELAN_AWAL.tinggiMm),
    marginAtas: clampAngka(r.marginAtas, 0, 40, SETELAN_AWAL.marginAtas),
    marginBawah: clampAngka(r.marginBawah, 0, 40, SETELAN_AWAL.marginBawah),
    marginKiri: clampAngka(r.marginKiri, 0, 40, SETELAN_AWAL.marginKiri),
    marginKanan: clampAngka(r.marginKanan, 0, 40, SETELAN_AWAL.marginKanan),
    kolom: Math.round(clampAngka(r.kolom, 2, 6, SETELAN_AWAL.kolom)),
    tinggiLabelMm: clampAngka(r.tinggiLabelMm, 10, 120, SETELAN_AWAL.tinggiLabelMm),
    jarakX: clampAngka(r.jarakX, 0, 10, SETELAN_AWAL.jarakX),
    jarakY: clampAngka(r.jarakY, 0, 10, SETELAN_AWAL.jarakY),
    isi: normalisasiIsi(r.isi),
    hargaPromo: typeof r.hargaPromo === 'boolean' ? r.hargaPromo : SETELAN_AWAL.hargaPromo,
    fontNamaPt: clampAngka(r.fontNamaPt, 5, 20, SETELAN_AWAL.fontNamaPt),
    fontHargaPt: clampAngka(r.fontHargaPt, 6, 48, SETELAN_AWAL.fontHargaPt),
    barcodeTinggiMm: clampAngka(r.barcodeTinggiMm, 4, 30, SETELAN_AWAL.barcodeTinggiMm),
    salinan: Math.round(clampAngka(r.salinan, 1, 50, SETELAN_AWAL.salinan)),
  };
}

export function getSetelanLabel(): SetelanLabel {
  try {
    const s = localStorage.getItem(KEY_SETELAN_LABEL);
    return s ? normalisasiSetelan(JSON.parse(s)) : setelanAwal();
  } catch {
    return setelanAwal();
  }
}

export function setSetelanLabel(s: SetelanLabel): void {
  try {
    localStorage.setItem(KEY_SETELAN_LABEL, JSON.stringify(s));
  } catch {
    /* mode private / quota penuh — setelan cukup hidup di memori */
  }
}

// ---------------------------------------------------------------------------
// Tata letak.

export function ukuranKertas(s: SetelanLabel): { lebarMm: number; tinggiMm: number } {
  if (s.kertas === 'custom') return { lebarMm: s.lebarMm, tinggiMm: s.tinggiMm };
  const p = KERTAS_PRESET[s.kertas];
  return { lebarMm: p.lebarMm, tinggiMm: p.tinggiMm };
}

export function hitungTataLetak(s: SetelanLabel): TataLetak {
  const k = ukuranKertas(s);
  const lebarIsi = k.lebarMm - s.marginKiri - s.marginKanan - (s.kolom - 1) * s.jarakX;
  const lebarLabelMm = lebarIsi / s.kolom;
  const tinggiIsi = k.tinggiMm - s.marginAtas - s.marginBawah;
  const barisPerLembar = Math.floor((tinggiIsi + s.jarakY) / (s.tinggiLabelMm + s.jarakY));
  const pesan =
    lebarIsi <= 0 || lebarLabelMm < 10
      ? 'Kertas, margin, dan kolom tidak muat — kecilkan margin atau jumlah kolom.'
      : barisPerLembar < 1
        ? 'Tinggi label melebihi area cetak — kecilkan tinggi label atau margin.'
        : '';
  // Setelan tidak sehat -> kapasitas 0 supaya pratinjau & cetak kompak
  // (pemanggil menampilkan `pesan`, tombol cetak mati).
  const perLembar = pesan === '' ? s.kolom * barisPerLembar : 0;
  return {
    lebarKertasMm: k.lebarMm,
    tinggiKertasMm: k.tinggiMm,
    lebarLabelMm,
    barisPerLembar,
    perLembar,
    pesan,
  };
}

export function hitungHalaman(jumlah: number, s: SetelanLabel): { perLembar: number; halaman: number } {
  const perLembar = Math.max(0, hitungTataLetak(s).perLembar);
  return { perLembar, halaman: perLembar > 0 && jumlah > 0 ? Math.ceil(jumlah / perLembar) : 0 };
}

/** Ulang tiap label `salinan` kali (berurutan — hasil cetak per produk berdampingan). */
export function denganSalinan(daftar: ProdukCetak[], salinan: number): ProdukCetak[] {
  const n = Math.max(1, Math.round(salinan));
  if (n === 1) return daftar.slice();
  const out: ProdukCetak[] = [];
  for (const p of daftar) for (let i = 0; i < n; i++) out.push(p);
  return out;
}

/** Pecah daftar jadi halaman-per-halaman sesuai kapasitas lembar. */
export function bagiLembar(s: SetelanLabel, daftar: ProdukCetak[]): ProdukCetak[][] {
  const per = hitungTataLetak(s).perLembar;
  if (per <= 0 || daftar.length === 0) return [];
  const out: ProdukCetak[][] = [];
  for (let i = 0; i < daftar.length; i += per) out.push(daftar.slice(i, i + per));
  return out;
}

// ---------------------------------------------------------------------------
// Barcode EAN-13 / EAN-8 — encoder SVG berdiri sendiri (tanpa dependency).
//
// Tabel L (odd parity) standar EAN; R = komplemen L, G = balikan R (dihitung
// supaya tidak ada salah ketik tabel ganda). Quiet zone kiri/kanan 11 modul,
// modul 0,33 mm (X-dimension ~100% pada 300 dpi).

const L_CODE = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];
const R_CODE = L_CODE.map((l) => l.replace(/[01]/g, (c) => (c === '0' ? '1' : '0')));
const G_CODE = R_CODE.map((r) => [...r].reverse().join(''));

/** Paritas enam digit kiri EAN-13 menurut digit pertama. */
const PARITAS = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

const MODUL_MM = 0.33; // lebar 1 modul barcode di kertas
const QUIET = 11; // quiet zone kiri/kanan (modul)

/** Digit cek EAN dari payload (12 digit EAN-13 / 7 digit EAN-8) — bobot 3 mulai dari digit terkanan. */
export function checksumEan(payload: string): number {
  let sum = 0;
  for (let i = payload.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(payload[i]) * w;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Normalisasi kode barcode -> digit lengkap + deret modul ('0'/'1').
 * Menerima EAN-13 (12/13 digit, digit cek dihitung ulang) & EAN-8 (7/8).
 * Selain itu (huruf/panjang lain) -> null (label tampil tanpa barcode).
 */
export function kodeBarcode(kode: string | null | undefined): { digit: string; modul: string } | null {
  const angka = String(kode ?? '').replace(/\s+/g, '');
  if (!/^\d+$/.test(angka)) return null;

  if (angka.length === 12 || angka.length === 13) {
    const payload = angka.slice(0, 12);
    const digit = payload + checksumEan(payload);
    const paritas = PARITAS[Number(digit[0])];
    let modul = '101';
    for (let i = 0; i < 6; i++) {
      const d = Number(digit[i + 1]);
      modul += paritas[i] === 'L' ? L_CODE[d] : G_CODE[d];
    }
    modul += '01010';
    for (let i = 0; i < 6; i++) modul += R_CODE[Number(digit[i + 7])];
    return { digit, modul: modul + '101' };
  }

  if (angka.length === 7 || angka.length === 8) {
    const payload = angka.slice(0, 7);
    const digit = payload + checksumEan(payload);
    let modul = '101';
    for (let i = 0; i < 4; i++) modul += L_CODE[Number(digit[i])];
    modul += '01010';
    for (let i = 0; i < 4; i++) modul += R_CODE[Number(digit[i + 4])];
    return { digit, modul: modul + '101' };
  }

  return null;
}

/**
 * SVG barcode EAN (garis + quiet zone) untuk kode apa pun yang dikenali,
 * atau null bila tidak bisa di-encode. `tinggiMm` = tinggi area batang di kertas.
 */
export function barcodeSvg(kode: string | null | undefined, tinggiMm: number): string | null {
  const b = kodeBarcode(kode);
  if (!b) return null;
  return svgModul(b.modul, tinggiMm, `Barcode ${b.digit}`);
}

/** SVG dari deret modul ('0'/'1') + quiet zone QUIET kiri/kanan — dipakai
 *  bersama jalur EAN & Code 128 (lebar modul MODUL_MM mm). */
function svgModul(modul: string, tinggiMm: number, aria: string): string {
  const totalModul = modul.length + QUIET * 2;
  const lebarMm = (totalModul * MODUL_MM).toFixed(2);
  const tinggi = Math.max(4, tinggiMm);
  let batang = '';
  for (let i = 0; i < modul.length; ) {
    if (modul[i] === '1') {
      let j = i;
      while (j < modul.length && modul[j] === '1') j++;
      batang += `<rect x="${QUIET + i}" y="0" width="${j - i}" height="100"/>`;
      i = j;
    } else {
      i++;
    }
  }
  return (
    `<svg viewBox="0 0 ${totalModul} 100" width="${lebarMm}mm" height="${tinggi}mm" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges" role="img" ` +
    `aria-label="${aria}" xmlns="http://www.w3.org/2000/svg">${batang}</svg>`
  );
}

// ---------------------------------------------------------------------------
// Barcode Code 128 (subset B) — aturan pemilik 2026-10-17: "barcode pilihan
// pertama, SKU bagi produk yang tidak memiliki barcode".
//
// Dipakai label untuk kode NON-EAN: isi kolom barcode produk, atau SKU sebagai
// FALLBACK bila produk belum punya barcode. Hanya subset B (ASCII 32..126)
// supaya encoder tetap kecil — di luar itu pemanggil mencetak TEKS (perilaku
// lama). Tabel 107 pola dari spesifikasi Code 128, diverifikasi silang dua
// sumber (JsBarcode constants.js + tabel Wikipedia "Code 128"): START B &
// STOP & vektor checksum 'PRD00001' (nilai 24) diuji di labelsheet-test.ts.
//
// PENTING: SKU numerik 12/13 digit SENGAJA tidak pernah lewat jalur EAN —
// checksum EAN dihitung ulang dan bisa mengubah digit terakhir, sehingga hasil
// scan tidak lagi sama persis dengan SKU (POS mencocokkan barcode/SKU persis).

const POLA_128: string[] = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
];

/** START B (nilai 104) & STOP (106) — checksum modulo 103. */
const START_B_128 = '11010010000';
const STOP_128 = '1100011101011';

/**
 * Batas karakter Code 128 di label: 10 char = 55,1 mm — masih muat di label
 * standar 62 mm; lebih panjang (11 char = 58,7 mm) sudah nyaris menyentuh tepi
 * dalam label, dan label 2+ digit lebih panjang dari itu pasti terpotong.
 */
export const MAKS_KODE128 = 10;

/**
 * Encode string ke deret modul Code 128 subset B, atau null bila tak bisa
 * (kosong / > MAKS_KODE128 / di luar ASCII printable 32..126). `kode` hasil =
 * string yang benar-benar di-encode (di-trim). Checksum =
 * (START_B + Σ nilai×posisi) mod 103, posisi pertama = 1 (spesifikasi Code 128).
 */
export function kode128(kode: string | null | undefined): { kode: string; modul: string } | null {
  const k = String(kode ?? '').trim();
  if (!k || k.length > MAKS_KODE128) return null;
  const nilai: number[] = [];
  for (const ch of k) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) return null; // subset B: ASCII 32..126
    nilai.push(v);
  }
  let cek = 104; // START B
  nilai.forEach((v, i) => { cek += v * (i + 1); });
  return {
    kode: k,
    modul:
      START_B_128 +
      nilai.map((v) => POLA_128[v]).join('') +
      POLA_128[cek % 103] +
      STOP_128,
  };
}

/**
 * SVG Code 128 — null bila tidak bisa di-encode ATAU tidak muat di
 * `lebarMaksMm` (label sempit: lebih baik tercetak TEKS daripada batang
 * terpotong `overflow:hidden`). Default tanpa batas lebar.
 */
export function barcode128Svg(
  kode: string | null | undefined,
  tinggiMm: number,
  lebarMaksMm = Infinity,
): string | null {
  const b = kode128(kode);
  if (!b) return null;
  const totalModul = b.modul.length + QUIET * 2;
  if (totalModul * MODUL_MM > lebarMaksMm) return null;
  return svgModul(b.modul, tinggiMm, `Barcode ${esc(b.kode)}`);
}

// ---------------------------------------------------------------------------
// Harga & promo.

function rp(n: number): string {
  return 'Rp' + new Intl.NumberFormat('id-ID').format(Math.round(n));
}

/**
 * Potongan harga produk (fitur "Harga promo" opsional): `pct` = persen dari
 * harga, `rp` = potongan rupiah. null bila tak ada diskon bermakna (0 / >= harga).
 */
export function hargaPromo(p: ProdukCetak): { pokok: number; bayar: number } | null {
  if (!Number.isFinite(p.discount) || p.discount <= 0) return null;
  const potong =
    p.discount_type === 'pct'
      ? Math.round((p.price * Math.min(100, p.discount)) / 100)
      : Math.round(p.discount);
  if (potong <= 0 || potong >= p.price) return null;
  return { pokok: p.price, bayar: p.price - potong };
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

// ---------------------------------------------------------------------------
// Builder HTML. Geometri (mm) inline per elemen supaya `CSS_LABEL` tetap satu
// string statis yang dipakai pratinjau DAN dokumen cetak.

function hargaHtml(s: SetelanLabel, p: ProdukCetak): string {
  const promo = s.hargaPromo ? hargaPromo(p) : null;
  if (promo) {
    return (
      `<div class="lb-harga" style="font-size:${s.fontHargaPt}pt">` +
      `<span class="lb-coret">${rp(promo.pokok)}</span>` +
      `<span class="lb-bayar">${rp(promo.bayar)}</span></div>`
    );
  }
  return `<div class="lb-harga" style="font-size:${s.fontHargaPt}pt">${rp(p.price)}</div>`;
}

/** Satu kartu label — urutan atas→bawah: nama, harga, barcode (pola Aronium).
 *  Baris kaki `SKU · satuan` DIHAPUS 2026-10-17 (permintaan pemilik: *"di
 *  bagian atas barcode dibawah Harga tidak perlu, bisa di hapus"*) — SKU sudah
 *  terbaca di bawah batang barcode (`lb-barcode-num`). */
export function labelHtml(s: SetelanLabel, p: ProdukCetak): string {
  const bagian: string[] = [];
  if (s.isi.nama) bagian.push(`<div class="lb-nama" style="font-size:${s.fontNamaPt}pt">${esc(p.name)}</div>`);
  if (s.isi.harga) bagian.push(hargaHtml(s, p));
  if (s.isi.barcode) {
    const blok = blokBarcode(s, p);
    if (blok) bagian.push(blok);
  }
  const kelas = s.isi.border ? 'lb-label lb-border' : 'lb-label';
  return `<div class="${kelas}">${bagian.join('')}</div>`;
}

/**
 * Blok barcode satu label — aturan pemilik 2026-10-17: "barcode pilihan
 * pertama, SKU bagi produk yang tidak memiliki barcode":
 *   1. kolom `barcode` valid EAN-13/EAN-8 (angka 12/13 atau 7/8 digit) ->
 *      batang EAN (checksum dihitung ulang, digit final tercetak di bawah);
 *   2. `barcode` non-EAN yang bisa di-encode -> Code 128;
 *   3. `barcode` kosong -> SKU sebagai Code 128 (semua produk punya SKU);
 *   4. tak encodable / tak muat lebar label -> TEKS apa adanya (menggambar
 *      barcode yang tidak bisa discan justru menyesatkan — perilaku lama).
 *  Jalur EAN TIDAK pernah dipakai untuk SKU: checksum EAN dihitung ulang bisa
 *  mengubah digit terakhir sehingga hasil scan tak lagi sama persis dengan SKU.
 */
function blokBarcode(s: SetelanLabel, p: ProdukCetak): string {
  const bc = (p.barcode ?? '').trim();
  const ean = bc ? kodeBarcode(bc) : null;
  if (ean) {
    return (
      `<div class="lb-barcode">${barcodeSvg(bc, s.barcodeTinggiMm)}` +
      `<span class="lb-barcode-num">${ean.digit}</span></div>`
    );
  }
  const kode = bc || (p.sku ?? '').trim();
  if (!kode) return '';
  // Lebar isi label = lebar label − padding .lb-label (1,2 mm × 2) − border
  // (.3 mm × 2, bila menyala); angka ini harus ikut CSS_LABEL di bawah.
  const lebarIsi = hitungTataLetak(s).lebarLabelMm - 2.4 - (s.isi.border ? 0.6 : 0);
  const svg = barcode128Svg(kode, s.barcodeTinggiMm, lebarIsi);
  if (svg) return `<div class="lb-barcode">${svg}<span class="lb-barcode-num">${esc(kode)}</span></div>`;
  return `<div class="lb-barcode"><span class="lb-barcode-num">${esc(kode)}</span></div>`;
}

/** Satu lembar kertas (grid label) — geometri kertas dari setelan, mm inline. */
export function lembarHtml(s: SetelanLabel, daftar: ProdukCetak[]): string {
  const k = ukuranKertas(s);
  const gaya =
    `width:${k.lebarMm}mm;height:${k.tinggiMm}mm;` +
    `padding:${s.marginAtas}mm ${s.marginKanan}mm ${s.marginBawah}mm ${s.marginKiri}mm;` +
    `grid-template-columns:repeat(${s.kolom},1fr);` +
    `grid-auto-rows:${s.tinggiLabelMm}mm;gap:${s.jarakY}mm ${s.jarakX}mm`;
  return `<div class="lb-lembar" style="${gaya}">${daftar.map((p) => labelHtml(s, p)).join('')}</div>`;
}

/** Semua lembar berurutan (dipakai pratinjau & dokumen cetak). */
export function htmlLembarSemua(s: SetelanLabel, daftar: ProdukCetak[]): string {
  return bagiLembar(s, daftar)
    .map((l) => lembarHtml(s, l))
    .join('');
}

/** CSS statis bersama: pratinjau halaman + dokumen cetak memakai aturan yang SAMA. */
export const CSS_LABEL = [
  '.lb-lembar{display:grid;align-content:start;background:#fff;color:#111;',
  'font-family:Arial,Helvetica,sans-serif;page-break-after:always;',
  'print-color-adjust:exact;-webkit-print-color-adjust:exact;}',
  '.lb-lembar:last-child{page-break-after:auto;}',
  '.lb-label{display:flex;flex-direction:column;align-items:center;justify-content:center;',
  'text-align:center;overflow:hidden;padding:1.2mm;gap:.6mm;}',
  '.lb-label.lb-border{border:.3mm solid #999;border-radius:.8mm;}',
  '.lb-nama{font-weight:700;line-height:1.12;}',
  '.lb-harga{font-weight:800;line-height:1.1;}',
  '.lb-harga .lb-coret{display:block;font-size:.55em;font-weight:400;color:#555;text-decoration:line-through;}',
  '.lb-harga .lb-bayar{display:block;}',
  '.lb-barcode{display:flex;flex-direction:column;align-items:center;}',
  '.lb-barcode svg{display:block;}',
  '.lb-barcode-num{font-family:ui-monospace,"Courier New",monospace;font-size:7pt;',
  'letter-spacing:.6px;color:#222;}',
].join('');

/** Dokumen cetak penuh (tab baru) — `@page` mengunci ukuran kertas di driver. */
export function htmlDokumenLabel(s: SetelanLabel, daftar: ProdukCetak[], judul = 'Label harga'): string {
  const k = ukuranKertas(s);
  return (
    '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">' +
    `<title>${esc(judul)}</title>` +
    '<style>' +
    `@page{size:${k.lebarMm}mm ${k.tinggiMm}mm;margin:0;}` +
    'html,body{margin:0;padding:0;background:#fff;}' +
    'body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}' +
    CSS_LABEL +
    '</style></head><body>' +
    htmlLembarSemua(s, daftar) +
    '<script>window.addEventListener("load",function(){window.print();});</script>' +
    '</body></html>'
  );
}

/**
 * Cetak lewat browser (tab baru + print otomatis saat load) — TANPA
 * print-agent. Popup diblokir -> throw (pemanggil men-toast; jangan diam).
 * Catatan: pratinjau cetak driver = "Default" + skala 100%, kertas A4/Folio
 * dipilih di dialog; `@page` sudah mengunci ukurannya.
 */
export function cetakLabel(s: SetelanLabel, daftar: ProdukCetak[]): void {
  const w = window.open('', '_blank');
  if (!w) throw new Error('popup diblokir browser — izinkan popup untuk mencetak label');
  w.document.open();
  w.document.write(htmlDokumenLabel(s, daftar));
  w.document.close();
}
