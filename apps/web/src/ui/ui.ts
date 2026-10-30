// ui/ui.ts - Komponen UI reusable
import { icon, IconName } from './icons';

export function emptyHtml(iconName: IconName, message: string) {
  return `<div class="empty py-12 text-center text-gray-500">${icon(iconName)}<span class="ml-2">${message}</span></div>`;
}

export function kbd(t: string) {
  return `<kbd class="kbd">${t}</kbd>`;
}

export function tableShell(thead: string, rows: string, minW?: string) {
  const w = minW ? `min-w-[${minW}]` : '';
  return `<div class="table-wrap"><table class="table ${w}"><thead>${thead}</thead><tbody>${rows}</tbody></table></div>`;
}

export function searchInputHtml(id: string, placeholder = 'Cari…') {
  return `<div class="relative"><span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400">${icon('search')}</span><input id="${id}" class="input pl-9" placeholder="${placeholder}" /></div>`;
}
