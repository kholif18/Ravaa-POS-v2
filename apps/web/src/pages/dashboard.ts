// Halaman Dashboard (#/dashboard) — halaman pembuka (default `#/`).
//
// Isi ringkas untuk pemilik/menjaga kasir: (1) kartu omzet & laba hari ini,
// (2) grafik penjualan 7 hari terakhir murni CSS (tanpa chart-lib — dilarang
// repo), (3) status shift kasir ini + antrian outbox offline, (4) stok menipis.
//
// ATURAN SATU SUMBER DATA: seluruh angka diambil dari
// `GET /api/reports/daily?date=` (7 pemanggilan paralel: hari ini + 6 hari
// sebelumnya) — tidak ada perhitungan ulang di klien, jadi angka di Dashboard
// mustahil beda dengan halaman Laporan untuk tanggal yang sama. Hari memakai
// UTC lewat `ui/waktu.ts` (satu implementasi untuk Riwayat/Laporan/Dashboard).
//
// Shift dibaca dari `GET /api/shifts/open?cashier=` — endpoint yang sama dengan
// gerbang POS, jadi "shift terbuka" di Dashboard = shift yang benar-benar bisa
// dipakai jualan. Outbox dibaca dari `outboxCount()` (localStorage) dan
// disegarkan tiap 5 detik selama halaman terpasang.

import { apiGet, HttpError, outboxCount } from '../api';
import { icon } from '../ui/icons';
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

type HariBar = { date: string; n: number; omzet: number };

/* ---------- state ---------- */

const N_HARI = 7;

const state = {
  hari: hariIni(),
  laporan: null as Laporan | null,   // laporan HARI INI (kartu + stok menipis)
  pekan: [] as HariBar[],            // N_HARI hari menaik, terakhir = hari ini
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
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  return e instanceof Error ? e.message : 'terjadi kesalahan';
}

/** 7 hari menaik: hari ini − 6 ... hari ini. */
function tanggalPekan(): string[] {
  return Array.from({ length: N_HARI }, (_, i) => geser(hariIni(), i - (N_HARI - 1)));
}

/* ---------- render ---------- */

function kepala(): string {
  return `
  <div class="card flex flex-wrap items-center justify-between gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="chip">${icon('calendar')}<span>${esc(tglPanjang(state.hari))}</span></span>
      <span class="chip">${icon('users')}<span>${esc(getCashier())}</span></span>
    </div>
    <button type="button" id="db-reload" class="chip" title="Muat ulang data">${icon('sync')}<span>Segarkan</span></button>
  </div>`;
}

function ringkasan(): string {
  const l = state.laporan;
  const nominal = l?.topup.reduce((a, t) => a + t.nominal, 0) ?? 0;
  const admin = l?.topup.reduce((a, t) => a + t.admin, 0) ?? 0;
  const nTopup = l?.topup.reduce((a, t) => a + t.n, 0) ?? 0;
  const kartu = [
    {
      label: 'Omzet hari ini',
      nilai: rp(l?.sales.omzet ?? 0),
      sub: l ? `${l.sales.n} transaksi (setelah diskon)` : 'memuat…',
    },
    {
      label: 'Laba hari ini',
      nilai: rp(l?.laba ?? 0),
      sub: 'omzet − HPP',
      tone: (l?.laba ?? 0) < 0 ? 'danger' : '',
    },
    { label: 'Topup & tarik', nilai: rp(nominal), sub: admin ? `+ ${rp(admin)} admin jasa` : `${nTopup} transaksi` },
    {
      label: 'Antrian offline',
      nilai: String(state.outbox),
      sub: state.outbox ? 'permintaan belum terkirim' : 'semua sudah terkirim',
      tone: state.outbox ? 'danger' : '',
    },
  ];
  return `<div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
    ${kartu
      .map((k) => {
        const warna = k.tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';
        return `<div class="card">
          <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">${k.label}</p>
          <p class="mt-1 text-sm font-semibold tabular-nums ${warna}">${esc(k.nilai)}</p>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">${esc(k.sub)}</p>
        </div>`;
      })
      .join('')}
  </div>`;
}

/** Grafik 7 hari — batang CSS murni. Tinggi % dari rel tetap (h-32), jadi
 *  tidak ada persen yang jatuh ke kontainer auto-tinggi (persen = 0 diam). */
function grafik(): string {
  const max = Math.max(1, ...state.pekan.map((d) => d.omzet));
  const batang = state.pekan
    .map((d) => {
      const tinggi = d.omzet <= 0 ? 2 : Math.max(6, Math.round((d.omzet / max) * 100));
      const hariIniKah = d.date === state.hari;
      const nilai = d.omzet > 0 ? rp(d.omzet) : 'Rp0';
      return `
      <div class="flex min-w-0 flex-1 flex-col items-center gap-1"
           data-tgl="${d.date}" data-omzet="${d.omzet}" data-n="${d.n}"
           title="${esc(tglPanjang(d.date))} — ${esc(nilai)} · ${d.n} transaksi">
        <span class="hidden text-[10px] font-medium tabular-nums sm:block ${
          hariIniKah ? 'text-primary' : 'text-gray-500 dark:text-gray-400'
        }">${esc(nilai)}</span>
        <div class="flex h-32 w-full items-end">
          <div class="w-full rounded-t-[3px] ${
            d.omzet <= 0 ? 'bg-gray-200 dark:bg-gray-700' : hariIniKah ? 'bg-primary' : 'bg-primary/45'
          }" style="height:${tinggi}%"></div>
        </div>
        <span class="text-[10px] ${hariIniKah ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}">${esc(
          hariPendek(d.date),
        )}</span>
        <span class="text-[10px] text-gray-400 dark:text-gray-500">${esc(tglPendek(d.date))}</span>
      </div>`;
    })
    .join('');
  const totalOmzet = state.pekan.reduce((a, d) => a + d.omzet, 0);
  const totalN = state.pekan.reduce((a, d) => a + d.n, 0);
  return `
  <div class="card lg:col-span-2">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Penjualan 7 hari</h2>
      <span class="chip">${icon('reports')}<span>${esc(rp(totalOmzet))} · ${totalN} transaksi</span></span>
    </div>
    <div class="mt-3 flex items-end gap-1.5 sm:gap-2" role="img"
         aria-label="Grafik penjualan 7 hari terakhir, total ${esc(rp(totalOmzet))} dari ${totalN} transaksi">
      ${batang}
    </div>
    <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
      Batang = omzet per hari (UTC), hari ini ditandai warna penuh. Klik
      <a href="#/reports" class="underline">Laporan</a> untuk rincian per tanggal.
    </p>
  </div>`;
}

