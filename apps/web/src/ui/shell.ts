import { icon, type IconName } from './icons';
import { getCashier, initials, logout, openProfileModal } from './user';
import { akunTersimpan, type Peran } from './auth';

export type AdminRoute = 'dashboard' | 'products' | 'labels' | 'satuan' | 'stock' | 'suppliers' | 'history' | 'returns' | 'customers' | 'debts' | 'reports' | 'expenses' | 'purchases' | 'shifts' | 'settings' | 'users' | 'audit';
// login & ubah-sandi dirender TANPA shell (layar penuh) — bukan admin.
// profil = halaman shell SEMUA peran (edit nama sendiri + pref perangkat).
export type Route = 'pos' | 'login' | 'ubah-sandi' | 'profil' | AdminRoute;

interface NavItem {
  route: AdminRoute;
  label: string;
  icon: IconName;
  /** Peran yang boleh MELIHAT + MEMBUKA menu ini (login 2026-10-11).
   *  Kasir: POS + Riwayat + Retur + Pelanggan + Hutang + Stok + Shift
   *  (shift sendiri); sisanya khusus pemilik (uang keluar, harga modal,
   *  omzet/laba, aturan, akun). Server menegakkan hal yang sama — nav ini
   *  hanya cermin agar kasir tak mengklik jalan buntu. */
  roles: Peran[];
}

const SEMUA: Peran[] = ['pemilik', 'kasir'];
const MILIK: Peran[] = ['pemilik'];

export const ADMIN_NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Utama',
    items: [{ route: 'dashboard', label: 'Dashboard', icon: 'dashboard', roles: MILIK }],
  },
  {
    // Alur uang masuk: lihat transaksi -> retur (uang keluar) -> kelola
    // pelanggan -> piutang.
    group: 'Penjualan',
    items: [
      // Linimasa penjualan + topup/tarik per hari (baru 2026-09-30).
      { route: 'history', label: 'Riwayat transaksi', icon: 'receipt', roles: SEMUA },
      // Retur penjualan (Tahap 2, 2026-10-11): barang kembali + uang kembali.
      { route: 'returns', label: 'Retur', icon: 'sync', roles: SEMUA },
      // Pelanggan & piutang (baru 2026-10-04): master kontak + ledger hutang.
      { route: 'customers', label: 'Pelanggan', icon: 'users', roles: SEMUA },
      { route: 'debts', label: 'Hutang', icon: 'wallet', roles: SEMUA },
    ],
  },
  {
    // Alur barang: master produk -> stok operasional -> pemasok -> kulakan ->
    // pendukung (satuan, label).
    group: 'Barang',
    items: [
      { route: 'products', label: 'Produk', icon: 'products', roles: MILIK },
      { route: 'stock', label: 'Stok', icon: 'stock', roles: SEMUA },
      // Master pemasok (baru 2026-10-11): pindahan `customers.supplier_no` —
      // dipakai Pembelian sebagai pilihan pemasok.
      { route: 'suppliers', label: 'Supplier', icon: 'truck', roles: MILIK },
      // Nota kulakan PO (Tahap 3, 2026-10-11): order -> terima -> bayar.
      { route: 'purchases', label: 'Pembelian', icon: 'download', roles: MILIK },
      { route: 'satuan', label: 'Satuan', icon: 'categories', roles: MILIK },
      // Label harga punya layar sendiri (kiri alat, kanan pratinjau) sejak
      // 2026-09-29 — dulu ia cuma dialog dari toolbar Produk.
      { route: 'labels', label: 'Label harga', icon: 'print', roles: MILIK },
    ],
  },
  {
    // Uang & pertanggungjawaban: laporan -> pengeluaran -> shift.
    group: 'Keuangan',
    items: [
      { route: 'reports', label: 'Laporan', icon: 'reports', roles: MILIK },
      // Kas keluar operasional (Tahap 1, 2026-10-11): mengurangi laci bila
      // terikat shift (lihat kasSeharusnya di shift-tutup.ts).
      { route: 'expenses', label: 'Pengeluaran', icon: 'coins', roles: MILIK },
      { route: 'shifts', label: 'Shift Kasir', icon: 'shifts', roles: SEMUA },
    ],
  },
  {
    // Group sendiri di paling bawah: pengaturan jarang disentuh dan sifatnya
    // BEDA dari data di atas — isinya aturan server yang berlaku untuk semua
    // device, bukan catatan per kasir.
    group: 'Sistem',
    items: [
      { route: 'settings', label: 'Pengaturan', icon: 'settings', roles: MILIK },
      // Akun & peran (login 2026-10-11): khusus pemilik.
      { route: 'users', label: 'Pengguna', icon: 'shieldCheck', roles: MILIK },
      // Jejak audit (2026-10-16): siapa mengubah apa — khusus pemilik.
      { route: 'audit', label: 'Jejak audit', icon: 'clock', roles: MILIK },
    ],
  },
];

