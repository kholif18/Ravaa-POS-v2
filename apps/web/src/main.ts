import { mountLabelsPage, unmountLabelsPage } from './pages/labels';
import { mountDashboardPage } from './pages/dashboard';
import { mountHistoryPage } from './pages/history';
import { mountReportsPage } from './pages/reports';
import { mountPosPage, unmountPosPage } from './pages/pos';
import { mountProductsPage } from './pages/products';
import { mountSatuanPage } from './pages/satuan';
import { mountSettingsPage } from './pages/settings';
import { mountStockPage, unmountStockPage } from './pages/stock';
import { icon, type IconName } from './ui/icons';
import {
  applySidebarState,
  applyTheme,
  bindShell,
  getTheme,
  isAdminRoute,
  parseRoute,
  renderPosShell,
  renderShell,
  type AdminRoute,
  type Route,
} from './ui/shell';
import { updateOutboxBadge } from './api';
import { getCashier } from './ui/user';

const app = document.getElementById('app');
if (!app) throw new Error('#app tidak ditemukan');

// Nama kasir dibaca dari localStorage tiap render (bukan sekali di module load),
// supaya hasil simpan di modal Profil langsung tercermin di header.
const cashier = getCashier;

/* ---------- Halaman sementara (kerangka) ---------- */

interface PagePlan {
  icon: IconName;
  intro: string;
  todo: string[];
}

const PAGES: Record<AdminRoute, PagePlan> = {
  dashboard: {
    icon: 'dashboard',
    intro: 'Ringkasan penjualan hari ini, shift berjalan, dan produk stok menipis.',
    todo: ['Kartu omzet, laba, topup & antrian offline', 'Grafik penjualan 7 hari (CSS)', 'Status shift kasir & outbox', 'Stok menipis'],
  },
  labels: {
    icon: 'print',
    intro: 'Cetak label harga: alat di kiri, pratinjau label 32 kolom di kanan.',
    todo: ['Pencarian & filter kategori', 'Centang label terpilih', 'Status print-agent', 'Cetak massal'],
  },
  products: {
    icon: 'products',
    intro: 'Kelola produk, kategori, dan tipe. Kategori memakai sidebar kiri, tabel di kanan.',
    todo: ['Sidebar kategori + tipe dengan CRUD inline', 'Tabel produk (stok, harga, status)', 'Modal tambah/ubah produk', 'Restock barang track_stock'],
  },
  satuan: {
    icon: 'categories',
    intro: 'Master satuan untuk struk. Form produk memilih dari daftar ini, jadi tidak ada lagi ketik bebas.',
    todo: ['CRUD satuan (tambah/ubah/hapus)', 'Satuan terkunci dipakai produk', 'Urutan dropdown form produk'],
  },
  stock: {
    icon: 'stock',
    intro: 'Pantau stok menipis dan riwayat restock.',
    todo: ['Filter stok kritis', 'Riwayat restock', 'Stok opname'],
  },
  history: {
    icon: 'receipt',
    intro: 'Linimasa penjualan dan topup/tarik per hari — klik baris untuk membuka isinya.',
    todo: ['Pilih hari (prev / next / Hari ini)', 'Gabung penjualan + topup/tarik', 'Ringkasan seangka halaman Laporan', 'Rincian item nota & pembayaran'],
  },
  reports: {
    icon: 'reports',
    intro: 'Laporan harian pemilik toko: omzet, laba, HPP, metode bayar, dan produk terlaris.',
    todo: ['Filter tanggal (prev / next / Hari ini)', 'Kartu omzet, laba, HPP, diskon', 'Rekap per metode bayar', 'Topup & tarik di luar omzet', 'Produk terlaris 10 besar', 'Stok menipis', 'Ekspor CSV'],
  },
  shifts: {
    icon: 'shifts',
    intro: 'Buka/tutup shift kasir dengan modal awal dan modal akhir.',
    todo: ['Modal buka shift', 'Modal tutup shift + selisih', 'Riwayat shift'],
  },
  settings: {
    icon: 'settings',
    intro: 'Aturan server yang berlaku untuk semua device kasir (bukan per browser).',
    todo: ['Stok boleh minus / tidak', 'Aturan lain menyusul'],
  },
};

function skeletonCard(): string {
  return `
    <div class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div class="w-1/2 space-y-2">
          <div class="skel"></div>
          <div class="skel w-2/3"></div>
        </div>
        <span class="chip">segera</span>
      </div>
      <ul class="space-y-2">
        <div class="skel"></div>
        <div class="skel w-5/6"></div>
        <div class="skel w-4/6"></div>
      </ul>
    </div>`;
}

function renderAdminPage(route: AdminRoute): string {
  const plan = PAGES[route];
  return `
    <div class="mx-auto max-w-5xl space-y-5">
      <div class="card flex items-start gap-4">
        <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary dark:bg-primary/15">
          ${icon(plan.icon)}
        </span>
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">Kerangka ${route} siap</h2>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">${plan.intro}</p>
        </div>
      </div>
      ${skeletonCard()}
      <div class="card">
        <h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Rencana isi halaman</h3>
        <ul class="grid gap-2 sm:grid-cols-2">
          ${plan.todo.map((t) => `<li class="chip justify-start">${t}</li>`).join('')}
        </ul>
      </div>
    </div>`;
}

/* ---------- Router ---------- */

function pageHtml(route: Route): string {
  return renderAdminPage(route as AdminRoute);
}

function render(): void {
  const route = parseRoute(location.hash);
  app!.innerHTML = isAdminRoute(route) ? renderShell(route, cashier()) : renderPosShell();
  bindShell();
  updateOutboxBadge();
  const page = document.getElementById('page');
  if (!page) return;
  // Keluar dari halaman Stok: buang host-nya supaya paint() berikutnya tidak
  // menulis ke DOM yang sudah tergantikan innerHTML di atas.
  if (route !== 'stock') unmountStockPage();
  if (route !== 'labels') unmountLabelsPage();

  if (route === 'products') {
    // Halaman Produk punya state sendiri (filter, form, sync) -> di-mount, bukan string statis.
    void mountProductsPage(page);
  } else if (route === 'dashboard') {
    // Dashboard: 7 laporan harian + shift + outbox, state sendiri.
    void mountDashboardPage(page);
  } else if (route === 'satuan') {
    void mountSatuanPage(page);
  } else if (route === 'stock') {
    // Halaman Stok: ringkasan + restock/opname, state sendiri -> di-mount.
    void mountStockPage(page);
  } else if (route === 'history') {
    // Riwayat transaksi: linimasa penjualan + topup/tarik, state sendiri.
    void mountHistoryPage(page);
  } else if (route === 'reports') {
    // Laporan harian: angka diambil utuh dari GET /api/reports/daily.
    void mountReportsPage(page);
  } else if (route === 'pos') {
    // POS: gate shift + keranjang, state sendiri -> di-mount.
    void mountPosPage(page);
  } else if (route === 'labels') {
    // Label harga: pratinjau per produk + cetak massal -> di-mount.
    void mountLabelsPage(page);
  } else if (route === 'settings') {
    // Pengaturan: baca-tulis GET/POST /api/settings -> di-mount.
    void mountSettingsPage(page);
  } else {
    // Keluar dari POS: buang listener yang menempel ke document.
    unmountPosPage();
    page.innerHTML = pageHtml(route);
  }
}

function boot(): void {
  applyTheme(getTheme());
  applySidebarState();
  if (!location.hash) location.hash = '#/dashboard';
  render();
  window.addEventListener('hashchange', render);
}

boot();
