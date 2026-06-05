import type Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_TABLE = "_migrations";

function getMigrationsDir() {
  return path.resolve(process.cwd(), "src", "lib", "db", "migrations");
}

function ensureMigrationsTable(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename TEXT PRIMARY KEY,
      executed_at INTEGER NOT NULL
    );
  `);
}

function listMigrationFiles() {
  const migrationsDir = getMigrationsDir();

  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir)
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort((first, second) => first.localeCompare(second));
}

function getExecutedMigrations(database: Database.Database) {
  const rows = database
    .prepare(`SELECT filename FROM ${MIGRATIONS_TABLE}`)
    .all() as Array<{ filename: string }>;

  return new Set(rows.map((row) => row.filename));
}

export function migrate(database: Database.Database) {
  ensureMigrationsTable(database);

  const migrationsDir = getMigrationsDir();
  const executedMigrations = getExecutedMigrations(database);
  const pendingMigrations = listMigrationFiles().filter(
    (filename) => !executedMigrations.has(filename),
  );

  for (const filename of pendingMigrations) {
    const sql = readFileSync(path.join(migrationsDir, filename), "utf8");

    const runMigration = database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (filename, executed_at) VALUES (?, ?)`,
        )
        .run(filename, Date.now());
    });

    runMigration();
  }
}
