// Client API: fetch JSON + outbox (antrian offline) untuk sales & topup.
// ID uuid dibuat di client -> POST ulang aman (server idempotent).

import { toast } from './ui/toast';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : 'jaringan terputus', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

export const apiGet = <T,>(path: string) => req<T>(path);
export const apiPost = <T,>(path: string, data: unknown) =>
  req<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const apiDelete = <T,>(path: string) => req<T>(path, { method: 'DELETE' });

export function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------- outbox: simpan request gagal, coba lagi tiap 5 detik ----------
type Job = { key: string; path: string; data: unknown; ts: number };
const LS_KEY = 'ravaa.outbox.v1';

function load(): Job[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Job[]; }
  catch { return []; }
}
function save(jobs: Job[]) { localStorage.setItem(LS_KEY, JSON.stringify(jobs)); }

export function enqueue(path: string, data: Record<string, unknown>): string {
  const jobs = load();
  const id = (data.id as string) ?? uuid();
  jobs.push({ key: id, path, data: { ...data, id }, ts: Date.now() });
  save(jobs);
  updateOutboxBadge();
  return id;
}

export function outboxCount(): number { return load().length; }

export async function flushOutbox(onDone?: (key: string) => void): Promise<void> {
  const jobs = load();
  if (jobs.length === 0) return;
  if (!navigator.onLine) return;
  const rest: Job[] = [];
  for (const j of jobs) {
    try {
      await apiPost(j.path, j.data);
      onDone?.(j.key);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status >= 400 && status < 500) {
        // Gagal validasi permanen (stok kurang, item kosong, dsb) — buang,
        // jangan retry tiap 5 detik selamanya hingga spam console + server.
        console.warn('[outbox] drop poison job', j.key, j.path, e);
        toast(`Antrian dibuang (gagal validasi): ${e instanceof Error ? e.message : e}`, 'error');
        continue;
      }
      rest.push(j); // jaringan mati / server 5xx -> coba lagi nanti
    }
  }
  save(rest);
  updateOutboxBadge();
}

export function updateOutboxBadge(): void {
  const n = outboxCount();
  const el = document.getElementById('outbox-badge');
  if (el) {
    el.textContent = n > 0 ? `antrian ${n}` : 'online';
    el.className = n > 0
      ? 'badge-low'
      : 'hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400';
  }
  // Chip notif POS "n transaksi antre offline" (baris saklar cetak, `#pos-notif`)
  // — teks & visibilitas disegarkan DI SINI supaya tidak basi sampai repaint
  // POS berikutnya (revisi pemilik 2026-10-08, lihat notifChips() di pos.ts).
  // Elemen dirender terus-menerus (hidden saat 0) supaya selalu ada untuk
  // pembaruan ini.
  const ob = document.querySelector<HTMLElement>('a[data-notif-outbox]');
  if (ob) {
    ob.classList.toggle('hidden', n === 0);
    const span = ob.querySelector('span');
    if (span) span.textContent = `${n} transaksi antre offline`;
  }
}

setInterval(() => { void flushOutbox(); }, 5000);
window.addEventListener('online', () => { void flushOutbox(); });
