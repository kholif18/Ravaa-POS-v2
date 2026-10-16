// Service worker Ravaa POS (PWA, 2026-10-16) — nol dependensi, satu file.
//
// Tujuan: aplikasi bisa DIBUKA tanpa jaringan (shell + aset dari cache) dan
// bisa dipasang ke home screen Android/desktop. Data TIDAK PERNAH di-cache:
// semua `/api/*` selalu langsung ke jaringan — angka kasir yang basi lebih
// berbahaya daripada layar error, dan antrean tulis offline sudah diurus
// outbox (ravaa.outbox.v1 di api.ts), bukan service worker.
//
// Strategi:
// - navigasi (buka halaman)  -> network-first, fallback shell `/` dari cache;
// - aset statis (js/css/ikon) -> cache-first (nama file ber-hash dari Vite,
//   jadi aman selamanya) + simpan salinan;
// - `/api/*`, metode non-GET, lintas origin (print-agent) -> diteruskan apa adanya.
//
// Naikkan VERSI setiap kali isi file ini berubah supaya cache lama dibuang.

const CACHE = 'ravaa-shell-v1';
const ASET_INTI = [
  '/',
  '/manifest.webmanifest',
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // Satu aset gagal (mis. ikon barumu belum ada) tidak boleh menggagalkan
      // seluruh pemasangan — tambah satu-satu lalu lanjut.
      .then((c) => Promise.all(ASET_INTI.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // lintas origin (print-agent) — biarkan
  if (url.pathname.startsWith('/api/')) return; // API SELALU jaringan

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const salinan = r.clone();
          caches.open(CACHE).then((c) => c.put('/', salinan)).catch(() => {});
          return r;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((r) => {
          if (r.ok) {
            const salinan = r.clone();
            caches.open(CACHE).then((c) => c.put(req, salinan)).catch(() => {});
          }
          return r;
        }),
    ),
  );
});
