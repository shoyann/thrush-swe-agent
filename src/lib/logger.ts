type LogMeta = Record<string, unknown>;

function log(
  level: "info" | "warn" | "error",
  requestId: string,
  msg: string,
  meta?: LogMeta,
) {
  console.log(
    JSON.stringify({
      ts: Date.now(),
      level,
      requestId,
      msg,
      ...(meta ?? {}),
    }),
  );
}

export function createLogger(requestId: string) {
  return {
    info: (msg: string, meta?: LogMeta) => {
      log("info", requestId, msg, meta);
    },
    warn: (msg: string, meta?: LogMeta) => {
      log("warn", requestId, msg, meta);
    },
    error: (msg: string, meta?: LogMeta) => {
      log("error", requestId, msg, meta);
    },
  };
}
