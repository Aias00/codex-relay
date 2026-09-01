export type RelayLifecyclePhase = "running" | "quiescing" | "draining" | "closing" | "closed";

export type RelayLifecycleHook = () => Promise<void> | void;

export type RelayShutdownReport = {
  drainTimedOut: boolean;
  errors: Array<{ message: string; phase: Exclude<RelayLifecyclePhase, "running" | "closed"> }>;
};

export type RelayLifecycle = {
  isQuiescing(): boolean;
  onClose(hook: RelayLifecycleHook): () => void;
  onDrain(hook: RelayLifecycleHook): () => void;
  onQuiesce(hook: RelayLifecycleHook): () => void;
  phase(): RelayLifecyclePhase;
  shutdown(): Promise<RelayShutdownReport>;
};

export function createRelayLifecycle(input: { drainTimeoutMs?: number } = {}): RelayLifecycle {
  const drainTimeoutMs = input.drainTimeoutMs ?? 10_000;
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 0) {
    throw new TypeError("drainTimeoutMs must be a nonnegative integer.");
  }
  let currentPhase: RelayLifecyclePhase = "running";
  let shutdownPromise: Promise<RelayShutdownReport> | undefined;
  const hooks = {
    close: new Set<RelayLifecycleHook>(),
    drain: new Set<RelayLifecycleHook>(),
    quiesce: new Set<RelayLifecycleHook>(),
  };

  const register = (phase: keyof typeof hooks, hook: RelayLifecycleHook) => {
    hooks[phase].add(hook);
    return () => hooks[phase].delete(hook);
  };

  return {
    isQuiescing() {
      return currentPhase !== "running";
    },
    onClose(hook) {
      return register("close", hook);
    },
    onDrain(hook) {
      return register("drain", hook);
    },
    onQuiesce(hook) {
      return register("quiesce", hook);
    },
    phase() {
      return currentPhase;
    },
    shutdown() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      currentPhase = "quiescing";
      shutdownPromise = (async () => {
        const report: RelayShutdownReport = { drainTimedOut: false, errors: [] };
        await runHooks(hooks.quiesce, "quiescing", report);

        currentPhase = "draining";
        const drain = runHooks(hooks.drain, "draining", report);
        report.drainTimedOut = !(await settlesWithin(drain, drainTimeoutMs));

        currentPhase = "closing";
        await runHooks(hooks.close, "closing", report);
        currentPhase = "closed";
        return report;
      })();
      return shutdownPromise;
    },
  };
}

async function runHooks(
  hooks: Set<RelayLifecycleHook>,
  phase: "quiescing" | "draining" | "closing",
  report: RelayShutdownReport,
) {
  for (const hook of hooks) {
    try {
      await Promise.resolve().then(() => hook());
    } catch (error) {
      report.errors.push({ message: errorMessage(error), phase });
    }
  }
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number) {
  if (timeoutMs === 0) {
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
