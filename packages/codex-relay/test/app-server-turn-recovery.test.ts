import { describe, expect, it, vi } from "vitest";

import { recoverActiveAppServerTurnClaims } from "../src/app-server-turn-recovery.js";
import { createRelayStateStore } from "../src/relay-state-store.js";

const capabilities = {
  approve: true,
  configure: true,
  interrupt: true,
  queue: true,
  send: true,
  steer: true,
  view: true,
};

describe("app-server turn startup recovery", () => {
  it("adopts the exact running runtime turn without starting another turn", async () => {
    const store = await createRelayStateStore(":memory:");
    const claim = await createBoundClaim(store, "thread-running", "turn-running");
    const readThread = vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(
      async () => ({
        id: "thread-running",
        turns: [appServerTurn("turn-running", "running")],
      }),
    );
    const appServer = { readThread, startTurn: vi.fn<() => Promise<unknown>>() };

    const result = await recoverActiveAppServerTurnClaims({
      appServer: appServer as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toMatchObject({
      recovered: [
        {
          claim: {
            claimId: claim.claimId,
            ownerEpoch: 2,
            runtimeTurnId: "turn-running",
          },
          input: { state: "running" },
          owner: { epoch: 2, ownerInstanceId: "process-2" },
        },
      ],
      skipped: 0,
      terminal: 0,
    });
    expect(readThread).toHaveBeenCalledWith("thread-running", { includeTurns: true });
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-running")).toMatchObject({
      ownerEpoch: 2,
      runtimeTurnId: "turn-running",
    });
  });

  it("does not adopt a turn from another Relay while its owner lease is active", async () => {
    const store = await createRelayStateStore(":memory:");
    const claim = await createBoundClaim(store, "thread-live-owner", "turn-live-owner", {
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const startTurn = vi.fn<() => Promise<unknown>>();

    const result = await recoverActiveAppServerTurnClaims({
      appServer: {
        readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => ({
          id: "thread-live-owner",
          turns: [appServerTurn("turn-live-owner", "running")],
        })),
        startTurn,
      } as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-live-owner")).toMatchObject({
      claimId: claim.claimId,
      ownerEpoch: 1,
    });
    expect(await store.getThreadOwner("thread-live-owner")).toMatchObject({
      epoch: 1,
      ownerInstanceId: "process-1",
    });
  });

  it("finalizes an exact terminal runtime turn after adopting its claim", async () => {
    const store = await createRelayStateStore(":memory:");
    await createBoundClaim(store, "thread-terminal", "turn-terminal");
    const appServer = {
      readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => ({
        id: "thread-terminal",
        turns: [appServerTurn("turn-terminal", "completed")],
      })),
      startTurn: vi.fn<() => Promise<unknown>>(),
    };

    const result = await recoverActiveAppServerTurnClaims({
      appServer: appServer as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 0, terminal: 1 });
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-terminal")).toBeUndefined();
    expect(await store.listThreadInputs({ threadId: "thread-terminal" })).toMatchObject([
      { state: "completed" },
    ]);
  });

  it("leaves claims untouched when their exact runtime turn cannot be confirmed", async () => {
    const store = await createRelayStateStore(":memory:");
    await createBoundClaim(store, "thread-missing-turn", "turn-expected");
    const appServer = {
      readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => ({
        id: "thread-missing-turn",
        turns: [appServerTurn("turn-other", "running")],
      })),
      startTurn: vi.fn<() => Promise<unknown>>(),
    };

    const result = await recoverActiveAppServerTurnClaims({
      appServer: appServer as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-missing-turn")).toMatchObject({
      ownerEpoch: 1,
      runtimeTurnId: "turn-expected",
    });
  });

  it("leaves a claim without a persisted runtime turn untouched", async () => {
    const store = await createRelayStateStore(":memory:");
    const { acquired } = await createClaim(store, "thread-runtime-unknown");
    const readThread = vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>();
    const appServer = {
      readThread,
      startTurn: vi.fn<() => Promise<unknown>>(),
    };

    const result = await recoverActiveAppServerTurnClaims({
      appServer: appServer as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(readThread).not.toHaveBeenCalled();
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-runtime-unknown")).toMatchObject({
      claimId: acquired.claim.claimId,
      ownerEpoch: 1,
      runtimeTurnId: undefined,
    });
  });

  it("recovers the only authoritative turn started after durable dispatch", async () => {
    const store = await createRelayStateStore(":memory:");
    const { acquired, owner } = await createClaim(store, "thread-dispatched");
    const marked = await store.markTurnClaimDispatch({
      claimId: acquired.claim.claimId,
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
    });
    if (marked.kind !== "updated") {
      throw new Error("Expected dispatch to be marked.");
    }
    const dispatchStartedAtMs = Date.parse(marked.claim.dispatchStartedAt!);
    const readThread = vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(
      async () => ({
        id: "thread-dispatched",
        turns: [
          {
            ...appServerTurn("turn-before-dispatch", "completed"),
            startedAt: dispatchStartedAtMs / 1_000 - 10,
          },
          {
            ...appServerTurn("turn-after-dispatch", "running"),
            startedAt: dispatchStartedAtMs / 1_000,
          },
        ],
      }),
    );
    const startTurn = vi.fn<() => Promise<unknown>>();

    const result = await recoverActiveAppServerTurnClaims({
      appServer: { readThread, startTurn } as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toMatchObject({
      recovered: [
        {
          claim: { claimId: acquired.claim.claimId, runtimeTurnId: "turn-after-dispatch" },
          owner: { epoch: 2, ownerInstanceId: "process-2" },
        },
      ],
      skipped: 0,
      terminal: 0,
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("does not guess when multiple turns started after durable dispatch", async () => {
    const store = await createRelayStateStore(":memory:");
    const { acquired, owner } = await createClaim(store, "thread-ambiguous-dispatch");
    const marked = await store.markTurnClaimDispatch({
      claimId: acquired.claim.claimId,
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
    });
    if (marked.kind !== "updated") {
      throw new Error("Expected dispatch to be marked.");
    }
    const dispatchStartedAt = Date.parse(marked.claim.dispatchStartedAt!) / 1_000;
    const startTurn = vi.fn<() => Promise<unknown>>();

    const result = await recoverActiveAppServerTurnClaims({
      appServer: {
        readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => ({
          id: "thread-ambiguous-dispatch",
          turns: [
            { ...appServerTurn("turn-a", "running"), startedAt: dispatchStartedAt },
            { ...appServerTurn("turn-b", "running"), startedAt: dispatchStartedAt + 1 },
          ],
        })),
        startTurn,
      } as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-ambiguous-dispatch")).toMatchObject({
      claimId: acquired.claim.claimId,
      runtimeTurnId: undefined,
    });
  });

  it("does not bind a later external turn outside the dispatch window", async () => {
    const store = await createRelayStateStore(":memory:");
    const { acquired, owner } = await createClaim(store, "thread-late-external-turn");
    const marked = await store.markTurnClaimDispatch({
      claimId: acquired.claim.claimId,
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
    });
    if (marked.kind !== "updated") {
      throw new Error("Expected dispatch to be marked.");
    }
    const dispatchStartedAt = Date.parse(marked.claim.dispatchStartedAt!) / 1_000;
    const startTurn = vi.fn<() => Promise<unknown>>();

    const result = await recoverActiveAppServerTurnClaims({
      appServer: {
        readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => ({
          id: "thread-late-external-turn",
          turns: [
            { ...appServerTurn("external-turn", "running"), startedAt: dispatchStartedAt + 60 },
          ],
        })),
        startTurn,
      } as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-late-external-turn")).toMatchObject({
      runtimeTurnId: undefined,
    });
  });

  it("leaves a bound claim untouched when its authoritative thread read fails", async () => {
    const store = await createRelayStateStore(":memory:");
    const claim = await createBoundClaim(store, "thread-read-failed", "turn-read-failed");
    const appServer = {
      readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => {
        throw new Error("socket disconnected");
      }),
      startTurn: vi.fn<() => Promise<unknown>>(),
    };

    const result = await recoverActiveAppServerTurnClaims({
      appServer: appServer as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-read-failed")).toMatchObject({
      claimId: claim.claimId,
      ownerEpoch: 1,
      runtimeTurnId: "turn-read-failed",
    });
  });

  it("does not infer terminal state from a missing completion timestamp", async () => {
    const store = await createRelayStateStore(":memory:");
    const claim = await createBoundClaim(store, "thread-unknown-state", "turn-unknown-state");
    const appServer = {
      readThread: vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(async () => ({
        id: "thread-unknown-state",
        turns: [
          {
            id: "turn-unknown-state",
            items: [],
            startedAt: 1,
            status: "runtime-specific-active-state",
          },
        ],
      })),
      startTurn: vi.fn<() => Promise<unknown>>(),
    };

    const result = await recoverActiveAppServerTurnClaims({
      appServer: appServer as never,
      capabilities,
      coordinator: store,
      ownerId: "relay-1",
      ownerInstanceId: "process-2",
      ownerType: "shared_app_server",
    });

    expect(result).toEqual({ recovered: [], skipped: 1, terminal: 0 });
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(await store.getActiveTurnClaim("thread-unknown-state")).toMatchObject({
      claimId: claim.claimId,
      ownerEpoch: 1,
      runtimeTurnId: "turn-unknown-state",
    });
  });
});

async function createBoundClaim(
  store: Awaited<ReturnType<typeof createRelayStateStore>>,
  threadId: string,
  turnId: string,
  options: { leaseExpiresAt?: string } = {},
) {
  const { acquired, owner } = await createClaim(store, threadId, options);
  const bound = await store.bindTurnClaimRuntimeTurn({
    claimId: acquired.claim.claimId,
    ownerEpoch: owner.epoch,
    ownerId: owner.ownerId,
    runtimeTurnId: turnId,
  });
  if (bound.kind !== "updated") {
    throw new Error(`Expected ${threadId} to bind its runtime turn.`);
  }
  return bound.claim;
}

async function createClaim(
  store: Awaited<ReturnType<typeof createRelayStateStore>>,
  threadId: string,
  options: { leaseExpiresAt?: string } = {},
) {
  const owner = await store.acquireThreadOwner({
    capabilities,
    leaseExpiresAt: options.leaseExpiresAt,
    ownerId: "relay-1",
    ownerInstanceId: "process-1",
    ownerType: "shared_app_server",
    threadId,
  });
  const inputId = `input-${threadId}`;
  await store.createThreadInput({
    clientId: "client-1",
    inputId,
    payload: { prompt: threadId },
    state: "accepted",
    threadId,
  });
  const acquired = await store.acquireTurnClaim({
    inputId,
    ownerEpoch: owner.epoch,
    ownerId: owner.ownerId,
    threadId,
  });
  if (acquired.kind !== "acquired") {
    throw new Error(`Expected ${threadId} to acquire a claim.`);
  }
  return { acquired, owner };
}

function appServerTurn(id: string, status: "completed" | "running") {
  return {
    completedAt: status === "completed" ? 2 : null,
    id,
    items: [],
    startedAt: 1,
    status,
  };
}
