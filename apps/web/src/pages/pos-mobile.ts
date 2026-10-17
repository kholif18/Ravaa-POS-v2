// UI MOBILE halaman POS (#/pos) — file TERPISAH dari pos.ts (permintaan
// pemilik 2026-10-17: *"buat halaman POS Mobile view jadi benar-benar mobile
// view, saya rasa bisa di pisahkan UInya jadi benar-benar pisah file dan juga
// cssnya agar memaksimalkan tampilan pos mobile view. mobile view ala mobile
// dengan navbar di bawah"*). Gaya CSS khusus di `pos-mobile.css` (kelas .pm-*).
//
// KONTRAK PEMBAGIAN (jangan dilanggar):
//  * `pos.ts` tetap pemilik SELURUH state + perilaku (cart, pay, hold, topup,
//    pintasan keyboard, modal, offline outbox). Modul ini hanya MERENDER
//    lapisan mobile + mem-binding interaksi MOBILE-ONLY (tab navbar bawah &
//    katalog produk) — semua aksi lain dijalankan lewat `ctx` (satu arah).
//  * Semua id/atribut yang sudah dipegang `bindCart()`/`bindSidebar()`/`paint()`
//    di pos.ts (`pos-q`, `pos-results`, `pos-qty`, `pos-rows`, `pos-clear`,
//    `pos-bayar`, `pos-pay-pas`, `pos-hold`, …) di-render ULANG di sini dengan
//    nama yang SAMA. Itulah yang membuat refresh bedah (`paintCart`,
//    `segNotifPos`) bekerja tanpa tahu mode tampilan sedang mobile.
//  * Baris keranjang WAJIB memakai `data-act`/`data-key` yang sama dengan tabel
//    desktop (inc/dec/del/qty/price/disc/unit/note/topup-del) — delegasi event
//    `#pos-rows` milik pos.ts tidak diubah sama sekali.
//  * `import type` dari './pos' HANYA tipe (dihapus compiler) supaya tidak ada
//    impor melingkar runtime; arah runtime selalu pos.ts → pos-mobile.ts.
import type { Product } from '../store';
import type { CartLine, TopupLine } from './pos';
import { icon } from '../ui/icons';
import { switchHtml } from '../ui/switch';

/* ---------- kontrak ctx (snapshot render + aksi dari pos.ts) ---------- */

/** Snapshot + aksi yang diberikan pos.ts setiap render. Dibangun ulang tiap
 *  `paint()`/`paintCart()`/katalog refresh (`pmCtx()` di pos.ts) supaya selalu
 *  membaca state TERKINI saat dipanggil. */
export interface PosMobileCtx {
  /** Nama kasir shift terbuka (bukan nama akun login). */
  kasir: string;
  shiftId: number | null;
  /** HTML tombol ⬅ kembali ke dashboard (`tombolKembaliHtml()` pos.ts). */
  kembali: string;
  /** Opsi `<option>` untuk `#pos-customer` (HTML, sudah ter-esc di pos.ts). */
  customerOptions: string;
  /** Pelanggan terpilih tier grosir — chip "Grosir". */
  grosir: boolean;
  /** Qty preset untuk item berikutnya (chip `#pos-qty`). */
  qtyNext: number;
  /** Isi `#pos-notif` (`notifChips()` pos.ts — pembungkusnya milik modul ini). */
  notifHtml: string;
  /** Isi `#pos-strips` (`stripKadaluarsa()` pos.ts). */
  stripsHtml: string;
  /** Semua produk cache (sumber tab Katalog). */
  products: Product[];
  /** Master kategori `GET /api/categories` (fallback: dipecah dari products). */
  categories: { name: string; slug: string }[];
  cart: CartLine[];
  cartTopup: TopupLine[];
  /** Jumlah transaksi tertahan (badge Pending). */
  holdCount: number;
  /** Diskon TRANSAKSI (Rp) — nilai awal input `#pos-discount` (pola sidebar desktop). */
  diskon: number;
  autoPrint: boolean;
  /** false = tombol Cetak ulang mati (device belum punya nota sukses). */
  bisaCetakUlang: boolean;
  /** true = sedang menyimpan penjualan (tombol bayar mati). */
  busy: boolean;

