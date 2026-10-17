// E2E POS MOBILE (2026-10-17) — pengujian tetap untuk tampilan mobile ala
// aplikasi: UI dipisah ke `apps/web/src/pages/pos-mobile.ts` +
// `apps/web/src/pos-mobile.css`, navbar bawah (Keranjang/Katalog/Lainnya).
// Permintaan pemilik: *"buat halaman POS Mobile view jadi benar-benar mobile
// view … mobile view ala mobile dengan navbar di bawah"*.
//
// Yang dijaga suite ini (bukan sekadar "tidak blank"):
//   A. 390px pref '1': shell mobile, keranjang = KARTU (`#pos-rows` DIV),
//      navbar 3 tab, scan -> kartu + TOTAL BELANJA dari master, stepper qty,
//      tinggi kartu ramping, spinner number tersembunyi (placeholder "Diskon"
//      dulu terpotong jadi "Disko"), Katalog (produk penuh + chip kategori +
//      filter), tap produk -> pindah tab Keranjang, tab Lainnya (shift +
//      tombol "Tampilan desktop"), toggle kembali ke desktop di 390;
//   B. pref '0' MENANG atas deteksi lebar (390 = desktop);
//   C. 1440 pref '0': layout desktop tidak berubah (tabel + sidebar);
//   D. tanpa pref + 390 = otomatis mobile.
//
// TIDAK ada mutasi server: suite hanya menambah ke keranjang (client-side,
// localStorage per konteks browser) — tidak menjual, tidak menyentuh stok.
// Prasyarat: API :3001 + vite :5656 hidup (runner menutup ini).
import { chromium } from 'playwright-core';
import { pasangToken } from './bantuan-uji.mjs';

const WEB = 'http://localhost:5656';
const API = 'http://localhost:3001';
let lolos = 0, gagal = 0;
const chk = (n, c, info = '') => {
  if (c) { lolos++; console.log(`  OK   ${n}`); }
  else { gagal++; console.log(`  GAGAL ${n}${info ? ` | ${info}` : ''}`); }
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: true,
});

// Master dari API = sumber yang sama dengan cache POS (mount menyinkron dulu
// sebelum paint pertama) — ekspektasi dihitung dari data yang sama.
const daftar = (await (await fetch(`${API}/api/products`)).json()).data ?? [];
const p1 = daftar.find((x) => x.sku === 'PRD00001');
const fisikLain = daftar.find((x) => x.track_stock === 1 && x.id !== p1?.id);
const rp = (n) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(n))}`;
if (!p1 || !fisikLain) {
  console.log(`  GAGAL prasyarat data: PRD00001/fisik lain tidak ada — jalankan seed dulu`);
  process.exit(1);
}

/** Konteks baru + pref layout + token (sebelum boot). `pref` null = tanpa kunci. */
async function buka(lebar, pref) {
  const ctx = await browser.newContext({ viewport: { width: lebar, height: 844 } });
  await ctx.addInitScript((p) => {
    try {
      if (p) localStorage.setItem('ravaa.mobile-layout', p);
      else localStorage.removeItem('ravaa.mobile-layout');
    } catch { /* private mode */ }
  }, pref);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await pasangToken(page);
  await page.goto(`${WEB}/#/pos`, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errs };
}

