import { NextResponse } from "next/server";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "@/lib/db/connection";
import { activity } from "@/lib/runtime/activity";
import { runtimePaths } from "@/lib/runtime/paths";
import { getMiniRuntimeStatus } from "@/lib/auto/mini-runtime";
import { requestAutoRunCancel } from "@/lib/db/auto-store";
import { requestAutoWorkerCancel } from "@/lib/auto/worker";
import { importLegacyData } from "@/lib/runtime/import-data";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const exec = promisify(execFile);
type Setup = { running: boolean; lines: string[]; error: string | null };
const shared = globalThis as typeof globalThis & { thrushSetup?: Setup };
const setup = (shared.thrushSetup ??= {
  running: false,
  lines: [],
  error: null,
});
function activeRuns() {
  return getDb()
    .prepare(
      "SELECT id FROM auto_runs WHERE status IN ('queued','preparing','running','reporting')",
    )
    .all() as { id: string }[];
}
async function check(command: string, args: string[]) {
  try {
    const result = await exec(command, args, {
      timeout: 10000,
      windowsHide: true,
    });
    return { ok: true, message: result.stdout.trim().slice(0, 300) };
  } catch {
    return {
      ok: false,
      message: `${command} is not available in this environment.`,
    };
  }
}
export async function GET(request: Request) {
  if (process.env.THRUSH_DESKTOP !== "1")
    return NextResponse.json({}, { status: 404 });
  const url = new URL(request.url);
  if (url.searchParams.get("action") === "directories") {
    try {
      const current = realpathSync(
        url.searchParams.get("path") || os.homedir(),
      );
      const directories = readdirSync(current, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: path.join(current, e.name) }));
      return NextResponse.json({
        current,
        parent: path.dirname(current),
        directories,
      });
    } catch {
      return NextResponse.json(
        { error: "Cannot read that directory." },
        { status: 400 },
      );
    }
  }
  if (url.searchParams.get("action") === "dependencies") {
    const [git, docker, github] = await Promise.all([
      check("git", ["--version"]),
      check("docker", ["info", "--format", "{{.ServerVersion}}"]),
      check("gh", ["auth", "status"]),
    ]);
    const mini = getMiniRuntimeStatus();
    let browser: { ok: boolean; message: string };
    try {
      const result = await exec(
        process.execPath,
        [path.join(runtimePaths().resources, "scripts", "check-browser.mjs")],
        { timeout: 20000, windowsHide: true },
      );
      browser = JSON.parse(result.stdout.trim());
    } catch (error) {
      try {
        browser = JSON.parse(
          String((error as { stdout?: string }).stdout).trim(),
        );
      } catch {
        browser = {
          ok: false,
          message:
            "Browser check failed. Prepare the runtime and review the diagnostics.",
        };
      }
    }
    return NextResponse.json({
      git,
      docker,
      github,
      mini: { ok: mini.ready, message: mini.message },
      browser,
      setup,
    });
  }
  return NextResponse.json({
    instance: process.env.THRUSH_INSTANCE_ID,
    active: activity.requests.size + activeRuns().length,
    setup,
    dataPath: runtimePaths().data,
  });
}
export async function POST(request: Request) {
  if (process.env.THRUSH_DESKTOP !== "1")
    return NextResponse.json({}, { status: 404 });
  try {
    const body = await request.json();
    if (body.action === "shutdown") {
      activity.stopping = true;
      const runs = activeRuns();
      for (const run of runs) {
        requestAutoRunCancel(run.id, "Desktop shutdown");
        requestAutoWorkerCancel(run.id);
      }
      await Promise.allSettled(
        runs.map((run) =>
          exec(
            "docker",
            ["rm", "-f", "thrush-" + run.id.replace(/[^a-zA-Z0-9_.-]/g, "")],
            { timeout: 10000, windowsHide: true },
          ),
        ),
      );
      return NextResponse.json({ ok: true });
    }
    if (activity.requests.size || activeRuns().length || setup.running)
      throw new Error("Wait for the current task or setup to finish.");
    if (body.action === "import") {
      if (typeof body.path !== "string" || !path.isAbsolute(body.path))
        throw new Error("Choose an absolute data directory.");
      activity.stopping = true;
      try {
        return NextResponse.json(await importLegacyData(body.path));
      } finally {
        activity.stopping = false;
      }
    }
    if (body.action === "prepare") {
      setup.running = true;
      setup.lines = [];
      setup.error = null;
      const child = spawn(
        process.execPath,
        [path.join(runtimePaths().resources, "scripts", "setup-runtime.mjs")],
        {
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const append = (buffer: Buffer) => {
        setup.lines = [...setup.lines, buffer.toString("utf8")].slice(-80);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        setup.running = false;
        setup.error = error.message;
      });
      child.on("close", (code) => {
        setup.running = false;
        if (code !== 0)
          setup.error = "Runtime setup failed. Check the log and retry.";
      });
      return NextResponse.json({ ok: true });
    }
    throw new Error("Unknown desktop operation.");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Operation failed." },
      { status: 400 },
    );
  }
}
