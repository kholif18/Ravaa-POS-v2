/**
 * Header tabel yang bisa diurutkan — pola SAMA dengan halaman Produk
 * (`thUrut` products.ts, 2026-10-31): panah `↕` pada kolom non-aktif
 * menandakan "bisa diklik" tanpa mengklaim urutan; `aria-sort` memberi tahu
 * pembaca layar; klik kolom yang sama MEMBALIK arah, klik kolom lain = asc.
 *
 * Dipakai halaman yang barisnya di-sort di SERVER (customers, suppliers,
 * orders, purchases, debts — `paramSort()` menempel `sort`/`dir` ke query)
 * dan halaman yang data penuh ada di klien (stock, satuan — urut lokal).
 * Halaman Produk SENDIRI sengaja tidak disentuh (implementasi lama tetap).
 *
 * CSS `.th-sort`/`.th-arrow` = kelas bersama di `styles/tables.css`.
 */

export type Arah = 'asc' | 'desc';

/** State sort satu halaman: `null` = urutan bawaan (server/klien lama). */
export type SortAktif<K extends string> = { key: K; dir: Arah } | null;

/** Toggle saat header diklik: kolom sama → balik arah; kolom lain → asc. */
export function toggleSort<K extends string>(sebelum: SortAktif<K>, key: K): SortAktif<K> {
  if (sebelum?.key === key) return { key, dir: sebelum.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

/**
 * Satu sel `<th>` berisi tombol urut. `extra` = kelas tambahan th
 * (mis. `text-right`). Kolom non-aktif memakai panah `↕` + `aria-sort="none"`.
 */
export function thUrut<K extends string>(
  key: K,
  label: string,
  aktif: SortAktif<K>,
  extra = '',
): string {
  const on = aktif?.key === key;
  const arah = on ? (aktif.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const panah = on ? (aktif.dir === 'asc' ? '▲' : '▼') : '↕';
  const kelasExtra = extra ? ` ${extra}` : '';
  return `<th class="th${kelasExtra}" aria-sort="${arah}">
            <button type="button" data-sort="${key}" class="th-sort${on ? ' is-on' : ''}"
              title="Urutkan menurut ${label}">${label}<span class="th-arrow" aria-hidden="true">${panah}</span></button>
          </th>`;
}

/**
 * Tempel `sort`/`dir` ke query request bila ada sort aktif — untuk endpoint
 * server yang mendukung param opsional itu (lihat §3 AGENTS). Tanpa sort,
 * query TIDAK berubah sama sekali (urutan bawaan server dipertahankan).
 */
export function paramSort<K extends string>(aktif: SortAktif<K>, p: URLSearchParams): void {
  if (!aktif) return;
  p.set('sort', aktif.key);
  p.set('dir', aktif.dir);
}

/**
 * Pasang listener klik semua `[data-sort]` di `host` (sekali per paint).
 * `onKlik(key)` dipanggil dengan key baru hasil toggle — pemanggil biasanya
 * `state.sort = toggleSort(state.sort, key); offset = 0; load(); paint();`.
 */
export function bindSort<K extends string>(
  host: HTMLElement,
  stateSort: SortAktif<K>,
  daftar: readonly string[],
  onKlik: (key: K, next: SortAktif<K>) => void,
): void {
  host.querySelectorAll<HTMLElement>('th [data-sort]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.dataset.sort as K;
      if (!daftar.includes(key)) return;
      onKlik(key, toggleSort(stateSort, key));
    });
  });
}