// ---------- A. mobile 390 (pref '1') ----------
{
  const { ctx, page: p, errs } = await buka(390, '1');
  try {
    await p.waitForSelector('.pm-shell', { timeout: 15000 });
    chk('A1 shell mobile tampil di 390 + pref "1"', (await p.locator('.pm-shell').count()) === 1);
    chk('A2 keranjang mobile = KARTU (#pos-rows DIV, bukan tabel)',
      await p.evaluate(() => document.querySelector('#pos-rows')?.tagName === 'DIV'));
    chk('A3 empty state tampil + Bayar disabled saat keranjang kosong',
      await p.locator('#pos-rows .pm-empty').isVisible()
      && await p.locator('#pos-bayar').isDisabled());
    chk('A4 navbar bawah 3 tab + Keranjang aktif',
      (await p.locator('[data-pm-tab]').count()) === 3
      && (await p.locator('.pm-tab.is-active').count()) === 1
      && (await p.locator('[data-pm-tab="kasir"].is-active').count()) === 1);

    // scan -> kartu
    await p.fill('#pos-q', 'PRD00001');
    await p.waitForSelector('#pos-results .suggest-item', { timeout: 8000 });
    await p.keyboard.press('Enter');
    await p.waitForSelector('#pos-rows .pm-card', { timeout: 8000 });
    chk('A5 scan PRD00001 menambah kartu keranjang', (await p.locator('#pos-rows .pm-card').count()) === 1);
    const grand = (await p.locator('#pos-grand').textContent())?.trim();
    chk(`A6 TOTAL BELANJA = harga master (${rp(p1.price)})`, grand === rp(p1.price), String(grand));
    chk('A7 badge jumlah di tab Keranjang = 1',
      ((await p.locator('#pm-nav-count').textContent())?.trim()) === '1');
    chk('A8 Bayar aktif setelah keranjang terisi', !(await p.locator('#pos-bayar').isDisabled()));

    // kartu ramping: struktur 3 baris + tinggi wajar (permintaan pemilik
    // 2026-10-17 "card produk terlalu besar, perpendek tingginya")
    const faktaKartu = await p.evaluate(() => {
      const c = document.querySelector('#pos-rows .pm-card');
      if (!c) return null;
      return {
        head: c.querySelectorAll(':scope > .pm-card-head').length,
        sub: c.querySelectorAll(':scope > .pm-sub').length,
        ctr: c.querySelectorAll(':scope > .pm-ctr').length,
        tinggi: Math.round(c.getBoundingClientRect().height),
      };
    });
    chk('A9 kartu = 3 baris (head/sub/kontrol) tanpa label kolom',
      faktaKartu && faktaKartu.head === 1 && faktaKartu.sub === 1 && faktaKartu.ctr === 1,
      JSON.stringify(faktaKartu));
    chk(`A10 kartu ramping (${faktaKartu?.tinggi}px ≤ 140px di 390)`,
      faktaKartu && faktaKartu.tinggi <= 140, JSON.stringify(faktaKartu));

    // stepper qty (data-act sama dengan tabel desktop)
    await p.click('#pos-rows .pm-card [data-act="inc"]');
    await p.waitForTimeout(300);
    chk('A11 stepper + kartu menaikkan qty',
      (await p.locator('#pos-rows .pm-qtyinp').first().inputValue()) === '2');

    // anti-regresi: spinner number di input harga/diskon tidak boleh kembali
    // (spinner merampas ruang dalam -> placeholder "Diskon" terpotong "Disko";
    // fix = appearance textfield + aturan ::-webkit-inner-spin-button)
    chk('A12 spinner number tersembunyi di input harga/diskon',
      await p.evaluate(() => {
        const el = document.querySelector('#pos-rows .pm-inp');
        if (!el || getComputedStyle(el).appearance !== 'textfield') return false;
        return [...document.styleSheets].some((s) => {
          try { return [...s.cssRules].some((r) => r.cssText?.includes('spin-button')); }
          catch { return false; }
        });
      }));

    // Katalog
    await p.click('[data-pm-tab="katalog"]');
    await p.waitForSelector('#pm-kat-list .pm-prod', { timeout: 8000 });
    chk(`A13 Katalog menampilkan SEMUA produk aktif (${daftar.length})`,
      (await p.locator('#pm-kat-list .pm-prod').count()) === daftar.length);
    const nSlug = new Set(daftar.map((x) => x.category_slug)).size;
    chk(`A14 chip kategori = "Semua" + ${nSlug} kategori berisi produk`,
      (await p.locator('#pm-kat-chips .pm-katchip').count()) === nSlug + 1);
    const chip1 = p.locator('#pm-kat-chips .pm-katchip').nth(1);
    await chip1.click();
    await p.waitForTimeout(250);
    const slug = await chip1.getAttribute('data-pm-kat');
    const nKat = daftar.filter((x) => x.category_slug === slug).length;
    chk(`A15 filter kategori (${slug}) = ${nKat} produk`,
      (await p.locator('#pm-kat-list .pm-prod').count()) === nKat);
    await p.locator('#pm-kat-chips .pm-katchip').first().click();
    await p.waitForTimeout(250);
    chk('A16 chip "Semua" mengembalikan daftar penuh',
      (await p.locator('#pm-kat-list .pm-prod').count()) === daftar.length);

    // tap produk fisik lain -> masuk keranjang + pindah tab Keranjang
    await p.click(`.pm-prod[data-pm-prod="${fisikLain.id}"]`);
    await p.waitForTimeout(500);
    chk('A17 tap produk = baris baru + otomatis pindah tab Keranjang',
      (await p.locator('#pos-rows .pm-card').count()) === 2
      && await p.locator('[data-pm-panel="kasir"]').isVisible());

    // tab Lainnya: shift + tombol kembali ke desktop
    await p.click('[data-pm-tab="aksi"]');
    await p.waitForTimeout(250);
    chk('A18 tab Lainnya memuat tombol tutup shift + "Tampilan desktop"',
      (await p.locator('#pos-shift-tutup').count()) === 1
      && await p.locator('#pos-mobile').isVisible());
    const shiftTxt = (await p.locator('.pm-shiftinfo').innerText()).replace(/\s+/g, ' ');
    chk('A19 info kasir + nomor shift terisi di panel Lainnya',
      /Shift #\d+/.test(shiftTxt), shiftTxt.slice(0, 90));

    // toggle kembali ke desktop
    await p.click('#pos-mobile');
    await p.waitForFunction(() => !document.querySelector('.pm-shell'), { timeout: 5000 });
    chk('A20 "Tampilan desktop" mengganti ke layout desktop (tabel + sidebar)',
      await p.evaluate(() => {
        const r = document.querySelector('#pos-rows');
        return !document.querySelector('.pm-shell') && r?.tagName === 'TBODY'
          && !!r?.closest('table') && document.querySelectorAll('.pos-side').length === 1;
      }));
    chk('A21 alur mobile tanpa pageerror', errs.length === 0, errs.join(' | '));
  } catch (e) {
    gagal++;
    console.log(`  GAGAL crash seksi A: ${String(e).slice(0, 300)}`);
  } finally { await ctx.close(); }
}

// ---------- B. pref '0' menang atas deteksi lebar (390) ----------
{
  const { ctx, page: p, errs } = await buka(390, '0');
  try {
    await p.waitForSelector('table tbody#pos-rows', { timeout: 15000 });
    chk('B1 pref "0" = desktop walau layar 390 (shell mobile tidak dirender)',
      (await p.locator('.pm-shell').count()) === 0);
    chk('B2 tanpa pageerror di 390 desktop', errs.length === 0, errs.join(' | '));
  } catch (e) {
    gagal++;
    console.log(`  GAGAL crash seksi B: ${String(e).slice(0, 300)}`);
  } finally { await ctx.close(); }
}

// ---------- C. desktop 1440 tidak berubah ----------
{
  const { ctx, page: p, errs } = await buka(1440, '0');
  try {
    await p.waitForSelector('table tbody#pos-rows', { timeout: 15000 });
    chk('C1 desktop 1440 tanpa shell mobile', (await p.locator('.pm-shell').count()) === 0);
    chk('C2 desktop 1440 = tabel `#pos-rows` + sidebar bayar', await p.evaluate(() => {
      const r = document.querySelector('#pos-rows');
      return r?.tagName === 'TBODY' && !!r?.closest('table')
        && document.querySelectorAll('.pos-side').length === 1;
    }));
    chk('C3 tanpa pageerror di desktop 1440', errs.length === 0, errs.join(' | '));
  } catch (e) {
    gagal++;
    console.log(`  GAGAL crash seksi C: ${String(e).slice(0, 300)}`);
  } finally { await ctx.close(); }
}

// ---------- D. tanpa pref + 390 = otomatis mobile ----------
{
  const { ctx, page: p, errs } = await buka(390, null);
  try {
    await p.waitForSelector('.pm-shell', { timeout: 15000 });
    chk('D1 tanpa pref + layar 390 = otomatis tampilan mobile',
      (await p.locator('.pm-shell').count()) === 1);
    chk('D2 tanpa pageerror (auto-detect)', errs.length === 0, errs.join(' | '));
  } catch (e) {
    gagal++;
    console.log(`  GAGAL crash seksi D: ${String(e).slice(0, 300)}`);
  } finally { await ctx.close(); }
}

console.log(`\n=== ${gagal === 0 ? 'SEMUA LOLOS' : 'ADA GAGAL'} ===  (lolos: ${lolos}, gagal: ${gagal})`);
await browser.close();
process.exit(gagal === 0 ? 0 : 1);
