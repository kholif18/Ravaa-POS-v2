// Halaman Dashboard (#/dashboard) — halaman pembuka (default `#/`).
//
// RESTYLE 2026-10-12 (mockup pemilik "Ravaa POS Sales Dashboard.png"):
// 4 kartu KPI berikon (Omzet/Laba/Topup&Tarik/Antrian) dengan **delta %
// vs. kemarin**, grafik batang bersumbu-Y + tooltip hover + pilihan rentang
// (7/14/30 hari), kartu Status shift berbadge + dua tombol, Stok menipis
// berikon, dan Antrian offline selebar baris.
//
// ATURAN SATU SUMBER DATA: seluruh angka diambil dari
// `GET /api/reports/daily?date=` (N pemanggilan paralel) — tidak ada
// perhitungan ulang agregat di klien; SATU-SATUNYA pengecualian = delta %
// vs. kemarin (pembagian dua angka server untuk TAMPILAN, preseden
// `nonTunai` di shift-tutup.ts). Hari memakai UTC lewat `ui/waktu.ts`.
//
// Shift dibaca dari `GET /api/shifts/open?cashier=` — endpoint yang sama
// dengan gerbang POS. Outbox dibaca dari `outboxCount()` dan disegarkan
// tiap 5 detik selama halaman terpasang.

import { apiGet, HttpError, outboxCount } from '../api';
import { icon, type IconName } from '../ui/icons';
import { getCashier } from '../ui/user';
import { waktu, hariIni, geser, tglPanjang, tglPendek, hariPendek } from '../ui/waktu';
import { rp } from '../escpos';

/* ---------- tipe (subkumpulan kontrak GET /api/reports/daily & shifts) ---------- */

type LowStock = { sku: string; name: string; stock: number; min_stock: number };

type Laporan = {
  date: string;
  sales: { n: number; omzet: number; diskon: number };
  hpp: number;
  laba: number;
  topup: { kind: string; n: number; nominal: number; admin: number }[];
  lowStock: LowStock[];
};

type Shift = {
  id: number; opened_at: string; closed_at: string | null;
  modal_awal: number; modal_akhir: number | null; cashier: string; status: string;
};

type HariBar = { date: string; n: number; omzet: number; laba: number; topupNominal: number };

/* ---------- state ---------- */

const PILIHAN_N = [7, 14, 30];

const state = {
  hari: hariIni(),
  n: 7,                              // rentang grafik (pilihan 7/14/30)
  laporan: null as Laporan | null,   // laporan HARI INI (kartu + stok menipis)
  pekan: [] as HariBar[],            // N hari menaik, terakhir = hari ini
  shift: null as Shift | null,
  shiftErr: '',
  outbox: 0,
  loading: true,
  error: '',
};

let host: HTMLElement | null = null;
let jedaOutbox: ReturnType<typeof setInterval> | null = null;

/* ---------- util ---------- */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** N hari menaik: hari ini − (N−1) ... hari ini. */
function tanggalPekan(n: number): string[] {
  return Array.from({ length: n }, (_, i) => geser(hariIni(), i - (n - 1)));
}

/** Delta % dua angka server (TAMPILAN saja): null bila pembanding 0. */
function deltaPct(kini: number, lalu: number): { arah: 'naik' | 'turun'; pct: number } | null {
  if (lalu <= 0) return null;
  const pct = Math.round(((kini - lalu) / lalu) * 100);
  if (pct === 0) return null;
  return { arah: pct > 0 ? 'naik' : 'turun', pct: Math.abs(pct) };
}

/** Baris delta "↑ 12% (vs. kemarin)" — hijau naik, merah turun, redup bila
 *  pembanding 0 (hari pertama toko / kemarin kosong). */
function barisDelta(kini: number, lalu: number): string {
  const d = deltaPct(kini, lalu);
  if (!d) return `<span class="text-xs text-gray-400 dark:text-gray-500">(vs. kemarin)</span>`;
  const naik = d.arah === 'naik';
  return `<span class="inline-flex items-center gap-1 text-xs font-semibold ${
    naik ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
  } [&>svg]:size-3.5">${naik ? icon('chevR') : icon('chevD')}<span class="tabular-nums">${d.pct}%</span></span>
  <span class="text-xs text-gray-400 dark:text-gray-500">(vs. kemarin)</span>`;
}

/* ---------- render: 4 kartu KPI ---------- */

