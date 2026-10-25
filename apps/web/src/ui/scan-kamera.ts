// Pemindai barcode lewat KAMERA perangkat (butir ROADMAP 1.6.1 — keputusan
// pemilik 2026-10-19: "scan kamera HP"). API browser murni (getUserMedia +
// BarcodeDetector) — TANPA dependensi (aturan repo: vanilla, tanpa lib baru).
//
// Dipakai POS desktop & mobile (tombol `#pos-scan-kamera` dirender di DUA
// shell dengan id sama — hanya satu yang ada di DOM). Hasil deteksi diserahkan
// ke pemanggil lewat callback; pos.ts mengalirkannya ke JALUR `#pos-q` yang
// sama dengan scan ketik/Enter, jadi sintaks `Qty*Kode` tetap jalan.
//
// Batas platform (FAKTA, bukan bug yang bisa ditambal di klien):
//  * getUserMedia hanya tersedia di konteks aman (HTTPS atau localhost).
//    Akses http://IP-LAN dari HP diblokir browser. BUTIR 1.7 (ACC 2026-10-25):
//    solusinya infrastruktur — Caddy menyajikan HTTPS internal di
//    https://<ip>:5656 (infra/Caddyfile). Di HP: peringatan sertifikat muncul
//    sekali, tap "Lanjutkan ke situs" → konteks jadi aman → kamera aktif.
//    Pesan di bawah mengarahkan ke langkah itu.
//  * `BarcodeDetector` adalah API browser (tersedia di Chrome/Edge Android &
//    sebagian desktop; tidak ada di Chrome Linux — terverifikasi 2026-10-19).
//    Browser tanpa API itu mendapat pesan yang menjelaskan.
//  * Deteksi & baca produk 100% OFFLINE: overlay ini TIDAK memanggil jaringan
//    sama sekali — hasil kode masuk ke alur `#pos-q` yang membaca cache
//    produk IndexedDB (store.ts getCachedProducts).
import { icon } from './icons';
import { toast } from './toast';

/** Kode barcode hasil deteksi (mentah — pemanggil yang memutuskan). */
type HasilScanKamera = (kode: string) => void;

/** Tipe minimal BarcodeDetector — lib.dom TS belum memuat API ini. */
interface DeteksiBarcode { rawValue?: string }
interface DetektorBarcode { detect(sumber: CanvasImageSource): Promise<DeteksiBarcode[]> }
interface KonstruktorBarcodeDetector {
  new (opsi?: { formats?: string[] }): DetektorBarcode;
  getSupportedFormats?: () => Promise<string[]>;
}

/** Format barcode yang relevan untuk label toko (EAN dari lembar label
 *  sendiri + Code 128 untuk SKU produk tanpa barcode — labelsheet.ts).
 *  Browser hanya menerima format yang didukungnya; sisanya dibuang. */
const FORMAT_DIMINTA = [
  'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'code_93', 'codabar',
];

let sesiAktif: { tutup: () => void } | null = null;

/** Kenapa kamera belum bisa dipakai di perangkat/konteks INI — pesan siap
 *  tampil (diperiksa tombol SEBELUM membuka overlay; tombol tidak dimatikan
 *  supaya kasir tahu sebabnya, bukan menebak-nebak). */
