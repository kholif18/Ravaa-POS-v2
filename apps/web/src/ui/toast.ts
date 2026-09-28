// Toast notifikasi vanilla (sukses/error/warning/info).
// Posisi: kanan-bawah desktop, atas-tengah HP. Maks 3, auto-dismiss.

export type ToastType = 'success' | 'error' | 'warning' | 'info';

const AUTO_MS: Record<ToastType, number> = {
  success: 3500,
  info: 3500,
  warning: 4000,
  error: 5000,
};

function root(): HTMLElement {
  let r = document.getElementById('toast-root');
  if (!r) {
    r = document.createElement('div');
    r.id = 'toast-root';
    r.className = 'toast-root';
    r.setAttribute('aria-live', 'polite');
    document.body.appendChild(r);
  }
  return r;
}

export function toast(message: string, type: ToastType = 'info', ms?: number): void {
  const r = root();
  while (r.children.length >= 3) r.firstElementChild?.remove();
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const dot = document.createElement('span');
  dot.className = 'tdot';
  const txt = document.createElement('span');
  txt.className = 'min-w-0 flex-1';
  txt.textContent = message;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'shrink-0 text-gray-400 transition hover:text-gray-700 dark:hover:text-gray-100';
  x.setAttribute('aria-label', 'Tutup notifikasi');
  x.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    t.remove();
  };
  x.addEventListener('click', dismiss);
  t.append(dot, txt, x);
  r.appendChild(t);
  window.setTimeout(dismiss, ms ?? AUTO_MS[type]);
}
