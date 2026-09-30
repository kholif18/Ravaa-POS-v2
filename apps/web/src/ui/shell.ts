import { icon, type IconName } from './icons';
import { getCashier, initials, logout, openProfileModal } from './user';

export type AdminRoute = 'dashboard' | 'products' | 'labels' | 'satuan' | 'stock' | 'history' | 'reports' | 'shifts' | 'settings';
export type Route = 'pos' | AdminRoute;

interface NavItem {
  route: AdminRoute;
  label: string;
  icon: IconName;
}

export const ADMIN_NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Menu',
    items: [
      { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { route: 'products', label: 'Produk', icon: 'products' },
      // Label harga punya layar sendiri (kiri alat, kanan pratinjau) sejak
      // 2026-09-29 — dulu ia cuma dialog dari toolbar Produk.
      { route: 'labels', label: 'Label harga', icon: 'print' },
      { route: 'satuan', label: 'Satuan', icon: 'categories' },
      { route: 'stock', label: 'Stok', icon: 'stock' },
      // Linimasa penjualan + topup/tarik per hari (baru 2026-09-30).
      { route: 'history', label: 'Riwayat transaksi', icon: 'receipt' },
      { route: 'reports', label: 'Laporan', icon: 'reports' },
      { route: 'shifts', label: 'Shift Kasir', icon: 'shifts' },
    ],
  },
  {
    // Group sendiri di paling bawah: pengaturan jarang disentuh dan sifatnya
    // BEDA dari data di atas — isinya aturan server yang berlaku untuk semua
    // device, bukan catatan per kasir.
    group: 'Sistem',
    items: [{ route: 'settings', label: 'Pengaturan', icon: 'settings' }],
  },
];

export const ROUTE_TITLES: Record<AdminRoute, string> = {
  dashboard: 'Dashboard',
  products: 'Produk',
  labels: 'Label harga',
  satuan: 'Satuan',
  stock: 'Stok',
  history: 'Riwayat transaksi',
  reports: 'Laporan',
  shifts: 'Shift Kasir',
  settings: 'Pengaturan',
};

/** Breadcrumb: grup nav -> halaman. Ditampilkan menyatu dengan judul di header. */
export const ROUTE_CRUMB: Record<AdminRoute, string[]> = {
  dashboard: ['Menu', 'Dashboard'],
  products: ['Menu', 'Produk'],
  labels: ['Menu', 'Label harga'],
  satuan: ['Menu', 'Satuan'],
  stock: ['Menu', 'Stok'],
  history: ['Menu', 'Riwayat transaksi'],
  reports: ['Menu', 'Laporan'],
  shifts: ['Menu', 'Shift Kasir'],
  settings: ['Sistem', 'Pengaturan'],
};

/** Subjudul per halaman (dipindah dari dalam body ke header). */
export const ROUTE_SUBS: Record<AdminRoute, string> = {
  dashboard: 'Ringkasan penjualan, shift, dan stok menipis.',
  products: 'Kelola produk, harga, dan stok per kategori.',
  labels: 'Cetak label harga 32 kolom — alat di kiri, pratinjau label di kanan.',
  satuan: 'Master satuan untuk struk; form produk memilih dari daftar ini.',
  stock: 'Pantau stok menipis dan riwayat restock.',
  history: 'Linimasa penjualan dan topup/tarik per hari, lengkap dengan isi notanya.',
  reports: 'Laporan penjualan harian, per kategori, dan produk terlaris.',
  shifts: 'Buka dan tutup shift kasir beserta modalnya.',
  settings: 'Aturan yang berlaku untuk semua device kasir, disimpan di server.',
};

const ADMIN_ROUTES = new Set<string>(ADMIN_NAV.flatMap((g) => g.items.map((i) => i.route)));

/** Hash router: '#/products' -> 'products'. Default & route POS = 'pos'. */
export function parseRoute(hash: string): Route {
  const slug = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  if (slug === 'pos' || slug === 'kasir') return 'pos';
  if (ADMIN_ROUTES.has(slug)) return slug as AdminRoute;
  return 'pos';
}