  /* helper format & hitung — SATU sumber dengan desktop (pos.ts) */
  rp(n: number): string;
  esc(s: unknown): string;
  jumlahBaris(l: Pick<CartLine, 'price' | 'qty'>): number;
  diskonBaris(): number;
  daftarSatuan(p: Product): { unit: string; factor: number; price: number }[];
  expBaris(productId: number | null): string;
  jenisLabel(jenis: string): string;
  /** Harga jual produk untuk pelanggan terpilih (tier grosir ikut). */
  hargaProduk(p: Product): number;
  /** Teks `#pos-count` (pola sama dengan paintCart desktop). */
  teksCount(): string;
  /** Teks `#pos-owncount` (pola sama dengan paintCart desktop). */
  teksOwncount(): string;
  count(): number;
  keranjangTerisi(): boolean;
  bisaBayar(): boolean;
  totalBayar(): number;

  /* aksi — jangan reimplementasi logika di modul ini */
  tambahProduk(p: Product): void;
  /** Pencarian produk multi-kata (queryResults tanpa batas 8 hasil). */
  cariProduk(q: string): Product[];
  /** `isLayanan(p)` pos.ts — kategori layanan topup (addProduct membuka dialog). */
  layananProduk(p: Product): boolean;
}

/* ---------- state modul (tab + filter katalog) ---------- */
//
// Tab aktif & filter katalog sengaja state MODUL: `paint()` penuh jarang
// terjadi (mount/toggle shift/toggle layout) — dalam pemakaian normal tidak
// ada yang mereset tab. `posMobileReset()` dipanggil `unmountPosPage()` supaya
// kunjungan berikutnya mulai bersih dari tab Keranjang.

type PmTab = 'kasir' | 'katalog' | 'aksi';
let pmTab: PmTab = 'kasir';
let katSlug: string | null = null;
let katQ = '';
let getCtx: (() => PosMobileCtx) | null = null;

/* ---------- keranjang versi kartu ---------- */

/** Isi `#pos-rows` versi mobile: satu kartu per baris (produk/manual ATAU
 *  layanan topup/tarik), BUKAN tabel 8 kolom — layar HP terlalu sempit untuk
 *  kolom No..Aksi. Semua kontrol membawa `data-act`/`data-key` yang sama
 *  dengan tabel desktop sehingga delegasi `#pos-rows` milik pos.ts utuh. */
export function pmCartHtml(ctx: PosMobileCtx): string {
  if (!ctx.keranjangTerisi()) {
    return `<div class="empty pm-empty">${icon('pos')}<p class="font-semibold">Keranjang masih kosong</p><p>Scan barcode, ketik di kolom cari, atau pilih produk dari tab <b>Katalog</b>.</p></div>`;
  }
  return (
    ctx.cart.map((l, i) => kartuBarisHtml(ctx, l, i)).join('') +
    ctx.cartTopup.map((l) => kartuTopupHtml(ctx, l)).join('')
  );
}

/** Satu kartu baris PRODUK/ITEM MANUAL — RAMING (revisi pemilik 2026-10-17:
 *  *"card produk pada keranjang belanja terlalu besar, bisa di perpendek
 *  tingginya dan seperti POS mobile pada umumnya yang sedang memiliki rating
 *  terbaik"*). Pola aplikasi kasir mobile ternama: baris 1 = nomor + nama +
 *  hapus, baris 2 = SKU/jasa + satuan, baris 3 = SATU baris kontrol
 *  (stepper qty ‖ harga ‖ diskon ‖ subtotal) tanpa label kolom — label
 *  diganti aria-label/title supaya tinggi turun ±60%. */