function ringkasan(): string {
  const l = state.laporan;
  const nominal = l?.topup.reduce((a, t) => a + t.nominal, 0) ?? 0;
  const admin = l?.topup.reduce((a, t) => a + t.admin, 0) ?? 0;
  const kemarin = state.pekan.length >= 2 ? state.pekan[state.pekan.length - 2] : null;

  const kartu: { label: string; ikon: IconName; warna: string; nilai: string; delta: string }[] = [
    {
      label: 'Omzet hari ini', ikon: 'reports',
      warna: 'bg-primary-soft text-primary dark:bg-primary/15',
      nilai: rp(l?.sales.omzet ?? 0),
      delta: barisDelta(l?.sales.omzet ?? 0, kemarin?.omzet ?? 0),
    },
    {
      label: 'Laba hari ini', ikon: 'wallet',
      warna: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
      nilai: rp(l?.laba ?? 0),
      delta: barisDelta(l?.laba ?? 0, kemarin?.laba ?? 0),
    },
    {
      label: 'Topup & tarik', ikon: 'sync',
      warna: 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400',
      nilai: rp(nominal),
      delta: barisDelta(nominal, kemarin?.topupNominal ?? 0),
    },
    {
      label: 'Antrian offline', ikon: 'users',
      warna: state.outbox
        ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
        : 'bg-primary-soft text-primary dark:bg-primary/15',
      nilai: String(state.outbox),
      delta: state.outbox
        ? `<span class="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400">${icon('alert')}<span>belum terkirim</span></span>`
        : `<span class="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 [&>svg]:size-3.5">${icon('check')}<span>Semua sudah terkirim</span></span>`,
    },
  ];
  return `<div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
    ${kartu
      .map(
        (k) => `<div class="card flex items-start gap-3">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-full ${k.warna} [&>svg]:size-5">${icon(k.ikon)}</span>
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${k.label}</p>
            <p class="mt-0.5 text-[20px] font-bold leading-tight tabular-nums text-gray-900 dark:text-white">${esc(k.nilai)}</p>
            <p class="mt-0.5 flex flex-wrap items-center gap-x-1.5">${k.delta}</p>
          </div>
        </div>`,
      )
      .join('')}
  </div>`;
}

/* ---------- render: grafik N hari (sumbu-Y + tooltip hover) ---------- */

function grafik(): string {
  const max = Math.max(1, ...state.pekan.map((d) => d.omzet));
  const tinggiPx = 160; // rel tetap (persen = 0 di kontainer auto-tinggi)
  const labelY = [max, Math.round(max / 2), 0].map((v) => rp(v));
  const batang = state.pekan
    .map((d) => {
      const tinggi = d.omzet <= 0 ? 2 : Math.max(4, Math.round((d.omzet / max) * 100));
      const hariIniKah = d.date === state.hari;
      const nilai = d.omzet > 0 ? rp(d.omzet) : 'Rp0';
      return `
      <div class="group relative h-full min-w-0 flex-1"
           data-tgl="${d.date}" data-omzet="${d.omzet}" data-n="${d.n}"
           title="${esc(tglPanjang(d.date))} — ${esc(nilai)} · ${d.n} transaksi">
        <span class="pointer-events-none absolute left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[10px] font-semibold text-white shadow-md group-hover:block" style="bottom:calc(${tinggi}% + 6px)">${esc(nilai)}</span>
        <div class="absolute inset-x-0 bottom-0 rounded-t-[4px] transition-colors ${
          d.omzet <= 0 ? 'bg-gray-200 dark:bg-gray-700' : hariIniKah ? 'bg-primary' : 'bg-primary/40 group-hover:bg-primary/70'
        }" style="height:${tinggi}%"></div>
      </div>`;
    })

  const totalOmzet = state.pekan.reduce((a, d) => a + d.omzet, 0);
  const totalN = state.pekan.reduce((a, d) => a + d.n, 0);
  const opsi = PILIHAN_N.map(
    (n) => `<option value="${n}"${n === state.n ? ' selected' : ''}>${n} hari terakhir</option>`,
  ).join('');
  return `
  <div class="card lg:col-span-2">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Penjualan ${state.n} hari</h2>
      <div class="flex items-center gap-2">
        <span class="chip">${icon('reports')}<span>${esc(rp(totalOmzet))} · ${totalN} transaksi</span></span>
        <select id="db-n" class="input input-sm !w-auto" aria-label="Rentang grafik">${opsi}</select>
        <button type="button" id="db-reload" class="chip" title="Muat ulang data">${icon('sync')}<span>Segarkan</span></button>
      </div>
    </div>
    <div class="mt-3 grid grid-cols-[auto_1fr] gap-x-2">
      <div class="flex flex-col justify-between text-right text-[10px] tabular-nums text-gray-400 dark:text-gray-500" style="height:${tinggiPx}px">
        <span>${esc(labelY[0])}</span><span>${esc(labelY[1])}</span><span>Rp0</span>
      </div>
      <div class="relative" style="height:${tinggiPx}px">
        <div class="pointer-events-none absolute inset-0 flex flex-col justify-between">
          <span class="border-t border-dashed border-gray-200 dark:border-gray-700"></span>
          <span class="border-t border-dashed border-gray-100 dark:border-gray-700/60"></span>
          <span class="border-t border-gray-200 dark:border-gray-700"></span>
        </div>
        <div class="absolute inset-0 flex items-end gap-1.5 sm:gap-2" role="img"
             aria-label="Grafik penjualan ${state.n} hari terakhir, total ${esc(rp(totalOmzet))} dari ${totalN} transaksi">
          ${batang}
        </div>
      </div>
      <div></div>
      <div class="flex gap-1.5 sm:gap-2">
        ${state.pekan
          .map(
            (d) => `<div class="min-w-0 flex-1 text-center text-[10px] text-gray-400 dark:text-gray-500">${esc(tglPendek(d.date))}</div>`,
          )
          .join('')}
      </div>
    </div>
    <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
      <span class="mr-1 inline-flex size-4 shrink-0 align-[-3px] text-primary [&>svg]:size-4">${icon('info')}</span> Batang = omzet per hari (UTC). Arahkan kursor ke batang untuk
      nilainya. Klik <a href="#/reports" class="underline">Laporan</a> untuk rincian per tanggal.
    </p>
  </div>`;
}

