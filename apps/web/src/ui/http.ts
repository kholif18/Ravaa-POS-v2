// ui/http.ts - Normalisasi pesan error
import { HttpError } from '../api';

export function errMsg(e: unknown): string {
  if (e instanceof HttpError) {
    // HttpError.message sudah berisi teks error server/tipe.
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Terjadi kesalahan';
}