export function dukunganScanKamera(): { bisa: boolean; pesan: string } {
  if (!window.isSecureContext) {
    return {
      bisa: false,
      pesan: 'Kamera butuh koneksi aman — buka https://IP-server:5656 di HP, lalu tap "Lanjutkan ke situs" pada peringatan sertifikat (sekali per perangkat)',
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { bisa: false, pesan: 'Browser ini tidak mendukung akses kamera (getUserMedia)' };
  }
  // `typeof === 'function'` (bukan `in window`): properti bisa ada tapi
  // bernilai undefined — itu tetap "tidak didukung".
  if (typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'function') {
    return {
      bisa: false,
      pesan: 'Browser ini tidak bisa memindai barcode (tanpa BarcodeDetector) — pakai Chrome/Edge terbaru',
    };
  }
  return { bisa: true, pesan: '' };
}

/** Ada overlay pemindai yang terbuka? (`bindPintasan()` POS melepas semua
 *  pintasan kasir selama true — jangan sampai F2/F10 menembus overlay.) */
export function scanKameraTerbuka(): boolean {
  return sesiAktif !== null;
}

/** Tutup paksa (dipanggil `unmountPosPage`). Wajib lewat sini: overlay nempel
 *  di document.body dan track kamera tetap HIDUP walau DOM-nya dihapus. */
export function tutupScanKamera(): void {
  sesiAktif?.tutup();
}

/** Buka overlay pemindai; `onHasil` dipanggil SEKALI lalu overlay menutup
 *  sendiri. Semua jalur gagal = toast penjelas + tanpa overlay. */
export async function bukaScanKamera(onHasil: HasilScanKamera): Promise<void> {
  const dukung = dukunganScanKamera();
  if (!dukung.bisa) {
    toast(dukung.pesan, 'warning');
    return;
  }
  if (sesiAktif) return; // sudah terbuka — klik kedua diabaikan

  const wrap = document.createElement('div');
  wrap.className = 'sk-overlay pos-scope';
  wrap.innerHTML = `
    <div class="sk-panel" role="dialog" aria-modal="true" aria-label="Pindai barcode dengan kamera">
      <div class="sk-head">
        <span class="sk-judul">${icon('camera')} Pindai barcode</span>
        <button type="button" class="icon-btn" data-sk-tutup aria-label="Tutup pemindai">${icon('close')}</button>
      </div>
      <div class="sk-view">
        <video class="sk-video" playsinline muted></video>
        <div class="sk-frame" aria-hidden="true"></div>
      </div>
      <p class="sk-hint" data-sk-status aria-live="polite">Meminta izin kamera…</p>
    </div>`;
  document.body.appendChild(wrap);

  const video = wrap.querySelector('video')!;
  const status = wrap.querySelector<HTMLElement>('[data-sk-status]')!;
  let stream: MediaStream | null = null;
  let timer: number | undefined;
  let berakhir = false;

  function tutup(): void {
    if (berakhir) return;
    berakhir = true;
    if (timer !== undefined) window.clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    if (sesiAktif?.tutup === tutup) sesiAktif = null;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    tutup();
  }

  wrap.querySelector('[data-sk-tutup]')?.addEventListener('click', tutup);
  // Esc dari mana pun selama overlay terbuka (capture — jalan duluan).
  // `bindPintasan` POS punya guard `scanKameraTerbuka()` sendiri, jadi tidak
  // ada pintasan kasir yang menembus lewat belakang overlay.
  document.addEventListener('keydown', onKey, true);
  (wrap.querySelector('[data-sk-tutup]') as HTMLElement | null)?.focus();
  sesiAktif = { tutup };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    toast(pesanGagalKamera(err), 'warning');
    tutup();
    return;
  }
  if (berakhir) {
    // Kasir menutup overlay selagi izin kamera masih diproses — matikan track
    // yang telanjur terbuka, jangan lanjut memutar video.
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  video.srcObject = stream;
  // play() SENGAJA tidak di-await: di lingkungan tanpa kompositor (mis.
  // headless/GPU terbatas — terbukti 2026-10-19: promise tidak pernah
  // selesai, overlay diam di "Meminta izin kamera…") video tetap mengalir
  // untuk detect() — jangan menggantung di sini.
  void video.play().catch(() => {});

  const Konstruktor = (window as unknown as { BarcodeDetector?: KonstruktorBarcodeDetector }).BarcodeDetector;
  let detektor: DetektorBarcode | null = null;
  if (Konstruktor) {
    try {
      const didukung = await Konstruktor.getSupportedFormats?.();
      const formats = Array.isArray(didukung)
        ? FORMAT_DIMINTA.filter((f) => didukung.includes(f))
        : FORMAT_DIMINTA;
      detektor = formats.length ? new Konstruktor({ formats }) : new Konstruktor();
    } catch {
      // Format spesifik ditolak implementasi browser — coba tanpa format.
      try { detektor = new Konstruktor(); } catch { detektor = null; }
    }
  }
  if (!detektor) {
    toast('Pemindai barcode browser gagal diinisialisasi', 'warning');
    tutup();
    return;
  }
  status.textContent = 'Arahkan kamera ke barcode produk';

  const d: DetektorBarcode = detektor;
  const putaran = async (): Promise<void> => {
    if (berakhir) return;
    try {
      const hasil = await d.detect(video);
      const kode = hasil.map((h) => (h.rawValue ?? '').trim()).find((v) => v !== '');
      if (kode) {
        tutup();
        onHasil(kode);
        return;
      }
    } catch {
      // Frame pertama kadang belum siap — putaran berikutnya mencoba lagi.
    }
    if (!berakhir) timer = window.setTimeout(() => void putaran(), 140);
  };
  timer = window.setTimeout(() => void putaran(), 140);
}

/** Terjemah error getUserMedia jadi kalimat yang bisa ditindaklanjuti kasir. */
function pesanGagalKamera(err: unknown): string {
  const nama = err instanceof DOMException ? err.name : '';
  if (nama === 'NotAllowedError' || nama === 'SecurityError') {
    return 'Akses kamera ditolak — izinkan kamera untuk situs ini di pengaturan browser';
  }
  if (nama === 'NotFoundError' || nama === 'OverconstrainedError') {
    return 'Tidak ada kamera yang terdeteksi di perangkat ini';
  }
  if (nama === 'NotReadableError') {
    return 'Kamera sedang dipakai aplikasi lain — tutup dulu aplikasinya';
  }
  return `Kamera gagal dibuka${nama ? ` (${nama})` : ''}`;
}