function kartuShift(): string {
  const kasir = getCashier();
  const isi = state.shiftErr
    ? `<div class="empty">${icon('alert')}<span>${esc(state.shiftErr)}</span></div>`
    : state.shift
      ? `<ul class="mt-2 space-y-2 text-sm">
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
        <div class="mt-3 flex flex-wrap gap-2">
          <a href="#/pos" class="btn btn-primary !min-h-[36px] !px-3 !py-1.5">${icon('pos')}<span>Buka layar kasir</span></a>
          <a href="#/shifts" class="btn btn-ghost !min-h-[36px] !px-3 !py-1.5">${icon('shifts')}<span>Kelola shift</span></a>
        </div>`
      : `<div class="empty">${icon('shifts')}<span>Kasir <b>${esc(kasir)}</b> belum punya shift terbuka — buka lewat layar Kasir sebelum jualan.</span></div>
        <div class="mt-3">
          <a href="#/pos" class="btn btn-primary !min-h-[36px] !px-3 !py-1.5">${icon('pos')}<span>Buka shift di POS</span></a>
        </div>`;
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Status shift</h2>
      ${state.shift && !state.shiftErr ? `<span class="chip">${icon('check')}<span>Shift #${state.shift.id} · terbuka</span></span>` : ''}
    </div>
    ${isi}
  </div>`;
}

function kartuOutbox(): string {
  const n = state.outbox;
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Antrian offline</h2>
      ${n ? `<span class="badge-low">${n} tertunda</span>` : `<span class="badge-ok">tersinkron</span>`}
    </div>
    ${
      n
        ? `<p class="mt-2 text-sm text-gray-600 dark:text-gray-300">
            ${n} permintaan (penjualan/topup) belum terkirim ke server — disimpan di
            perangkat ini dan dikirim otomatis tiap 5 detik selama ada koneksi.
          </p>`
        : `<p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Semua transaksi sudah diterima server. Angka ini naik otomatis saat POS
            menembak ke server gagal (mis. koneksi putus).
          </p>`
    }
  </div>`;
}

function stokMenipis(): string {
  const low = state.laporan?.lowStock ?? [];
  return `
  <div class="card">
    <div class="flex items-baseline justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900 dark:text-white">Stok menipis</h2>
      <a href="#/stock" class="chip">${icon('stock')}<span>Buka Stok</span></a>
    </div>
    ${
      low.length
        ? `<ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
          ${low
            .slice(0, 8)
            .map(
              (p) => `<li class="flex items-center justify-between gap-2 py-2">
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium text-gray-900 dark:text-white">${esc(p.name)}</span>
                  <span class="cell-sub">${esc(p.sku)}</span>
                </span>
                <span class="shrink-0 text-sm font-semibold tabular-nums ${
                  p.stock <= 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                }">${p.stock} / min ${p.min_stock}</span>
              </li>`,
            )
            .join('')}
        </ul>`
        : `<div class="empty">Semua stok aman.</div>`
    }
  </div>`;
}

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
    <div class="grid gap-2 lg:grid-cols-2">
      ${grafik()}
      ${kartuShift()}
      ${kartuOutbox()}
      ${stokMenipis()}
    </div>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Angka diambil dari <code>GET /api/reports/daily?date=…</code> (7 hari) dan
      <code>GET /api/shifts/open</code> — sumber yang sama dengan halaman Laporan
      dan gerbang POS, jadi tidak mungkin berbeda. Hari memakai UTC.
    </p>`;
}

function paint(): void {
  const body = host?.querySelector('#db-body');
  if (!body) return;
  body.innerHTML = kepala() + `<div class="mt-3 space-y-3">${isi()}</div>`;
  bind();
}

function bind(): void {
  host?.querySelector('#db-reload')?.addEventListener('click', () => void load());
}

/* ---------- muat ---------- */

async function load(): Promise<void> {
  state.loading = true;
  state.error = '';
  paint();
  const tanggal = tanggalPekan();
  try {
    const laporan = await Promise.all(
      tanggal.map((d) => apiGet<{ data: Laporan }>(`/api/reports/daily?date=${encodeURIComponent(d)}`)),
    );
    state.pekan = laporan.map((j) => ({ date: j.data.date, n: j.data.sales.n, omzet: j.data.sales.omzet }));
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
  // memuat ulang 7 laporan, cukup paint() ulang bila jumlahnya berubah.
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