function kartuBarisHtml(ctx: PosMobileCtx, l: CartLine, i: number): string {
  const gross = ctx.jumlahBaris(l);
  const net = gross - l.discount;
  // Satuan per baris: select hanya bila produk punya satuan alternatif (aturan
  // sama dengan tabel desktop — gantiSatuan() menerima data-act="unit");
  // selain itu badge kecil bila satuan jual ≠ satuan dasar.
  const pAlt = l.product_id !== null ? ctx.products.find((x) => x.id === l.product_id) : undefined;
  const unitUi = pAlt && (pAlt.units?.length ?? 0) > 0
    ? `<select class="input pm-unitsel" data-act="unit" data-key="${l.key}" aria-label="Satuan ${ctx.esc(l.name)}">${ctx
        .daftarSatuan(pAlt)
        .map((o) => `<option value="${ctx.esc(o.unit)}"${o.unit === l.unit ? ' selected' : ''}>${ctx.esc(o.unit)}${o.factor !== 1 ? ` ×${o.factor}` : ''}</option>`)
        .join('')}</select>`
    : l.unit && l.baseUnit && l.unit !== l.baseUnit
      ? `<span class="pm-unitbadge">per ${ctx.esc(l.unit)}</span>`
      : '';
  return `<article class="pm-card" data-key="${l.key}">
    <div class="pm-card-head">
      <span class="pm-no">${i + 1}</span>
      <p class="pm-nama">${ctx.esc(l.name)}</p>
      <button type="button" class="row-btn row-btn-danger" data-act="del" data-key="${l.key}" title="Hapus baris" aria-label="Hapus ${ctx.esc(l.name)}">${icon('trash')}</button>
    </div>
    <div class="pm-sub">
      <span class="pm-sub-txt">${l.sku ? `<span class="font-mono">${ctx.esc(l.sku)}</span>` : ''}${l.product_id === null ? ' · item manual' : l.track_stock ? '' : ' · jasa'}${ctx.expBaris(l.product_id)}</span>
      ${unitUi}
    </div>
    <div class="pm-ctr">
      <div class="pm-step">
        <button type="button" class="pm-stepbtn" data-act="dec" data-key="${l.key}" title="Kurangi qty" aria-label="Kurangi qty">${icon('minus')}</button>
        <input class="input pm-qtyinp" data-act="qty" data-key="${l.key}" type="number" inputmode="numeric" min="0" value="${l.qty}" aria-label="Qty ${ctx.esc(l.name)}" />
        <button type="button" class="pm-stepbtn" data-act="inc" data-key="${l.key}" title="Tambah qty" aria-label="Tambah qty">${icon('plus')}</button>
      </div>
      ${l.dyn
        ? `<input class="input pm-inp" data-act="price" data-key="${l.key}" type="number" inputmode="numeric" min="0" step="500" value="${l.price}" aria-label="Harga ${ctx.esc(l.name)}" title="Harga jual boleh diubah (produk harga khusus)" />`
        : `<span class="pm-harga">${ctx.rp(l.price)}</span>`}
      <input class="input pm-inp pm-inp-disc" data-act="disc" data-key="${l.key}" type="number" inputmode="numeric" min="0" step="100" value="${l.discount || ''}" placeholder="Diskon" aria-label="Diskon baris ${ctx.esc(l.name)}" title="Diskon baris (Rp) — maksimum ${ctx.rp(gross)}" />
      <span class="pm-net">${l.discount > 0 ? `<s class="pm-strike">${ctx.rp(gross)}</s> ` : ''}${ctx.rp(net)}</span>
    </div>
    ${l.useNote ? `<input class="input pm-note" type="text" maxlength="200" data-act="note" data-key="${l.key}" value="${ctx.esc(l.note)}" placeholder="Catatan (mis. ukuran 1 x 3 meter)" aria-label="Catatan ${ctx.esc(l.name)}" />` : ''}
  </article>`;
}

/** Satu kartu baris LAYANAN (topup/tarik — Opsi B hybrid). Angka kanan =
 *  kontribusi ke TOTAL BELANJA (topup: nominal+admin; tarik: admin saja). */
