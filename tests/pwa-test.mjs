// PWA (2026-10-16): manifest + service worker + ikon hasil BUILD benar-benar
// tersaji dan mampu membuka shell saat offline. SW sengaja hanya diregistrasi
// di PROD (main.ts), jadi suite ini membangun dist lalu menjalankan
// `vite preview` di port terpisah (4179) supaya tidak bentrok dev :5656.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path0 from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const chk = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  OK   ', name, info ? `| ${info}` : ''); }
  else { fail++; console.log('  GAGAL', name, '|', info); }
};
const REPO = path0.resolve(path0.dirname(fileURLToPath(import.meta.url)), '..');
const WEBAPP = path0.join(REPO, 'apps/web');
const PREVIEW = 'http://localhost:4179';

console.log('=== A. Build + artefak PWA ===');
execFileSync('npm', ['run', 'build', '-w', 'apps/web'], { cwd: REPO, stdio: 'pipe', timeout: 180_000 });
const dist = path0.join(WEBAPP, 'dist');
chk('dist: sw.js + manifest + 3 ikon + apple-touch',
  ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png']
    .every((f) => existsSync(path0.join(dist, f))));

console.log('=== B. vite preview menyajikan aset PWA ===');
const prev = spawn('npx', ['vite', 'preview', '--port', '4179', '--strictPort'], {
  cwd: WEBAPP, detached: true, stdio: 'ignore',
});
const mati = () => { try { process.kill(-prev.pid, 'SIGTERM'); } catch { /* sudah mati */ } };
try {
  let siap = false;
  for (let i = 0; i < 40 && !siap; i++) {
    try { siap = (await fetch(PREVIEW + '/', { signal: AbortSignal.timeout(1000) })).ok; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!siap) {
    console.log('  GAGAL setup: vite preview tidak siap di :4179');
    process.exit(1);
  }
  const mf = await (await fetch(`${PREVIEW}/manifest.webmanifest`)).json();
  chk('manifest: identitas + standalone',
    mf.name === 'Ravaa POS' && mf.short_name === 'RavaaPOS' && mf.display === 'standalone'
    && mf.start_url === '/' && mf.scope === '/', `${mf.name} / ${mf.display}`);
  chk('manifest: theme + ikon any/maskable',
    mf.theme_color === '#1d6df0' && mf.background_color === '#f2f5fa'
    && mf.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')
    && mf.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')
    && mf.icons.some((i) => i.purpose === 'maskable'), `${mf.icons.length} ikon`);
  const swTxt = await (await fetch(`${PREVIEW}/sw.js`)).text();
  chk('sw.js: versi cache + skip /api', swTxt.includes("ravaa-shell-v1") && swTxt.includes("startsWith('/api/')"));
  chk('ikon 192 tersaji sebagai PNG', (await fetch(`${PREVIEW}/icons/icon-192.png`)).headers.get('content-type') === 'image/png');

  console.log('=== C. Service worker menguasai + shell ter-cache ===');
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable' });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const err = [];
  p.on('pageerror', (e) => err.push(String(e).slice(0, 120)));
  await p.goto(PREVIEW + '/', { waitUntil: 'networkidle' });
  const swAktif = await p.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  chk('SW aktif (registrasi PROD-only jalan)', swAktif);
  chk('halaman dikendalikan SW (clients.claim)', await p.evaluate(() => !!navigator.serviceWorker.controller));
  const cache = await p.evaluate(async () => {
    const c = await caches.open('ravaa-shell-v1');
    return (await c.keys()).map((r) => new URL(r.url).pathname);
  });
  chk('shell + ikon + manifest ter-cache', ['/', '/manifest.webmanifest', '/icons/icon-192.png'].every((u) => cache.includes(u)), cache.join(', '));
  chk('HTML memuat link manifest + meta theme',
    await p.getAttribute('link[rel=manifest]', 'href') === '/manifest.webmanifest'
    && await p.getAttribute('meta[name=theme-color]', 'content') === '#1d6df0');

  console.log('=== D. Offline: shell tetap terbuka ===');
  await ctx.setOffline(true);
  await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(1200);
  chk('judul + #app ada tanpa jaringan', (await p.title()) === 'Ravaa POS' && await p.locator('#app').count() === 1);
  await ctx.setOffline(false);
  chk('tidak ada pageerror', err.length === 0, err.join(' ~ '));
  await b.close();
} finally {
  mati();
}

console.log(`\n=== ${fail ? 'ADA GAGAL' : 'SEMUA LOLOS'} ===  (lolos: ${pass}, gagal: ${fail})  [pwa-test.mjs]`);
if (fail) process.exit(1);
