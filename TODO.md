# TODO — Ravaa POS v2

Checklist hidup. Coretan saat selesai. Sumber riset & prioritas di bawah.

## Backlog — hasil riset UI/UX POS (2026-10-04)

Referensi: KulaPOS/NgertiKode (video YouTube `mVE7zPq2VXk` 48 menit — transkrip
`/tmp/opencode/kulapos-transcript.txt`, frame `/tmp/opencode/kp/`; 12 screenshot
galeri `ngertikode.id` → `/tmp/opencode/kula-*.png` — catatan: file /tmp bisa
terhapus, bukti utama sudah diekstrak ke laporan chat 2026-10-04).

- [x] 2026-10-04 **P1 — Uang diterima auto-isi = Total** — selama kasir belum
      menyentuh kolom (`cashTouched`), nilai ikut total tiap keranjang/diskon/
      metode berubah; input manual dihormati, barrier `pay()` tetap pengaman.
      Test: kolom auto-isi Rp4.000 + barrier dijalankan setelah kolom
      dikosongkan (`e2e-struk.mjs` 83 asersi).
- [x] 2026-10-04 **P2 — Teks konteks Kembalian** — `teksKembalian()` di
      `pos.ts`: "Kurang Rp…" (merah) / "Uang pas. Tidak ada kembalian."
      (hijau) di baris `#pos-change-ctx` bawah angka KEMBALIAN.
- [x] 2026-10-04 **P3 — Label shortcut `<kbd>`** — helper `kbd()` + label
      Cari `F3`, Qty `F4`, Bersihkan `F5`, Diskon `F6` pada tombolnya, plus
      pintasan baru **F5** (kosongkan keranjang — sekalian memperbaiki kolom
      diskon yang tidak ikut dikosongkan) dan **F6** (fokus kolom diskon) di
      `bindPintasan()`, preventDefault F5/F6 agar Chrome tidak reload/find.
- [ ] **P4 — Grid katalog + tab kategori di POS** (mode `Daftar|Grid`, ≥860px;
      HP tetap search) — tanpa API baru (cache produk + `/api/categories`).
- [x] **P5 — Tahan/pending transaksi** — SELESAI 2026-10-04: snapshot keranjang
      (`Hold` = items/diskon/pelanggan/waktu/kasir) ke **IndexedDB per device**
      (`getHolds()`/`saveHolds()` di `store.ts`, kv key `'holds'` — tanpa
      endpoint baru), tombol **Tahan** + **Pending (n)** (badge
      `#pos-hold-count`) di section **Aksi cepat** sidebar POS, modal daftar
      **[Lanjutkan] [Hapus]** (konfirmasi swal; Lanjutkan validasi pelanggan
      ke master + dorong `manualSeq`), persisten setelah reload. Uji
      `uji-hold.mjs` 23/23 + `npm test` 837 hijau.
- [ ] **P6 — Biaya tambahan / voucher** ⚠️ butuh diskusi kontrak `POST /api/sales`
      (jangan diimplementasi sepihak; kompromi saat ini = Item manual Rp500).
- [ ] **P7 — Customer display** (jendela kedua via `BroadcastChannel`, struk
      live gaya KulaPOS) — client-only, tanpa API.

Tidak diusulkan (alasan tercatat di laporan riset): multi-tata-letak/tema picker,
member/poin.
**Catatan 2026-10-04 (putaran 5–6)**: dua yang dulu "tidak diusulkan" justru
diminta pemilik dan kini ADA — **piutang saat bayar POS** (uang kurang ->
hutang, syarat pelanggan bukan "Pelanggan Umum") dan **payment modal**
(form bayar terpusat ala Aronium F10); daftar di atas dicabut untuk keduanya.

**Catatan 2026-10-04 (putaran 7)**: tiga fitur kecil permintaan pemilik &
user (saat akhir session):
- ✅ **Chip `<kbd>F6</kbd>` di label diskon transaksi dihapus** — F6 label ada
  hanya di tombol "Diskon F6" grid Aksi cepat; `cartGridHtml` / `paintFormBayar`
  comment diperbarui; screenshot verifikasi.