function kartuTopupHtml(ctx: PosMobileCtx, l: TopupLine): string {
  const keluar = l.jenis.startsWith('tarik-');
  const j = ctx.jenisLabel(l.jenis);
  const detail = [l.nomor ? ctx.esc(l.nomor) : '', l.token ? `token ${ctx.esc(l.token)}` : ''].filter(Boolean).join(' · ');
  return `<article class="pm-card pm-card-layanan ${keluar ? 'is-tarik' : 'is-topup'}" data-key="${l.key}">
    <div class="pm-card-head">
      <div class="min-w-0 flex-1">
        <p class="pm-nama"><span class="pm-badge ${keluar ? 'pm-badge-tarik' : 'pm-badge-topup'}">${keluar ? 'Tarik' : 'Topup'}</span>${ctx.esc(j)} ${ctx.rp(l.nominal)}</p>
        <p class="pm-sub">${detail ? `${detail} · ` : ''}admin ${ctx.rp(l.admin)} — ${keluar ? 'uang keluar diserahkan tunai' : 'topup, bukan stok'} (dibayar bersama nota ini)</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <span class="pm-val pm-net">${ctx.rp(keluar ? l.admin : l.nominal + l.admin)}</span>
        <button type="button" class="row-btn row-btn-danger" data-act="topup-del" data-key="${l.key}" title="Hapus baris ${keluar ? 'tarik' : 'topup'}" aria-label="Hapus baris ${keluar ? 'tarik' : 'topup'} ${ctx.esc(j)}">${icon('trash')}</button>
      </div>
    </div>
  </article>`;
}

/* ---------- tab Katalog ---------- */

/** Chip kategori (horizontal scroll) — dihitung dari produk yang PUNYA isi;
 *  fallback slug mentah bila master kategori gagal dimuat (offline). */
function chipKategoriHtml(ctx: PosMobileCtx): string {
  const jumlah = new Map<string, number>();
  for (const p of ctx.products) jumlah.set(p.category_slug, (jumlah.get(p.category_slug) ?? 0) + 1);
  const dariMaster = ctx.categories.filter((c) => jumlah.has(c.slug));
  const slugMaster = new Set(dariMaster.map((c) => c.slug));
  const yatim = [...jumlah.keys()].filter((s) => !slugMaster.has(s)).sort();
  const chip = (slug: string, nama: string, n: number) =>
    `<button type="button" class="chip pm-katchip${katSlug === (slug || null) ? ' is-active' : ''}" data-pm-kat="${ctx.esc(slug)}">${ctx.esc(nama)} <span class="pm-katn">${n}</span></button>`;
  return [
    chip('', 'Semua', ctx.products.length),
    ...dariMaster.map((c) => chip(c.slug, c.name, jumlah.get(c.slug) ?? 0)),
    ...yatim.map((s) => chip(s, s, jumlah.get(s) ?? 0)),
  ].join('');
}

/** Grid produk tab Katalog (2 kolom) — ikut filter kategori + kata saring. */
function katalogListHtml(ctx: PosMobileCtx): string {
  const kata = katQ.trim();
  let daftar = kata ? ctx.cariProduk(kata) : ctx.products;
  if (katSlug) daftar = daftar.filter((p) => p.category_slug === katSlug);
  if (!daftar.length) {
    return `<div class="empty pm-empty">${icon('search')}${
      ctx.products.length
        ? '<p class="font-semibold">Produk tidak ditemukan</p><p>Ubah kata saring atau pilih kategori lain.</p>'
        : // Cache kosong (device belum sync) — jalan pintas ke Manage.
          '<p class="font-semibold">Cache produk kosong</p><p><a class="underline" href="#/products">Buka halaman Produk</a> untuk sinkronisasi dulu.</p>'
    }</div>`;
  }
  return daftar.map((p) => kartuProdukHtml(ctx, p)).join('');
}

/** Satu kartu produk katalog. Tap = jalur yang SAMA dengan scan (`tambahProduk`
 *  -> addProduct: layanan topup otomatis membuka dialognya, produk biasa masuk
 *  keranjang + pindah tab diputuskan bindPosMobile). */
