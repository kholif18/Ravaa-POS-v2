// Modal generik (utility): satu overlay, ESC/backdrop = batal.
// Panggil close() atau tombol OK (el.ok) dari pemanggil — modal TIDAK menutup sendiri
// supaya pemanggil bisa memvalidasi form dulu.

export interface ModalHandle {
  el: HTMLElement;
  ok: HTMLButtonElement;
  close: () => void;
}

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';

export function openModal(o: {
  title: string;
  body: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  wide?: boolean;
  /** `max-w-5xl` — dipakai form produk 2 kolom (kiri foto, kanan form).
   *  `wide` (max-w-3xl) tidak cukup: kolom kanan menyusut jadi ±460px dan
   *  grid 3 kolom "Harga" di dalamnya tinggal ±140px per input. */
  wider?: boolean;
  onMount?: (api: ModalHandle) => void;
}): ModalHandle {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const prevFocus = document.activeElement as HTMLElement | null;
  const title = o.title.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  overlay.innerHTML = `
    <div class="modal${o.wider ? ' modal-wider' : o.wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal-header">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white">${title}</h3>
        <button type="button" class="row-btn" data-x aria-label="Tutup">${CLOSE_SVG}</button>
      </div>
      <div class="modal-body">${o.body}</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-x>${o.cancelLabel ?? 'Batal'}</button>
        <button type="button" class="btn ${o.danger ? 'bg-red-600 text-white hover:bg-red-700' : 'btn-primary'}" data-ok>${o.okLabel ?? 'Simpan'}</button>
      </div>
    </div>`;

  let gone = false;
  const close = () => {
    if (gone) return;
    gone = true;
    document.removeEventListener('keydown', onKey, true);
    // prefers-reduced-motion: animasi keluar dimatikan CSS, jadi node boleh
    // dilepas sekarang juga — tidak usah menunggu 120ms yang tak terlihat.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      overlay.remove();
    } else {
      // remove + add dalam satu putaran JS yang sama: tidak ada frame
      // display:none di antaranya, jadi animasi keluar tetap jalan.
      overlay.classList.remove('is-open');
      overlay.classList.add('is-closing');
      window.setTimeout(() => overlay.remove(), 160); // 120ms animasi keluar + buffer
    }
    prevFocus?.focus?.();
  };
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // Modal bertumpuk (mis. konfirmasi di atas form): ESC hanya menutup yang teratas.
    // :not(.is-closing) — modal yang sedang menutup masih menempel di DOM selama
    // animasi; kalau dihitung, ESC kedua dalam <120ms justru "tertahan" olehnya.
    const stack = document.querySelectorAll('.modal-overlay:not(.is-closing)');
    if (stack[stack.length - 1] !== overlay) return;
    e.stopPropagation();
    close();
  }

  overlay.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  // Enter pada input = tekan OK (berguna untuk form produk/kategori).
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      handle.ok.click();
    }
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  overlay.classList.add('is-open');

  const handle: ModalHandle = {
    el: overlay,
    ok: overlay.querySelector('[data-ok]') as HTMLButtonElement,
    close,
  };
  o.onMount?.(handle);
  return handle;
}

export function confirmDialog(o: {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const handle = openModal({
      title: o.title,
      body: `<p class="text-sm text-gray-600 dark:text-gray-300">${o.message.replace(/</g, '&lt;')}</p>`,
      okLabel: o.okLabel ?? 'Ya',
      cancelLabel: o.cancelLabel ?? 'Batal',
      danger: o.danger,
      onMount: (api) => {
        // Fokus awal di Batal (opsi aman) — sesuai aturan dialog konfirmasi.
        api.el.querySelector<HTMLButtonElement>('[data-x]')?.focus();
        api.ok.addEventListener('click', () => { answer = true; api.close(); });
      },
    });
    const done = () => resolve(answer);
    handle.el.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', done, { once: true }));
    handle.el.addEventListener('mousedown', (e) => { if (e.target === handle.el) done(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); }, { capture: true, once: true });
    handle.ok.addEventListener('click', done, { once: true });
  });
}