export const ROUTE_TITLES: Record<AdminRoute, string> = {
  dashboard: 'Dashboard',
  products: 'Produk',
  labels: 'Label harga',
  satuan: 'Satuan',
  stock: 'Stok',
  suppliers: 'Supplier',
  purchases: 'Pembelian',
  history: 'Riwayat transaksi',
  returns: 'Retur',
  customers: 'Pelanggan',
  debts: 'Hutang',
  reports: 'Laporan',
  expenses: 'Pengeluaran',
  shifts: 'Shift Kasir',
  settings: 'Pengaturan',
  users: 'Pengguna',
  audit: 'Jejak audit',
};

/** Metadata halaman di LUAR nav (profil — dropdown akun): dipakai header. */
export const ROUTE_META_EXTRA: Partial<Record<Route, { title: string; crumb: string[]; sub: string }>> = {
  profil: { title: 'Profil Saya', crumb: ['Akun', 'Profil Saya'], sub: 'Nama tampil, tampilan perangkat, dan keamanan akun.' },
};

/** Breadcrumb: grup nav -> halaman. Ditampilkan menyatu dengan judul di header. */
export const ROUTE_CRUMB: Record<AdminRoute, string[]> = {
  dashboard: ['Utama', 'Dashboard'],
  products: ['Barang', 'Produk'],
  labels: ['Barang', 'Label harga'],
  satuan: ['Barang', 'Satuan'],
  stock: ['Barang', 'Stok'],
  suppliers: ['Barang', 'Supplier'],
  purchases: ['Barang', 'Pembelian'],
  history: ['Penjualan', 'Riwayat transaksi'],
  returns: ['Penjualan', 'Retur'],
  customers: ['Penjualan', 'Pelanggan'],
  debts: ['Penjualan', 'Hutang'],
  reports: ['Keuangan', 'Laporan'],
  expenses: ['Keuangan', 'Pengeluaran'],
  shifts: ['Keuangan', 'Shift Kasir'],
  settings: ['Sistem', 'Pengaturan'],
  users: ['Sistem', 'Pengguna'],
  audit: ['Sistem', 'Jejak audit'],
};

/** Subjudul per halaman (dipindah dari dalam body ke header). */
export const ROUTE_SUBS: Record<AdminRoute, string> = {
  dashboard: 'Ringkasan penjualan, shift, dan stok menipis.',
  products: 'Kelola produk, harga, dan stok per kategori.',
  labels: 'Cetak label harga 32 kolom — alat di kiri, pratinjau label di kanan.',
  satuan: 'Master satuan untuk struk; form produk memilih dari daftar ini.',
  stock: 'Pantau stok menipis dan riwayat restock.',
  suppliers: 'Pemasok barang kulakan — dipakai untuk Pembelian (Tahap 3).',
  purchases: 'Nota kulakan PO: order, terima (stok masuk), bayar — tunai penuh bawaan.',
  history: 'Linimasa penjualan dan topup/tarik per hari, lengkap dengan isi notanya.',
  returns: 'Barang kembali + uang kembali ke pelanggan — mengurangi laci bila terikat shift.',
  customers: 'Kontak pembeli — dipakai untuk mencatat hutang di halaman Hutang.',
  debts: 'Buku piutang: catat siapa berhutang dan pembayarannya.',
  reports: 'Omzet, laba, HPP, rekap metode bayar, produk terlaris, dan stok menipis.',
  expenses: 'Kas keluar operasional — mengurangi laci bila terikat shift.',
  shifts: 'Riwayat shift + buka/tutup shift dengan modal awal & modal akhir.',
  settings: 'Aturan yang berlaku untuk semua device kasir, disimpan di server.',
  users: 'Akun kasir & pemilik: tambah, atur peran, reset sandi, nonaktifkan.',
  audit: 'Siapa mengubah apa — jejak master, stok, aturan, dan uang (khusus pemilik).',
};