function kartuProdukHtml(ctx: PosMobileCtx, p: Product): string {
  const harga = ctx.hargaProduk(p);
  const kategori = ctx.categories.find((c) => c.slug === p.category_slug)?.name ?? p.category_slug;
  const stok = p.track_stock
    ? `<span class="pm-stok${p.stock <= 0 ? ' is-habis' : p.min_stock > 0 && p.stock <= p.min_stock ? ' is-menipis' : ''}">${p.stock}</span>`
    : '';
  return `<button type="button" class="pm-prod" data-pm-prod="${p.id}">
    ${p.image
      ? `<img class="pm-prod-img" src="/api/products/${p.id}/image" alt="" loading="lazy" decoding="async" />`
      : `<span class="pm-prod-img pm-prod-img-ikon">${icon('products')}</span>`}
    <span class="pm-prod-nama">${ctx.esc(p.name)}</span>
    <span class="pm-prod-kat">${ctx.esc(kategori)}${p.price_dynamic ? ' · dinamis' : ''}</span>
    <span class="pm-prod-baris"><span class="pm-prod-harga">${ctx.rp(harga)}</span>${stok}</span>
  </button>`;
}

/* ---------- tab Lainnya (aksi) ---------- */

function aksiPanelHtml(ctx: PosMobileCtx): string {
  const diskonItem = ctx.diskonBaris();
  return `
  <div class="card pm-sec">
    <span class="label">Aksi cepat</span>
    <div class="pos-side-grid">
      <button type="button" id="pos-hold" class="btn btn-ghost pos-qa" title="Bekukan keranjang, lanjutkan nanti lewat Pending (pintasan F7)"${ctx.keranjangTerisi() && !ctx.busy ? '' : ' disabled'}>${icon('pause')}<span>Tahan</span></button>
      <button type="button" id="pos-hold-open" class="btn btn-ghost pos-qa" title="Buka daftar transaksi tertahan (pintasan F8)"${ctx.holdCount ? '' : ' disabled'}>${icon('clock')}<span>Pending (<span id="pos-hold-count">${ctx.holdCount}</span>)</span></button>
      <button type="button" id="pos-qa-manual" class="btn btn-ghost pos-qa">${icon('pencil')}<span>Item manual</span></button>
      <button type="button" id="pos-qa-topup" class="btn btn-ghost pos-qa" title="Tambah baris topup (pulsa/e-wallet/PLN) atau tarik tunai ke keranjang — dibayar bersama belanja">${icon('wallet')}<span>Topup/Tarik</span></button>
      <button type="button" id="pos-qa-disc" class="btn btn-ghost pos-qa">${icon('filter')}<span>Diskon</span></button>
      <button type="button" id="pos-reprint" class="btn btn-ghost pos-qa" title="Cetak ulang nota terakhir dari device ini" ${ctx.bisaCetakUlang ? '' : 'disabled '}>${icon('print')}<span>Cetak ulang</span></button>
    </div>
  </div>

  <div class="card pm-sec">
    <span class="label">Diskon &amp; menu</span>
    <div class="space-y-1.5">
      <label class="label !mb-0" for="pos-discount">Diskon transaksi (Rp)</label>
      <input id="pos-discount" class="input" type="number" inputmode="numeric" min="0" step="500" value="${ctx.diskon || ''}" placeholder="0" />
      <div class="flex items-baseline justify-between" id="pos-disc-item-row" ${diskonItem ? '' : 'hidden'}>
        <span class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Diskon item</span>
        <span id="pos-disc-item" class="text-sm font-semibold text-red-600 dark:text-red-400">-${ctx.rp(diskonItem)}</span>
      </div>
    </div>
    <div class="pos-side-grid mt-2">
      <a href="#/history" class="btn btn-ghost pos-qa" title="Riwayat transaksi — linimasa penjualan & topup/tarik per hari">${icon('receipt')}<span>Riwayat</span></a>
      <a href="#/products" class="btn btn-ghost pos-qa" title="Buka halaman Produk">${icon('products')}<span>Produk</span></a>
      <a href="#/stock" class="btn btn-ghost pos-qa" title="Buka halaman Stok">${icon('stock')}<span>Stok</span></a>
      <a href="#/settings" class="btn btn-ghost pos-qa" title="Pengaturan struk &amp; sistem">${icon('settings')}<span>Sistem</span></a>
    </div>
  </div>

  <div class="card pm-sec">
    <span class="label">Shift</span>
    <div class="pm-shiftinfo">
      <span class="pm-shiftrow">${icon('clock')}<span id="pos-jam">—</span></span>
      <span class="pm-shiftrow">${icon('users')}<span>${ctx.esc(ctx.kasir)} · Shift #${ctx.shiftId ?? '—'}</span></span>
    </div>
    <button type="button" id="pos-shift-tutup" class="btn pm-tutup" title="Tutup shift kasir ini">${icon('logout')}<span>Tutup shift</span></button>
  </div>

  <div class="card pm-sec">
    <span class="label">Perangkat ini</span>
    <div class="pm-perangkat">
      ${switchHtml('pos-autoprint', ctx.autoPrint, 'Cetak struk otomatis')}
      <button type="button" id="pos-mobile" class="btn btn-ghost pos-qa" title="Kembali ke layout desktop (sidebar kanan 320px)" aria-pressed="true">${icon('smartphone')}<span>Tampilan desktop</span></button>
    </div>
  </div>`;
}

