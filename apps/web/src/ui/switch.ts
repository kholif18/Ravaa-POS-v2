// Switch gaya Aronium (label + toggle) untuk field boolean.
// Satu tempat karena dipakai dua halaman: form produk (price_dynamic) dan
// panel bayar POS (cetak struk). Tanpa JS: <input> peer disembunyikan, sisanya
// diwarnai lewat peer-checked.

export function switchHtml(id: string, checked: boolean, label: string): string {
  return `
    <label class="flex cursor-pointer items-center gap-2" for="${id}">
      <input id="${id}" type="checkbox" class="peer sr-only" ${checked ? 'checked' : ''} />
      <span class="relative h-5 w-9 shrink-0 rounded-full bg-gray-300 transition peer-checked:bg-primary after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 dark:bg-gray-700"></span>
      <span class="text-xs font-semibold text-gray-700 dark:text-gray-200">${label}</span>
    </label>`;
}
