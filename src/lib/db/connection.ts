import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "@/lib/db/migrate";

let db: Database.Database | null = null;

function getDatabasePath() {
  return path.resolve(process.cwd(), "data", "thrush.db");
}

export function getDb() {
  if (db) {
    return db;
  }

  const databasePath = getDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });

  db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  migrate(db);

  return db;
}