/* ---------- render: status shift ---------- */

function kartuShift(): string {
  const kasir = getCashier();
  const badge = state.shift && !state.shiftErr
    ? `<span class="badge-ok [&>svg]:size-3.5">${icon('check')}<span>Shift #${state.shift.id} · terbuka</span></span>`
    : '';
  const isi = state.shiftErr
    ? `<div class="empty">${icon('alert')}<span>${esc(state.shiftErr)}</span></div>`
    : state.shift
      ? `<ul class="mt-3 space-y-2 text-sm">
          <li class="flex items-center justify-between gap-2">
            <span class="text-gray-500 dark:text-gray-400">Kasir</span>
            <span class="font-medium text-gray-900 dark:text-white">${esc(state.shift.cashier)}</span>
          </li>
          <li class="flex items-center justify-between gap-2">
            <span class="text-gray-500 dark:text-gray-400">Dibuka</span>
            <span class="font-medium tabular-nums text-gray-900 dark:text-white">${esc(waktu(state.shift.opened_at))}</span>
          </li>
          <li class="flex items-center justify-between gap-2">
            <span class="text-gray-500 dark:text-gray-400">Modal awal</span>
            <span class="font-medium tabular-nums text-gray-900 dark:text-white">${esc(rp(state.shift.modal_awal))}</span>
          </li>
        </ul>
        <div class="mt-4 grid grid-cols-2 gap-2">
          <a href="#/pos" class="btn btn-primary justify-center">${icon('pos')}<span>Buka layar kasir</span></a>
          <a href="#/shifts" class="btn btn-ghost justify-center">${icon('shifts')}<span>Kelola shift</span></a>
        </div>`
      : `<div class="empty">${icon('shifts')}<span>Kasir <b>${esc(kasir)}</b> belum punya shift terbuka — buka lewat layar Kasir sebelum jualan.</span></div>
        <div class="mt-3">
          <a href="#/pos" class="btn btn-primary w-full justify-center">${icon('pos')}<span>Buka shift di POS</span></a>
        </div>`;
  return `
  <div class="card">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"><span class="inline-flex size-5 shrink-0 text-primary [&>svg]:size-5">${icon('shifts')}</span><span>Status shift</span></h2>
      ${badge}
    </div>
    ${isi}
  </div>`;
}

/* ---------- render: antrian offline (selebar baris) ---------- */

function kartuOutbox(): string {
  const n = state.outbox;
  return `
  <div class="card lg:col-span-2">
    <div class="flex items-center justify-between gap-2">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full ${
          n ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
        } [&>svg]:size-4">${icon(n ? 'alert' : 'sync')}</span>
        <span>Antrian offline</span>
      </h2>
      ${n ? `<span class="badge-low">${n} tertunda</span>` : `<span class="badge-ok [&>svg]:size-3.5">${icon('check')}<span>Tersinkron</span></span>`}
    </div>
    <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
      ${
        n
          ? `${n} permintaan (penjualan/topup) belum terkirim ke server — disimpan di perangkat ini dan dikirim otomatis tiap 5 detik selama ada koneksi.`
          : 'Semua transaksi sudah diterima server. Angka ini naik otomatis saat POS menembak ke server gagal (mis. koneksi putus).'
      }
    </p>
  </div>`;
}

/* ---------- render: stok menipis ---------- */

