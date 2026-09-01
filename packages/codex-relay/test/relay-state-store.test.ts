import { createClient } from "@libsql/client/node";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { createRelayStateStore } from "../src/relay-state-store.js";

describe("relay state store", () => {
  it("persists aggregated content-safe compatibility observations", async () => {
    const store = await createRelayStateStore(":memory:");

    await store.recordCompatibilityObservation({
      feature: "legacy.run_stream_prompt",
      observedAt: "2026-08-31T00:00:00.000Z",
    });
    await store.recordCompatibilityObservation({
      feature: "legacy.run_stream_prompt",
      observedAt: "2026-08-31T00:01:00.000Z",
    });

    await expect(store.listCompatibilityObservations()).resolves.toEqual([
      {
        count: 2,
        feature: "legacy.run_stream_prompt",
        firstSeenAt: "2026-08-31T00:00:00.000Z",
        lastSeenAt: "2026-08-31T00:01:00.000Z",
      },
    ]);
    await expect(
      store.recordCompatibilityObservation({ feature: "prompt content is invalid" }),
    ).rejects.toThrow("Invalid compatibility feature");
  });

  it("keeps compatibility observations across store restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-compatibility-"));
    const databasePath = join(directory, "relay-state.db");
    try {
      const firstStore = await createRelayStateStore(databasePath);
      await firstStore.recordCompatibilityObservation({
        feature: "legacy.workspace_path_without_id",
        observedAt: "2026-08-31T00:00:00.000Z",
      });
      firstStore.close();

      const reopenedStore = await createRelayStateStore(databasePath);
      await expect(reopenedStore.listCompatibilityObservations()).resolves.toEqual([
        {
          count: 1,
          feature: "legacy.workspace_path_without_id",
          firstSeenAt: "2026-08-31T00:00:00.000Z",
          lastSeenAt: "2026-08-31T00:00:00.000Z",
        },
      ]);
      reopenedStore.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("allocates a monotonic sequence per thread", async () => {
    const store = await createRelayStateStore(":memory:");

    const [first, otherThread, second] = await Promise.all([
      store.appendThreadEvent({
        eventId: "event-a1",
        threadId: "thread-a",
        event: stateEvent("thread-a", "running"),
      }),
      store.appendThreadEvent({
        eventId: "event-b1",
        threadId: "thread-b",
        event: stateEvent("thread-b", "running"),
      }),
      store.appendThreadEvent({
        eventId: "event-a2",
        threadId: "thread-a",
        event: stateEvent("thread-a", "completed"),
      }),
    ]);

    expect([first.sequence, second.sequence].sort((left, right) => left - right)).toEqual([1, 2]);
    expect(otherThread.sequence).toBe(1);

    const page = await store.listThreadEvents({ threadId: "thread-a" });
    expect(page.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(page.hasMore).toBe(false);
    expect(page.lastSequence).toBe(2);
  });

  it("returns the original event when an event id is appended again", async () => {
    const store = await createRelayStateStore(":memory:");
    const input = {
      eventId: "same-event",
      threadId: "thread-1",
      event: stateEvent("thread-1", "running"),
    } as const;

    const first = await store.appendThreadEvent(input);
    const second = await store.appendThreadEvent(input);

    expect(second).toEqual(first);
    expect((await store.listThreadEvents({ threadId: "thread-1" })).events).toHaveLength(1);
  });

  it("rejects event ids reused by another thread", async () => {
    const store = await createRelayStateStore(":memory:");
    await store.appendThreadEvent({
      eventId: "same-event",
      threadId: "thread-1",
      event: stateEvent("thread-1", "running"),
    });

    await expect(
      store.appendThreadEvent({
        eventId: "same-event",
        threadId: "thread-2",
        event: stateEvent("thread-2", "running"),
      }),
    ).rejects.toThrow("already belongs to thread thread-1");
    expect((await store.listThreadEvents({ threadId: "thread-2" })).events).toEqual([]);
  });

  it("rejects payloads that identify another thread", async () => {
    const store = await createRelayStateStore(":memory:");

    await expect(
      store.appendThreadEvent({
        eventId: "mismatched-event",
        threadId: "thread-1",
        event: stateEvent("thread-2", "running"),
      }),
    ).rejects.toThrow("belongs to thread thread-2");
    expect((await store.listThreadEvents({ threadId: "thread-1" })).events).toEqual([]);
  });

  it("paginates strictly after the requested sequence", async () => {
    const store = await createRelayStateStore(":memory:");
    for (let index = 1; index <= 4; index += 1) {
      await store.appendThreadEvent({
        eventId: `event-${index}`,
        threadId: "thread-1",
        event: stateEvent("thread-1", index === 4 ? "completed" : "running"),
      });
    }

    const firstPage = await store.listThreadEvents({
      afterSequence: 1,
      limit: 2,
      threadId: "thread-1",
    });
    const secondPage = await store.listThreadEvents({
      afterSequence: firstPage.lastSequence,
      limit: 2,
      threadId: "thread-1",
    });

    expect(firstPage.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.lastSequence).toBe(3);
    expect(secondPage.events.map((event) => event.sequence)).toEqual([4]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.lastSequence).toBe(4);
  });

  it("requires a snapshot reset after compacted event history", async () => {
    const store = await createRelayStateStore(":memory:");
    for (let index = 1; index <= 4; index += 1) {
      await store.appendThreadEvent({
        eventId: `event-${index}`,
        threadId: "thread-1",
        event: stateEvent("thread-1", index === 4 ? "completed" : "running"),
      });
    }

    await expect(
      store.compactThreadEvents!({ threadId: "thread-1", throughSequence: 2 }),
    ).resolves.toEqual({
      compactedThroughSequence: 2,
      deletedCount: 2,
      lastSequence: 4,
    });
    await expect(
      store.listThreadEvents({ threadId: "thread-1", afterSequence: 0 }),
    ).resolves.toEqual({
      events: [],
      hasMore: false,
      lastSequence: 4,
      resetRequired: true,
    });
    await expect(
      store.listThreadEvents({ threadId: "thread-1", afterSequence: 2 }),
    ).resolves.toMatchObject({
      events: [{ sequence: 3 }, { sequence: 4 }],
      hasMore: false,
      lastSequence: 4,
      resetRequired: false,
    });
  });

  it("reopens a file database without losing events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-state-"));
    const path = join(directory, "state with # hash.db");

    try {
      const firstStore = await createRelayStateStore(path);
      await firstStore.appendThreadEvent({
        eventId: "persisted-event",
        threadId: "thread-1",
        event: stateEvent("thread-1", "completed"),
      });

      const reopenedStore = await createRelayStateStore(path);
      const page = await reopenedStore.listThreadEvents({ threadId: "thread-1" });

      expect(page.events).toMatchObject([
        {
          eventId: "persisted-event",
          sequence: 1,
          threadId: "thread-1",
          event: { type: "thread.state.changed" },
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("persists thread inputs and deduplicates client events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-input-state-"));
    const path = join(directory, "relay-state.db");

    try {
      const store = await createRelayStateStore(path);
      const first = await store.createThreadInput({
        clientEventId: "73b758a3-afcb-4c3f-af99-0b982097f6ea",
        clientId: "client-a",
        inputId: "input-a",
        payload: { prompt: "Run once" },
        result: { acceptedAs: "queued", inputId: "input-a" },
        state: "queued",
        threadId: "thread-a",
        workspaceId: "workspace-a",
      });
      const duplicate = await store.createThreadInput({
        clientEventId: "73b758a3-afcb-4c3f-af99-0b982097f6ea",
        clientId: "client-a",
        inputId: "input-duplicate",
        payload: { prompt: "Must not replace the original" },
        result: { acceptedAs: "queued", inputId: "input-duplicate" },
        state: "queued",
        threadId: "thread-a",
      });
      const otherClient = await store.createThreadInput({
        clientEventId: "73b758a3-afcb-4c3f-af99-0b982097f6ea",
        clientId: "client-b",
        inputId: "input-b",
        payload: { prompt: "Another client" },
        state: "queued",
        threadId: "thread-a",
      });
      const legacyFirst = await store.createThreadInput({
        clientId: "legacy",
        inputId: "input-legacy-a",
        payload: { prompt: "Legacy request" },
        state: "queued",
        threadId: "thread-a",
      });
      const legacySecond = await store.createThreadInput({
        clientId: "legacy",
        inputId: "input-legacy-b",
        payload: { prompt: "Legacy request" },
        state: "queued",
        threadId: "thread-a",
      });

      expect(first.created).toBe(true);
      expect(duplicate).toEqual({ created: false, input: first.input });
      expect(otherClient.created).toBe(true);
      expect(legacyFirst.created).toBe(true);
      expect(legacySecond.created).toBe(true);

      const reopenedStore = await createRelayStateStore(path);
      const queued = await reopenedStore.listThreadInputs({
        states: ["queued"],
        threadId: "thread-a",
      });

      expect(queued.map((input) => input.inputId)).toEqual([
        "input-a",
        "input-b",
        "input-legacy-a",
        "input-legacy-b",
      ]);
      expect(queued[0]).toMatchObject({
        clientEventId: "73b758a3-afcb-4c3f-af99-0b982097f6ea",
        payload: { prompt: "Run once" },
        result: { acceptedAs: "queued", inputId: "input-a" },
        workspaceId: "workspace-a",
      });
      await reopenedStore.updateThreadInputState("input-a", "running");
      expect(
        await reopenedStore.getThreadInputByClientEvent(
          "client-a",
          "73b758a3-afcb-4c3f-af99-0b982097f6ea",
        ),
      ).toMatchObject({ inputId: "input-a", state: "running" });
      expect(
        await reopenedStore.listThreadInputs({ states: ["queued"], threadId: "thread-a" }),
      ).toHaveLength(3);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts ten concurrent retries as one durable input", async () => {
    const store = await createRelayStateStore(":memory:");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.createThreadInput({
          clientEventId: "2ef23af2-1c7b-4c77-9961-bf560346b31e",
          clientId: "retry-client",
          inputId: `retry-input-${index}`,
          payload: { prompt: "Run exactly once" },
          state: "queued",
          threadId: "retry-thread",
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.input.inputId))).toHaveLength(1);
    await expect(store.listThreadInputs({ threadId: "retry-thread" })).resolves.toHaveLength(1);
  });

  it("guards turn claims with owner epochs and durable cancellation tombstones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-claims-"));
    const path = join(directory, "relay-state.db");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };

    try {
      const store = await createRelayStateStore(path);
      for (const [inputId, createdAt] of [
        ["input-1", "2026-08-26T00:00:01.000Z"],
        ["input-2", "2026-08-26T00:00:02.000Z"],
      ] as const) {
        await store.createThreadInput({
          clientId: "client-a",
          createdAt,
          inputId,
          payload: { id: inputId, prompt: inputId },
          state: "queued",
          threadId: "thread-1",
        });
      }

      const firstOwner = await store.acquireThreadOwner({
        capabilities,
        ownerId: "relay-1",
        ownerInstanceId: "process-1",
        ownerType: "relay_app_server",
        threadId: "thread-1",
      });
      const sameOwner = await store.acquireThreadOwner({
        capabilities,
        ownerId: "relay-1",
        ownerInstanceId: "process-1",
        ownerType: "relay_app_server",
        threadId: "thread-1",
      });
      expect(firstOwner.epoch).toBe(1);
      expect(sameOwner.epoch).toBe(1);

      const [firstClaim, competingClaim] = await Promise.all([
        store.acquireTurnClaim({
          inputId: "input-1",
          ownerEpoch: firstOwner.epoch,
          ownerId: firstOwner.ownerId,
          threadId: "thread-1",
        }),
        store.acquireTurnClaim({
          inputId: "input-2",
          ownerEpoch: firstOwner.epoch,
          ownerId: firstOwner.ownerId,
          threadId: "thread-1",
        }),
      ]);
      expect(firstClaim.kind).toBe("acquired");
      expect(competingClaim.kind).toBe("busy");
      if (firstClaim.kind !== "acquired") {
        throw new Error("Expected the first input to acquire the claim.");
      }

      const replacementOwner = await store.acquireThreadOwner({
        capabilities,
        ownerId: "relay-1",
        ownerInstanceId: "process-2",
        ownerType: "relay_app_server",
        threadId: "thread-1",
      });
      expect(replacementOwner.epoch).toBe(2);
      expect(await store.getActiveTurnClaim("thread-1")).toBeUndefined();
      expect(
        await store.finalizeTurnClaim({
          claimId: firstClaim.claim.claimId,
          ownerEpoch: firstOwner.epoch,
          ownerId: firstOwner.ownerId,
          state: "completed",
        }),
      ).toMatchObject({ kind: "stale_owner" });
      expect(
        (await store.listThreadInputs({ threadId: "thread-1" })).find(
          (input) => input.inputId === "input-1",
        ),
      ).toMatchObject({ state: "failed" });

      const nextClaim = await store.claimNextThreadInput({
        ownerEpoch: replacementOwner.epoch,
        ownerId: replacementOwner.ownerId,
        threadId: "thread-1",
      });
      expect(nextClaim).toMatchObject({ kind: "acquired", input: { inputId: "input-2" } });
      if (nextClaim.kind !== "acquired") {
        throw new Error("Expected the replacement owner to claim the next input.");
      }
      expect(
        await store.finalizeTurnClaim({
          claimId: nextClaim.claim.claimId,
          ownerEpoch: firstOwner.epoch,
          ownerId: firstOwner.ownerId,
          state: "completed",
        }),
      ).toMatchObject({ kind: "stale_owner" });
      expect(
        await store.finalizeTurnClaim({
          claimId: nextClaim.claim.claimId,
          ownerEpoch: replacementOwner.epoch,
          ownerId: replacementOwner.ownerId,
          state: "completed",
        }),
      ).toMatchObject({ kind: "updated", claim: { state: "completed" } });
      expect(
        await store.finalizeTurnClaim({
          claimId: nextClaim.claim.claimId,
          ownerEpoch: replacementOwner.epoch,
          ownerId: replacementOwner.ownerId,
          state: "failed",
        }),
      ).toMatchObject({ kind: "already_terminal", claim: { state: "completed" } });

      const reopenedStore = await createRelayStateStore(path);
      expect(await reopenedStore.getThreadOwner("thread-1")).toMatchObject({
        epoch: 2,
        ownerInstanceId: "process-2",
      });
      expect(await reopenedStore.getActiveTurnClaim("thread-1")).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not replace an owner while its lease is active, then permits takeover after expiry", async () => {
    const store = await createRelayStateStore(":memory:");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };
    const activeLease = new Date(Date.now() + 60_000).toISOString();
    const first = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: activeLease,
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
      ownerType: "relay_app_server",
      threadId: "thread-lease",
    });
    const blocked = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: "relay-b",
      ownerInstanceId: "process-b",
      ownerType: "relay_app_server",
      threadId: "thread-lease",
    });

    expect(blocked).toMatchObject({
      epoch: first.epoch,
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
    });

    const expiredOwner = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
      ownerType: "relay_app_server",
      threadId: "thread-expired-lease",
    });
    const replacement = await store.acquireThreadOwner({
      capabilities,
      ownerId: "relay-b",
      ownerInstanceId: "process-b",
      ownerType: "relay_app_server",
      threadId: "thread-expired-lease",
    });

    expect(replacement).toMatchObject({
      epoch: expiredOwner.epoch + 1,
      ownerId: "relay-b",
      ownerInstanceId: "process-b",
    });
  });

  it("renews a lease for the same owner generation without changing its epoch", async () => {
    const store = await createRelayStateStore(":memory:");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };
    const first = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: new Date(Date.now() + 1_000).toISOString(),
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
      ownerType: "relay_app_server",
      threadId: "thread-renewal",
    });
    const renewedLease = new Date(Date.now() + 60_000).toISOString();
    const renewed = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: renewedLease,
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
      ownerType: "relay_app_server",
      threadId: "thread-renewal",
    });

    expect(renewed).toMatchObject({
      epoch: first.epoch,
      leaseExpiresAt: renewedLease,
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
    });
  });

  it("repairs only expired owner leases and cancels their stale claims", async () => {
    const store = await createRelayStateStore(":memory:");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };
    const owner = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      ownerId: "relay-expired",
      ownerInstanceId: "process-expired",
      ownerType: "relay_app_server",
      threadId: "thread-owner-repair",
    });
    await store.createThreadInput({
      clientId: "client-a",
      inputId: "input-owner-repair",
      payload: { prompt: "repair" },
      state: "accepted",
      threadId: "thread-owner-repair",
    });
    const claim = await store.acquireTurnClaim({
      inputId: "input-owner-repair",
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
      threadId: "thread-owner-repair",
    });
    if (claim.kind !== "acquired") {
      throw new Error("Expected a stale claim to repair.");
    }

    await expect(
      store.repairExpiredThreadOwner({ threadId: "thread-owner-repair" }),
    ).resolves.toMatchObject({
      cancelledClaimCount: 1,
      kind: "repaired",
    });
    await expect(store.getThreadOwner("thread-owner-repair")).resolves.toBeUndefined();
    await expect(store.getActiveTurnClaim("thread-owner-repair")).resolves.toBeUndefined();
    await expect(
      store.listThreadInputs({ threadId: "thread-owner-repair" }),
    ).resolves.toMatchObject([{ inputId: "input-owner-repair", state: "failed" }]);

    const liveOwner = await store.acquireThreadOwner({
      capabilities,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerId: "relay-live",
      ownerInstanceId: "process-live",
      ownerType: "relay_app_server",
      threadId: "thread-live-owner",
    });
    await expect(
      store.repairExpiredThreadOwner({ threadId: "thread-live-owner" }),
    ).resolves.toEqual({
      kind: "not_expired",
      owner: liveOwner,
    });
  });

  it("persists the dispatch boundary before a runtime turn is bound", async () => {
    const store = await createRelayStateStore(":memory:");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };
    const owner = await store.acquireThreadOwner({
      capabilities,
      ownerId: "relay-a",
      ownerInstanceId: "process-a",
      ownerType: "relay_app_server",
      threadId: "thread-dispatch",
    });
    await store.createThreadInput({
      clientId: "client-a",
      inputId: "input-dispatch",
      payload: { prompt: "dispatch once" },
      state: "accepted",
      threadId: "thread-dispatch",
    });
    const acquired = await store.acquireTurnClaim({
      inputId: "input-dispatch",
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
      threadId: "thread-dispatch",
    });
    if (acquired.kind !== "acquired") {
      throw new Error("Expected a turn claim.");
    }

    const marked = await store.markTurnClaimDispatch({
      claimId: acquired.claim.claimId,
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
    });

    expect(marked).toMatchObject({
      claim: {
        claimId: acquired.claim.claimId,
        dispatchStartedAt: expect.any(String),
        runtimeTurnId: undefined,
      },
      kind: "updated",
    });
    expect(await store.getActiveTurnClaim("thread-dispatch")).toMatchObject({
      dispatchStartedAt: marked.kind === "updated" ? marked.claim.dispatchStartedAt : undefined,
      runtimeTurnId: undefined,
    });
  });

  it("persists pending approvals until their app-server request is resolved", async () => {
    const store = await createRelayStateStore(":memory:");
    const created = await store.createPendingApproval({
      approvalId: "approval-17",
      kind: "structuredUserInput",
      method: "item/tool/requestUserInput",
      questions: [{ id: "scope", question: "Continue?" }],
      requestId: 17,
      threadId: "thread-approval",
      turnId: "turn-approval",
    });

    expect(created).toMatchObject({
      approvalId: "approval-17",
      questions: [{ id: "scope", question: "Continue?" }],
      requestId: 17,
    });
    await expect(store.listPendingApprovals()).resolves.toMatchObject([
      { approvalId: "approval-17", turnId: "turn-approval" },
    ]);
    await expect(store.resolvePendingApproval("approval-17")).resolves.toBe(true);
    await expect(store.resolvePendingApproval("approval-17")).resolves.toBe(false);
    await expect(store.listPendingApprovals()).resolves.toEqual([]);
  });

  it("persists one app-server turn identity for each active claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-runtime-turn-"));
    const path = join(directory, "relay-state.db");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };

    try {
      const store = await createRelayStateStore(path);
      const owner = await store.acquireThreadOwner({
        capabilities,
        ownerId: "relay-1",
        ownerInstanceId: "process-1",
        ownerType: "shared_app_server",
        threadId: "thread-runtime",
      });
      await store.createThreadInput({
        clientId: "client-a",
        inputId: "input-runtime",
        payload: { prompt: "persist runtime identity" },
        state: "accepted",
        threadId: "thread-runtime",
      });
      const acquired = await store.acquireTurnClaim({
        inputId: "input-runtime",
        ownerEpoch: owner.epoch,
        ownerId: owner.ownerId,
        threadId: "thread-runtime",
      });
      if (acquired.kind !== "acquired") {
        throw new Error("Expected the runtime input to acquire a claim.");
      }
      expect(
        await store.adoptActiveTurnClaim({
          capabilities,
          claimId: acquired.claim.claimId,
          ownerId: "relay-1",
          ownerInstanceId: "process-2",
          ownerType: "shared_app_server",
          runtimeTurnId: "turn-runtime-1",
          threadId: "thread-runtime",
        }),
      ).toEqual({ kind: "runtime_unknown" });

      expect(
        await store.bindTurnClaimRuntimeTurn({
          claimId: acquired.claim.claimId,
          ownerEpoch: owner.epoch,
          ownerId: owner.ownerId,
          runtimeTurnId: "turn-runtime-1",
        }),
      ).toMatchObject({
        claim: { runtimeTurnId: "turn-runtime-1" },
        kind: "updated",
      });
      expect(
        await store.bindTurnClaimRuntimeTurn({
          claimId: acquired.claim.claimId,
          ownerEpoch: owner.epoch,
          ownerId: owner.ownerId,
          runtimeTurnId: "turn-runtime-1",
        }),
      ).toMatchObject({ kind: "already_bound" });
      expect(
        await store.bindTurnClaimRuntimeTurn({
          claimId: acquired.claim.claimId,
          ownerEpoch: owner.epoch,
          ownerId: owner.ownerId,
          runtimeTurnId: "turn-runtime-conflict",
        }),
      ).toMatchObject({
        claim: { runtimeTurnId: "turn-runtime-1" },
        kind: "conflict",
      });
      expect(
        await store.adoptActiveTurnClaim({
          capabilities,
          claimId: acquired.claim.claimId,
          ownerId: "relay-1",
          ownerInstanceId: "process-2",
          ownerType: "shared_app_server",
          runtimeTurnId: "turn-runtime-conflict",
          threadId: "thread-runtime",
        }),
      ).toEqual({ kind: "runtime_mismatch" });
      expect(
        await store.adoptActiveTurnClaim({
          capabilities,
          claimId: acquired.claim.claimId,
          ownerId: "relay-1",
          ownerInstanceId: "process-2",
          ownerType: "shared_app_server",
          runtimeTurnId: "turn-runtime-1",
          threadId: "thread-other",
        }),
      ).toEqual({ kind: "stale_claim" });

      const reopenedStore = await createRelayStateStore(path);
      expect(await reopenedStore.listActiveTurnClaims()).toMatchObject([
        {
          claimId: acquired.claim.claimId,
          inputId: "input-runtime",
          runtimeTurnId: "turn-runtime-1",
          threadId: "thread-runtime",
        },
      ]);
      const adopted = await reopenedStore.adoptActiveTurnClaim({
        capabilities,
        claimId: acquired.claim.claimId,
        ownerId: "relay-1",
        ownerInstanceId: "process-2",
        ownerType: "shared_app_server",
        runtimeTurnId: "turn-runtime-1",
        threadId: "thread-runtime",
      });
      expect(adopted).toMatchObject({
        claim: {
          ownerEpoch: 2,
          ownerId: "relay-1",
          runtimeTurnId: "turn-runtime-1",
          state: "active",
        },
        input: { inputId: "input-runtime", state: "running" },
        kind: "adopted",
        owner: { epoch: 2, ownerInstanceId: "process-2" },
      });
      expect(
        await reopenedStore.bindTurnClaimRuntimeTurn({
          claimId: acquired.claim.claimId,
          ownerEpoch: owner.epoch,
          ownerId: owner.ownerId,
          runtimeTurnId: "turn-runtime-1",
        }),
      ).toMatchObject({ kind: "stale_owner" });
      expect(
        await reopenedStore.finalizeTurnClaim({
          claimId: acquired.claim.claimId,
          ownerEpoch: owner.epoch,
          ownerId: owner.ownerId,
          state: "completed",
        }),
      ).toMatchObject({ kind: "stale_owner" });
      expect(await reopenedStore.listActiveTurnClaims()).toMatchObject([
        { claimId: acquired.claim.claimId, ownerEpoch: 2, runtimeTurnId: "turn-runtime-1" },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("claims queued inputs in FIFO order without duplicate active claims", async () => {
    const store = await createRelayStateStore(":memory:");
    const owner = await store.acquireThreadOwner({
      capabilities: {
        approve: false,
        configure: false,
        interrupt: true,
        queue: true,
        send: true,
        steer: false,
        view: true,
      },
      ownerId: "relay-1",
      ownerInstanceId: "process-1",
      ownerType: "shared_app_server",
      threadId: "thread-fifo",
    });
    await store.createThreadInput({
      clientId: "client-a",
      createdAt: "2026-08-26T00:00:01.000Z",
      inputId: "fifo-1",
      payload: { prompt: "first" },
      state: "queued",
      threadId: "thread-fifo",
    });
    await store.createThreadInput({
      clientId: "client-a",
      createdAt: "2026-08-26T00:00:02.000Z",
      inputId: "fifo-2",
      payload: { prompt: "second" },
      state: "queued",
      threadId: "thread-fifo",
    });

    const first = await store.claimNextThreadInput({
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
      threadId: "thread-fifo",
    });
    expect(first).toMatchObject({ kind: "acquired", input: { inputId: "fifo-1" } });
    expect(
      await store.claimNextThreadInput({
        ownerEpoch: owner.epoch,
        ownerId: owner.ownerId,
        threadId: "thread-fifo",
      }),
    ).toMatchObject({ kind: "busy" });
    if (first.kind !== "acquired") {
      throw new Error("Expected the first FIFO claim to be acquired.");
    }
    await store.finalizeTurnClaim({
      claimId: first.claim.claimId,
      ownerEpoch: owner.epoch,
      ownerId: owner.ownerId,
      state: "completed",
    });
    expect(
      await store.claimNextThreadInput({
        ownerEpoch: owner.epoch,
        ownerId: owner.ownerId,
        threadId: "thread-fifo",
      }),
    ).toMatchObject({ kind: "acquired", input: { inputId: "fifo-2" } });
  });

  it("remaps an active claim and input to a recovered thread atomically", async () => {
    const store = await createRelayStateStore(":memory:");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };
    const previousOwner = await store.acquireThreadOwner({
      capabilities,
      ownerId: "relay-1",
      ownerInstanceId: "process-1",
      ownerType: "relay_app_server",
      threadId: "thread-missing",
    });
    await store.createThreadInput({
      clientEventId: "3b361f08-582c-4eb5-83ac-10bc8b4c26e9",
      clientId: "mobile-client",
      inputId: "input-recovered",
      payload: { prompt: "recover this turn" },
      state: "accepted",
      threadId: "thread-missing",
    });
    const acquired = await store.acquireTurnClaim({
      inputId: "input-recovered",
      ownerEpoch: previousOwner.epoch,
      ownerId: previousOwner.ownerId,
      threadId: "thread-missing",
    });
    if (acquired.kind !== "acquired") {
      throw new Error("Expected the missing thread input to be claimed.");
    }
    const recoveredOwner = await store.acquireThreadOwner({
      capabilities,
      ownerId: "relay-1",
      ownerInstanceId: "process-1",
      ownerType: "relay_app_server",
      threadId: "thread-recovered",
      workspaceId: "workspace-recovered",
    });

    const remapped = await store.remapActiveTurnClaim({
      claimId: acquired.claim.claimId,
      fromOwnerEpoch: previousOwner.epoch,
      fromOwnerId: previousOwner.ownerId,
      ownerEpoch: recoveredOwner.epoch,
      ownerId: recoveredOwner.ownerId,
      threadId: "thread-recovered",
      workspaceId: "workspace-recovered",
    });

    expect(remapped).toMatchObject({
      claim: {
        ownerEpoch: recoveredOwner.epoch,
        ownerId: recoveredOwner.ownerId,
        threadId: "thread-recovered",
      },
      input: {
        inputId: "input-recovered",
        threadId: "thread-recovered",
        workspaceId: "workspace-recovered",
      },
      kind: "updated",
    });
    expect(await store.getActiveTurnClaim("thread-missing")).toBeUndefined();
    expect(await store.getActiveTurnClaim("thread-recovered")).toMatchObject({
      claimId: acquired.claim.claimId,
    });
    expect(
      await store.finalizeTurnClaim({
        claimId: acquired.claim.claimId,
        ownerEpoch: recoveredOwner.epoch,
        ownerId: recoveredOwner.ownerId,
        state: "completed",
      }),
    ).toMatchObject({
      input: { state: "completed", threadId: "thread-recovered" },
      kind: "updated",
    });
  });

  it("migrates a v1 event database without losing durable replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-v1-state-"));
    const databasePath = join(directory, "relay-state.db");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const legacyEvent = stateEvent("legacy-thread", "completed");
    const client = createClient({
      intMode: "number",
      url: pathToFileURL(databasePath).href,
    });

    try {
      await client.executeMultiple(`
        CREATE TABLE relay_state_schema (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE thread_event_sequences (
          thread_id TEXT PRIMARY KEY,
          next_sequence INTEGER NOT NULL
        );
        CREATE TABLE thread_events (
          event_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          workspace_id TEXT,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(thread_id, sequence)
        );
      `);
      await client.batch(
        [
          {
            sql: "INSERT INTO relay_state_schema (version, applied_at) VALUES (1, ?)",
            args: [Date.parse("2026-08-26T00:00:00.000Z")],
          },
          {
            sql: "INSERT INTO thread_event_sequences (thread_id, next_sequence) VALUES (?, 2)",
            args: ["legacy-thread"],
          },
          {
            sql: `INSERT INTO thread_events (
                    event_id, thread_id, workspace_id, sequence, event_type, payload_json, created_at
                  ) VALUES (?, ?, NULL, 1, ?, ?, ?)`,
            args: [
              "legacy-event",
              "legacy-thread",
              legacyEvent.type,
              JSON.stringify(legacyEvent),
              Date.parse("2026-08-26T00:00:00.000Z"),
            ],
          },
        ],
        "write",
      );
      client.close();

      const store = await createRelayStateStore(databasePath);
      const replay = await store.listThreadEvents({ threadId: "legacy-thread" });
      const workspace = await store.registerWorkspace({
        path: workspacePath,
        source: "relay_startup",
      });
      const reopenedStore = await createRelayStateStore(databasePath);

      expect(replay.events).toMatchObject([
        { eventId: "legacy-event", sequence: 1, threadId: "legacy-thread" },
      ]);
      expect((await reopenedStore.resolveWorkspace(workspacePath))?.workspaceId).toBe(
        workspace.workspaceId,
      );
      expect((await reopenedStore.listThreadEvents({ threadId: "legacy-thread" })).events).toEqual(
        replay.events,
      );
    } finally {
      client.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("migrates v4 turn claims through runtime and dispatch identity schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-v4-state-"));
    const databasePath = join(directory, "relay-state.db");
    const client = createClient({
      intMode: "number",
      url: pathToFileURL(databasePath).href,
    });

    try {
      await client.executeMultiple(`
        CREATE TABLE relay_state_schema (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE thread_inputs (
          input_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          client_event_id TEXT,
          thread_id TEXT NOT NULL,
          workspace_id TEXT,
          payload_json TEXT NOT NULL,
          result_json TEXT,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(client_id, client_event_id)
        );
        CREATE TABLE thread_owners (
          thread_id TEXT PRIMARY KEY,
          workspace_id TEXT,
          owner_id TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          lease_expires_at INTEGER,
          capabilities_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE turn_claims (
          claim_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          input_id TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          owner_epoch INTEGER NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          terminal_at INTEGER,
          FOREIGN KEY(input_id) REFERENCES thread_inputs(input_id)
        );
      `);
      const now = Date.parse("2026-08-26T00:00:00.000Z");
      await client.batch(
        [
          {
            sql: "INSERT INTO relay_state_schema (version, applied_at) VALUES (4, ?)",
            args: [now],
          },
          {
            sql: `INSERT INTO thread_inputs
                    (input_id, client_id, thread_id, payload_json, state, created_at, updated_at)
                  VALUES ('input-v4', 'client-v4', 'thread-v4', '{}', 'running', ?, ?)`,
            args: [now, now],
          },
          {
            sql: `INSERT INTO thread_owners
                    (thread_id, owner_id, owner_instance_id, owner_type, epoch,
                     capabilities_json, updated_at)
                  VALUES ('thread-v4', 'relay-v4', 'process-v4', 'shared_app_server', 1, ?, ?)`,
            args: [
              JSON.stringify({
                approve: true,
                configure: true,
                interrupt: true,
                queue: true,
                send: true,
                steer: true,
                view: true,
              }),
              now,
            ],
          },
          {
            sql: `INSERT INTO turn_claims
                    (claim_id, thread_id, input_id, owner_id, owner_epoch, state,
                     created_at, updated_at)
                  VALUES ('claim-v4', 'thread-v4', 'input-v4', 'relay-v4', 1,
                          'active', ?, ?)`,
            args: [now, now],
          },
        ],
        "write",
      );
      client.close();

      const store = await createRelayStateStore(databasePath);
      expect(await store.listActiveTurnClaims()).toMatchObject([
        { claimId: "claim-v4", runtimeTurnId: undefined },
      ]);
      expect(
        await store.bindTurnClaimRuntimeTurn({
          claimId: "claim-v4",
          ownerEpoch: 1,
          ownerId: "relay-v4",
          runtimeTurnId: "turn-v5",
        }),
      ).toMatchObject({
        claim: { runtimeTurnId: "turn-v5" },
        kind: "updated",
      });
      const migratedClient = createClient({
        intMode: "number",
        url: pathToFileURL(databasePath).href,
      });
      const versions = await migratedClient
        .execute("SELECT version FROM relay_state_schema ORDER BY version")
        .then((result) => result.rows.map((row) => Number(row.version)));
      migratedClient.close();
      expect(versions).toEqual([4, 9]);
    } finally {
      client.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("migrates v7 pending approvals before reading message payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-v7-approvals-"));
    const databasePath = join(directory, "relay-state.db");
    const client = createClient({
      intMode: "number",
      url: pathToFileURL(databasePath).href,
    });
    const now = Date.now();

    try {
      await client.batch(
        [
          {
            sql: `CREATE TABLE relay_state_schema (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                  )`,
            args: [],
          },
          {
            sql: "INSERT INTO relay_state_schema (version, applied_at) VALUES (7, ?)",
            args: [now],
          },
          {
            sql: `CREATE TABLE pending_approvals (
                    approval_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    turn_id TEXT,
                    request_id INTEGER NOT NULL,
                    method TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    message_id TEXT,
                    questions_json TEXT,
                    state TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                  )`,
            args: [],
          },
          {
            sql: `INSERT INTO pending_approvals (
                    approval_id, thread_id, turn_id, request_id, method, kind,
                    message_id, questions_json, state, created_at, updated_at
                  ) VALUES ('approval-v7', 'thread-v7', 'turn-v7', 7,
                    'item/tool/requestUserInput', 'structuredUserInput', NULL,
                    '[{"id":"scope","question":"Continue?"}]', 'pending', ?, ?)`,
            args: [now, now],
          },
        ],
        "write",
      );
      client.close();

      const store = await createRelayStateStore(databasePath);
      await expect(store.listPendingApprovals()).resolves.toMatchObject([
        {
          approvalId: "approval-v7",
          message: undefined,
          questions: [{ id: "scope", question: "Continue?" }],
        },
      ]);
    } finally {
      client.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps a stable workspace identity across registration and database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-workspaces-"));
    const databasePath = join(directory, "relay-state.db");
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const canonicalWorkspacePath = await realpath(workspacePath);

    try {
      const firstStore = await createRelayStateStore(databasePath);
      const first = await firstStore.registerWorkspace({
        path: workspacePath,
        source: "relay_startup",
      });
      const repeated = await firstStore.registerWorkspace({
        path: workspacePath,
        source: "thread_cwd",
      });
      const reopenedStore = await createRelayStateStore(databasePath);
      const reopened = await reopenedStore.resolveWorkspace(workspacePath);
      const reopenedById = await reopenedStore.resolveWorkspaceById(first.workspaceId);

      expect(first.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(repeated.workspaceId).toBe(first.workspaceId);
      expect(reopened?.workspaceId).toBe(first.workspaceId);
      expect(reopenedById).toEqual(reopened);
      expect(reopened).toMatchObject({
        canonicalPath: canonicalWorkspacePath,
        displayName: "workspace",
        state: "available",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("serializes concurrent file-backed event and workspace writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-concurrent-state-"));
    const databasePath = join(directory, "relay-state.db");
    const workspacePaths = Array.from({ length: 12 }, (_, index) =>
      join(directory, `workspace-${index}`),
    );
    await Promise.all(workspacePaths.map((path) => mkdir(path)));

    try {
      const store = await createRelayStateStore(databasePath);
      await Promise.all([
        ...Array.from({ length: 30 }, (_, index) =>
          store.appendThreadEvent({
            eventId: `concurrent-event-${index}`,
            threadId: "concurrent-thread",
            event: stateEvent("concurrent-thread", index === 29 ? "completed" : "running"),
          }),
        ),
        ...workspacePaths.map((path) => store.registerWorkspace({ path, source: "thread_cwd" })),
      ]);

      const events = await store.listThreadEvents({ threadId: "concurrent-thread" });
      expect(events.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 30 }, (_, index) => index + 1),
      );
      expect(await store.listWorkspaces()).toHaveLength(workspacePaths.length);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("maps a symlink and its real path to one workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-workspace-alias-"));
    const workspacePath = join(directory, "workspace");
    const aliasPath = join(directory, "workspace-link");
    await mkdir(workspacePath);
    await symlink(workspacePath, aliasPath, "dir");
    const canonicalWorkspacePath = await realpath(workspacePath);

    try {
      const store = await createRelayStateStore(":memory:");
      const fromAlias = await store.registerWorkspace({
        path: aliasPath,
        source: "thread_cwd",
      });
      const fromRealPath = await store.registerWorkspace({
        path: workspacePath,
        source: "relay_startup",
      });

      expect(fromAlias.workspaceId).toBe(fromRealPath.workspaceId);
      expect(fromAlias.canonicalPath).toBe(canonicalWorkspacePath);
      expect((await store.resolveWorkspace(aliasPath))?.workspaceId).toBe(fromRealPath.workspaceId);
      expect((await store.resolveWorkspace(workspacePath))?.workspaceId).toBe(
        fromRealPath.workspaceId,
      );
      expect(await store.listWorkspaces()).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("records missing workspaces and rejects relative paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-missing-workspace-"));
    const missingPath = join(directory, "missing");

    try {
      const store = await createRelayStateStore(":memory:");
      const workspace = await store.registerWorkspace({
        path: missingPath,
        source: "operator",
      });

      expect(workspace).toMatchObject({
        canonicalPath: missingPath,
        displayName: "missing",
        state: "missing",
      });
      await expect(
        store.registerWorkspace({ path: "relative/workspace", source: "operator" }),
      ).rejects.toThrow("absolute path");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps different clones separate even when repository identity matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-clones-"));
    const firstPath = join(directory, "clone-a");
    const secondPath = join(directory, "clone-b");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    const canonicalPaths = await Promise.all([realpath(firstPath), realpath(secondPath)]);

    try {
      const store = await createRelayStateStore(":memory:");
      const first = await store.registerWorkspace({
        path: firstPath,
        repositoryIdentity: "git@example.com:owner/repository.git",
        source: "operator",
      });
      const second = await store.registerWorkspace({
        path: secondPath,
        repositoryIdentity: "git@example.com:owner/repository.git",
        source: "operator",
      });

      expect(second.workspaceId).not.toBe(first.workspaceId);
      expect((await store.listWorkspaces()).map((workspace) => workspace.canonicalPath)).toEqual(
        canonicalPaths,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("adds trusted aliases without changing the workspace identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-explicit-alias-"));
    const workspacePath = join(directory, "workspace");
    const oldPath = join(directory, "previous-location");
    await mkdir(workspacePath);

    try {
      const store = await createRelayStateStore(":memory:");
      const workspace = await store.registerWorkspace({
        path: workspacePath,
        source: "relay_startup",
      });
      await store.addWorkspaceAlias({
        path: oldPath,
        source: "operator",
        workspaceId: workspace.workspaceId,
      });
      const registeredFromMissingAlias = await store.registerWorkspace({
        path: oldPath,
        source: "thread_cwd",
      });

      expect((await store.resolveWorkspace(oldPath))?.workspaceId).toBe(workspace.workspaceId);
      expect(registeredFromMissingAlias.state).toBe("available");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function stateEvent(threadId: string, state: "running" | "completed") {
  const timestamp = "2026-08-26T00:00:00.000Z";
  return {
    type: "thread.state.changed" as const,
    thread: {
      id: threadId,
      title: "Thread",
      createdAt: timestamp,
      updatedAt: timestamp,
      state,
      messageCount: 0,
    },
  };
}