/** Rute yang tampil TANPA header sama sekali (keputusan pemilik 2026-10-03):
 *  halaman tabel padat (Produk, Stok) memakai seluruh tinggi layar untuk area
 *  kerja. Konsekuensinya toggle sidebar, badge outbox, ganti tema, dan menu
 *  user (profil/keluar) tidak ada di rute ini — di layar kecil (< lg) drawer
 *  navigasi dibuka lewat tombol #nav-toggle di toolbar masing-masing halaman
 *  (lihat toggleNavDrawer di bawah). */
const TANPA_HEADER: readonly AdminRoute[] = ['products', 'stock'];

const ADMIN_ROUTES = new Set<string>(ADMIN_NAV.flatMap((g) => g.items.map((i) => i.route)));

/** Hash router: '#/products' -> 'products'. Default & route POS = 'pos'.
 *  Sub-segmen diabaikan di sini ('#/purchases/baru' -> 'purchases'): rute induk
 *  = segmen pertama, sisa hash di-parse halaman sendiri (pola sub-halaman
 *  Pembelian 2026-10-17 — alur PO jadi halaman, bukan modal). */
export function parseRoute(hash: string): Route {
  const slug = (hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/')[0] ?? '';
  if (slug === 'pos' || slug === 'kasir') return 'pos';
  if (slug === 'login') return 'login';
  if (slug === 'ubah-sandi') return 'ubah-sandi';
  if (slug === 'profil') return 'profil';
  if (ADMIN_ROUTES.has(slug)) return slug as AdminRoute;
  return 'pos';
}

export function isAdminRoute(route: Route): route is AdminRoute {
  return route !== 'pos' && route !== 'login' && route !== 'ubah-sandi';
}

/** Bolehkah peran ini membuka rute? POS/login/ubah-sandi selalu boleh
 *  (dijaga terpisah); halaman admin ikut `roles` item nav-nya. */
export function bolehBuka(route: Route, peran: Peran): boolean {
  if (route === 'pos' || route === 'login' || route === 'ubah-sandi' || route === 'profil') return true;
  for (const g of ADMIN_NAV) {
    const item = g.items.find((i) => i.route === route);
    if (item) return item.roles.includes(peran);
  }
  return false;
}

/* ---------- Tema ---------- */

export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  try {
    return localStorage.getItem('ravaa.theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('ravaa.theme', theme);
  } catch {
    /* private mode: abaikan */
  }
}

/* ---------- Sidebar ---------- */

export function isCollapsed(): boolean {
  try {
    return localStorage.getItem('ravaa.sidebar') === 'collapsed';
  } catch {
    return false;
  }
}

export function setCollapsed(collapsed: boolean): void {
  document.documentElement.dataset.collapsed = collapsed ? '1' : '0';
  try {
    localStorage.setItem('ravaa.sidebar', collapsed ? 'collapsed' : 'open');
  } catch {
    /* abaikan */
  }
}

export function applySidebarState(): void {
  setCollapsed(isCollapsed());
}

/* ---------- Render shell ---------- */

function navHtml(active: AdminRoute | 'profil', peran: Peran): string {
  return ADMIN_NAV.map((group) => {
    const items = group.items.filter((i) => i.roles.includes(peran));
    if (!items.length) return '';
    return `
      <div class="mb-6">
        <p class="nav-title">${group.group}</p>
        <ul>
          ${items
            .map(
              (item) => `
            <li>
              <a href="#/${item.route}" class="nav-link${item.route === active ? ' is-active' : ''}" title="${item.label}">
                ${icon(item.icon)}<span class="nav-label">${item.label}</span>
              </a>
            </li>`,
            )
            .join('')}
        </ul>
      </div>`;
  }).join('');
}

function iconBtn(id: string, name: IconName, label: string): string {
  return `<button type="button" id="${id}" class="icon-btn" aria-label="${label}" title="${label}">${icon(name)}</button>`;
}

/** Blok kiri header: breadcrumb + judul jadi satu baris, subjudul di bawahnya. */
function titleBlock(active: AdminRoute | 'profil'): string {
  const extra = ROUTE_META_EXTRA[active];
  if (extra) {
    return `
    <div class="min-w-0 flex-1">
      <h1 class="page-title flex items-center gap-1.5">
        ${extra.crumb.slice(0, -1).map((c) => `<span class="crumb">${c}</span><span class="crumb-sep" aria-hidden="true">${icon('chevR')}</span>`).join('')}
        <span class="truncate">${extra.title}</span>
      </h1>
      <p class="page-sub">${extra.sub}</p>
    </div>`;
  }
  const meta = active as AdminRoute;
  const crumb = ROUTE_CRUMB[meta];
  const lead = crumb.slice(0, -1);
  const last = crumb[crumb.length - 1] ?? ROUTE_TITLES[meta];
  return `
    <div class="min-w-0 flex-1">
      <h1 class="page-title flex items-center gap-1.5">
        ${lead
          .map((c) => `<span class="crumb">${c}</span><span class="crumb-sep" aria-hidden="true">${icon('chevR')}</span>`)
          .join('')}
        <span class="truncate">${last}</span>
      </h1>
      <p class="page-sub">${ROUTE_SUBS[meta]}</p>
    </div>`;
}

/** Menu user paling kanan: avatar + nama + lencana peran, dropdown profil & keluar. */
function userMenu(name: string, peran: Peran): string {
  // Lencana peran TIDAK di tombol (permintaan pemilik: avatar+nama saja);
  // peran baru tampil di dropdown (dd-head). Avatar = file server bila ada,
  // fallback INISIAL nama (bukan gambar bawaan — pembeda akun tetap jelas).
  const av = akunTersimpan()?.akun.avatar;
  const avSrc = av ? `/api/users/${akunTersimpan()!.akun.id}/avatar?${Date.now()}` : '';
  const avat = (cls: string, id: string) =>
    avSrc
      ? `<span class="${cls}" id="${id}"><img src="${avSrc}" alt="${name}" class="size-full rounded-full object-cover" /></span>`
      : `<span class="${cls}" id="${id}">${initials(name)}</span>`;
  return `
    <div class="user-wrap" id="user-wrap">
      <button type="button" id="user-btn" class="user-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Menu akun ${name}" title="Akun">
        ${avat('avatar', 'user-avatar')}
        <span class="user-name" id="user-name">${name}</span>
        ${icon('chevD')}
      </button>
      <div class="user-dd" id="user-dd" role="menu" hidden>
        <div class="dd-head">
          ${avat('avatar avatar-lg', 'dd-avatar')}
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-gray-900 dark:text-white" id="dd-name">${name}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400" id="dd-role">${peran === 'pemilik' ? 'Owner' : 'Kasir'}</p>
          </div>
        </div>
        <div class="dd-sep"></div>
        <a href="#/profil" class="dd-item no-underline" role="menuitem" data-user-act="profile">
          ${icon('users')}<span>Edit Profil</span>
        </a>
        <div class="dd-sep"></div>
        <button type="button" class="dd-item dd-item-danger" role="menuitem" data-user-act="logout">
          ${icon('logout')}<span>Keluar</span>
        </button>
      </div>
    </div>`;
}

export function renderShell(active: AdminRoute | 'profil', cashier: string, peran: Peran): string {
  // 'profil' sengaja TIDAK ada di daftar ini (selalu berheader).
  const tanpaHeader = (TANPA_HEADER as readonly string[]).includes(active);
  return `
  <div class="app-layout">
    <aside class="sidebar" id="sidebar" aria-label="Navigasi utama">
      <div class="brand">
        <img class="brand-logo" src="/logo.png" alt="Logo Ravaa" />
        <span class="brand-name truncate text-sm font-semibold text-white">Ravaa POS</span>
      </div>
      <div class="nav-scroll">
        ${navHtml(active, peran)}
      </div>
      <div class="sidebar-foot">
        <a href="#/pos" class="btn btn-primary w-full" title="Buka kasir fullscreen">
          ${icon('pos')}<span class="nav-label">Buka Kasir</span>
        </a>
      </div>
    </aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>

    <div class="main-col">
      ${tanpaHeader ? '' : `
      <header class="app-header">
        ${iconBtn('menu-toggle', 'menu', 'Buka menu')}
        ${titleBlock(active)}
        <div class="flex shrink-0 items-center gap-2">
          <span class="chip hidden lg:inline-flex" id="outbox-badge" title="Status sinkronisasi">online</span>
          ${iconBtn('theme-toggle', getTheme() === 'dark' ? 'sun' : 'moon', 'Ganti tema')}
          ${userMenu(cashier, peran)}
        </div>
      </header>`}
      <main class="page" id="page" tabindex="-1"></main>
    </div>
  </div>`;
}

export function renderPosShell(): string {
  // Tanpa header sama sekali (permintaan pemilik 2026-10-04, dua putaran:
  // "hilangkan header" lalu "full hapus untuk POS") — layar kasir dibuka
  // penuh dari baris pertama, seperti referensi KulaPOS. Catatan: dengan ini
  // TIDAK ada tombol di-app kembali ke dashboard (shell POS tanpa sidebar);
  // keluar = tombol back browser / ganti hash manual.
  return `
  <div class="flex h-full flex-col bg-canvas dark:bg-gray-900">
    <main class="page" id="page" tabindex="-1"></main>
  </div>`;
}

/* ---------- Interaksi shell ---------- */

// shell di-render ulang tiap navigasi; listener document harus dibersihkan
// supaya tidak menumpuk (bug: satu handler per render).
let shellAbort: AbortController | null = null;

function paintThemeToggle(): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const dark = getTheme() === 'dark';
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.title = dark ? 'Mode terang' : 'Mode gelap';
  btn.setAttribute('aria-label', btn.title);
}

