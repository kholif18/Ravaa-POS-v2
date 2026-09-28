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
