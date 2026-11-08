// Fishingbot v2.6.0 local-first database entry point.
// The production desktop/server edition uses SQLite exclusively.
// Supabase kv_store JSON migration remains supported by db-sqlite.js.
import { db as sqliteDb, databasePath, closeDatabase } from './db-sqlite.js';
export const LOCAL_EDITION = true;
export const db = sqliteDb;
export { databasePath, closeDatabase };
