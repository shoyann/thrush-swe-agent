import {
  appendAutoEvent,
  claimNextQueuedAutoRun,
  getAutoRun,
} from "@/lib/db/auto-store";
import { cancelRunningAutoRun, runAutoRun } from "@/lib/auto/runner";

let workerStarted = false;
let workerBusy = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick() {
  if (workerBusy) {
    schedule();
    return;
  }

  workerBusy = true;
  try {
    const run = claimNextQueuedAutoRun();

    if (run) {
      appendAutoEvent({
        autoRunId: run.id,
        message: "Auto Worker claimed this run.",
        type: "worker_claimed",
      });
      await runAutoRun(run.id);
    }
  } finally {
    workerBusy = false;
    schedule();
  }
}

function schedule() {
  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(() => {
    void tick();
  }, 1500);
  timer.unref?.();
}

export function ensureAutoWorkerStarted() {
  if (workerStarted) {
    return;
  }

  workerStarted = true;
  schedule();
}

export function requestAutoWorkerCancel(autoRunId: string) {
  const run = getAutoRun(autoRunId);

  if (run?.status === "running" || run?.status === "preparing") {
    cancelRunningAutoRun(autoRunId);
  }
}