- ✅ **Baris Subtotal sidebar dihapus** ("ini juga hapus saja") — ringkasan
  sidebar kini hanya Diskon item; `const sub`/`const tot` di `cartGridHtml`
  dihapus; `set('#pos-subtotal')` dihapus.
- ✅ **Tombol Item manual ganda di scan bar dihapus** — tetap ada hanya di
  Aksi cepat `#pos-qa-manual` ("sudah ada pada deretan tombol panel kanan");
  listener `#pos-manual` dihapus.
- ✅ **Layar cari pelanggan ala F3** — `#pos-cust-cari` button di info bar →
  `openCariPelanggan()` (pola identik `openCariProduk()`): input multi-kata
  filter nama/HP/nomor urut/catatan, ↑↓ sorot, Enter/**Pilih**/klik = pilih
  + set `#pos-customer` value + kembali fokus scan. Cust type extend phone/note.
- ✅ **Shortcut F1/F8 (fokus scan)** — **F1** = referensi KulaPOS
  *"Jumlah Beli * Kode [F1/Cmd+K]"*, **F8** = alias jalan pendek satu tekan;
  placeholder Kolom Scan + title tooltip F1/F8/Esc diupdate.
- ✅ **Shortcut F9 (cari pelanggan)** — tombol `#pos-cust-cari` + title
  "Cari pelanggan (F9)" + hint `<kbd>F9</kbd>` di input modal cari pelanggan.
- ✅ **`<kbd>` hint di modal cari produk** — tambah `<kbd>F3</kbd>` di
  modal `openCariProduk()` (samping input search).
- ✅ Docs: AGENTS §2 (info bar + sidebar ringkasan + scan bar), README
  (info bar + sidebar + Aksi cepat + Layar cari pelanggan bullet + shortcut
  F1/F8/F9), SKILL, pos.ts komentar, TODO catatan ini.
- ✅ Tests: `e2e-struk.mjs` section K (6 asersi baru: Subtotal/Manual/Cari
  modal/filter/Enter select/no-match message) → 99 + 6 = **105**, run.mjs
  ekspek diupdate; **npm test total 883 assertion SEMUA HIJAU**.
- ✅ **Bug fix bonus**: `skipable()` di `pos-qtykode-test.mjs` memanggil
  async callback tanpa await (race: note-click paralel dengan fill search
  dropdown); fixed async + await, test kembali hijau 24/24.

**Gap analysis KulaPOS vs Ravaa POS (2026-10-04)** — sumber: `kula-01..12*.png`
(khususnya `kula-02-transaksi-pos.png`, `kula-07-pos-kasir.png`) +
`kulapos-transcript.txt` segmen 35:00–41:00:

* **Sudah setara / selesai**: Pending-Tahan (P5) + pintasan F7, `Qty*Kode`,
  navigasi ↑↓ baris, Bersihkan F5, diskon faktur F6, pelanggan inline, strip
  stok/kadaluarsa, cetak struk otomatis, satuan jual, catatan per baris.
* **Menyusul (sudah tercatat)**: P4 grid katalog, P6 biaya tambahan/voucher,
  P7 customer display, plus kandidat kecil di section Menyusul
  (tutup shift dari POS, ganti satuan baris, **hapus duplikat Item manual**,
  **hapus baris Subtotal sidebar**, **cari pelanggan ala F3** — ketiganya
  permintaan pemilik 2026-10-04 di akhir section itu).
* **Ditunda keputusan pemilik**: **pajak PPN 10% + service charge**
  ("D pajak skip dulu", 2026-10-04) — butuh kolom/setting baru dan menyentuh
  `POST /api/sales`, laporan, struk, invoice; harga baris bisa diedit kasir
  (bertabrakan dengan "harga non-dinamis dikunci server").
