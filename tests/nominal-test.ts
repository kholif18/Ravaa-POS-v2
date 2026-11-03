// Test modul format nominal (apps/web/src/ui/nominal.ts) — murni, tanpa browser.
// Jalankan: npx tsx tests/nominal-test.ts
//
// Latar (2026-10-27, keputusan pemilik): SEMUA form nominal = titik pemisah
// LIVE saat mengetik ('100000' -> '100.000'). Bug modal awal "0100000" harus
// tetap mati: prefill 0 -> '' + placeholder, formatter membuang leading zero.
//
// DUA pengecualian "0"-survivor (harga restock 0 = barang hadiah, modal akhir
// shift = laci kosong sah) diuji di TINGKAT HALAMAN (Playwright suite lain),
// bukan di sini — di sini yang diuji = kontrak modul murni: formatNominal
// SENGAJA 0 -> '' (pemanggil khusus punya listener sendiri yang menuliskan "0").
import {
  bacaNominal,
  formatNominal,
  formatNominalLive,
  pasangNominal,
  parseNominal,
  prefillNominal,
} from '../apps/web/src/ui/nominal.ts';

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

/* Stub input minimal: cukup property yang dibaca fungsi modul (value,
 * selectionStart, setSelectionRange). Dipakai bacaNominal/formatNominalLive/
 * pasangNominal tanpa DOM nyata — pola unit test murni borongan-test. */
const stub = (value: string, selectionStart: number | null = value.length) => {
  const listeners: Array<() => void> = [];
  const o = {
    value,
    selectionStart,
    _sel: null as number | null,
    _listeners: listeners,
    setSelectionRange(s: number, _e?: number) { this._sel = s; },
    addEventListener(_tipe: string, fn: () => void) { listeners.push(fn); },
    kirim() { for (const f of Array.from(listeners)) f(); },
  };
  return o as unknown as HTMLInputElement & typeof o;
};

/* Stub khusus prefillNominal: tidak punya selection*, punya get/setAttribute. */
const stubPh = (ph: string | null) => {
  const o = {
    value: '',
    _ph: null as string | null,
    getAttribute(k: string) { return k === 'placeholder' ? ph : null; },
    setAttribute(k: string, v: string) { if (k === 'placeholder') this._ph = v; },
  };
  return o as unknown as HTMLInputElement & typeof o;
};

console.log('=== A. formatNominal: angka -> tampilan bertitik ===');
eq('0 = kosong (bukan "0")', formatNominal(0), '');
eq('negatif = kosong', formatNominal(-5), '');
eq('NaN = kosong', formatNominal(NaN), '');
eq('satu digit', formatNominal(9), '9');
eq('999 tanpa titik', formatNominal(999), '999');
eq('1.000', formatNominal(1000), '1.000');
eq('100.000', formatNominal(100000), '100.000');
eq('1.000.000', formatNominal(1000000), '1.000.000');
eq('123.456.789', formatNominal(123456789), '123.456.789');
eq('desimal dipotong ke rupiah bulat', formatNominal(1234567.8), '1.234.567');
eq('999.999.999.999 (batas 12 digit)', formatNominal(999999999999), '999.999.999.999');
eq('42.000', formatNominal(42000), '42.000');

console.log('=== B. parseNominal: tampilan/sampah ketik -> angka ===');
eq("'100.000' -> 100000", parseNominal('100.000'), 100000);
eq("'50.000' -> 50000", parseNominal('50.000'), 50000);
eq("'0' -> 0", parseNominal('0'), 0);
eq("'' -> 0", parseNominal(''), 0);
eq("'abc' -> 0", parseNominal('abc'), 0);
eq("sampah ketik '50abc000' -> 50000", parseNominal('50abc000'), 50000);
eq("'Rp 1.500' -> 1500", parseNominal('Rp 1.500'), 1500);
eq("'50.000,5' -> 500005 (parser ambil SEMUA digit; rupiah bulat dijamin pemanggil)", parseNominal('50.000,5'), 500005);
eq("di-slice 12 digit '1234567890123456' -> 123456789012", parseNominal('1234567890123456'), 123456789012);
eq("'1.999.999' -> 1999999", parseNominal('1.999.999'), 1999999);

