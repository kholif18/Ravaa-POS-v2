import { seed, dbPath } from './db.js';

seed();
console.log(`seed ok -> ${dbPath}`);
process.exit(0);