/** Cat ulang avatar + nama + peran tanpa render ulang shell (state halaman terjaga). */
function paintUserMenu(): void {
  const name = getCashier();
  const ini = initials(name);
  const peran = akunTersimpan()?.akun.role === 'pemilik' ? 'Owner' : 'Kasir';
  const av = akunTersimpan()?.akun.avatar;
  const avSrc = av ? `/api/users/${akunTersimpan()!.akun.id}/avatar?${Date.now()}` : '';
  const isiAvatar = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = avSrc
      ? `<img src="${avSrc}" alt="${name}" class="size-full rounded-full object-cover" />`
      : ini;
  };
  isiAvatar('user-avatar');
  isiAvatar('dd-avatar');
  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('user-name', name);
  set('dd-name', name);
  set('dd-role', peran);
  document.getElementById('user-btn')?.setAttribute('aria-label', `Menu akun ${name}`);
}

function setUserMenu(open: boolean): void {
  const dd = document.getElementById('user-dd');
  const btn = document.getElementById('user-btn');
  if (!dd || !btn) return;
  dd.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  dd.classList.toggle('is-open', open);
}

/** Buka/tutup drawer navigasi. Dipakai tombol #nav-toggle di toolbar halaman
 *  tanpa header (Produk, Stok) pada layar kecil — satu-satunya jalan membuka
 *  navigasi di sana karena #menu-toggle ikut hilang bersama header. */