export function isAdminRoute(route: Route): route is AdminRoute {
  return route !== 'pos';
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

function navHtml(active: AdminRoute): string {
  return ADMIN_NAV.map(
    (group) => `
      <div class="mb-6">
        <p class="nav-title">${group.group}</p>
        <ul>
          ${group.items
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
      </div>`,
  ).join('');
}

function iconBtn(id: string, name: IconName, label: string): string {
  return `<button type="button" id="${id}" class="icon-btn" aria-label="${label}" title="${label}">${icon(name)}</button>`;
}

/** Blok kiri header: breadcrumb + judul jadi satu baris, subjudul di bawahnya. */
function titleBlock(active: AdminRoute): string {
  const crumb = ROUTE_CRUMB[active];
  const lead = crumb.slice(0, -1);
  const last = crumb[crumb.length - 1] ?? ROUTE_TITLES[active];
  return `
    <div class="min-w-0 flex-1">
      <h1 class="page-title flex items-center gap-1.5">
        ${lead
          .map((c) => `<span class="crumb">${c}</span><span class="crumb-sep" aria-hidden="true">${icon('chevR')}</span>`)
          .join('')}
        <span class="truncate">${last}</span>
      </h1>
      <p class="page-sub">${ROUTE_SUBS[active]}</p>
    </div>`;
}

/** Menu user paling kanan: avatar + nama, dropdown profil & keluar. */
function userMenu(name: string): string {
  return `
    <div class="user-wrap" id="user-wrap">
      <button type="button" id="user-btn" class="user-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Menu akun ${name}" title="Akun">
        <span class="avatar" id="user-avatar">${initials(name)}</span>
        <span class="user-name" id="user-name">${name}</span>
        ${icon('chevD')}
      </button>
      <div class="user-dd" id="user-dd" role="menu" hidden>
        <div class="dd-head">
          <span class="avatar avatar-lg" id="dd-avatar">${initials(name)}</span>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-gray-900 dark:text-white" id="dd-name">${name}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400">Kasir aktif</p>
          </div>
        </div>
        <div class="dd-sep"></div>
        <button type="button" class="dd-item" role="menuitem" data-user-act="profile">
          ${icon('users')}<span>Pengaturan Akun / Edit Profil</span>
        </button>
        <div class="dd-sep"></div>
        <button type="button" class="dd-item dd-item-danger" role="menuitem" data-user-act="logout">
          ${icon('logout')}<span>Keluar</span>
        </button>
      </div>
    </div>`;
}

export function renderShell(active: AdminRoute, cashier: string): string {
  return `
  <div class="app-layout">
    <aside class="sidebar" id="sidebar" aria-label="Navigasi utama">
      <div class="brand">
        <img class="brand-logo" src="/logo.png" alt="Logo Ravaa" />
        <span class="brand-name truncate text-base font-semibold text-white">Ravaa POS</span>
      </div>
      <div class="nav-scroll">
        ${navHtml(active)}
      </div>
      <div class="sidebar-foot">
        <a href="#/pos" class="btn btn-primary w-full" title="Buka kasir fullscreen">
          ${icon('pos')}<span class="nav-label">Buka Kasir</span>
        </a>
      </div>
    </aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>

    <div class="main-col">
      <header class="app-header">
        ${iconBtn('menu-toggle', 'menu', 'Buka menu')}
        ${titleBlock(active)}
        <div class="flex shrink-0 items-center gap-2">
          <span class="chip hidden lg:inline-flex" id="outbox-badge" title="Status sinkronisasi">online</span>
          ${iconBtn('theme-toggle', getTheme() === 'dark' ? 'sun' : 'moon', 'Ganti tema')}
          ${userMenu(cashier)}
        </div>
      </header>
      <main class="page" id="page" tabindex="-1"></main>
    </div>
  </div>`;
}

export function renderPosShell(): string {
  return `
  <div class="flex h-full flex-col bg-canvas dark:bg-gray-900">
    <header class="app-header">
      <a href="#/dashboard" class="icon-btn" aria-label="Kembali ke dashboard" title="Kembali ke dashboard">${icon('chevL')}</a>
      <div class="min-w-0">
        <h1 class="page-title">Kasir (POS)</h1>
        <p class="page-sub">Keranjang kasir — scan atau ketik produk</p>
      </div>
    </header>
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

/** Cat ulang avatar + nama tanpa render ulang shell (state halaman terjaga). */
function paintUserMenu(): void {
  const name = getCashier();
  const ini = initials(name);
  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('user-avatar', ini);
  set('dd-avatar', ini);
  set('user-name', name);
  set('dd-name', name);
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

  document.querySelectorAll<HTMLElement>('[data-user-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.userAct;
      setUserMenu(false);
      if (act === 'profile') openProfileModal();
      else if (act === 'logout') await logout();
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
