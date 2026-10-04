import { mountLabelsPage, unmountLabelsPage } from './pages/labels';
import { mountDashboardPage } from './pages/dashboard';
import { mountHistoryPage } from './pages/history';
import { mountReportsPage } from './pages/reports';
import { mountPosPage, unmountPosPage } from './pages/pos';
import { mountProductsPage } from './pages/products';
import { mountSatuanPage } from './pages/satuan';
import { mountCustomersPage } from './pages/customers';
import { mountDebtsPage } from './pages/debts';
import { mountShiftsPage } from './pages/shifts';
import { mountSettingsPage } from './pages/settings';
import { mountStockPage, unmountStockPage } from './pages/stock';
import {
  applySidebarState,
  applyTheme,
  bindShell,
  getTheme,
  isAdminRoute,
  parseRoute,
  renderPosShell,
  renderShell,
} from './ui/shell';
import { updateOutboxBadge } from './api';
import { getCashier } from './ui/user';

const app = document.getElementById('app');
if (!app) throw new Error('#app tidak ditemukan');

// Nama kasir dibaca dari localStorage tiap render (bukan sekali di module load),
// supaya hasil simpan di modal Profil langsung tercermin di header.
const cashier = getCashier;

/* ---------- Router ---------- */

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
  // Keluar dari POS: buang listener yang menempel ke document (posAbort,
  // lihat document.addEventListener di pos.ts). Dulu panggilan ini hanya ada di
  // cabang else yang tak terjangkau — listener mousedown dokumen POS bocor
  // selama user berada di halaman admin.
  if (route !== 'pos') unmountPosPage();

  if (route === 'products') {
    // Halaman Produk punya state sendiri (filter, form, sync) -> di-mount, bukan string statis.
    void mountProductsPage(page);
  } else if (route === 'dashboard') {
    // Dashboard: 7 laporan harian + shift + outbox, state sendiri.
    void mountDashboardPage(page);
  } else if (route === 'satuan') {
    void mountSatuanPage(page);
  } else if (route === 'customers') {
    // Pelanggan: master kontak, state sendiri (cari multi-kata + CRUD).
    void mountCustomersPage(page);
  } else if (route === 'debts') {
    // Hutang: ledger piutang, state sendiri (ringkasan + rincian + catat).
    void mountDebtsPage(page);
  } else if (route === 'stock') {
    // Halaman Stok: ringkasan + restock/opname, state sendiri -> di-mount.
    void mountStockPage(page);
  } else if (route === 'shifts') {
    // Shift Kasir: riwayat + buka/tutup shift, state sendiri.
    void mountShiftsPage(page);
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
  }
  // Tidak ada cabang else: parseRoute hanya menghasilkan 'pos' atau salah satu
  // dari 11 AdminRoute, dan semuanya sudah di-mount di atas.
}

function boot(): void {
  applyTheme(getTheme());
  applySidebarState();
  if (!location.hash) location.hash = '#/dashboard';
  render();
  window.addEventListener('hashchange', render);
}

boot();
