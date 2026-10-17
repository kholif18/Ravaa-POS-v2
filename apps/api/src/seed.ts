import { seed, dbPath, peringatkanSkema } from './db.js';

seed();
console.log(`seed ok -> ${dbPath}`);
// Peringatan bila DB lama ketinggalan kolom — pada DB seperti ini semua
// CREATE TABLE di schema.sql no-op dan keluaran "seed ok" MENYESATKAN
// (kejadian nyata 2026-10-18). Ditulis paling akhir supaya blok peringatan
// jadi hal terakhir yang terlihat.
peringatkanSkema();
process.exit(0);