function stokMenipis(): string {
  const low = state.laporan?.lowStock ?? [];
  const baris = low
    .slice(0, 8)
    .map(
      (p) => `<li class="flex items-center gap-2 py-2">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary dark:bg-primary/15 [&>svg]:size-4">${icon('products')}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium text-gray-900 dark:text-white">${esc(p.name)}</span>
          <span class="cell-sub">${esc(p.sku)}</span>
        </span>
        <span class="shrink-0 text-sm font-semibold tabular-nums ${
          p.stock <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
        }">${p.stock} / min ${p.min_stock}</span>
        <span class="shrink-0 text-gray-300 dark:text-gray-600 [&>svg]:size-4">${icon('chevR')}</span>
      </li>`,
    )
    .join('');
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400 [&>svg]:size-4">${icon('alert')}</span>
        <span>Stok menipis</span>
      </h2>
      <a href="#/stock" class="chip">${icon('stock')}<span>Buka Stok</span></a>
    </div>
    ${
      low.length
        ? `<ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-800">${baris}</ul>`
        : `<div class="empty">Semua stok aman.</div>`
    }
  </div>`;
}

/* ---------- isi ---------- */

function isi(): string {
  if (state.loading) {
    return `<div class="space-y-3">
      <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
        ${'<div class="card"><div class="skel h-3 w-24"></div><div class="skel mt-2 h-7 w-32"></div></div>'.repeat(4)}
      </div>
      <div class="card"><div class="skel h-40 w-full"></div></div>
    </div>`;
  }
  if (state.error) {
    return `<div class="card"><div class="empty">${icon('alert')}<span>Gagal memuat dashboard: ${esc(state.error)}</span></div></div>`;
  }
  return `
    ${ringkasan()}
    <div class="grid gap-2 lg:grid-cols-3">
      ${grafik()}
      ${kartuShift()}
      ${kartuOutbox()}
      ${stokMenipis()}
    </div>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Angka diambil dari <code>GET /api/reports/daily?date=…</code> (${state.n} hari) dan
      <code>GET /api/shifts/open</code> — sumber yang sama dengan halaman Laporan
      dan gerbang POS, jadi tidak mungkin berbeda. Hari memakai UTC.
    </p>`;
}

function paint(): void {
  const body = host?.querySelector('#db-body');
  if (!body) return;
  body.innerHTML = `<div class="space-y-3">${isi()}</div>`;
  bind();
}

function bind(): void {
  host?.querySelector('#db-reload')?.addEventListener('click', () => void load());
  host?.querySelector('#db-n')?.addEventListener('change', (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    if (PILIHAN_N.includes(v) && v !== state.n) {
      state.n = v;
      void load();
    }
  });
}

/* ---------- muat ---------- */

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  const tanggal = tanggalPekan(state.n);
  try {
    const laporan = await Promise.all(
      tanggal.map((d) => apiGet<{ data: Laporan }>(`/api/reports/daily?date=${encodeURIComponent(d)}`)),
    );
    state.pekan = laporan.map((j) => ({
      date: j.data.date,
      n: j.data.sales.n,
      omzet: j.data.sales.omzet,
      laba: j.data.laba,
      topupNominal: j.data.topup.reduce((a, t) => a + t.nominal, 0),
    }));
    state.laporan = laporan[laporan.length - 1]?.data ?? null;
    state.hari = state.laporan?.date ?? hariIni();
  } catch (e) {
    state.error = errMsg(e);
    state.laporan = null;
    state.pekan = [];
  }
  // Shift: kegagalan (offline) TIDAK menghapus seluruh dashboard — hanya kartu
  // shift yang menampilkan catatan, persis perlakuan gerbang POS.
  try {
    const j = await apiGet<{ data: Shift | null }>(
      `/api/shifts/open?cashier=${encodeURIComponent(getCashier())}`,
    );
    state.shift = j.data;
    state.shiftErr = '';
  } catch (e) {
    state.shift = null;
    state.shiftErr = `Tidak bisa mengecek shift (${errMsg(e)})`;
  }
  state.outbox = outboxCount();
  state.loading = false;
  if (host?.isConnected) paint();
}

/* ---------- entry ---------- */

export async function mountDashboardPage(el: HTMLElement): Promise<void> {
  host = el;
  state.hari = hariIni();
  state.outbox = outboxCount();
  // Lebar penuh ke seluruh body (tanpa max-w/mx-auto) — konsisten dengan
  // halaman Stok & Produk; card/grafik di dalamnya sudah pakai grid responsif.
  el.innerHTML = `<div class="space-y-3"><div id="db-body"></div></div>`;
  paint();
  // Outbox berubah tiap kali flush 5 detik dari api.ts — segarkan angka tanpa
  // memuat ulang laporan, cukup paint() ulang bila jumlahnya berubah.
  if (jedaOutbox) clearInterval(jedaOutbox);
  jedaOutbox = setInterval(() => {
    if (!host?.isConnected) {
      if (jedaOutbox) clearInterval(jedaOutbox);
      jedaOutbox = null;
      return;
    }
    const n = outboxCount();
    if (n !== state.outbox) {
      state.outbox = n;
      paint();
    }
  }, 5000);
  await load();
}