export function toggleNavDrawer(): void {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  const buka = !sb?.classList.contains('is-open');
  sb?.classList.toggle('is-open', buka);
  bd?.classList.toggle('is-open', buka);
}

export function bindShell(): void {
  shellAbort?.abort();
  shellAbort = new AbortController();
  const sig = shellAbort.signal;
  paintThemeToggle();
  paintUserMenu();

  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  const setMenu = (open: boolean) => {
    sidebar?.classList.toggle('is-open', open);
    backdrop?.classList.toggle('is-open', open);
  };

  document.getElementById('menu-toggle')?.addEventListener('click', () => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      setCollapsed(!isCollapsed());
    } else {
      setMenu(!sidebar?.classList.contains('is-open'));
    }
  });
  backdrop?.addEventListener('click', () => setMenu(false));
  sidebar?.querySelectorAll('a[href^="#/"]').forEach((a) => {
    a.addEventListener('click', () => setMenu(false));
  });

  // Ganti tema hanya tukar atribut + ikon (TIDAK render ulang halaman:
  // halaman Produk sedang punya state filter yang harus bertahan).
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    paintThemeToggle();
  });

  /* ---------- Menu user ---------- */
  const userBtn = document.getElementById('user-btn');
  const userWrap = document.getElementById('user-wrap');

  userBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setUserMenu(document.getElementById('user-dd')?.hidden !== false);
  });

  // "Edit Profil" kini <a href="#/profil"> (navigasi biasa) — hanya logout
  // yang masih aksi JS di sini. Tutup dropdown saat klik apa pun di dalamnya
  // (sidebar handler a[href^="#/"] di atas tidak menjangkau user-dd).
  document.querySelectorAll<HTMLElement>('[data-user-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.userAct;
      setUserMenu(false);
      if (act === 'logout') await logout();
    });
  });

  // Klik di luar dropdown -> tutup. Pakai AbortSignal supaya handler lama
  // ikut dibuang tiap render (tidak menumpuk).
  document.addEventListener(
    'click',
    (e) => {
      if (userWrap && !userWrap.contains(e.target as Node)) setUserMenu(false);
    },
    { signal: sig },
  );

  // Nama kasir / tema berubah dari luar (modal profil) -> cat ulang header.
  document.addEventListener('ravaa:user', () => paintUserMenu(), { signal: sig });
  document.addEventListener('ravaa:theme', () => paintThemeToggle(), { signal: sig });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      setUserMenu(false);
    },
    { signal: sig },
  );
}
