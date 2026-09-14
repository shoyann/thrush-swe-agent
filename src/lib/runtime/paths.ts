import path from "node:path";
export function runtimePaths(root = process.cwd()) {
  const resources = path.resolve(process.env.THRUSH_RESOURCE_DIR || root);
  const data = path.resolve(
    process.env.THRUSH_DATA_DIR || path.join(root, "data"),
  );
  const runtime = path.resolve(process.env.THRUSH_RUNTIME_DIR || data);
  return {
    resources,
    data,
    runtime,
    logs: path.resolve(process.env.THRUSH_LOG_DIR || path.join(data, "logs")),
    database: path.join(data, "thrush.db"),
    migrations: path.join(resources, "src", "lib", "db", "migrations"),
    runs: path.join(data, "auto-runs"),
    workspace: path.join(data, "workspace"),
  };
}