/* ---------- shell mobile ---------- */

/** Seluruh kerangka halaman POS versi mobile: header (scan + pelanggan +
 *  notif) → body tab (Keranjang/Katalog/Lainnya) → bar bayar → navbar bawah.
 *  Scroll utama ada di `.pm-body` (satu-satunya area yang `overflow-y-auto`),
 *  jadi header/bar bayar/navbar selalu terlihat — pola aplikasi mobile. */
export function pmShellHtml(ctx: PosMobileCtx): string {
  const bayarMati = !ctx.bisaBayar() || ctx.busy;
  const tab = (t: PmTab) => (pmTab === t ? ' is-active' : '');
  // Panel non-aktif WAJIB ikut `hidden` sejak render pertama — `tampilTab()`
  // men-toggle kelas yang SAMA, kalau shell hanya menandai `is-active` ketiga
  // panel tampil bertumpuk di mount.
  const pnl = (t: PmTab) => (pmTab === t ? ' is-active' : ' hidden');
  return `
  <div class="pm-shell pos-scope">
    <header class="pm-head">
      <div class="pm-headrow">
        ${ctx.kembali}
        <div class="pm-scanwrap">
          <div class="search-wrap">
            ${icon('search')}
            <input id="pos-q" class="input pm-scan" type="search" autocomplete="off" role="combobox"
                   aria-expanded="false" aria-controls="pos-results" aria-autocomplete="list"
                   placeholder="Scan / ketik nama / SKU"
                   title="Scan barcode, ketik nama/SKU, atau Qty*Kode (mis. 3*PRD00001). Fokus balik ke sini: F1 atau Esc" />
          </div>
          <div id="pos-results" class="suggest hidden" role="listbox" aria-label="Hasil pencarian produk"></div>
        </div>
        <button type="button" id="pos-qty" class="btn btn-ghost pm-qtychip${ctx.qtyNext > 1 ? ' !border-primary !text-primary' : ''}" title="Qty untuk item BERIKUTNYA, dipakai sekali lalu kembali ke 1">Qty ${ctx.qtyNext}</button>
      </div>
      <div class="pm-headrow">
        <span id="pos-tier" class="chip pm-tierchip${ctx.grosir ? '' : ' hidden'}">${icon('users')}<span>Grosir</span></span>
        <select id="pos-customer" class="input pm-custsel min-w-0 flex-1" aria-label="Pelanggan">${ctx.customerOptions}</select>
        <button type="button" id="pos-cust-cari" class="btn btn-ghost pm-iconbtn" title="Cari pelanggan (F9)" aria-label="Cari pelanggan (F9)">${icon('search')}</button>
      </div>
      <div id="pos-notif" class="pm-notif">${ctx.notifHtml}</div>
    </header>

    <div class="pm-body">
      <section class="pm-panel${pnl('kasir')}" data-pm-panel="kasir" aria-label="Keranjang">
        <div id="pos-strips" class="${ctx.stripsHtml ? 'flex flex-col gap-2' : 'hidden'}">${ctx.stripsHtml}</div>
        <div class="pos-cartbar">
          <span id="pos-count" class="font-semibold">${ctx.teksCount()}</span>
          <button type="button" id="pos-clear" class="btn btn-ghost text-red-600 !min-h-[30px] !px-2.5 !py-1 text-sm" title="Kosongkan keranjang (pintasan F5)" aria-label="Kosongkan keranjang"${ctx.keranjangTerisi() ? '' : ' disabled'}>${icon('trash')}<span>Bersihkan</span></button>
        </div>
        <div id="pos-rows" class="pm-cards">${pmCartHtml(ctx)}</div>
      </section>

      <section class="pm-panel${pnl('katalog')}" data-pm-panel="katalog" aria-label="Katalog produk">
        <div class="pm-katsearch">
          ${icon('search')}
          <input id="pm-kat-q" class="input pm-katin" type="search" autocomplete="off" inputmode="search" placeholder="Saring nama / SKU…" value="${ctx.esc(katQ)}" aria-label="Saring katalog" />
        </div>
        <div id="pm-kat-chips" class="pm-katchips">${chipKategoriHtml(ctx)}</div>
        <div id="pm-kat-list" class="pm-katgrid">${katalogListHtml(ctx)}</div>
      </section>

      <section class="pm-panel${pnl('aksi')}" data-pm-panel="aksi" aria-label="Aksi lain">
        ${aksiPanelHtml(ctx)}
      </section>
    </div>

    <div class="pm-pay">
      <div class="pm-payrow">
        <div class="min-w-0">
          <div class="pm-paylabel">Total belanja</div>
          <div id="pos-owncount" class="pm-paycount">${ctx.teksOwncount()}</div>
        </div>
        <div id="pos-grand" class="pm-paygrand">${ctx.rp(ctx.totalBayar())}</div>
      </div>
      <div class="pm-payrow pm-payaksi">
        <button type="button" id="pos-bayar" class="btn btn-primary pm-bayar"${bayarMati ? ' disabled' : ''} title="Buka form bayar (pintasan F10)">${icon('check')}<span>Bayar</span></button>
        <button type="button" id="pos-pay-pas" class="btn pm-pas"${bayarMati ? ' disabled' : ''} title="Uang diterima = total, langsung bayar tanpa form (F12)"><span>Bayar pas</span></button>
      </div>
    </div>

    <nav class="pm-nav" aria-label="Navigasi POS">
      <button type="button" data-pm-tab="kasir" class="pm-tab${tab('kasir')}" aria-selected="${pmTab === 'kasir'}">${icon('pos')}<span>Keranjang</span><span id="pm-nav-count" class="pm-navcount${ctx.keranjangTerisi() ? '' : ' hidden'}">${ctx.cart.length + ctx.cartTopup.length}</span></button>
      <button type="button" data-pm-tab="katalog" class="pm-tab${tab('katalog')}" aria-selected="${pmTab === 'katalog'}">${icon('products')}<span>Katalog</span></button>
      <button type="button" data-pm-tab="aksi" class="pm-tab${tab('aksi')}" aria-selected="${pmTab === 'aksi'}">${icon('menu')}<span>Lainnya</span></button>
    </nav>
  </div>`;
}

