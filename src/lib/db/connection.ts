import { runtimePaths } from "../runtime/paths";
import path from "node:path";
import { activity } from "../runtime/activity";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { migrate } from "./migrate";

let db: Database.Database | null = null;

function getDatabasePath() {
  return runtimePaths().database;
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
  if (process.env.THRUSH_DESKTOP === "1" && !activity.initialized) {
    activity.initialized = true;
    db.prepare("UPDATE auto_runs SET status='failed', failure_category='unknown', failure_message='Interrupted when the desktop service stopped. Review artifacts before starting a new task.', finished_at=? WHERE status IN ('queued','preparing','running','reporting')").run(Date.now());
  }

  return db;
}
