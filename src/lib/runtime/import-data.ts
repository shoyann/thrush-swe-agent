import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { getDb } from "../db/connection";
import { runtimePaths } from "./paths";

const tables = [
  "projects",
  "sessions",
  "messages",
  "tool_runs",
  "checkpoints",
  "mini_presets",
  "auto_runs",
  "auto_events",
  "auto_artifacts",
] as const;
export async function importLegacyData(sourceDirectory: string) {
  const paths = runtimePaths();
  const sourceRoot = realpathSync(sourceDirectory);
  const sourceFile = path.join(sourceRoot, "thrush.db");
  if (path.resolve(sourceFile) === path.resolve(paths.database))
    throw new Error("Choose a different source database.");
  const target = getDb();
  if (
    (
      target.prepare("SELECT COUNT(*) AS n FROM projects").get() as {
        n: number;
      }
    ).n
  )
    throw new Error("Import requires an empty environment.");
  const source = new Database(sourceFile, {
    readonly: true,
    fileMustExist: true,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(paths.data, "backups", stamp);
  mkdirSync(backupDir, { recursive: true });
  try {
    const known = new Set(
      readdirSync(paths.migrations).filter((n) => n.endsWith(".sql")),
    );
    const migrations = source
      .prepare("SELECT filename FROM _migrations")
      .all() as { filename: string }[];
    if (migrations.some((m) => !known.has(m.filename)))
      throw new Error(
        "This database belongs to a newer Thrush version (for example Assist V2). It cannot be downgraded.",
      );
    const actualTables = source
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    if (
      actualTables.some(
        (t) => ![...tables, "_migrations", "sqlite_sequence"].includes(t.name),
      )
    )
      throw new Error("Unsupported database schema.");
    await source.backup(path.join(backupDir, "source.db"));
    const snapshot = new Database(path.join(backupDir, "source.db"), {
      readonly: true,
    });
    try {
      const rows = Object.fromEntries(
        tables.map((table) => [
          table,
          snapshot.prepare(`SELECT * FROM "${table}"`).all(),
        ]),
      ) as Record<string, Record<string, unknown>[]>;
      const warnings: string[] = [];
      for (const project of rows.projects) {
        if (!existsSync(String(project.workspace_path))) {
          project.workspace_path_confirmed_at = null;
          warnings.push(
            `Project path is unavailable in this environment: ${project.workspace_path}`,
          );
        }
      }
      for (const session of rows.sessions) {
        const context = JSON.parse(String(session.context_json || "{}"));
        delete context.pendingDraft;
        delete context.pendingWorkspaceSwitch;
        context.autoApprove = false;
        session.auto_approve = 0;
        session.context_json = JSON.stringify(context);
        session.steps_json = "[]";
      }
      for (const run of rows.auto_runs) {
        if (
          ["queued", "preparing", "running", "reporting"].includes(
            String(run.status),
          )
        ) {
          run.status = "failed";
          run.failure_category = "unknown";
          run.failure_message =
            "Interrupted before import. This is a historical run.";
          run.finished_at = Date.now();
        }
        run.worktree_path = null;
        run.result_status = "imported_history";
      }
      for (const artifact of rows.auto_artifacts) {
        if (!artifact.file_path) continue;
        const oldPath = String(artifact.file_path);
        if (existsSync(oldPath)) {
          const real = realpathSync(oldPath);
          const relative = path.relative(sourceRoot, real);
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            !relative.startsWith("auto-runs" + path.sep)
          ) {
            warnings.push(`External artifact not copied: ${oldPath}`);
            artifact.file_path = null;
            continue;
          }
          const dest = path.join(
            paths.data,
            "imported-artifacts",
            stamp,
            String(artifact.id).replace(/[^a-zA-Z0-9_-]/g, "_"),
            path.basename(real),
          );
          mkdirSync(path.dirname(dest), { recursive: true });
          copyFileSync(real, dest);
          artifact.file_path = dest;
        } else {
          artifact.file_path = null;
          warnings.push(`Artifact file is missing: ${oldPath}`);
        }
      }
      target.transaction(() => {
        target.pragma("defer_foreign_keys = ON");
        for (const table of tables) {
          const columns = (
            target.prepare(`PRAGMA table_info("${table}")`).all() as {
              name: string;
            }[]
          ).map((c) => c.name);
          for (const row of rows[table]) {
            const names = columns.filter((c) => c in row);
            target
              .prepare(
                `INSERT INTO "${table}" (${names.map((n) => '"' + n + '"').join(",")}) VALUES (${names.map(() => "?").join(",")})`,
              )
              .run(...names.map((n) => row[n]));
          }
        }
      })();
      return {
        projects: rows.projects.length,
        messages: rows.messages.length,
        warnings,
        backup: backupDir,
      };
    } finally {
      snapshot.close();
    }
  } finally {
    source.close();
  }
}
