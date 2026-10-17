import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A hosting runtime (multi-project process) pins the project root for the
 * duration of one operation. pi never sets this, so its behavior is unchanged:
 * every reader falls back to the process cwd exactly as before.
 */
const scope = new AsyncLocalStorage<string>();

export function scopedProjectRoot(): string | undefined {
  return scope.getStore();
}

export function runWithProjectRoot<T>(root: string, operation: () => T): T {
  return scope.run(root, operation);
}