console.log('=== C. roundtrip: format -> parse kembali nilai sama ===');
for (const n of [9, 999, 1000, 50000, 42000, 123456789, 999999999999]) {
  eq(`roundtrip ${n}`, parseNominal(formatNominal(n)), n);
}

console.log('=== D. bacaNominal: pembaca baku input terformat ===');
eq('null -> 0', bacaNominal(null), 0);
eq("input '100.000' -> 100000", bacaNominal(stub('100.000')), 100000);
eq("input kosong -> 0", bacaNominal(stub('')), 0);

console.log('=== E. formatNominalLive: LIVE + leading zero + caret ===');
{
  // Bug root modal awal: ketik "0100000" jangan menggantung "0" muka.
  const s = stub('0100000');
  eq('nilai kembali 100.000', formatNominalLive(s), 100000);
  eq("value dirender '100.000' (nol muka gugur)", s.value, '100.000');
}
eq("value kosong -> nilai 0, value tetap ''", (() => { const s = stub(''); const n = formatNominalLive(s); return `${n}/${s.value}`; })(), "0/");
{
  // Caret ujung: setelah reformat, posisi = setelah digit terakhir.
  const s = stub('100000', 6);
  formatNominalLive(s);
  eq("caret di ujung '100.000'", s._sel, 7);
}
{
  // Caret tengah SEBELUM titik: jangan loncat ke ujung tiap ketik.
  const s = stub('50000', 1);
  formatNominalLive(s);
  eq("caret tengah tetap setelah '5'", s._sel, 1);
}
{
  // Caret tengah TEPAT di batas digit ke-3: tetap sebelum titik sisipan.
  const s = stub('100000', 3);
  formatNominalLive(s);
  eq('caret digit ke-3 tetap pos 3', s._sel, 3);
}
{
  const s = stub('aa12345', 8);
  eq('sampah muka dibuang', formatNominalLive(s), 12345);
  eq("value dirender '12.345'", s.value, '12.345');
}
{
  // Sudah terformat = tidak ada perubahan value -> caret TIDAK disentuh.
  const s = stub('50.000', 6);
  formatNominalLive(s);
  eq('value tetap', s.value, '50.000');
  eq('setSelectionRange tidak dipanggil saat value sama', s._sel, null);
}

console.log('=== F. pasangNominal: listener input = format + callback setelahnya ===');
{
  const s = stub('1000x');
  let diterima: number | null = null;
  pasangNominal(s, (n) => { diterima = n; });
  s.value = '300000';
  s.kirim();
  eq('callback menerima angka', diterima, 300000);
  eq("input ikut terformat '300.000'", s.value, '300.000');
}
{
  const s = stub('');
  pasangNominal(s); // tanpa callback
  s.value = '1.500';
  s.kirim();
  eq("tanpa callback tetap terformat '1.500'", s.value, '1.500');
}
pasangNominal(null, () => { eq('callback pada input null TIDAK dipanggil', false, true); });
eq('pasangNominal(null) tidak melempar', true, true);

console.log('=== G. prefillNominal: prefill 0 = kosong + placeholder (akar "0100000") ===');
{
  const s = stubPh(null);
  prefillNominal(s, 0);
  eq('prefill 0 -> value kosong', s.value, '');
  eq('placeholder "0" dipasang', s._ph, '0');
}
{
  const s = stubPh(null);
  prefillNominal(s, null);
  eq('prefill null -> kosong', s.value, '');
}
{
  const s = stubPh(null);
  prefillNominal(s, 20000);
  eq('prefill 20.000 terformat', s.value, '20.000');
}
{
  const s = stubPh(null);
  prefillNominal(s, '');
  eq("prefill '' -> tetap kosong", s.value, '');
}
{
  const s = stubPh(null);
  prefillNominal(s, 1500, 'cth: 1.500');
  eq('placeholder ikut argumen ketiga', s._ph, 'cth: 1.500');
}
{
  // Placeholder yang sudah ada jangan ditimpa (markup yang set sendiri aman).
  const s = stubPh('ada-sudah');
  prefillNominal(s, 500, 'jangan-pakai-ini');
  eq('placeholder lama dipertahankan', s._ph, null);
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
if (gagal > 0) process.exit(1);
