// Konfirmasi & pesan modal — SweetAlert2 (swal) sebagai standar.
// Aturan repo: toast untuk success/error/warning, swal untuk KONFIRMASI &
// pesan yang butuh keputusan pengguna (bukan `alert()`/`confirm()` native).
//
// PENTING: `buttonsStyling: false` membuat SweetAlert2 sama sekali tidak
// memberi gaya tombol — dan `confirmButtonColor`/`cancelButtonColor` ikut
// DIABAIKAN (butuh buttonsStyling: true). Dulu itu bikin tombol transparan,
// tanpa padding, dan menempel jadi satu baris ("Batal Nonaktifkan").
// Solusi: class sendiri `.sw-btn*` di styles.css yang menanggung seluruh
// tampilan. Warna hex TIDAK lagi dikirim lewat opsi swal karena sudah terbukti
// diabaikan — dan `customClass` ditulis per-panggilan (bukan di mixin) supaya
// tidak bergantung pada perilaku merge mixin+fire.

import Swal from 'sweetalert2';

const base = Swal.mixin({
  buttonsStyling: false,
  focusCancel: true,
});

/** Kelas tombol & popup. Bahaya = merah, normal = primer, batal = outline. */
function cls(danger: boolean): Record<string, string> {
  return {
    popup: danger ? 'sw-popup sw-danger' : 'sw-popup',
    actions: 'sw-actions',
    confirmButton: danger ? 'sw-btn sw-btn-danger' : 'sw-btn sw-btn-primary',
    cancelButton: 'sw-btn sw-btn-ghost',
  };
}

/** Konfirmasi Ya/Batal. Resolusi boolean. */
export function confirmDialog(o: {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  icon?: 'warning' | 'question' | 'error' | 'info' | 'success';
}): Promise<boolean> {
  return base
    .fire({
      title: o.title,
      text: o.message,
      icon: o.icon ?? (o.danger ? 'warning' : 'question'),
      showCancelButton: true,
      // Label tegas & konsisten: "Batal" vs aksi yang benar-benar terjadi.
      confirmButtonText: o.okLabel ?? 'Ya, lanjutkan',
      cancelButtonText: o.cancelLabel ?? 'Batal',
      customClass: cls(o.danger === true),
      focusCancel: true,
    })
    .then((r) => r.isConfirmed)
    .catch(() => false);
}

/** Pesan SWAL tanpa tombol Ya/Batal (dipakai bila toast tidak cukup penting). */
export function alertDialog(o: {
  title: string;
  message: string;
  icon?: 'warning' | 'question' | 'error' | 'info' | 'success';
}): Promise<void> {
  return base
    .fire({
      title: o.title,
      text: o.message,
      icon: o.icon ?? 'info',
      showCancelButton: false,
      confirmButtonText: 'Mengerti',
      customClass: cls(false),
    })
    .then(() => undefined);
}

/** Pilihan LEBIH DARI DUA — dipakai dialog cetak selesai transaksi
 *  ([Thermal] [A4] [Tidak]). SweetAlert2 punya tepat tiga slot tombol
 *  (confirm / deny / cancel), jadi `choices` maksimal tiga: slot pertama
 *  = konfirmasi (primer), kedua = deny, ketiga = cancel (ghost).
 *  Resolusi: key tombol yang diklik, atau `null` bila Esc / klik luar.
 *  `html` (mutual eksklusif dengan `message`): isi ber-format — dipakai
 *  modal resume pasca-bayar POS (putaran 11, 2026-10-05) untuk baris-baris
 *  ringkasan; `message` tetap untuk teks polos caller lama. */
export function choiceDialog(o: {
  title: string;
  message?: string;
  html?: string;
  icon?: 'question' | 'info' | 'success' | 'warning';
  choices: { key: string; label: string }[];
  cancelLabel?: string;
  /** `true` = sweetalert2 menempelkan listener keydown ke **window (capture)**
   *  — Esc didengar dari mana pun fokus. Default bawaan menempel di popup,
   *  jadi Esc MATI bila fokus sempat pindah keluar (kasus modal resume POS:
   *  `pay()` memfokus kolom scan sesaat setelah dialog dibuka). */
  keydownListenerCapture?: boolean;
  /** `false` = sweetalert2 tidak mengembalikan fokus ke elemen saat
   *  `fire()` (returnFocus-nya bisa menimpa `focusScan()` penutup yang
   *  menyiapkan kolom scan untuk transaksi berikutnya). */
  returnFocus?: boolean;
}): Promise<string | null> {
  const [a, b] = o.choices;
  return base
    .fire({
      title: o.title,
      ...(o.html != null ? { html: o.html } : { text: o.message }),
      icon: o.icon ?? 'question',
      ...(o.keydownListenerCapture === true ? { keydownListenerCapture: true } : {}),
      ...(o.returnFocus === false ? { returnFocus: false } : {}),
      showDenyButton: b !== undefined,
      showCancelButton: true,
      confirmButtonText: a?.label ?? 'Ya',
      denyButtonText: b?.label ?? '',
      cancelButtonText: o.cancelLabel ?? 'Batal',
      customClass: {
        popup: 'sw-popup',
        actions: 'sw-actions',
        confirmButton: 'sw-btn sw-btn-primary',
        denyButton: 'sw-btn sw-btn-ghost',
        cancelButton: 'sw-btn sw-btn-ghost',
      },
      focusCancel: true,
    })
    .then((r) => (r.isConfirmed ? a?.key ?? null : r.isDenied ? b?.key ?? null : null))
    .catch(() => null);
}