/* ---------- binding (dipanggil paint() pos.ts tepat setelah bindCart) ---------- */

/** Binding mobile-only: tab navbar bawah + interaksi tab Katalog. SELURUH id
 *  lain (`#pos-qty`, `#pos-rows`, `#pos-bayar`, `#pos-hold`, …) sudah diikat
 *  binder pos.ts — jangan daftarkan ulang di sini (dobel listener). */
export function bindPosMobile(hostEl: HTMLElement, g: () => PosMobileCtx): void {
  getCtx = g;
  // `paint()` penuh = render ulang seluruh shell: filter katalog kembali ke
  // default (state DOM-nya juga baru) — sinkron dengan HTML shell.
  katSlug = null;
  katQ = '';

  hostEl.querySelectorAll<HTMLButtonElement>('[data-pm-tab]').forEach((b) => {
    b.addEventListener('click', () => tampilTab(hostEl, b.dataset.pmTab as PmTab));
  });

  const katInp = hostEl.querySelector<HTMLInputElement>('#pm-kat-q');
  katInp?.addEventListener('input', () => {
    katQ = katInp.value;
    renderKatalogList();
  });
  hostEl.querySelector('#pm-kat-chips')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pm-kat]');
    if (!b) return;
    katSlug = b.dataset.pmKat || null;
    hostEl.querySelectorAll('[data-pm-kat]').forEach((x) => x.classList.toggle('is-active', x === b));
    renderKatalogList();
  });
  hostEl.querySelector('#pm-kat-list')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pm-prod]');
    if (!b || !getCtx) return;
    const p = getCtx().products.find((x) => x.id === Number(b.dataset.pmProd));
    if (!p) return;
    const layanan = getCtx().layananProduk(p);
    getCtx().tambahProduk(p);
    // Produk biasa = langsung pindah ke tab Keranjang supaya kasir melihat
    // barisnya masuk (pola tombol "Tambah" aplikasi kasir mobile). Kategori
    // layanan topup TIDAK: addProduct membuka dialog, tab tidak relevan.
    if (!layanan) tampilTab(hostEl, 'kasir');
  });
}

