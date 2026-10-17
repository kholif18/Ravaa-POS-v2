import { mountLabelsPage, unmountLabelsPage } from './pages/labels';
import { mountDashboardPage } from './pages/dashboard';
import { mountHistoryPage } from './pages/history';
import { mountReturnsPage } from './pages/returns';
import { mountReportsPage } from './pages/reports';
import { mountPosPage, unmountPosPage } from './pages/pos';
import { mountProductsPage } from './pages/products';
import { mountSatuanPage } from './pages/satuan';
import { mountCustomersPage } from './pages/customers';
import { mountSuppliersPage } from './pages/suppliers';
import { mountPurchasesPage } from './pages/purchases';
import { mountExpensesPage } from './pages/expenses';
import { mountDebtsPage } from './pages/debts';
import { mountShiftsPage } from './pages/shifts';
import { mountSettingsPage } from './pages/settings';
import { mountUsersPage } from './pages/users';
import { mountAuditPage } from './pages/audit';
import { renderLoginPage } from './pages/login';
import { renderProfilPage } from './pages/profil';
import { renderUbahSandiPage } from './pages/ubah-sandi';
import { mountStockPage, unmountStockPage } from './pages/stock';
import {
  applySidebarState,
  applyTheme,
  bindShell,
  bolehBuka,
  getTheme,
  isAdminRoute,
  parseRoute,
  renderLabelShell,
  renderPosShell,
  renderShell,
} from './ui/shell';
import { updateOutboxBadge } from './api';
import { getCashier } from './ui/user';
import { profilSaya, ruteBawaan } from './ui/auth';
import { toast } from './ui/toast';

const app = document.getElementById('app');
if (!app) throw new Error('#app tidak ditemukan');

// Nama kasir dibaca dari localStorage tiap render (bukan sekali di module load),
// supaya hasil simpan di modal Profil langsung tercermin di header.
const cashier = getCashier;

/* ---------- Router (berpenjaga login 2026-10-11) ---------- */

function renderBare(judul: string, gambar: (el: HTMLElement) => void): void {
  document.title = `${judul} — Ravaa POS`;
  app!.innerHTML = `<div class="flex h-full flex-col"><main class="page" id="page" tabindex="-1"></main></div>`;
  gambar(app!.querySelector('#page')!);
}

async function render(): Promise<void> {
  const route = parseRoute(location.hash);
  if (route === 'login') {
    renderBare('Masuk', renderLoginPage);
    return;
  }
  const saya = await profilSaya();
  if (!saya) {
    // Tanpa sesi: paksa ke Login (kecuali sudah di sana — hindari loop hash).
    if (location.hash !== '#/login') location.hash = '#/login';
    else renderBare('Masuk', renderLoginPage);
    return;
  }
  if (saya.wajib && route !== 'ubah-sandi') {
    if (location.hash !== '#/ubah-sandi') location.hash = '#/ubah-sandi';
    else renderBare('Ganti sandi', renderUbahSandiPage);
    return;
  }
  if (route === 'profil') {
    // Profil: edit nama sendiri + pref perangkat — di dalam shell (semua peran).
    app!.innerHTML = renderShell(route, cashier(), saya.akun.role);
    bindShell();
    updateOutboxBadge();
    renderProfilPage(document.getElementById('page')!);
    return;
  }
  if (route === 'ubah-sandi') {
    renderBare('Ganti sandi', renderUbahSandiPage);
    return;
  }
  if (!bolehBuka(route, saya.akun.role)) {
    // Kasir nyasar ke halaman owner (ketik hash manual): kembalikan ke
    // bawaan perannya SEKALI (hash berubah -> render ulang yang sah).
    toast('Halaman ini khusus owner', 'warning');
    location.hash = ruteBawaan(saya.akun.role);
    return;
  }
  // labels (2026-10-17) = layar penuh tanpa sidebar (shell sendiri, pola POS):
  // pratinjau lembar A4/Folio butuh lebar; masuknya lewat toolbar Produk.
  app!.innerHTML =
    route === 'labels'
      ? renderLabelShell()
      : isAdminRoute(route)
        ? renderShell(route, cashier(), saya.akun.role)
        : renderPosShell();
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
  } else if (route === 'suppliers') {
    // Supplier: master pemasok, state sendiri (cari multi-kata + CRUD).
    void mountSuppliersPage(page);
  } else if (route === 'purchases') {
    // Pembelian: nota PO kulakan, state sendiri (filter status + dialog).
    void mountPurchasesPage(page);
  } else if (route === 'expenses') {
    // Pengeluaran: kas keluar operasional per hari, state sendiri.
    void mountExpensesPage(page);
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
  } else if (route === 'returns') {
    // Retur penjualan: linimasa + retur manual, state sendiri.
    void mountReturnsPage(page);
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
  } else if (route === 'users') {
    // Pengguna: akun kasir & owner (khusus owner, dijaga guard + nav).
    void mountUsersPage(page);
  } else if (route === 'audit') {
    // Jejak audit: read-only, siapa mengubah apa (khusus owner).
    void mountAuditPage(page);
  }
  // Tidak ada cabang else: parseRoute hanya menghasilkan 'pos' atau salah satu
  // AdminRoute, dan semuanya sudah di-mount di atas.
}

function boot(): void {
  applyTheme(getTheme());
  applySidebarState();
  if (!location.hash) location.hash = '#/dashboard';
  void render();
  window.addEventListener('hashchange', () => void render());
  // PWA (2026-10-16): service worker HANYA di build produksi. Di server dev
  // Vite, SW justru merusak pengalaman (aset modul tidak ber-hash + cache
  // menahan versi lama sesudah edit). Gagal daftar bukan alasan app berhenti.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* offline/PWA tidak tersedia — abaikan */
      });
    });
  }
}

boot();
