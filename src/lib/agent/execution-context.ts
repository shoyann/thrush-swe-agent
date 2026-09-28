import { AsyncLocalStorage } from "node:async_hooks";

const execution = new AsyncLocalStorage<AbortSignal | undefined>();
export const getExecutionSignal = () => execution.getStore();
export function withExecutionSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
) {
  return execution.run(signal, fn);
}