/** Ganti tab aktif: panel `hidden` + kelas `is-active` tombol nav + scroll
 *  body kembali ke atas (tiap panel punya posisi scroll sendiri-sendiri di
 *  satu container — tanpa reset, pindah tab terlihat "melompat"). */
function tampilTab(hostEl: HTMLElement, t: PmTab): void {
  pmTab = t;
  hostEl.querySelectorAll<HTMLElement>('[data-pm-panel]').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.pmPanel !== t);
  });
  hostEl.querySelectorAll<HTMLElement>('[data-pm-tab]').forEach((b) => {
    const aktif = b.dataset.pmTab === t;
    b.classList.toggle('is-active', aktif);
    b.setAttribute('aria-selected', String(aktif));
  });
  const body = hostEl.querySelector<HTMLElement>('.pm-body');
  if (body) body.scrollTop = 0;
}

/** Gambar ulang isi grid katalog (chip kategori TIDAK diulang — jumlahnya
 *  tidak berubah selama sesi; hanya daftar produk yang ikut filter). */
function renderKatalogList(): void {
  if (!getCtx) return;
  const list = document.getElementById('pm-kat-list');
  if (list) list.innerHTML = katalogListHtml(getCtx());
}

/** Segmentation HANYA katalog — dipanggil pos.ts setelah stok tersinkron
 *  pasca-penjualan (`segarkanStokPos`), supaya badge stok di kartu produk
 *  ikut segar tanpa paint() penuh (paint() membuang fokus kolom scan).
 *  `paintCart()` sudah diurus pos.ts; elemen tidak ada (mode desktop /
 *  shift gate) = no-op. */
export function posMobileSegarkan(): void {
  if (!getCtx || !document.getElementById('pm-kat-list')) return;
  renderKatalogList();
}

/** Reset state modul saat meninggalkan halaman POS (dipanggil
 *  `unmountPosPage()` pos.ts): kunjungan berikutnya mulai dari tab Keranjang
 *  tanpa filter. `getCtx` dibuang supaya tidak menahan state lama. */
export function posMobileReset(): void {
  pmTab = 'kasir';
  katSlug = null;
  katQ = '';
  getCtx = null;
}