* **Di luar ruang lingkup toko ini** (dicatat, tidak dikerjakan): retur &
  garansi, pengeluaran (kas keluar), supplier/pembelian (PO), Kas In/Out,
  multi-cabang + transfer stok, payment gateway, notif struk WhatsApp,
  member/poin.

## Selesai (ringkas)

- [x] 2026-10-04 **Form bayar (modal) + Bayar pas di side panel + uang
      kurang = HUTANG** (permintaan pemilik putaran 5–6: "pindahkan ke modal
      ketika klik bayar" lalu "bayar uang pas letakkan di sidepanel bawahnya
      Bayar F10 … kalau uang kurang jadi Hutang dengan catatan harus ada
      customer yang terpilih dan tidak boleh customer default/umum"):
      * **Side panel** kini hanya berisi **Bayar F10** (`#pos-bayar`, buka
        form) dan **tepat di bawahnya Bayar pas hijau F12** (`#pos-pay-pas`)
        — sekali ketuk, tanpa modal.
      * **Form bayar = modal** (`bukaBayar()`/`formBayarHtml()`): total
        tagihan, metode `data-pay`, `#pos-cash` + chip `data-cash`,
        kembalian, petunjuk hutang; **OK modal = `#pos-pay`** (Enter/F2/F10
        satu aksi). Isian lama dipindah utuh — id & selector tidak berubah.
      * **Uang kurang -> hutang**: `pay()` menawarkan `confirmDialog`
        bila `cekHutangDiperbolehkan()` lolos (ada pelanggan terpilih, bukan
        "Pelanggan Umum"/`CUS-000001`) -> `pay({hutang:true})` melewati
        barrier -> penjualan + `POST /api/customer-debts` `type=charge`,
        `note: 'Nota <invoice_no> — sisa bayar POS'`; gagal ledger = nota
        tetap sukses + toast penunjuk halaman Hutang. Tidak lolos syarat =
        penolakan barrier lama **persis** (pesan + fokus kolom uang) —
        teruji barrier lama di section F tetap hijau.
      * Struk memuat baris **Hutang** bila sisa > 0; **guard pintasan swal**
        (dialog konfirmasi cetak/hutang menahan F-key, sebab `.modal-overlay`
        bisa menemukan form bayar di bawah swal — tanpa ini F12 membayar
        lewat belakang konfirmasi).
      * Pintasan baru **F8** (fokus kolom scan), **F10** (buka form bayar),
        **F12** (bayar pas) — rujukan help.aronium.com.
      * Test: `tests/e2e-struk.mjs` **83 -> 99 asersi** (section J baru:
        posisi Bayar pas, bayar tanpa form, penolakan pelanggan Umum,
        dialog konfirmasi, ledger charge = sisa, nota invoice, bersih-bersih)
        + `tests/e2e-multisatuan.mjs` menyesuaikan alur form; total suite
        **877 assertion SEMUA HIJAU** (`tests/run.mjs` ekspek 83 -> 99);
        tsc + `npm run build -w apps/web` lolos. Docs: AGENTS §2 + §3
        (customer-debts punya pelanggan kedua = POS), README, skill
        `frontend-pos` pola #8/#9, header pos.ts.
      * **Catatan DB dev**: pelanggan uji `UjiHutang POS E2E` tidak bisa
        dihapus (FK `sales.customer_id`) — dipakai ulang tiap run, ledger
        dibersihkan tiap run.

- [x] 2026-10-04 **Input cepat ala KulaPOS: `Qty*Kode`, navigasi ↑↓ baris,
      pintasan F7 Tahan** (hasil gap analysis, blok C) — `bacaQtyKode()`
      memparse `3*PRD00001` / `2 * aqua` di kolom scan (qty eksplisit menang
      atas chip Qty/F4 tetapi TIDAK mengosongkan preset itu; qty 0 ditolak
      "Qty minimal 1"; kode tak dikenal -> pesan "tidak ditemukan"; tanpa
      tanda `*` perilaku scan lama utuh; placeholder kolom scan ikut
      mengumumkannya), `pindahBarisKeranjang()` ↑↓ selama fokus di dalam
      `#pos-rows` (baris catatan dilewati, input catatan dikecualikan karena
      panah = kursor, clamp di ujung; panah kolom scan tetap milik dropdown),
      **F7** = Tahan (F2/F3 sudah terpakai Bayar/Layar cari) + label `<kbd>F7>`
      di tombolnya. Test baru **`tests/pos-qtykode-test.mjs` 24 asersi**
      (terdaftar `tests/run.mjs`; total suite kini **861 assertion**), docs:
      AGENTS §2 + README + header pos.ts.
- [x] 2026-10-04 **Info bar: 3 kolom SAMA RATA** (permintaan pemilik "buat
      kolomnya sama rata, jangan lebar di tengah, belum sama rata ukuran
      kolomnya"): grid `lg:grid-cols-[auto_1fr_auto]` → **`lg:grid-cols-3`**
      (track select pelanggan `1fr` dulu menyerap seluruh sisa lebar) +
      `lg:min-w-[340px]` kolom kanan ikut dibuang (track sudah 1/3; min-width
      itu meluap di layar 1024px). Uji ukur: **1440px → 453/453/453px,
      1024px → 314/314/314px**, `#pos-grand` tetap 48px menempel kanan, tanpa
      scroll horizontal, `npm test` **837 hijau**.

- [x] 2026-10-04 **Nomor nota konsisten — uuid penuh dibuang dari layar**
      (laporan pemilik: "Nota d35b5731-… kok tidak sama dengan
      261004-000013"): dialog **detail nota Riwayat** (`history.ts` — baris
      `Nota ${s.id}` uuid penuh) kini `invoice_no ?? id.slice(0,8)`, sama
      seperti toast cetak-ulang & toast "Terjual" POS. **Riwayat Stok**
      (`stock.ts` `Nota <8 digit>`) ikut — API `GET /api/stock-moves` kini
      mengembalikan **`ref_invoice`** (subquery `sales.invoice_no`, additive,
      kontrak §3 diupdate) supaya kolom Keterangan memakai nomor nota yang
      sama. Verifikasi curl: `ref_invoice: "261004-000008"` menemani
      `ref_id` uuid; `npm test` 837 assertion hijau.

- [x] 2026-10-04 **Pelanggan tersimpan di penjualan + nomor urut customer/
      supplier** (permintaan pemilik) — kolom `customers.code`/`supplier_no`/
      `address` + `sales.customer_id`/`customer_name` (ALTER in-place, backup
      `data.db.bak.customer-sales`; SQL migrasi dicatat di AGENTS §5).
      `nomorUrutPelanggan()` = MAX+1 via `CAST(substr(...))` (bukan COUNT —
      gap nomor tidak dipakai ulang; **prefiks wajib `'CUS-'`/`'SUP-'`** —
      bug nyata: pref tanpa dash bikin CAST `-1` → nomor dobel). Seed
      **Pelanggan Umum** = `CUS-000001`. `POST /api/sales` terima
      `customer_id?` (400 bila tak dikenal) + snapshot `customer_name`;
      struk/invoice/riwayat/cetak-ulang memuat baris **Pelanggan** (fallback
      "Pelanggan Umum"); select pelanggan di info bar POS, reset tiap bayar.

- [x] 2026-10-04 **Refactor layout POS mengikuti KulaPOS (Fase 2)** — info
      bar (jam live `jamPos()` + Kasir/Shift + select pelanggan + TOTAL
      BELANJA `#pos-grand` + `#pos-owncount`), tabel keranjang **8 kolom**
      (No/Kode/Nama/Harga/Qty/Diskon/Subtotal/Aksi), **footer horizontal
      4 kolom** menggantikan panel bayar vertikal (semua id lama
      `#pos-cash`/`#pos-pay`/`#pos-change` dipertahankan → F2/Enter/barrier +
      suite test aman), tombol **Bayar pas** `#pos-pay-pas`, modal selesai =
      **`Kembalian RpX` [Thermal] [A4] [Selesai]**. Ikon info bar dipegang
      rule `.info-bar svg` (pola `.chip svg` — terbukti ikon clock jadi
      raksasa tanpa itu). **Putaran lanjutan pemilik 2026-10-04**: header
      judul "Kasir (POS)" **full dihapus** dari `renderPosShell()` (POS tanpa
      `<header>` — keluar = back browser), urutan disamakan ke referensi
      (info bar → scan bar → label "n item + Bersihkan [F5]" di atas tabel →
      tabel ‖ sidebar kanan). Putaran 3: baris **Kasir dipindah ke bawah
      Waktu** (tumpukan vertikal) + **tombol ⬅ kembali ke dashboard**
      (`tombolKembaliHtml()`) di kiri info bar / baris Mode topup-tarik.
      Putaran 4: **footer horizontal DITOLAK** — panel bayar kembali jadi
      **sidebar kanan 320px** (grid `lg:grid-cols-[1fr_320px]`, isi & id
      sama). Putaran 5: info bar — kolom total dipecah (label+n item kiri,
      `#pos-grand` kanan) + **garis pemisah vertikal ketiga kolom**
      (`border-l` ≥lg). Putaran 6: select pelanggan **selebar kolom** (hapus
      `max-w-[520px]`) + kolom total `lg:min-w-[340px]` supaya label benar-
      benar menempel kiri & angka kanan. Putaran 7: `#pos-grand` font
      **kustom `text-[48px]`** (2x lipat `text-2xl` 24px — "custom ukuran
      font, besarkan lagi 2x lipat"). Putaran 8 (sidebar): **baris Grand
      total DIHAPUS** (duplikat TOTAL BELANJA) + section **Aksi cepat**
      grid 2 kolom (Tahan/Pending = fitur P5, Item manual/Diskon nyata,
      Voucher/Cetak ulang placeholder `data-soon`). Verifikasi: tsc 0,
      build OK, `npm test` **837 assertion SEMUA HIJAU** (tanpa ubah
      ekspek), uji playwright `uji-pos-layout.mjs` 22/22 + `uji-hold.mjs`
      23/23 (font 48px, grand total hilang, alur Tahan→Pending→Lanjutkan/
      Hapus, persistensi IndexedDB pasca-reload; kasus awal "Lanjutkan
      timeout" = asersi test salah hitung — baris catatan `note-row` juga
      menyandang `data-key`, bukan bug fitur).

- [x] 2026-10-04 **Nomor invoice/struk direvisi: `YYMMDD-NNNNNN`** — permintaan
      pemilik "jangan random, kombinasi tahun+bulan+tanggal+nomor urut":
      generator server `POST /api/sales` kini memakai prefiks **tanggal UTC**
      + urut **harian** (`261004-000001`, pola `LIKE '<YYMMDD>-%'` +
      `CAST(substr(...,8))` — sekaligus memperbaiki off-by-one `slice(6)` lama
      yang salah dihitung). Struk thermal & riwayat kini mencetak **`No.`
      invoice** (bukan lagi 8 digit uuid yang terlihat random), waktu dan No.
      dipisah baris supaya tidak kena `potong(m, 32)`. Kontrak AGENTS §3,
      schema.sql, README, history.ts, 2 asersi `e2e-struk.mjs` ikut diupdate.

- [x] 2026-10-04 **Super-compact skala KulaPOS/RPOS (putaran 2)** — pemilik
      menilai putaran 1 masih "terlalu besar": seluruh tangga teks Tailwind
      diturunkan satu tingkat di `@theme` `styles.css` (`--text-xs` **11px**,
      `--text-sm` **13px**, base 14/lg 15/xl 17/2xl 20/3xl 24) — ±90 `text-xs`
      + ±89 `text-sm` ikut otomatis. Komponen dipersepat: `.btn` **34px**,
      `.input` **33px** / `.input-sm` **31px**, header **44px**, `.icon-btn`
      32px, `.card` p-3, th/td/chip/badge/modal/toast/nav padding satu tingkat;
      chip **26px** (tetap tombol sentuh); swal judul/isi **13px** + ikon
      **45px**; spacing template `gap-3→2`, `gap-4→3`, `p-5→4`. Guard test
      `satuan-test.mjs` `.th` 12 → **11px** disadari + didokumentasikan
      (`.sw-btn` 40px TIDAK disentuh); sticky wrapper halaman Produk
      disinkronkan dengan padding `.page` baru. Total POS tetap
      `text-sm font-bold` (keputusan pemilik putaran 1: menonjol via bold+warna,
      bukan ukuran). Census akhir: **0 teks >14,5px** di 12 rute + modal +
      swal + toast + semua state; 12/12 rute @356px tanpa overflow;
      `npm test` **835 assertion ×3 SEMUA HIJAU**, build + tsc lolos.
- [x] 2026-10-04 **Hutang: tombol bayar per baris + cetak A4 rincian** —
      `pages/debts.ts`: tombol **Bayar** (ikon `wallet`) di tiap baris
      pelanggan berhutang membuka form catat-bayar prefill (nama + sisa +
      pratinjau "Sisa setelah bayar", `—` netral selama kosong, peringatan
      bila melebihi sisa), dan dialog rincian ledger kini punya tombol
      primer **Cetak A4** (`htmlHutangA4` + `cetakHutangA4`: kop `store_*`,
      tabel kronologis, ringkasan sisa — pola popup `invoice.ts`, tanpa
      print-agent; gagal hanya toast). Verifikasi end-to-end 10/10,
      `npm test` 835 hijau. Perbaikan inkonsistensi rute: 9 referensi
      `#/hutang` di 7 file (AGENTS/README/schema/komentar) → `#/debts`
      (rute asli `main.ts`).
      (Bukti ukuran: header 44, btn 34, `.th` 11, body 13, Bayar 43, popup 203px.)

- [x] 2026-10-04 **Halaman Pelanggan `#/customers` + Hutang `#/debts`** — master
      kontak + ledger piutang `charge|payment` (guard hapus saat masih ada
      catatan, bayar > sisa ditolak server), kontrak AGENTS §3 + §2 + §5 +
      README, test `customer-debt-test.mjs` 32 asersi.
- [x] 2026-10-04 **UI compact ala KulaPOS (pilihan C — seluruhnya)** — teks
      `text-base|lg|xl|2xl|3xl` → `text-sm` (14px) di semua halaman, spasi
      kartu/tabel/header/tombol dipersempit (`.btn`/`.input` 38px, header
      48px; `.th` 12px & `.sw-btn` 40px TIDAK disentuh — dijaga test), token
      baru dicatat di skill `frontend-pos`. Audit visual 15 screenshot + scan
      horizontal 12 rute @356px **menemukan 2 bug**: tabel Riwayat & Satuan
      tanpa `.table-wrap` (kolom Metode/Total/Aksi tak terjangkau di HP, dan
      `.sr-only` absolute menggeser halaman jadi 721px) → dibungkus
      `.table-wrap` + kelas itu kini `relative` (akar masalah containment).
      Lanjutan audit computed-style: **judul swal 18 → 14px** (satu-satunya
      teks >14px yang tersisa), padding dialog dipersempit, ikon swal box
      56 → 50px. Census semua rute + modal + swal + toast + state POS:
      **0 teks >14,5px**. `npm test` 835 assertion **×3 SEMUA HIJAU**,
      build + tsc lolos.
- [x] 2026-10-04 Invoice A4 ala Aronium (`invoice_no`, kop `store_*`,
      pilihan cetak [Thermal][A4][Tidak]), kartu Pengaturan toko, keranjang
      compact 43px, panel bayar ala Aronium + barrier uang diterima — push
      `488b382`.
- [x] 2026-10-03 Catatan per baris (`use_note`), F3/F4, dua layout struk, L3110.
- [x] 2026-10-02 Backup DB otomatis + kartu Backup (test 27 asersi).
- [x] 2026-10-01 Expected-cash tutup shift; kadaluarsa per kategori; menu Shift/
      Riwayat; foto produk & diskon per produk.

## Menyusul — permintaan pemilik berikutnya (belum dikerjakan)

- [ ] **Keranjang POS: kolom angka compact** — Harga / Qty / Diskon /
      Subtotal / Aksi diperkecil sesuai isi kontennya (width auto/shrink),
      hanya kolom **Nama barang** yang melebar menyerap sisa lebar tabel
      (permintaan pemilik 2026-10-04: "selanjutnya nanti pada tabel
      keranjang kolom Harga, QTY, Diskon, sub total, aksi di perkecil,
      compact saja sesuai ukuran konten, buat kolom nama barang saja yang
      lebar").
- [ ] **Rapikan layout sidebar POS** — permintaan pemilik "sidebar nanti
      rapikan layoutnya" (menyusul masuknya section Aksi cepat + penghapusan
      baris Grand total).
- [ ] **Tombol placeholder → fitur nyata** — **Voucher** (kaitan dengan P6,
      butuh diskusi kontrak `POST /api/sales`) dan **Cetak ulang** (ulang
      struk nota terakhir?) saat ini `data-soon` → toast "menyusul"
      (permintaan pemilik "placeholder/hardcode dulu tidak apa-apa").
- [ ] **Tutup shift dari dalam POS** (sisa gap analysis) — KulaPOS punya
      tombol merah "Tutup Sesi Kas" di header POS; shell Ravaa sengaja tanpa
      menu, jadi kasir harus keluar ke `#/shifts` (halaman Shift Kasir sudah
      punya dialog tutup + rumus expected-cash). Butuh keputusan bentuk:
      tombol di info bar / sidebar, atau sekadar tautan.
- [ ] **Ganti satuan baris yang sudah ada di keranjang** (sisa gap analysis) —
      KulaPOS punya select Satuan di bar "Parameter Barang Aktif"; Ravaa
      memilih satuan saat menambah (key baris = `<id>:<unit>`), jadi ubah
      satuan kini = hapus baris + scan ulang. Butuh keputusan UI (chip
      satuan per baris vs dialog) — jangan disentuh tanpa itu.
- [ ] **Hapus duplikat "Item manual"** (permintaan pemilik 2026-10-04) —
      tombol itu muncul **DUA kali**: di scan bar (`#pos-manual`, tetap) dan
      lagi di grid **Aksi cepat** sidebar (`#pos-qa-manual`, dipanggil
      `bindCart()` pos.ts) → **yang di Aksi cepat dihapus** (redundan);
      pasangannya di `pos.ts` (render `cartGridHtml` + listener) ikut
      dibuang, bukan hanya tombolnya.
- [ ] **Hapus baris "Subtotal" di sidebar** (permintaan pemilik 2026-10-04) —
      `<span id="pos-subtotal">` + baris flex-nya di `cartGridHtml()` dihapus;
      angka subtotal tetap hidup di ringkasan struk/laporan, jadi tidak ada
      sumber data yang hilang. `paintCart()` yang menulis `#pos-subtotal`
      ikut dibersihkan supaya tidak jadi query mati.
- [ ] **Pelanggan bisa dicari seperti cari produk F3** (permintaan pemilik
      2026-10-04) — `<select id="pos-customer">` sudah memuat master
      (`GET /api/customers`) tapi daftarnya makin panjang (banyak kontak
      supplier/pembeli) dan kasir harus men-scroll; ganti jadi pencarian
      multi-kata seperti layar cari produk (**F3**) — pola `openCariProduk()`
      di `pos.ts` (input + listbox + ↑↓ + Enter) atau dropdown hasil cari di
      samping select. `customer_id` yang terpilih tetap dikirim `pay()`
      seperti sekarang (server yang men-SNAPSHOT `customer_name`), jadi ini
      **murni UI** — tidak menyentuh kontrak API.
