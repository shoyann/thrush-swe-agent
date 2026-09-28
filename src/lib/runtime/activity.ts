type Activity = {
  requests: Set<string>;
  sessions: Set<string>;
  initialized: boolean;
  stopping: boolean;
};
const globalState = globalThis as typeof globalThis & {
  thrushActivity?: Activity;
};
export const activity = (globalState.thrushActivity ??= {
  requests: new Set(),
  sessions: new Set(),
  initialized: false,
  stopping: false,
});
