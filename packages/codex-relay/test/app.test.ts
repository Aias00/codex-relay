import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromByteArray, toByteArray } from "base64-js";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createRelayLifecycle } from "../src/relay-lifecycle.js";
import { AppServerRequestTimeoutError } from "../src/app-server.js";
import type { CodexClient, CodexThread } from "../src/codex.js";
import { createTursoPairingSessionStore } from "../src/pairing-store.js";
import {
  createFileRuntimePreferencesStore,
  type RuntimePreferencesStore,
} from "../src/preferences-store.js";
import type { PushNotificationSender, RelayPushNotification } from "../src/push-notifications.js";
import { createRelayStateStore } from "../src/relay-state-store.js";
import { createServerIdentity } from "../src/secure-transport.js";

const execFileAsync = promisify(execFile);
const requirePackage = createRequire(import.meta.url);
const relayPackage = requirePackage("../package.json") as { version: string };

function createMockCodex(handlers?: {
  onResumeThread?: (threadId: string, options: Parameters<CodexClient["resumeThread"]>[1]) => void;
  onStartThread?: (options: Parameters<CodexClient["startThread"]>[0]) => void;
}): CodexClient {
  const threads = new Map<string, CodexThread>();

  return {
    startThread(options) {
      handlers?.onStartThread?.(options);
      const id = `thread-${threads.size + 1}`;
      const thread = {
        id,
        async run(prompt: string) {
          return { finalResponse: `result: ${prompt}` };
        },
        async runStreamed(prompt: string) {
          async function* events() {
            yield { type: "turn.started" };
            yield {
              type: "item.completed",
              item: { id: "item-1", type: "agent_message", text: `streamed: ${prompt}` },
            };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            };
          }

          return { events: events() };
        },
      };
      threads.set(id, thread);
      return thread;
    },
    resumeThread(threadId: string, options) {
      handlers?.onResumeThread?.(threadId, options);
      const thread = threads.get(threadId);
      if (!thread) {
        throw new Error("missing mock thread");
      }
      return thread;
    },
  };
}

async function createAdoptedTestClaim(input: {
  inputId: string;
  ownerId: string;
  store: Awaited<ReturnType<typeof createRelayStateStore>>;
  threadId: string;
  turnId: string;
}) {
  const capabilities = {
    approve: true,
    configure: true,
    interrupt: true,
    queue: true,
    send: true,
    steer: true,
    view: true,
  };
  const owner = await input.store.acquireThreadOwner({
    capabilities,
    ownerId: input.ownerId,
    ownerInstanceId: "process-before-restart",
    ownerType: "shared_app_server",
    threadId: input.threadId,
  });
  await input.store.createThreadInput({
    clientId: "mobile-client",
    inputId: input.inputId,
    payload: { prompt: "active before restart" },
    state: "accepted",
    threadId: input.threadId,
  });
  const acquired = await input.store.acquireTurnClaim({
    inputId: input.inputId,
    ownerEpoch: owner.epoch,
    ownerId: owner.ownerId,
    threadId: input.threadId,
  });
  if (acquired.kind !== "acquired") {
    throw new Error("Expected the pre-restart input to acquire a claim.");
  }
  const bound = await input.store.bindTurnClaimRuntimeTurn({
    claimId: acquired.claim.claimId,
    ownerEpoch: owner.epoch,
    ownerId: owner.ownerId,
    runtimeTurnId: input.turnId,
  });
  if (bound.kind !== "updated") {
    throw new Error("Expected the pre-restart claim to bind its runtime turn.");
  }
  const adopted = await input.store.adoptActiveTurnClaim({
    capabilities,
    claimId: acquired.claim.claimId,
    ownerId: input.ownerId,
    ownerInstanceId: "process-after-restart",
    ownerType: "shared_app_server",
    runtimeTurnId: input.turnId,
    threadId: input.threadId,
  });
  if (adopted.kind !== "adopted") {
    throw new Error("Expected the pre-restart claim to be adopted.");
  }
  return adopted;
}

function appServerHistoryThread(input: {
  id: string;
  name: string;
  turns: Array<{
    id: string;
    items: Array<
      | { id: string; type: "agentMessage"; text: string }
      | {
          id: string;
          type: "userMessage";
          content: Array<{ type: "text"; text: string; text_elements: [] }>;
        }
    >;
    completedAt: number;
    startedAt: number;
    status: { type: string };
  }>;
  workspacePath: string;
}) {
  const now = Date.now() / 1000;
  return {
    id: input.id,
    preview: input.name,
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
    cwd: input.workspacePath,
    source: "app",
    modelProvider: "openai",
    name: input.name,
    turns: input.turns,
  };
}

function appServerTurn(id: string, text: string, timestamp: number) {
  return {
    id,
    items: [
      {
        id: `${id}-user`,
        type: "userMessage" as const,
        content: [{ type: "text" as const, text, text_elements: [] as [] }],
      },
      { id: `${id}-assistant`, type: "agentMessage" as const, text: `Reply: ${text}` },
    ],
    completedAt: timestamp + 1,
    startedAt: timestamp,
    status: { type: "completed" },
  };
}

function codexInjectedContextBlocks(workspacePath: string) {
  return [
    "<recommended_plugins>\nAvailable plugins\n</recommended_plugins>",
    [
      `# AGENTS.md instructions for ${workspacePath}`,
      "",
      "<INSTRUCTIONS>",
      "Keep internal context private.",
      "</INSTRUCTIONS>",
    ].join("\n"),
    ["<environment_context>", `  <cwd>${workspacePath}</cwd>`, "</environment_context>"].join("\n"),
  ];
}

function testPairingTranscript(input: {
  approvalCode: string;
  clientEphemeralPublicKey: string;
  clientNonce: string;
  keyEpoch: number;
  serverEphemeralPublicKey: string;
  serverIdentityPublicKey: string;
  serverNonce: string;
  serverUrl: string;
}) {
  return utf8ToBytes(
    JSON.stringify({
      tag: "codex-relay-e2ee-v1",
      approvalCode: input.approvalCode,
      clientEphemeralPublicKey: input.clientEphemeralPublicKey,
      clientNonce: input.clientNonce,
      keyEpoch: input.keyEpoch,
      serverEphemeralPublicKey: input.serverEphemeralPublicKey,
      serverIdentityPublicKey: input.serverIdentityPublicKey,
      serverNonce: input.serverNonce,
      serverUrl: input.serverUrl,
    }),
  );
}

function testDeriveSession(sharedSecret: Uint8Array, transcript: Uint8Array, keyEpoch: number) {
  const salt = sha256(transcript);
  const infoPrefix = `codex-relay-e2ee-v1|${keyEpoch}|${fromByteArray(sha256(transcript))}`;
  return {
    serverToMobileKey: hkdf(
      sha256,
      sharedSecret,
      salt,
      utf8ToBytes(`${infoPrefix}|serverToMobile`),
      32,
    ),
  };
}

function testDecrypt(
  key: Uint8Array,
  sender: "mobile" | "server",
  counter: number,
  ciphertext: string,
) {
  return new TextDecoder().decode(
    gcm(key, testNonceFor(sender, counter)).decrypt(toByteArray(ciphertext)),
  );
}

function testNonceFor(sender: "mobile" | "server", counter: number) {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === "mobile" ? 1 : 2;
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function waitUntil(assertion: () => void | Promise<void>) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > 1000) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("Codex Relay server routes", () => {
  it("rejects new mutations and streams while shutdown keeps reads available", async () => {
    const lifecycle = createRelayLifecycle();
    const app = createApp({ codex: createMockCodex(), lifecycle });
    await lifecycle.shutdown();

    const read = await app.request("/version");
    const mutation = await app.request("/v1/threads", {
      body: JSON.stringify({ title: "Too late" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const stream = await app.request("/v1/threads/thread-1/events/stream");

    expect(read.status).toBe(200);
    expect(mutation.status).toBe(503);
    expect(mutation.headers.get("retry-after")).toBe("1");
    await expect(mutation.json()).resolves.toMatchObject({
      error: { code: "service_shutdown" },
    });
    expect(stream.status).toBe(503);
  });
  it("returns relay package version", async () => {
    const app = createApp({ codex: createMockCodex(), workspacePath: "/tmp/codex-relay" });

    const response = await app.request("/version");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "codex-relay-server",
      packageName: "@aias00/codex-relay",
      packageVersion: relayPackage.version,
    });
  });

  it("returns status", async () => {
    const app = createApp({ codex: createMockCodex(), workspacePath: "/tmp/codex-relay" });

    const response = await app.request("/v1/status");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "codex-relay-server",
      sdkAvailable: true,
      machineName: expect.any(String),
      workspacePath: "/tmp/codex-relay",
      threadCount: 0,
      preferences: { runtimeMode: "default" },
    });
  });

  it("returns status for a selected workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const selectedWorkspacePath = await mkdtemp(join(tmpdir(), "codex-relay-selected-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const update = await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "auto",
        workspacePath: selectedWorkspacePath,
      }),
    });
    const response = await app.request(
      `/v1/status?workspacePath=${encodeURIComponent(selectedWorkspacePath)}`,
    );
    const body = await response.json();

    expect(update.status).toBe(200);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspacePath: selectedWorkspacePath,
      preferences: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "auto",
      },
    });
  });

  it("records content-safe legacy API usage without blocking requests", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const observedFeatures: string[] = [];
    const compatibilityObservations = {
      async listCompatibilityObservations() {
        return [];
      },
      async recordCompatibilityObservation(input: { feature: string }) {
        observedFeatures.push(input.feature);
        return {
          count: 1,
          feature: input.feature,
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        };
      },
    };
    const app = createApp({
      codex: createMockCodex(),
      compatibilityObservations,
      workspacePath,
    });

    const status = await app.request(
      `/v1/status?workspacePath=${encodeURIComponent(workspacePath)}`,
    );
    const createResponse = await app.request("/v1/threads", {
      body: JSON.stringify({ title: "Compatibility telemetry" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const created = await createResponse.json();
    const promptStream = await app.request(`/v1/threads/${created.thread.id}/runs/stream`, {
      body: JSON.stringify({ prompt: "content must never enter telemetry" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await promptStream.text();
    const attach = await app.request(`/v1/threads/${created.thread.id}/runs/stream`, {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(status.status).toBe(200);
    expect(promptStream.status).toBe(200);
    expect(attach.status).toBe(409);
    expect(observedFeatures).toEqual([
      "legacy.workspace_path_without_id",
      "legacy.run_stream_prompt",
      "legacy.input_without_client_event_id",
      "legacy.run_stream_attach",
    ]);
    expect(JSON.stringify(observedFeatures)).not.toContain("content must never enter telemetry");
  });

  it("keeps compatibility telemetry fail-open", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({
      codex: createMockCodex(),
      compatibilityObservations: {
        async listCompatibilityObservations() {
          return [];
        },
        async recordCompatibilityObservation() {
          throw new Error("telemetry unavailable");
        },
      },
      workspacePath,
    });

    const response = await app.request(
      `/v1/status?workspacePath=${encodeURIComponent(workspacePath)}`,
    );

    expect(response.status).toBe(200);
  });

  it("updates and returns runtime preferences", async () => {
    const app = createApp({ codex: createMockCodex(), workspacePath: "/tmp/codex-relay" });

    const update = await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        serviceTier: "priority",
        reasoningEffort: "high",
        runtimeMode: "full-access",
      }),
    });
    const updateBody = await update.json();
    const status = await app.request("/v1/status");
    const statusBody = await status.json();

    expect(update.status).toBe(200);
    expect(updateBody).toMatchObject({
      preferences: {
        model: "gpt-5.5",
        serviceTier: "priority",
        reasoningEffort: "high",
        runtimeMode: "full-access",
      },
    });
    expect(statusBody).toMatchObject(updateBody);
  });

  it("updates model and reasoning preferences on the thread workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });
    const createResponse = await app.request("/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Thread scoped settings" }),
    });
    const createBody = await createResponse.json();

    const update = await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        serviceTier: "priority",
        reasoningEffort: "high",
        runtimeMode: "auto",
        threadId: createBody.thread.id,
      }),
    });
    const updateBody = await update.json();
    const detail = await app.request(`/v1/threads/${createBody.thread.id}`);
    const detailBody = await detail.json();
    const status = await app.request("/v1/status");
    const statusBody = await status.json();

    expect(update.status).toBe(200);
    expect(updateBody).toMatchObject({
      preferences: {
        model: "gpt-5.5",
        serviceTier: "priority",
        reasoningEffort: "high",
        runtimeMode: "auto",
      },
      workspacePath,
    });
    expect(updateBody).not.toHaveProperty("threadId");
    expect(detailBody.thread).not.toHaveProperty("model");
    expect(detailBody.thread).not.toHaveProperty("reasoningEffort");
    expect(detailBody.thread).not.toHaveProperty("runtimeMode");
    expect(statusBody.preferences).toEqual({
      model: "gpt-5.5",
      serviceTier: "priority",
      reasoningEffort: "high",
      runtimeMode: "auto",
    });
  });

  it("returns app-server service tiers with models", async () => {
    const appServer = {
      listModels: vi.fn<() => Promise<unknown[]>>(async () => [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          serviceTiers: [
            {
              id: "priority",
              name: "Fast",
              description: "1.5x speed, increased usage",
            },
          ],
        },
      ]),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath: "/tmp/codex-relay",
    });

    const response = await app.request("/v1/models");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models[0]).toMatchObject({
      model: "gpt-5.5",
      serviceTiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
    });
  });

  it("keeps legacy file runtime preferences after server restarts", async () => {
    const workspacePath = "/tmp/codex-relay";
    const preferencesPath = join(
      await mkdtemp(join(tmpdir(), "codex-relay-preferences-")),
      "preferences.json",
    );
    await writeFile(
      preferencesPath,
      `${JSON.stringify({
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "full-access",
      })}\n`,
    );

    let app = createApp({
      codex: createMockCodex(),
      preferences: createFileRuntimePreferencesStore(preferencesPath),
      workspacePath,
    });
    let status = await app.request("/v1/status");
    let statusBody = await status.json();

    expect(statusBody.preferences).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      runtimeMode: "full-access",
    });

    await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        reasoningEffort: "low",
        runtimeMode: "auto",
        workspacePath,
      }),
    });
    app = createApp({
      codex: createMockCodex(),
      preferences: createFileRuntimePreferencesStore(preferencesPath),
      workspacePath,
    });
    status = await app.request("/v1/status");
    statusBody = await status.json();

    expect(statusBody.preferences).toEqual({
      model: "gpt-5.4",
      reasoningEffort: "low",
      runtimeMode: "auto",
    });
    expect(statusBody.runtimePreferencesByWorkspacePath).toEqual({
      [workspacePath]: {
        model: "gpt-5.4",
        reasoningEffort: "low",
        runtimeMode: "auto",
      },
    });
  });

  it("persists active thread runtime preferences to the selected workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const preferencesPath = join(
      await mkdtemp(join(tmpdir(), "codex-relay-preferences-")),
      "preferences.json",
    );
    let app = createApp({
      codex: createMockCodex(),
      preferences: createFileRuntimePreferencesStore(preferencesPath),
      workspacePath,
    });
    const createResponse = await app.request("/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Workspace permissions" }),
    });
    const createBody = await createResponse.json();

    const update = await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "full-access",
        threadId: createBody.thread.id,
        workspacePath,
      }),
    });
    const updateBody = await update.json();
    const status = await app.request("/v1/status");
    const statusBody = await status.json();

    expect(update.status).toBe(200);
    expect(updateBody).toMatchObject({
      preferences: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "full-access",
      },
      runtimePreferencesByWorkspacePath: {
        [workspacePath]: {
          model: "gpt-5.5",
          reasoningEffort: "high",
          runtimeMode: "full-access",
        },
      },
      workspacePath,
    });
    expect(updateBody).not.toHaveProperty("threadId");
    expect(statusBody.preferences).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      runtimeMode: "full-access",
    });

    app = createApp({
      codex: createMockCodex(),
      preferences: createFileRuntimePreferencesStore(preferencesPath),
      workspacePath,
    });
    const restartedStatus = await app.request("/v1/status");
    const restartedStatusBody = await restartedStatus.json();

    expect(restartedStatusBody.preferences).toEqual({
      model: "gpt-5.5",
      reasoningEffort: "high",
      runtimeMode: "full-access",
    });
  });

  it("defers runtime preferences until a thread starts running", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const startOptions: Parameters<CodexClient["startThread"]>[0][] = [];
    const resumeOptions: Parameters<CodexClient["resumeThread"]>[1][] = [];
    const app = createApp({
      codex: createMockCodex({
        onResumeThread: (_threadId, options) => resumeOptions.push(options),
        onStartThread: (options) => startOptions.push(options),
      }),
      workspacePath,
    });

    await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        runtimeMode: "auto",
      }),
    });
    const response = await app.request("/v1/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New chat" }),
    });
    const createBody = await response.json();

    expect(response.status).toBe(201);
    expect(startOptions[0]).toMatchObject({
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
    expect(createBody.thread).not.toHaveProperty("model");
    expect(createBody.thread).not.toHaveProperty("reasoningEffort");
    expect(createBody.thread).not.toHaveProperty("runtimeMode");

    const runResponse = await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvalPolicy: "never",
        prompt: "Continue",
        sandboxMode: "danger-full-access",
      }),
    });
    const runBody = await runResponse.json();

    expect(runResponse.status).toBe(200);
    expect(resumeOptions[0]).toMatchObject({
      approvalPolicy: "never",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "ultra",
      sandboxMode: "danger-full-access",
    });
    expect(runBody.thread).toMatchObject({
      approvalPolicy: "never",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      runtimeMode: "auto",
      sandboxMode: "danger-full-access",
    });

    await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        runtimeMode: "default",
      }),
    });
    const followupResponse = await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue again" }),
    });
    const followupBody = await followupResponse.json();

    expect(followupResponse.status).toBe(200);
    expect(resumeOptions[1]).toMatchObject({
      approvalPolicy: "on-request",
      model: "gpt-5.6-luna",
      modelReasoningEffort: "max",
      sandboxMode: "workspace-write",
    });
    expect(followupBody.thread).toMatchObject({
      approvalPolicy: "on-request",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      runtimeMode: "default",
      sandboxMode: "workspace-write",
    });

    await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "beyond-ultra" }),
    });
    const futureEffortResponse = await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue with a future effort" }),
    });
    const futureEffortBody = await futureEffortResponse.json();

    expect(futureEffortResponse.status).toBe(200);
    expect(resumeOptions[2]).not.toHaveProperty("modelReasoningEffort");
    expect(futureEffortBody.thread).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "beyond-ultra",
    });
  });

  it("uses the current directory as the default workspace", async () => {
    const app = createApp({ codex: createMockCodex() });

    const response = await app.request("/v1/status");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspacePath: process.cwd(),
    });
  });

  it("lists workspace directories within the configured workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await mkdir(join(workspacePath, "apps"));
    await mkdir(join(workspacePath, ".hidden"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace-directories");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      rootPath: workspacePath,
      path: workspacePath,
      parentPath: dirname(workspacePath),
      directories: [{ name: "apps", path: join(workspacePath, "apps") }],
    });
  });

  it("lists available workspace skills", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const skillPath = join(workspacePath, ".agents", "skills", "agent-device");
    await mkdir(skillPath, { recursive: true });
    await writeFile(
      join(skillPath, "SKILL.md"),
      [
        "---",
        "name: agent-device",
        "description: Automates interactions for mobile devices.",
        "---",
        "",
        "# Agent Device",
        "",
      ].join("\n"),
    );
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/skills");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "agent-device",
          displayName: "Agent Device",
          description: "Automates interactions for mobile devices.",
          source: "workspace",
          sourceLabel: basename(workspacePath),
        }),
      ]),
    );
  });

  it("lists workspace skills from symlinked skill directories", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const vendorPath = await mkdtemp(join(tmpdir(), "codex-relay-vendor-skills-"));
    const vendorSkillPath = join(vendorPath, "marimo-notebook");
    const workspaceSkillsPath = join(workspacePath, ".agents", "skills");
    const workspaceSkillLink = join(workspaceSkillsPath, "marimo-notebook");
    await mkdir(vendorSkillPath, { recursive: true });
    await mkdir(workspaceSkillsPath, { recursive: true });
    await writeFile(
      join(vendorSkillPath, "SKILL.md"),
      [
        "---",
        "name: marimo-notebook",
        "description: Write marimo notebooks.",
        "---",
        "",
        "# Marimo Notebook",
        "",
      ].join("\n"),
    );
    await symlink(vendorSkillPath, workspaceSkillLink, "dir");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/skills");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "marimo-notebook",
          displayName: "Marimo Notebook",
          description: "Write marimo notebooks.",
          path: join(workspaceSkillLink, "SKILL.md"),
          source: "workspace",
          sourceLabel: basename(workspacePath),
        }),
      ]),
    );
  });

  it("parses folded descriptions and ignores headings inside code fences", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const skillPath = join(workspacePath, ".agents", "skills", "marimo-pair");
    await mkdir(skillPath, { recursive: true });
    await writeFile(
      join(skillPath, "SKILL.md"),
      [
        "---",
        "name: marimo-pair",
        "description: >-",
        "  Drive a live marimo notebook as a workspace.",
        "  Inspect live notebook state.",
        "---",
        "",
        "Introductory text without a top-level heading.",
        "",
        "```python",
        "# Public definitions: values, total, i, value, mean",
        "values = [1, 2, 3]",
        "```",
        "",
      ].join("\n"),
    );
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/skills");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "marimo-pair",
          displayName: "Marimo Pair",
          description: "Drive a live marimo notebook as a workspace. Inspect live notebook state.",
        }),
      ]),
    );
  });

  it("deduplicates repeated plugin cache skills by logical skill identity", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const homePath = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const codexHome = join(homePath, ".codex");
    const pluginSkillPaths = [
      join(codexHome, "plugins", "cache", "omo", "4.13.0", "skills", "visual-qa"),
      join(codexHome, "plugins", "cache", "omo-copy", "4.13.0", "skills", "visual-qa"),
    ];
    for (const [index, skillPath] of pluginSkillPaths.entries()) {
      await mkdir(skillPath, { recursive: true });
      await writeFile(
        join(skillPath, "SKILL.md"),
        [
          "---",
          "name: visual-qa",
          `description: Rigorous visual QA for any UI you built or changed.${index === 0 ? "" : " Updated cache copy."}`,
          "---",
          "",
          `# Visual QA - Dual-Oracle Web and TUI Visual Verification${index === 0 ? "" : " v2"}`,
          "",
        ].join("\n"),
      );
    }
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({ codex: createMockCodex(), workspacePath });

    try {
      const response = await app.request("/v1/skills");
      const body = await response.json();
      const visualQaSkills = body.skills.filter(
        (skill: { readonly name: string }) => skill.name === "visual-qa",
      );

      expect(response.status).toBe(200);
      expect(visualQaSkills).toHaveLength(1);
      expect(visualQaSkills[0]).toMatchObject({
        name: "visual-qa",
        displayName: "Visual QA - Dual-Oracle Web and TUI Visual Verification",
        description: "Rigorous visual QA for any UI you built or changed.",
        source: "plugin",
        sourceLabel: "plugin",
      });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("lists directories outside the configured workspace when a cwd points there", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const externalPath = await mkdtemp(join(tmpdir(), "codex-relay-external-"));
    await mkdir(join(externalPath, "sibling-project"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request(
      `/v1/workspace-directories?path=${encodeURIComponent(externalPath)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      rootPath: workspacePath,
      path: externalPath,
      parentPath: dirname(externalPath),
      directories: [{ name: "sibling-project", path: join(externalPath, "sibling-project") }],
    });
  });

  it("creates, reads, writes, and closes a workspace terminal session", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const startResponse = await app.request("/v1/workspace/terminal/sessions", {
      method: "POST",
      body: JSON.stringify({ cols: 80, rows: 24 }),
      headers: { "content-type": "application/json" },
    });
    const startBody = await startResponse.json();

    expect(startResponse.status).toBe(200);
    expect(startBody).toMatchObject({
      cols: 80,
      rows: 24,
      workspacePath,
    });
    expect(startBody.sessionId).toEqual(expect.any(String));

    const legacyInputResponse = await app.request(
      `/v1/workspace/terminal/sessions/${startBody.sessionId}/input`,
      {
        method: "POST",
        body: JSON.stringify({ input: "printf legacy-terminal-smoke\\n\n" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(legacyInputResponse.status).toBe(204);

    const inputResponse = await app.request(
      `/v1/workspace/terminal/sessions/${startBody.sessionId}/input`,
      {
        method: "POST",
        body: JSON.stringify({ data: "printf terminal-smoke\\n\nexit\n" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(inputResponse.status).toBe(204);

    await waitUntil(async () => {
      const outputResponse = await app.request(
        `/v1/workspace/terminal/sessions/${startBody.sessionId}/output?since=0`,
      );
      const outputBody = await outputResponse.json();
      expect(outputResponse.status).toBe(200);
      const output = outputBody.chunks.map((chunk: { data: string }) => chunk.data).join("");
      expect(output).toContain("legacy-terminal-smoke");
      expect(output).toContain("terminal-smoke");
    });

    const closeResponse = await app.request(
      `/v1/workspace/terminal/sessions/${startBody.sessionId}`,
      { method: "DELETE" },
    );
    expect(closeResponse.status).toBe(204);
  });

  it("starts Tailscale Serve for a workspace web preview URL", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const servedUrls: string[] = [];
    const app = createApp({
      codex: createMockCodex(),
      tailscaleServeForPreviewUrl: async ({ url }) => {
        servedUrls.push(url);
        return {
          port: 3000,
          url: "https://device.tailnet.ts.net",
        };
      },
      workspacePath,
    });

    const response = await app.request("/v1/workspace/tailscale/serve", {
      method: "POST",
      body: JSON.stringify({ url: "http://100.103.76.81:3000/" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(servedUrls).toEqual(["http://100.103.76.81:3000/"]);
    expect(body).toEqual({
      port: 3000,
      url: "https://device.tailnet.ts.net",
    });
  });

  it("rejects non-Tailscale workspace web preview URLs before starting Serve", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace/tailscale/serve", {
      method: "POST",
      body: JSON.stringify({ url: "http://192.168.1.4:3000/" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "invalid_tailscale_preview_url",
      },
    });
  });

  it("streams workspace terminal output without repeated output reads", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const startResponse = await app.request("/v1/workspace/terminal/sessions", {
      method: "POST",
      body: JSON.stringify({ cols: 80, rows: 24 }),
      headers: { "content-type": "application/json" },
    });
    const startBody = await startResponse.json();
    const streamResponse = await app.request(
      `/v1/workspace/terminal/sessions/${startBody.sessionId}/output/stream?since=0`,
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

    const inputResponse = await app.request(
      `/v1/workspace/terminal/sessions/${startBody.sessionId}/input`,
      {
        method: "POST",
        body: JSON.stringify({ data: "printf terminal-stream-smoke\\n\nexit\n" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(inputResponse.status).toBe(204);

    const reader = streamResponse.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let streamedText = "";
    await Promise.race([
      (async () => {
        for (;;) {
          const result = await reader!.read();
          if (result.done) {
            return;
          }
          streamedText += decoder.decode(result.value, { stream: true });
          if (streamedText.includes("terminal-stream-smoke")) {
            await reader!.cancel();
            return;
          }
        }
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for terminal stream output.")), 1000),
      ),
    ]);

    expect(streamedText).toContain("event: output");
    expect(streamedText).toContain("terminal-stream-smoke");
  });

  it("returns git status and diff for workspace changes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await git(workspacePath, ["init", "-b", "main"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, ".gitignore"), "ignored/\n");
    await writeFile(join(workspacePath, "README.md"), "hello\n");
    await git(workspacePath, ["add", ".gitignore", "README.md"]);
    await git(workspacePath, ["commit", "-m", "initial"]);
    await writeFile(join(workspacePath, "README.md"), "hello mobile\n");
    await mkdir(join(workspacePath, "ignored"));
    await writeFile(join(workspacePath, "ignored", "cache.log"), "ignored\n");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace/changes");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspacePath,
      hasChanges: true,
      currentBranch: "main",
      branches: [{ current: true, name: "main" }],
    });
    expect(body.status).toContain("M README.md");
    expect(body.diff).toContain("-hello");
    expect(body.diff).toContain("+hello mobile");
    expect(body.files).not.toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining("ignored"),
      }),
    );
    expect(body.stats).toMatchObject({
      additions: 1,
      deletions: 1,
      filesChanged: 1,
    });
    expect(body.files).toEqual([
      expect.objectContaining({
        additions: 1,
        deletions: 1,
        oldPath: "README.md",
        path: "README.md",
        status: "Modified",
      }),
    ]);
    expect(body.files[0].patch).toContain("diff --git a/README.md b/README.md");
  }, 15_000);

  it("returns git status and diff for a selected thread workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const threadWorkspacePath = join(workspacePath, "apps", "mobile");
    await mkdir(threadWorkspacePath, { recursive: true });
    await git(threadWorkspacePath, ["init", "-b", "main"]);
    await git(threadWorkspacePath, ["config", "user.email", "test@example.com"]);
    await git(threadWorkspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(threadWorkspacePath, "README.md"), "hello\n");
    await git(threadWorkspacePath, ["add", "README.md"]);
    await git(threadWorkspacePath, ["commit", "-m", "initial"]);
    await writeFile(join(threadWorkspacePath, "README.md"), "hello thread\n");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request(
      `/v1/workspace/changes?workspacePath=${encodeURIComponent(threadWorkspacePath)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspacePath: threadWorkspacePath,
      hasChanges: true,
      currentBranch: "main",
    });
    expect(body.diff).toContain("+hello thread");
  }, 15_000);

  it("checks out a workspace branch", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await git(workspacePath, ["init", "-b", "main"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "hello\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "initial"]);
    await git(workspacePath, ["checkout", "-b", "feature/mobile"]);
    await git(workspacePath, ["checkout", "main"]);
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const checkoutResponse = await app.request("/v1/workspace/checkout", {
      method: "POST",
      body: JSON.stringify({ branch: "feature/mobile" }),
      headers: { "content-type": "application/json" },
    });
    const checkoutBody = await checkoutResponse.json();

    expect(checkoutResponse.status).toBe(200);
    expect(checkoutBody).toMatchObject({
      branch: "feature/mobile",
      message: "Checked out feature/mobile.",
    });

    const changesResponse = await app.request("/v1/workspace/changes");
    const changesBody = await changesResponse.json();
    expect(changesBody).toMatchObject({
      currentBranch: "feature/mobile",
      branches: expect.arrayContaining([
        { current: true, name: "feature/mobile" },
        { current: false, name: "main" },
      ]),
    });
  }, 15_000);

  it("creates and checks out a missing workspace branch", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await git(workspacePath, ["init", "-b", "main"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "hello\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "initial"]);
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const checkoutResponse = await app.request("/v1/workspace/checkout", {
      method: "POST",
      body: JSON.stringify({ branch: "feature/new-mobile-flow" }),
      headers: { "content-type": "application/json" },
    });
    const checkoutBody = await checkoutResponse.json();

    expect(checkoutResponse.status).toBe(200);
    expect(checkoutBody).toMatchObject({
      branch: "feature/new-mobile-flow",
      message: "Created and checked out feature/new-mobile-flow.",
    });

    const changesResponse = await app.request("/v1/workspace/changes");
    const changesBody = await changesResponse.json();
    expect(changesBody).toMatchObject({
      currentBranch: "feature/new-mobile-flow",
      branches: expect.arrayContaining([
        { current: true, name: "feature/new-mobile-flow" },
        { current: false, name: "main" },
      ]),
    });
  }, 15_000);

  it("requires secure pairing when pairing is enabled", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        sessions,
      },
    });

    const unauthenticated = await app.request("/v1/status");
    expect(unauthenticated.status).toBe(401);

    const version = await app.request("/version");
    expect(version.status).toBe(200);

    const insecurePairing = await app.request("/v1/pair", {
      method: "POST",
      body: JSON.stringify({ clientName: "test phone" }),
      headers: { "content-type": "application/json" },
    });
    expect(insecurePairing.status).toBe(400);
  });

  it("serves local pairing controls on localhost", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const expiresAt = Date.now() + 60_000;
    await sessions.createPendingPairing({
      approvalCode: "BE01-C955",
      approved: false,
      clientEphemeralPublicKey: "client-public-key",
      clientNonce: "client-nonce",
      expiresAt,
      serverUrl: "http://127.0.0.1:8788",
    });
    const onPairApproved = vi.fn<(client: { approvalCode: string; clientName?: string }) => void>();
    const app = createApp({
      codex: createMockCodex(),
      management: {
        connectUrl: "http://127.0.0.1:8788",
        connectUrlCandidates: [{ label: "Local", url: "http://127.0.0.1:8788" }],
        getConnectionInfo: () => ({ remote: { address: "127.0.0.1" } }),
        listenUrl: "http://0.0.0.0:8788",
        pairingPayload: "codex-relay://pair?serverUrl=http%3A%2F%2F127.0.0.1%3A8788",
        port: 8788,
      },
      pairing: {
        approvalSecret: "approve-secret",
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        onPairApproved,
        sessions,
      },
    });

    const page = await app.request("/", {
      headers: { host: "127.0.0.1:8788" },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Codex Relay Pairing");

    const pairing = await app.request("/local/pairing", {
      headers: { host: "localhost:8788" },
    });
    const pairingBody = await pairing.json();
    expect(pairing.status).toBe(200);
    expect(pairingBody).toMatchObject({
      connectUrl: "http://127.0.0.1:8788",
      pendingPairings: [
        {
          approvalCode: "BE01-C955",
          approved: false,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      ],
      pairingPayload: "codex-relay://pair?serverUrl=http%3A%2F%2F127.0.0.1%3A8788",
      port: 8788,
    });
    expect(pairingBody.qrText).toContain("▄▄");

    const approval = await app.request("/local/pairing/approve", {
      method: "POST",
      body: JSON.stringify({ approvalCode: "be01 c955" }),
      headers: { "content-type": "application/json", host: "localhost:8788" },
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toEqual({ ok: true });
    expect(onPairApproved).toHaveBeenCalledWith({ approvalCode: "BE01-C955" });
    expect(await sessions.getPendingPairing("BE01-C955", Date.now())).toMatchObject({
      approved: true,
    });

    const afterApproval = await app.request("/local/pairing", {
      headers: { host: "localhost:8788" },
    });
    expect(await afterApproval.json()).toMatchObject({
      pendingPairings: [
        {
          approvalCode: "BE01-C955",
          approved: true,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      ],
    });
  });

  it("rejects local pairing controls without a loopback socket peer or with a cross-site origin", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const app = createApp({
      codex: createMockCodex(),
      management: {
        getConnectionInfo: (request) => {
          const url = new URL(request.url);
          return {
            remote: {
              address: url.searchParams.get("peer") ?? "127.0.0.1",
            },
          };
        },
        pairingPayload: "codex-relay://pair",
      },
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        sessions,
      },
    });

    const nonLoopbackPeer = await app.request("/local/pairing?peer=192.168.31.114", {
      headers: { host: "localhost:8788" },
    });
    expect(nonLoopbackPeer.status).toBe(403);

    const crossSiteOrigin = await app.request("/local/pairing", {
      headers: {
        host: "localhost:8788",
        origin: "https://example.invalid",
      },
    });
    expect(crossSiteOrigin.status).toBe(403);

    const localOrigin = await app.request("/local/pairing", {
      headers: {
        host: "localhost:8788",
        origin: "http://localhost:8788",
      },
    });
    expect(localOrigin.status).toBe(200);

    const otherLoopbackOrigin = await app.request("/local/pairing", {
      headers: {
        host: "localhost:8788",
        origin: "http://localhost:3000",
      },
    });
    expect(otherLoopbackOrigin.status).toBe(403);
  });

  it("rejects local pairing controls from non-localhost hosts", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const app = createApp({
      codex: createMockCodex(),
      management: {
        getConnectionInfo: () => ({ remote: { address: "127.0.0.1" } }),
        pairingPayload: "codex-relay://pair",
      },
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        sessions,
      },
    });

    const pairing = await app.request("/local/pairing", {
      headers: { host: "192.168.31.114:8788" },
    });
    expect(pairing.status).toBe(403);

    const approval = await app.request("/local/pairing/approve", {
      method: "POST",
      body: JSON.stringify({ approvalCode: "BE01-C955" }),
      headers: { "content-type": "application/json", host: "192.168.31.114:8788" },
    });
    expect(approval.status).toBe(403);
  });

  it("keeps client tokens valid after the legacy expiry timestamp", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    await sessions.createSession("expired-client-token", { expiresAt: Date.now() - 1 });
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        sessions,
      },
    });

    const authenticated = await app.request("/v1/status", {
      headers: { authorization: "Bearer expired-client-token" },
    });
    expect(authenticated.status).toBe(200);
    expect(await sessions.getValidSession("expired-client-token")).toBeDefined();
  });

  it("counts active clients by stable client session id and replaces stale tokens", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const expiresAt = Date.now() + 60_000;

    await sessions.createSession("legacy-client-token", {
      clientName: "test phone",
      expiresAt,
    });
    await sessions.createSession("client-token-1", {
      clientName: "test phone",
      clientSessionId: "phone-session",
      expiresAt,
    });
    expect(await sessions.countActive()).toBe(1);

    await sessions.createSession("client-token-2", {
      clientName: "test phone",
      clientSessionId: "phone-session",
      expiresAt,
    });

    expect(await sessions.countActive()).toBe(1);
    expect(await sessions.getValidSession("legacy-client-token")).toBeUndefined();
    expect(await sessions.getValidSession("client-token-1")).toBeUndefined();
    expect(await sessions.getValidSession("client-token-2")).toMatchObject({
      clientName: "test phone",
      clientSessionId: "phone-session",
    });
  });

  it("registers and removes push notifications through the paired device session", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    await sessions.createSession("client-token", {
      clientSessionId: "phone-session",
      expiresAt: Date.now() + 60_000,
    });
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        createClientToken: () => "unused-client-token",
        hashClientToken: (token) => token,
        sessions,
      },
    });

    const registration = await app.request("/v1/notifications/push", {
      method: "PUT",
      body: JSON.stringify({
        expoPushToken: "ExponentPushToken[phone-token]",
        platform: "ios",
        preferences: { actionRequired: true, turnTerminal: false },
      }),
      headers: {
        authorization: "Bearer client-token",
        "content-type": "application/json",
      },
    });

    expect(registration.status).toBe(200);
    await expect(registration.json()).resolves.toEqual({
      preferences: { actionRequired: true, turnTerminal: false },
      registered: true,
    });
    expect(await sessions.getPushNotificationSubscription("phone-session")).toEqual({
      actionRequired: true,
      clientSessionId: "phone-session",
      expoPushToken: "ExponentPushToken[phone-token]",
      platform: "ios",
      turnTerminal: false,
    });

    const settings = await app.request("/v1/notifications/push", {
      headers: { authorization: "Bearer client-token" },
    });
    await expect(settings.json()).resolves.toEqual({
      preferences: { actionRequired: true, turnTerminal: false },
      registered: true,
    });

    const removal = await app.request("/v1/notifications/push", {
      method: "DELETE",
      headers: { authorization: "Bearer client-token" },
    });
    expect(removal.status).toBe(200);
    await expect(removal.json()).resolves.toEqual({
      preferences: { actionRequired: false, turnTerminal: false },
      registered: false,
    });
    expect(await sessions.getPushNotificationSubscription("phone-session")).toBeUndefined();
  });

  it("observes app-server terminal turns and action requests without handling the request", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const workspaceRegistry = await createRelayStateStore(":memory:");
    const workspace = await workspaceRegistry.registerWorkspace({
      path: workspacePath,
      source: "relay_startup",
    });
    const sessions = await createTursoPairingSessionStore(":memory:");
    await sessions.createSession("client-token", {
      clientSessionId: "phone-session",
      expiresAt: Date.now() + 60_000,
    });
    await sessions.upsertPushNotificationSubscription({
      actionRequired: true,
      clientSessionId: "phone-session",
      expoPushToken: "ExponentPushToken[phone-token]",
      platform: "ios",
      turnTerminal: true,
    });
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const appServer = {
      async readThread(threadId: string) {
        return {
          cwd: workspacePath,
          parentThreadId: threadId === "agent-thread-1" ? "thread-1" : null,
        };
      },
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      },
    };
    const sent: RelayPushNotification[][] = [];
    const sender: PushNotificationSender = {
      async send(notifications) {
        sent.push([...notifications]);
        return { invalidExpoPushTokens: [] };
      },
    };
    createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: { relayId: "relay-push", serverEpoch: "epoch-push" },
      pairing: {
        createClientToken: () => "unused-client-token",
        hashClientToken: (token) => token,
        sessions,
      },
      pushNotificationSender: sender,
      workspaceRegistry,
      workspacePath,
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "item/completed",
        params: {
          item: {
            agentsStates: {},
            id: "spawn-agent",
            model: null,
            prompt: null,
            reasoningEffort: null,
            receiverThreadIds: ["agent-thread-1"],
            senderThreadId: "thread-1",
            status: "completed",
            tool: "spawnAgent",
            type: "collabAgentToolCall",
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "agent-thread-1", turnId: "agent-turn-1" },
      });
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "agent-thread-1", turnId: "agent-turn-1" },
      });
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "thread-1", turnId: "turn-1" },
      });
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "thread-1", turnId: "turn-1" },
      });
      handler({
        method: "turn/completed",
        params: { status: "cancelled", threadId: "thread-cancelled", turnId: "turn-2" },
      });
    }
    for (const handler of requestHandlers) {
      handler({
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          questions: [{ id: "scope", question: "What should Codex do next?" }],
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
    }

    await waitUntil(() => expect(sent).toHaveLength(2));
    expect(sent.flat()).toHaveLength(2);
    expect(sent.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: {
            intent: "turn_terminal",
            relayId: "relay-push",
            semanticEventId: "turn_terminal:thread-1:turn-1",
            threadId: "thread-1",
            turnId: "turn-1",
            workspaceId: workspace.workspaceId,
          },
        }),
        expect.objectContaining({
          data: {
            intent: "action_required",
            relayId: "relay-push",
            semanticEventId: "action_required:thread-1:turn-1:7",
            threadId: "thread-1",
            turnId: "turn-1",
            workspaceId: workspace.workspaceId,
          },
        }),
      ]),
    );
  });

  it("rejects secure tokens when the in-process e2ee session is gone", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    await sessions.createSession("client-token", { expiresAt: Date.now() + 60_000 });
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        serverIdentity: createServerIdentity(),
        sessions,
      },
    });

    const authenticated = await app.request("/v1/status", {
      headers: { authorization: "Bearer client-token" },
    });
    const body = await authenticated.json();

    expect(authenticated.status).toBe(401);
    expect(body).toMatchObject({
      error: {
        code: "secure_session_required",
      },
    });
  });

  it("clears paired sessions and pending pairing requests from a local clear command", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const expiresAt = Date.now() + 60_000;
    await sessions.createSession("client-token", { clientName: "test phone", expiresAt });
    await sessions.createPendingPairing({
      approvalCode: "1234-5678",
      approved: false,
      clientEphemeralPublicKey: "client-public-key",
      clientNonce: "client-nonce",
      expiresAt,
      serverUrl: "http://127.0.0.1",
    });
    const onPairingsCleared =
      vi.fn<(result: { pendingPairingsCleared: number; sessionsCleared: number }) => void>();
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        approvalSecret: "approve-secret",
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        onPairingsCleared,
        sessions,
      },
    });

    const authenticated = await app.request("/v1/status", {
      headers: { authorization: "Bearer client-token" },
    });
    expect(authenticated.status).toBe(200);

    const unauthorizedClear = await app.request("/v1/sessions/clear", {
      method: "POST",
    });
    expect(unauthorizedClear.status).toBe(401);

    const clear = await app.request("/v1/sessions/clear", {
      method: "POST",
      headers: { "x-codex-relay-approve-secret": "approve-secret" },
    });
    const clearBody = await clear.json();

    expect(clear.status).toBe(200);
    expect(clearBody).toMatchObject({
      ok: true,
      pendingPairingsCleared: 1,
      sessionsCleared: 1,
    });
    expect(onPairingsCleared).toHaveBeenCalledWith({
      pendingPairingsCleared: 1,
      sessionsCleared: 1,
    });
    expect(await sessions.countActive()).toBe(0);
    expect(await sessions.getPendingPairing("1234-5678", Date.now())).toBeUndefined();

    const afterClear = await app.request("/v1/status", {
      headers: { authorization: "Bearer client-token" },
    });
    expect(afterClear.status).toBe(401);
  });

  it("approves pairing requests and encrypts paired responses", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const reserveServerCounterRange = vi.spyOn(sessions, "reserveServerCounterRange");
    const serverIdentity = createServerIdentity();
    const tokens = ["client-token", "client-token-2"];
    const onPairApprovalRequested =
      vi.fn<(client: { approvalCode: string; clientName?: string }) => void>();
    const onPairApproved = vi.fn<(client: { approvalCode: string; clientName?: string }) => void>();
    const onPaired = vi.fn<(client: { clientName?: string; tokenCount: number }) => void>();
    const onTokenRefreshed = vi.fn<(client: { clientName?: string; tokenCount: number }) => void>();
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        approvalSecret: "approve-secret",
        createClientToken: () => tokens.shift()!,
        hashClientToken: (token) => token,
        onPairApprovalRequested,
        onPairApproved,
        onPaired,
        onTokenRefreshed,
        serverCounterReservationSize: 2,
        serverIdentity,
        sessions,
      },
      workspacePath: "/tmp/codex-relay",
    });
    const clientPrivateKey = x25519.utils.randomSecretKey();
    const clientPublicKey = fromByteArray(x25519.getPublicKey(clientPrivateKey));
    const clientNonce = fromByteArray(randomBytes(32));

    const pairing = await app.request("http://127.0.0.1/v1/pair", {
      method: "POST",
      body: JSON.stringify({
        clientSessionId: "phone-session",
        clientName: "test phone",
        secure: {
          clientEphemeralPublicKey: clientPublicKey,
          clientNonce,
          protocolVersion: 1,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const pairingBody = await pairing.json();

    expect(pairing.status).toBe(202);
    expect(pairingBody.approvalCode).toEqual(expect.any(String));
    expect(pairingBody.secure).toBeUndefined();
    expect(onPairApprovalRequested).toHaveBeenCalledWith({
      approvalCode: pairingBody.approvalCode,
      clientName: "test phone",
    });

    const pending = await app.request(`/v1/pair/${pairingBody.approvalCode}`);
    expect(pending.status).toBe(202);

    const unauthorizedApproval = await app.request("/v1/pair/approve", {
      method: "POST",
      body: JSON.stringify({ approvalCode: pairingBody.approvalCode }),
      headers: { "content-type": "application/json" },
    });
    expect(unauthorizedApproval.status).toBe(401);

    const approval = await app.request("/v1/pair/approve", {
      method: "POST",
      body: JSON.stringify({ approvalCode: pairingBody.approvalCode }),
      headers: {
        "content-type": "application/json",
        "x-codex-relay-approve-secret": "approve-secret",
      },
    });
    expect(approval.status).toBe(200);
    expect(onPairApproved).toHaveBeenCalledWith({
      approvalCode: pairingBody.approvalCode,
      clientName: "test phone",
    });

    const approved = await app.request(`/v1/pair/${pairingBody.approvalCode}`);
    const approvedBody = await approved.json();

    expect(approved.status).toBe(201);
    expect(approvedBody.clientToken).toBeUndefined();
    expect(approvedBody.secure?.encryptedPayload).toEqual(expect.any(String));
    expect(onPaired).toHaveBeenCalledWith({ clientName: "test phone", tokenCount: 1 });

    const transcript = testPairingTranscript({
      approvalCode: pairingBody.approvalCode,
      clientEphemeralPublicKey: clientPublicKey,
      clientNonce,
      keyEpoch: approvedBody.secure.keyEpoch,
      serverEphemeralPublicKey: approvedBody.secure.serverEphemeralPublicKey,
      serverIdentityPublicKey: serverIdentity.publicKey,
      serverNonce: approvedBody.secure.serverNonce,
      serverUrl: "http://127.0.0.1",
    });
    expect(
      ed25519.verify(
        toByteArray(approvedBody.secure.serverSignature),
        transcript,
        toByteArray(serverIdentity.publicKey),
      ),
    ).toBe(true);

    const sharedSecret = x25519.getSharedSecret(
      clientPrivateKey,
      toByteArray(approvedBody.secure.serverEphemeralPublicKey),
    );
    const keys = testDeriveSession(sharedSecret, transcript, approvedBody.secure.keyEpoch);
    const tokenPayload = JSON.parse(
      testDecrypt(keys.serverToMobileKey, "server", 0, approvedBody.secure.encryptedPayload),
    );
    expect(tokenPayload).toMatchObject({
      clientToken: "client-token",
      clientTokenExpiresAt: "9999-12-31T23:59:59.999Z",
    });
    const storedPairedSession = await sessions.getValidSession("client-token");
    expect(storedPairedSession).toMatchObject({
      clientName: "test phone",
      clientSessionId: "phone-session",
    });
    expect(storedPairedSession?.secureSession?.nextServerCounter).toBeGreaterThan(2);

    const status = await app.request("/v1/status", {
      headers: { authorization: "Bearer client-token" },
    });
    const statusEnvelope = await status.json();
    expect(statusEnvelope.sender).toBe("server");
    const statusBody = JSON.parse(
      testDecrypt(keys.serverToMobileKey, "server", 1, statusEnvelope.ciphertext),
    );
    expect(statusBody).toMatchObject({
      ok: true,
      machineName: expect.any(String),
      workspacePath: "/tmp/codex-relay",
    });
    const secondStatus = await app.request("/v1/status", {
      headers: { authorization: "Bearer client-token" },
    });
    expect(secondStatus.status).toBe(200);
    await secondStatus.json();
    expect(reserveServerCounterRange).toHaveBeenCalledTimes(2);
    expect(
      (await sessions.getValidSession("client-token"))?.secureSession?.nextServerCounter,
    ).toBeGreaterThan(5);

    const refresh = await app.request("/v1/session/refresh", {
      method: "POST",
      headers: { authorization: "Bearer client-token" },
    });
    const refreshEnvelope = await refresh.json();
    const refreshBody = JSON.parse(
      testDecrypt(keys.serverToMobileKey, "server", 3, refreshEnvelope.ciphertext),
    );
    expect(refresh.status).toBe(201);
    expect(refreshBody).toMatchObject({
      clientToken: "client-token-2",
      clientTokenExpiresAt: "9999-12-31T23:59:59.999Z",
    });
    expect(await sessions.getValidSession("client-token")).toBeUndefined();
    expect(await sessions.getValidSession("client-token-2")).toMatchObject({
      clientName: "test phone",
      clientSessionId: "phone-session",
    });
    expect(onTokenRefreshed).toHaveBeenCalledWith({ clientName: "test phone", tokenCount: 1 });
  }, 15_000);

  it("auto-approves pairing when the dangerous auto-approve option is enabled", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const serverIdentity = createServerIdentity();
    const onPairApprovalRequested =
      vi.fn<(client: { approvalCode: string; clientName?: string }) => void>();
    const onPairApproved = vi.fn<(client: { approvalCode: string; clientName?: string }) => void>();
    const app = createApp({
      codex: createMockCodex(),
      pairing: {
        approvalSecret: "approve-secret",
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        onPairApprovalRequested,
        onPairApproved,
        dangerouslyAutoApprove: true,
        serverIdentity,
        sessions,
      },
      workspacePath: "/tmp/codex-relay",
    });

    const clientPrivateKey = x25519.utils.randomSecretKey();
    const matchedPairing = await app.request("http://127.0.0.1/v1/pair", {
      method: "POST",
      body: JSON.stringify({
        clientName: "test phone",
        secure: {
          clientEphemeralPublicKey: fromByteArray(x25519.getPublicKey(clientPrivateKey)),
          clientNonce: fromByteArray(randomBytes(32)),
          protocolVersion: 1,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const matchedBody = await matchedPairing.json();
    expect(matchedPairing.status).toBe(202);
    expect((await app.request(`/v1/pair/${matchedBody.approvalCode}`)).status).toBe(201);
    expect(onPairApproved).toHaveBeenCalledWith({
      approvalCode: matchedBody.approvalCode,
      clientName: "test phone",
    });
    expect(onPairApprovalRequested).not.toHaveBeenCalled();
  });

  it("starts a thread and runs an initial prompt", async () => {
    const app = createApp({ codex: createMockCodex() });

    const response = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ prompt: "Inspect the project" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread).toMatchObject({
      id: "thread-1",
      title: "Inspect the project",
      state: "completed",
      lastPrompt: "Inspect the project",
    });
    expect(body.result).toBe("result: Inspect the project");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "Inspect the project" });
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      content: "result: Inspect the project",
    });
  });

  it("persists collaboration mode in thread summaries", async () => {
    const app = createApp({ codex: createMockCodex() });

    const response = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ collaborationMode: "plan", title: "Plan thread" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();
    const listResponse = await app.request("/v1/threads");
    const listBody = await listResponse.json();

    expect(response.status).toBe(201);
    expect(body.thread).toMatchObject({ collaborationMode: "plan" });
    expect(listBody.threads[0]).toMatchObject({ collaborationMode: "plan" });
  });

  it("filters app-server threads by selected workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const selectedWorkspacePath = await mkdtemp(join(tmpdir(), "codex-relay-selected-"));
    const otherWorkspacePath = await mkdtemp(join(tmpdir(), "codex-relay-other-"));
    const selectedThread = appServerHistoryThread({
      id: "selected-thread",
      name: "Selected workspace",
      turns: [],
      workspacePath: selectedWorkspacePath,
    });
    const otherThread = appServerHistoryThread({
      id: "other-thread",
      name: "Other workspace",
      turns: [],
      workspacePath: otherWorkspacePath,
    });
    const listThreads = vi.fn<(limit?: number) => Promise<unknown[]>>(async () => [
      selectedThread,
      otherThread,
    ]);
    const appServer = {
      listThreads,
    } as unknown as NonNullable<Parameters<typeof createApp>[0]>["appServer"];
    const app = createApp({ appServer, codex: createMockCodex(), workspacePath });

    const filteredResponse = await app.request(
      `/v1/threads?workspacePath=${encodeURIComponent(selectedWorkspacePath)}`,
    );
    const filteredBody = await filteredResponse.json();
    const defaultResponse = await app.request("/v1/threads");
    const defaultBody = await defaultResponse.json();

    expect(filteredResponse.status).toBe(200);
    expect(filteredBody.threads.map((thread: { id: string }) => thread.id)).toEqual([
      "selected-thread",
    ]);
    expect(defaultBody.threads.map((thread: { id: string }) => thread.id).sort()).toEqual([
      "other-thread",
      "selected-thread",
    ]);
    expect(listThreads).toHaveBeenCalledWith(500);
    expect(listThreads).toHaveBeenCalledTimes(1);
  });

  it("subscribes to active external app-server threads discovered by the thread list", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const runningThread = {
      ...appServerHistoryThread({
        id: "external-running-thread",
        name: "External running thread",
        turns: [],
        workspacePath,
      }),
      source: "cli",
      status: { type: "active" },
    };
    const idleThread = appServerHistoryThread({
      id: "external-idle-thread",
      name: "External idle thread",
      turns: [],
      workspacePath,
    });
    const alreadySubscribedThread = {
      ...runningThread,
      id: "already-subscribed-thread",
    };
    const subscribedThreadIds = new Set([alreadySubscribedThread.id]);
    const resumeThread = vi.fn<({ threadId }: { threadId: string }) => Promise<unknown>>(
      async ({ threadId }) => {
        subscribedThreadIds.add(threadId);
        return [runningThread, idleThread, alreadySubscribedThread].find(
          (thread) => thread.id === threadId,
        );
      },
    );
    const appServer = {
      isThreadSubscribed: (threadId: string) => subscribedThreadIds.has(threadId),
      listThreads: async () => [runningThread, idleThread, alreadySubscribedThread],
      resumeThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads");

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(resumeThread).toHaveBeenCalledTimes(1));
    expect(resumeThread).toHaveBeenCalledWith({
      excludeTurns: true,
      threadId: runningThread.id,
    });
  });

  it("subscribes to active external threads during shared app-server startup", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const runningThread = {
      ...appServerHistoryThread({
        id: "startup-external-running-thread",
        name: "Startup external running thread",
        turns: [],
        workspacePath,
      }),
      source: "cli",
      status: { type: "active" },
    };
    const subscribedThreadIds = new Set<string>();
    const resumeThread = vi.fn<({ threadId }: { threadId: string }) => Promise<unknown>>(
      async ({ threadId }) => {
        subscribedThreadIds.add(threadId);
        return runningThread;
      },
    );
    const appServer = {
      appServerMode: "socket",
      isThreadSubscribed: (threadId: string) => subscribedThreadIds.has(threadId),
      listThreads: async () => [runningThread],
      resumeThread,
    };

    createApp({ appServer: appServer as never, codex: createMockCodex(), workspacePath });

    await vi.waitFor(() => expect(resumeThread).toHaveBeenCalledTimes(1));
    expect(resumeThread).toHaveBeenCalledWith({
      excludeTurns: true,
      threadId: runningThread.id,
    });
  });

  it("starts a new thread in the selected workspace directory", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const externalPath = await mkdtemp(join(tmpdir(), "codex-relay-external-"));
    const appPath = join(externalPath, "apps");
    await mkdir(appPath);
    const startOptions: Parameters<CodexClient["startThread"]>[0][] = [];
    const app = createApp({
      codex: createMockCodex({ onStartThread: (options) => startOptions.push(options) }),
      workspacePath,
    });

    const response = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Mobile app", workspacePath: appPath }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(startOptions[0]).toMatchObject({ workingDirectory: appPath });
    expect(body.thread).toMatchObject({ cwd: appPath });
  });

  it("archives in-memory threads", async () => {
    const app = createApp({ codex: createMockCodex() });

    const firstResponse = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "First thread" }),
      headers: { "content-type": "application/json" },
    });
    const firstBody = await firstResponse.json();
    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Second thread" }),
      headers: { "content-type": "application/json" },
    });

    const archiveResponse = await app.request(`/v1/threads/${firstBody.thread.id}`, {
      method: "DELETE",
    });
    const archiveBody = await archiveResponse.json();
    const detailResponse = await app.request(`/v1/threads/${firstBody.thread.id}`);

    expect(archiveResponse.status).toBe(200);
    expect(archiveBody).toMatchObject({
      archivedThreadId: firstBody.thread.id,
      source: "memory",
    });
    expect(archiveBody.threads).toHaveLength(1);
    expect(archiveBody.threads[0].title).toBe("Second thread");
    expect(detailResponse.status).toBe(404);
  });

  it("archives app-server threads through the Codex app-server", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const remainingThread = {
      id: "app-thread-remaining",
      preview: "Remaining thread",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      cwd: workspacePath,
      source: "app-server",
      modelProvider: "openai",
      name: "Remaining thread",
      turns: [],
    };
    const archiveThread = vi.fn<(params: { threadId: string }) => Promise<void>>(
      async () => undefined,
    );
    const appServer = {
      archiveThread,
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [remainingThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => remainingThread),
      startThread: vi.fn<() => Promise<unknown>>(async () => remainingThread),
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    await threadCoordinator.acquireThreadOwner({
      capabilities: {
        approve: true,
        configure: true,
        interrupt: true,
        queue: true,
        send: true,
        steer: true,
        view: true,
      },
      ownerId: "relay-archive",
      ownerInstanceId: "process-archive",
      ownerType: "relay_app_server",
      threadId: "app-thread-archive",
    });
    let ownerReadCount = 0;
    const racingThreadCoordinator = {
      ...threadCoordinator,
      async getThreadOwner(threadId: string) {
        const owner = await threadCoordinator.getThreadOwner(threadId);
        ownerReadCount += 1;
        if (ownerReadCount === 2) {
          await threadCoordinator.acquireThreadOwner({
            capabilities: owner!.capabilities,
            ownerId: "relay-archive-replacement",
            ownerInstanceId: "process-archive-replacement",
            ownerType: "relay_app_server",
            threadId,
          });
        }
        return owner;
      },
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator: racingThreadCoordinator,
      workspacePath,
    });

    const staleResponse = await app.request("/v1/threads/app-thread-archive", {
      method: "DELETE",
      body: JSON.stringify({ expectedOwnerEpoch: 2 }),
      headers: { "content-type": "application/json" },
    });
    expect(staleResponse.status).toBe(409);
    expect(archiveThread).not.toHaveBeenCalled();

    const racedResponse = await app.request("/v1/threads/app-thread-archive", {
      method: "DELETE",
      body: JSON.stringify({ expectedOwnerEpoch: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(racedResponse.status).toBe(409);
    expect(archiveThread).not.toHaveBeenCalled();

    const response = await app.request("/v1/threads/app-thread-archive", {
      method: "DELETE",
      body: JSON.stringify({ expectedOwnerEpoch: 2 }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(archiveThread).toHaveBeenCalledWith({ threadId: "app-thread-archive" });
    expect(body).toMatchObject({
      archivedThreadId: "app-thread-archive",
      source: "app-server",
    });
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({
      id: "app-thread-remaining",
      title: "Remaining thread",
    });
  });

  it("renames an app-server thread", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const originalThread = appServerHistoryThread({
      id: "app-thread-rename",
      name: "Original chat",
      turns: [],
      workspacePath,
    });
    const renamedThread = appServerHistoryThread({
      id: "app-thread-rename",
      name: "Renamed chat",
      turns: [],
      workspacePath,
    });
    let readCount = 0;
    const readThread = vi.fn<() => Promise<unknown>>(async () => {
      readCount += 1;
      return readCount === 1 ? originalThread : renamedThread;
    });
    const setThreadName = vi.fn<() => Promise<unknown>>(async () => ({}));
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
      setThreadName,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-rename/name", {
      method: "POST",
      body: JSON.stringify({ title: "Renamed chat" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(setThreadName).toHaveBeenCalledWith({
      name: "Renamed chat",
      threadId: "app-thread-rename",
    });
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(body.thread).toMatchObject({ id: "app-thread-rename", title: "Renamed chat" });
  });

  it("refreshes app-server thread details from full turn history even after a stale running cache", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const runningThread = appServerHistoryThread({
      id: "app-thread-refresh-terminal-output",
      name: "Refresh terminal output",
      turns: [],
      workspacePath,
    });
    const idleThread = {
      ...runningThread,
      status: { type: "idle" },
      updatedAt: now + 5,
    };
    const completedThread = appServerHistoryThread({
      id: "app-thread-refresh-terminal-output",
      name: "Refresh terminal output",
      turns: [appServerTurn("turn-final-refresh", "Final prompt", now)],
      workspacePath,
    });
    let readThreadCalls = 0;
    const readThread = vi.fn<
      (threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => {
      readThreadCalls += 1;
      if (options?.includeTurns) {
        return completedThread;
      }
      return readThreadCalls === 1 ? runningThread : idleThread;
    });
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const initialResponse = await app.request("/v1/threads/app-thread-refresh-terminal-output");
    const refreshResponse = await app.request(
      "/v1/threads/app-thread-refresh-terminal-output?refresh=true",
    );
    const refreshBody = await refreshResponse.json();

    expect(initialResponse.status).toBe(200);
    expect(refreshResponse.status).toBe(200);
    expect(refreshBody.thread).toMatchObject({ id: "app-thread-refresh-terminal-output" });
    expect(refreshBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "turn-final-refresh-assistant",
          content: "Reply: Final prompt",
          role: "assistant",
        }),
      ]),
    );
  });

  it("rewinds an app-server thread from a selected user turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const beforeRewind = {
      ...appServerHistoryThread({
        id: "app-thread-rewind",
        name: "Rewind history",
        turns: [
          appServerTurn("turn-1", "First prompt", now),
          appServerTurn("turn-2", "Second prompt", now + 10),
        ],
        workspacePath,
      }),
      historyMode: "paginated" as const,
    };
    const afterRewind = {
      ...appServerHistoryThread({
        id: "app-thread-rewind",
        name: "Rewind history",
        turns: [appServerTurn("turn-1", "First prompt", now)],
        workspacePath,
      }),
      historyMode: "paginated" as const,
    };
    const rollbackThread = vi.fn<() => Promise<unknown>>(async () => afterRewind);
    const revertThread = vi.fn<() => Promise<unknown>>(async () => afterRewind);
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => beforeRewind),
      revertThread,
      rollbackThread,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    await threadCoordinator.acquireThreadOwner({
      capabilities: {
        approve: true,
        configure: true,
        interrupt: true,
        queue: true,
        send: true,
        steer: true,
        view: true,
      },
      ownerId: "relay-rewind",
      ownerInstanceId: "process-rewind",
      ownerType: "relay_app_server",
      threadId: "app-thread-rewind",
    });
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator,
      workspacePath,
    });

    const staleResponse = await app.request("/v1/threads/app-thread-rewind/rollback", {
      method: "POST",
      body: JSON.stringify({ expectedOwnerEpoch: 2, turnId: "turn-2" }),
      headers: { "content-type": "application/json" },
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: { code: "stale_owner_epoch" },
    });
    expect(rollbackThread).not.toHaveBeenCalled();

    const response = await app.request("/v1/threads/app-thread-rewind/rollback", {
      method: "POST",
      body: JSON.stringify({ expectedOwnerEpoch: 1, turnId: "turn-2" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(revertThread).toHaveBeenCalledWith({
      beforeTurnId: "turn-2",
      threadId: "app-thread-rewind",
    });
    expect(rollbackThread).not.toHaveBeenCalled();
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([
      "turn-1-user",
      "turn-1-assistant",
    ]);
  });

  it("uses legacy rollback instead of paginated revert for legacy history", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const beforeRewind = {
      ...appServerHistoryThread({
        id: "app-thread-legacy-rewind",
        name: "Legacy rewind",
        turns: [
          appServerTurn("turn-1", "First prompt", now),
          appServerTurn("turn-2", "Second prompt", now + 10),
        ],
        workspacePath,
      }),
      historyMode: "legacy" as const,
    };
    const afterRewind = {
      ...beforeRewind,
      turns: [appServerTurn("turn-1", "First prompt", now)],
    };
    const rollbackThread = vi.fn<() => Promise<unknown>>(async () => afterRewind);
    const revertThread = vi.fn<() => Promise<unknown>>(async () => afterRewind);
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => beforeRewind),
      revertThread,
      rollbackThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-legacy-rewind/rollback", {
      method: "POST",
      body: JSON.stringify({ turnId: "turn-2" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(rollbackThread).toHaveBeenCalledWith({
      numTurns: 1,
      threadId: "app-thread-legacy-rewind",
    });
    expect(revertThread).not.toHaveBeenCalled();
  });

  it("serializes rewind with an app-server turn start", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const idleThread = appServerHistoryThread({
      id: "app-thread-rewind-race",
      name: "Rewind race",
      turns: [appServerTurn("turn-1", "First prompt", now)],
      workspacePath,
    });
    let currentThread = idleThread;
    let signalStartTurn: () => void = () => undefined;
    const startTurnStarted = new Promise<void>((resolve) => {
      signalStartTurn = resolve;
    });
    let releaseStartTurn: () => void = () => undefined;
    const startTurnReleased = new Promise<void>((resolve) => {
      releaseStartTurn = resolve;
    });
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      signalStartTurn();
      await startTurnReleased;
      currentThread = {
        ...idleThread,
        status: { type: "running" },
      };
      return {
        id: "turn-2",
        completedAt: null,
        items: [],
        startedAt: now + 10,
        status: { type: "running" },
      };
    });
    const rollbackThread = vi.fn<() => Promise<unknown>>(async () => idleThread);
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => currentThread),
      rollbackThread,
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const streamResponse = await app.request("/v1/threads/app-thread-rewind-race/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Second prompt" }),
      headers: { "content-type": "application/json" },
    });
    await startTurnStarted;
    const rewindResponsePromise = app.request("/v1/threads/app-thread-rewind-race/rollback", {
      method: "POST",
      body: JSON.stringify({ turnId: "turn-1" }),
      headers: { "content-type": "application/json" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseStartTurn();
    const rewindResponse = await rewindResponsePromise;
    await streamResponse.body?.cancel();

    expect(streamResponse.status).toBe(200);
    expect(rewindResponse.status).toBe(409);
    expect(rollbackThread).not.toHaveBeenCalled();
  });

  it("refreshes an app-server thread from its current history", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    let currentThread = appServerHistoryThread({
      id: "app-thread-refresh",
      name: "Refresh history",
      turns: [
        appServerTurn("turn-1", "First prompt", now),
        appServerTurn("turn-2", "Second prompt", now + 10),
      ],
      workspacePath,
    });
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => currentThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads/app-thread-refresh");
    currentThread = appServerHistoryThread({
      id: "app-thread-refresh",
      name: "Refresh history",
      turns: [appServerTurn("turn-1", "First prompt", now)],
      workspacePath,
    });
    const response = await app.request("/v1/threads/app-thread-refresh?refresh=true");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread.messageCount).toBe(2);
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([
      "turn-1-user",
      "turn-1-assistant",
    ]);
  });

  it("reads an app-server thread goal", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-goal",
      preview: "Thread with goal",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      cwd: workspacePath,
      source: "app",
      modelProvider: "openai",
      name: "Thread with goal",
      turns: [],
    };
    const appServer = {
      getThreadGoal: vi.fn<() => Promise<unknown>>(async () => ({
        threadId: "app-thread-goal",
        objective: "Ship goal UI",
        status: "active",
        tokenBudget: null,
        tokensUsed: 321,
        timeUsedSeconds: 42,
        createdAt: now,
        updatedAt: now,
      })),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-goal/goal");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(appServer.getThreadGoal).toHaveBeenCalledWith({ threadId: "app-thread-goal" });
    expect(body).toMatchObject({
      goal: {
        objective: "Ship goal UI",
        status: "active",
        timeUsedSeconds: 42,
        tokensUsed: 321,
      },
      thread: {
        goal: {
          objective: "Ship goal UI",
          status: "active",
        },
        id: "app-thread-goal",
      },
    });
  });

  it("updates and clears an app-server thread goal", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-goal-actions",
      preview: "Thread with editable goal",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      cwd: workspacePath,
      source: "app",
      modelProvider: "openai",
      name: "Thread with editable goal",
      turns: [],
    };
    const setThreadGoal = vi.fn<() => Promise<unknown>>(async () => ({
      threadId: "app-thread-goal-actions",
      objective: "Updated objective",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 7,
      timeUsedSeconds: 11,
      createdAt: now,
      updatedAt: now,
    }));
    const clearThreadGoal = vi.fn<() => Promise<void>>(async () => undefined);
    const appServer = {
      clearThreadGoal,
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      setThreadGoal,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    await threadCoordinator.acquireThreadOwner({
      capabilities: {
        approve: true,
        configure: true,
        interrupt: true,
        queue: true,
        send: true,
        steer: true,
        view: true,
      },
      ownerId: "relay-goal",
      ownerInstanceId: "process-goal",
      ownerType: "relay_app_server",
      threadId: "app-thread-goal-actions",
    });
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator,
      workspacePath,
    });

    const staleUpdateResponse = await app.request("/v1/threads/app-thread-goal-actions/goal", {
      method: "POST",
      body: JSON.stringify({ expectedOwnerEpoch: 2, objective: "Stale objective" }),
      headers: { "content-type": "application/json" },
    });
    expect(staleUpdateResponse.status).toBe(409);
    expect(setThreadGoal).not.toHaveBeenCalled();

    const updateResponse = await app.request("/v1/threads/app-thread-goal-actions/goal", {
      method: "POST",
      body: JSON.stringify({
        expectedOwnerEpoch: 1,
        objective: "Updated objective",
        status: "paused",
      }),
      headers: { "content-type": "application/json" },
    });
    const updateBody = await updateResponse.json();
    const staleClearResponse = await app.request("/v1/threads/app-thread-goal-actions/goal", {
      method: "DELETE",
      body: JSON.stringify({ expectedOwnerEpoch: 2 }),
      headers: { "content-type": "application/json" },
    });
    expect(staleClearResponse.status).toBe(409);
    expect(clearThreadGoal).not.toHaveBeenCalled();
    const clearResponse = await app.request("/v1/threads/app-thread-goal-actions/goal", {
      method: "DELETE",
      body: JSON.stringify({ expectedOwnerEpoch: 1 }),
      headers: { "content-type": "application/json" },
    });
    const clearBody = await clearResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(setThreadGoal).toHaveBeenCalledWith({
      threadId: "app-thread-goal-actions",
      objective: "Updated objective",
      status: "paused",
      tokenBudget: undefined,
    });
    expect(updateBody.thread.goal).toMatchObject({
      objective: "Updated objective",
      status: "paused",
    });
    expect(clearResponse.status).toBe(200);
    expect(clearThreadGoal).toHaveBeenCalledWith({ threadId: "app-thread-goal-actions" });
    expect(clearBody.goal).toBeNull();
    expect(clearBody.thread.goal).toBeNull();
  });

  it("preserves active state for empty app-server threads", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-empty-active",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Empty active",
        preview: "Empty active",
        source: "app",
        status: { type: "active" },
        turns: [],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "New chat" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.thread).toMatchObject({
      id: "app-thread-empty-active",
      state: "running",
      messageCount: 0,
    });
  });

  it("attaches to an already-running empty app-server thread", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const cleanupNotificationHandler = vi.fn<() => void>();
    const cleanupRequestHandler = vi.fn<() => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-empty-stream",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Empty stream",
      preview: "Empty stream",
      source: "app",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => {
          cleanupNotificationHandler();
          notificationHandlers.delete(handler);
        };
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => {
          cleanupRequestHandler();
          requestHandlers.delete(handler);
        };
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => {
        return appThread;
      }),
      resumeThread: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "thread/status/changed",
              params: { status: { type: "idle" }, threadId: "app-thread-empty-stream" },
            });
          }
        });
        return appThread;
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-empty-stream/runs/stream", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const stateEvents = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)
      .filter((event) => event.type === "thread.state.changed");

    expect(response.status).toBe(200);
    expect(appServer.resumeThread).toHaveBeenCalledWith({
      excludeTurns: true,
      threadId: "app-thread-empty-stream",
    });
    expect(body).toContain('"state":"idle"');
    expect((stateEvents.at(-1)?.thread as { state?: string } | undefined)?.state).toBe("idle");
    expect(notificationHandlers).toHaveLength(1);
    expect(requestHandlers).toHaveLength(0);
    expect(cleanupNotificationHandler).toHaveBeenCalledTimes(1);
    expect(cleanupRequestHandler).toHaveBeenCalledTimes(1);

    appThread.status = { type: "idle" };
    for (const handler of notificationHandlers) {
      handler({
        method: "item/completed",
        params: {
          item: {
            id: "late-background-item",
            type: "commandExecution",
            command: "pnpm test",
            aggregatedOutput: "passed",
            status: "completed",
          },
          threadId: appThread.id,
          turnId: "completed-turn",
        },
      });
    }
    const detailResponse = await app.request(`/v1/threads/${appThread.id}`);
    const detail = await detailResponse.json();
    expect(detail.messages).toContainEqual(
      expect.objectContaining({
        id: "late-background-item",
        kind: "commandExecution",
        role: "tool",
      }),
    );
  });

  it("keeps external active-writer attachments readable without failing the thread", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const threadId = "app-thread-external-writer-attachment";
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "External writer attachment",
      preview: "External writer attachment",
      source: "cli",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      resumeThread: vi.fn<() => Promise<never>>(async () => {
        throw new Error(`thread ${threadId} already has an active writer`);
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });
    const response = await app.request(`/v1/threads/${threadId}/runs/stream`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      const decoder = new TextDecoder();
      let body = "";
      for (let reads = 0; reads < 4 && !body.includes("\n\n"); reads += 1) {
        const chunk = await reader!.read();
        body += decoder.decode(chunk.value, { stream: true });
      }

      expect(response.status).toBe(200);
      expect(body).toContain("thread.state.changed");
      expect(body).toContain('"state":"running"');
      expect(body).not.toContain("thread.error");
      expect(body).not.toContain("codex_run_failed");

      const detailResponse = await app.request(`/v1/threads/${threadId}`);
      const detail = await detailResponse.json();
      expect(detail).toMatchObject({ thread: { id: threadId, state: "running" } });
      expect(detail.thread).not.toHaveProperty("lastError");
    } finally {
      await reader!.cancel("test complete");
    }
  });

  it("does not accumulate preview probes or app-server handlers across cancelled attachments", async () => {
    vi.useFakeTimers();
    const previousPreviewPorts = process.env.CODEX_RELAY_WEB_PREVIEW_PORTS;
    process.env.CODEX_RELAY_WEB_PREVIEW_PORTS = "65534";
    const probeSignals: AbortSignal[] = [];
    const fetchPreview = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected preview probe to include an AbortSignal.");
      }
      probeSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchPreview);

    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const cleanupNotificationHandler = vi.fn<() => void>();
    const cleanupRequestHandler = vi.fn<() => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-cancelled-stream",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Cancelled stream",
      preview: "Cancelled stream",
      source: "app",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => {
          cleanupNotificationHandler();
          notificationHandlers.delete(handler);
        };
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => {
          cleanupRequestHandler();
          requestHandlers.delete(handler);
        };
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      for (let attachment = 1; attachment <= 3; attachment += 1) {
        const response = await app.request("/v1/threads/app-thread-cancelled-stream/runs/stream", {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        });
        reader = response.body?.getReader();
        expect(reader).toBeDefined();
        await reader!.read();
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchPreview).toHaveBeenCalledTimes(attachment);
        expect(notificationHandlers).toHaveLength(2);
        expect(requestHandlers).toHaveLength(1);

        await reader!.cancel("test cancellation");
        reader = undefined;

        expect(probeSignals[attachment - 1]?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(4500);
        expect(fetchPreview).toHaveBeenCalledTimes(attachment);
        expect(notificationHandlers).toHaveLength(1);
        expect(requestHandlers).toHaveLength(0);
        expect(cleanupNotificationHandler).toHaveBeenCalledTimes(attachment);
        expect(cleanupRequestHandler).toHaveBeenCalledTimes(attachment);
      }
    } finally {
      await reader?.cancel().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      if (previousPreviewPorts === undefined) {
        delete process.env.CODEX_RELAY_WEB_PREVIEW_PORTS;
      } else {
        process.env.CODEX_RELAY_WEB_PREVIEW_PORTS = previousPreviewPorts;
      }
    }
  });

  it("stops scanning after detecting the first configured web preview target", async () => {
    vi.useFakeTimers();
    const previousPreviewPorts = process.env.CODEX_RELAY_WEB_PREVIEW_PORTS;
    process.env.CODEX_RELAY_WEB_PREVIEW_PORTS = "65533,65534";
    const fetchPreview = vi.fn<typeof fetch>(
      async () =>
        new Response("<!doctype html><html><title>Preview</title></html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchPreview);

    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-preview-detected",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Preview detected",
      preview: "Preview detected",
      source: "app",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await app.request("/v1/threads/app-thread-preview-detected/runs/stream", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      let streamedText = "";
      for (let reads = 0; reads < 6 && !streamedText.includes('"port":65533'); reads += 1) {
        const result = await reader!.read();
        expect(result.done).toBe(false);
        streamedText += decoder.decode(result.value, { stream: true });
      }

      expect(streamedText).toContain('"port":65533');
      expect(streamedText.match(/"type":"thread\.preview_target\.detected"/g)).toHaveLength(1);
      expect(fetchPreview).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4500);
      expect(fetchPreview).toHaveBeenCalledTimes(2);
    } finally {
      await reader?.cancel().catch(() => undefined);
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      if (previousPreviewPorts === undefined) {
        delete process.env.CODEX_RELAY_WEB_PREVIEW_PORTS;
      } else {
        process.env.CODEX_RELAY_WEB_PREVIEW_PORTS = previousPreviewPorts;
      }
    }
  });

  it("keeps attached running app-server streams alive through transient idle status", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-transient-idle",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Transient idle",
      preview: "Transient idle",
      source: "app",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/started",
              params: {
                threadId: "app-thread-transient-idle",
                turnId: "turn-transient-idle",
              },
            });
            handler({
              method: "thread/status/changed",
              params: {
                status: { type: "idle" },
                threadId: "app-thread-transient-idle",
              },
            });
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "still running",
                itemId: "assistant-transient-idle",
                threadId: "app-thread-transient-idle",
                turnId: "turn-transient-idle",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-transient-idle",
                turn: {
                  id: "turn-transient-idle",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                  durationMs: 1,
                },
              },
            });
          }
        });
        return appThread;
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-transient-idle/runs/stream", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const idleIndex = body.indexOf('"state":"idle"');
    const deltaIndex = body.indexOf("still running");
    const completedIndex = body.indexOf('"state":"completed"');

    expect(response.status).toBe(200);
    expect(idleIndex).toBe(-1);
    expect(deltaIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(deltaIndex);
  });

  it("treats an in-progress app-server turn as a running thread", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-in-progress-turn",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "In progress turn",
        preview: "In progress turn",
        source: "app",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-in-progress",
            completedAt: null,
            items: [],
            startedAt: now,
            status: "inProgress",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-in-progress-turn");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread).toMatchObject({
      id: "app-thread-in-progress-turn",
      state: "running",
    });
  });

  it("treats non-terminal in-flight turn status variants as running", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-working-turn",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Working turn",
        preview: "Working turn",
        source: "app",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-working",
            completedAt: null,
            items: [],
            startedAt: now,
            status: { type: "working" },
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-working-turn");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread).toMatchObject({
      id: "app-thread-working-turn",
      state: "running",
    });
  });

  it("does not treat completed working turn status as running", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-completed-working-turn",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Completed working turn",
        preview: "Completed working turn",
        source: "app",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-working-completed",
            completedAt: now,
            items: [],
            startedAt: now,
            status: { type: "working" },
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-completed-working-turn");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread).toMatchObject({
      id: "app-thread-completed-working-turn",
      state: "idle",
    });
  });

  it("truncates large app server tool details in thread detail responses", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const largeOutput = `stdout-start\n${"o".repeat(12000)}\nstdout-end`;
    const largePatch = `diff-start\n${"p".repeat(12000)}\ndiff-end`;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-large-details",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Large details",
        preview: "Large details",
        source: "app",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-large-details",
            completedAt: now,
            items: [
              {
                id: "command-large",
                type: "commandExecution",
                command: "pnpm test",
                aggregatedOutput: largeOutput,
                status: "completed",
              },
              {
                id: "patch-large",
                type: "fileChange",
                changes: [{ kind: "modified", path: "src/app.ts" }],
                patch: largePatch,
              },
            ],
            startedAt: now,
            status: { type: "completed" },
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-large-details");
    const body = await response.json();
    const commandDetails = body.messages[0].details;
    const patchDetails = body.messages[1].details;

    expect(response.status).toBe(200);
    expect(commandDetails.output).toContain("[... truncated ");
    expect(commandDetails.output).toContain("stdout-start");
    expect(commandDetails.output).toContain("stdout-end");
    expect(commandDetails.output.length).toBeLessThan(largeOutput.length);
    expect(commandDetails.outputOriginalLength).toBe(largeOutput.length);
    expect(commandDetails.outputTruncated).toBe(true);
    expect(body.messages[1]).toMatchObject({
      content: "1 file changed: src/app.ts",
      id: "patch-large",
      kind: "fileChange",
      role: "tool",
    });
    expect(patchDetails.patch).toContain("[... truncated ");
    expect(patchDetails.patch).toContain("diff-start");
    expect(patchDetails.patch).toContain("diff-end");
    expect(patchDetails.patch.length).toBeLessThan(largePatch.length);
    expect(patchDetails.patchOriginalLength).toBe(largePatch.length);
    expect(patchDetails.patchTruncated).toBe(true);

    const outputResponse = await app.request(
      "/v1/threads/app-thread-large-details/messages/command-large/details/output",
    );
    const outputBody = await outputResponse.json();
    const patchResponse = await app.request(
      "/v1/threads/app-thread-large-details/messages/patch-large/details/patch",
    );
    const patchBody = await patchResponse.json();

    expect(outputResponse.status).toBe(200);
    expect(outputBody).toEqual({
      field: "output",
      messageId: "command-large",
      originalLength: largeOutput.length,
      value: largeOutput,
    });
    expect(patchResponse.status).toBe(200);
    expect(patchBody).toEqual({
      field: "patch",
      messageId: "patch-large",
      originalLength: largePatch.length,
      value: largePatch,
    });
  });

  it("adds plan-only guidance for SDK fallback plan mode", async () => {
    const app = createApp({ codex: createMockCodex() });

    const response = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ collaborationMode: "plan", prompt: "Sketch the migration" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result).toContain("# Plan Mode (Conversational)");
    expect(body.result).toContain("wrap it in a `<proposed_plan>` block");
    expect(body.result).toContain("User request:\nSketch the migration");
  });

  it("passes app-server collaboration mode on streamed plan runs", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async (_params) => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: { status: "completed", threadId: "app-thread-1", turnId: "turn-1" },
          });
        }
      });
      return { id: "turn-1", items: [], status: "completed", startedAt: null, completedAt: null };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-1",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Plan thread",
        preview: "Plan thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Plan thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-1/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        collaborationMode: "plan",
        model: "gpt-5.6-sol",
        prompt: "Plan this",
        reasoningEffort: "ultra",
      }),
      headers: { "content-type": "application/json" },
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: {
          mode: "plan",
          settings: {
            developer_instructions: null,
            model: "gpt-5.6-sol",
            reasoning_effort: "ultra",
          },
        },
      }),
    );
  });

  it("passes selected skills as structured app-server input items", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: { status: "completed", threadId: "app-thread-skills", turnId: "turn-1" },
          });
        }
      });
      return { id: "turn-1", items: [], status: "completed", startedAt: null, completedAt: null };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-skills",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Skill thread",
        preview: "Skill thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });
    const skillPath = join(workspacePath, ".agents", "skills", "dogfood", "SKILL.md");

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Skill thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-skills/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        prompt: `Use this skill [$dogfood](${skillPath})`,
        skills: [
          {
            name: "dogfood",
            path: skillPath,
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(`Use this skill [$dogfood](${skillPath})`);
    expect(body).not.toContain('"details":{"skills"');
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            type: "text",
            text: `Use this skill [$dogfood](${skillPath})`,
            text_elements: [],
          },
          { type: "skill", name: "dogfood", path: skillPath },
        ],
      }),
    );
  });

  it("passes image attachments as structured app-server local image input", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const imagePath = join(workspacePath, "photo.png");
    await writeFile(imagePath, Buffer.from("image"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: { status: "completed", threadId: "app-thread-image", turnId: "turn-1" },
          });
        }
      });
      return { id: "turn-1", items: [], status: "completed", startedAt: null, completedAt: null };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-image",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Image thread",
        preview: "Image thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });
    const attachment = {
      mimeType: "image/png",
      name: "photo.png",
      path: imagePath,
      type: "image" as const,
      url: "/v1/attachments/images/photo.png",
    };

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Image thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-image/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        attachments: [attachment],
        prompt: "Describe this",
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Describe this");
    expect(body).toContain("Attached image 1 (photo.png)");
    expect(body).toContain('"content":"Describe this\\n\\nAttached image 1 (photo.png)"');
    expect(body).not.toContain("data:image/png;base64");
    expect(body).not.toContain('"dataUri"');
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          { type: "text", text: "Describe this", text_elements: [] },
          { type: "localImage", path: imagePath },
        ],
      }),
    );
  });

  it("uploads multiple image attachments from repeated multipart fields", async () => {
    const app = createApp({ codex: createMockCodex(), workspacePath: "/tmp/codex-relay" });
    const formData = new FormData();
    formData.append("images", new Blob([Buffer.from("one")], { type: "image/png" }), "one.png");
    formData.append("images", new Blob([Buffer.from("two")], { type: "image/png" }), "two.png");
    formData.append("images", new Blob([Buffer.from("three")], { type: "image/png" }), "three.png");

    const response = await app.request("/v1/attachments/images", {
      method: "POST",
      body: formData,
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.attachments).toHaveLength(3);
    expect(body.attachments.map((attachment: { name: string }) => attachment.name)).toEqual([
      "one.png",
      "two.png",
      "three.png",
    ]);
    for (const attachment of body.attachments as Array<{ url: string }>) {
      const imageResponse = await app.request(attachment.url);
      expect(imageResponse.status).toBe(200);
    }
  });

  it("hides Codex-injected context from app-server user message history", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-injected-context",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Injected context history",
        preview: "Injected context history",
        source: "app",
        status: "idle",
        turns: [
          {
            id: "turn-1",
            completedAt: now,
            items: [
              {
                id: "injected-context-1",
                content: codexInjectedContextBlocks(workspacePath).map((text) => ({
                  text,
                  text_elements: [],
                  type: "text",
                })),
                type: "userMessage",
              },
              {
                id: "user-1",
                content: [{ text: "ㅎㅇ", text_elements: [], type: "text" }],
                type: "userMessage",
              },
              { id: "assistant-1", text: "안녕하세요", type: "agentMessage" },
            ],
            startedAt: now,
            status: "completed",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-injected-context");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread.messageCount).toBe(2);
    expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
      "ㅎㅇ",
      "안녕하세요",
    ]);
  });

  it("normalizes markdown skill mentions from app-server user message history", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const skillPath = join(workspacePath, ".agents", "skills", "dogfood", "SKILL.md");
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-skill-history",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Skill history",
        preview: "Skill history",
        source: "app",
        status: "idle",
        turns: [
          {
            id: "turn-1",
            completedAt: now,
            items: [
              {
                id: "user-1",
                content: [
                  {
                    text: `Review this [$dogfood](${skillPath})`,
                    text_elements: [],
                    type: "text",
                  },
                  { name: "dogfood", path: skillPath, type: "skill" },
                ],
                type: "userMessage",
              },
            ],
            startedAt: now,
            status: "completed",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-skill-history");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages).toEqual([
      expect.objectContaining({
        content: `Review this [$dogfood](${skillPath})`,
        id: "user-1",
        role: "user",
      }),
    ]);
  });

  it("returns local app-server image history as attachment URLs for mobile thread detail", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const imagePath = join(workspacePath, "photo.png");
    await writeFile(imagePath, Buffer.from("image"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-local-image-history",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "이미지 테스트",
        preview: "이미지 테스트",
        source: "app",
        status: "idle",
        turns: [
          {
            id: "turn-1",
            completedAt: now,
            items: [
              {
                id: "user-1",
                content: [
                  { text: "이미지 테스트", text_elements: [], type: "text" },
                  { path: imagePath, type: "localImage" },
                ],
                type: "userMessage",
              },
            ],
            startedAt: now,
            status: "completed",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-local-image-history");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0]).toMatchObject({
      content: "이미지 테스트\n\nAttached image 1",
      id: "user-1",
      role: "user",
    });
    expect(body.messages[0].details.attachments[0]).toMatchObject({
      mimeType: "image/png",
      name: "photo.png",
      path: expect.any(String),
      type: "image",
      url: expect.stringMatching(/^\/v1\/attachments\/images\/.+\.png\?v=\d+$/),
    });
    expect(body.messages[0].details.attachments[0]).not.toHaveProperty("dataUri");
  });

  it("returns local markdown images in assistant history as attachment URLs", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const imagePath = join(workspacePath, "md-preview-chat.png");
    await writeFile(imagePath, Buffer.from("image"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-assistant-markdown-image-history",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "이미지 응답 테스트",
        preview: "이미지 응답 테스트",
        source: "app",
        status: "idle",
        turns: [
          {
            id: "turn-1",
            completedAt: now,
            items: [
              {
                id: "assistant-1",
                text: `증거 스크린샷:\n![WorkspacePreview on iPhone 17](${imagePath})\n\n완료`,
                type: "agentMessage",
              },
            ],
            startedAt: now,
            status: "completed",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-assistant-markdown-image-history");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0]).toMatchObject({
      content: "증거 스크린샷:\n\n완료",
      id: "assistant-1",
      role: "assistant",
    });
    expect(body.messages[0].details.attachments[0]).toMatchObject({
      mimeType: "image/png",
      name: "WorkspacePreview on iPhone 17",
      path: expect.any(String),
      type: "image",
      url: expect.stringMatching(/^\/v1\/attachments\/images\/.+\.png\?v=\d+$/),
    });
    expect(body.messages[0].details.attachments[0]).not.toHaveProperty("dataUri");
  });

  it("returns app-server document history as markdown attachments for mobile thread detail", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const markdownPath = join(workspacePath, "hermes-v1-async-await-root-cause.md");
    await writeFile(markdownPath, "# Hermes root cause\n");
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-document-history",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "문서 테스트",
        preview: "문서 테스트",
        source: "app",
        status: "idle",
        turns: [
          {
            id: "turn-1",
            completedAt: now,
            items: [
              {
                id: "user-1",
                content: [
                  { text: "문서 테스트", text_elements: [], type: "text" },
                  {
                    mimeType: "text/markdown",
                    name: "hermes-v1-async-await-root-cause.md",
                    path: markdownPath,
                    type: "document",
                  },
                ],
                type: "userMessage",
              },
            ],
            startedAt: now,
            status: "completed",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-document-history");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0]).toMatchObject({
      content: "문서 테스트",
      id: "user-1",
      role: "user",
    });
    expect(body.messages[0].details.attachments[0]).toMatchObject({
      mimeType: "text/markdown",
      name: "hermes-v1-async-await-root-cause.md",
      path: markdownPath,
      type: "document",
    });
  });

  it("lists workspace files for @ mention completion", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await mkdir(join(workspacePath, "apps", "mobile"), { recursive: true });
    await mkdir(join(workspacePath, "packages", "codex-relay"), { recursive: true });
    await writeFile(join(workspacePath, "package.json"), "{}\n");
    await writeFile(join(workspacePath, "apps", "mobile", "package.json"), "{}\n");
    await writeFile(join(workspacePath, "packages", "codex-relay", "package.json"), "{}\n");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace/files?query=pac");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      directory: "",
      parentDirectory: null,
      query: "pac",
      workspacePath,
    });
    expect(body.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          name: "package.json",
          path: "package.json",
        }),
        expect.objectContaining({
          kind: "file",
          name: "package.json",
          path: "apps/mobile/package.json",
        }),
        expect.objectContaining({
          kind: "directory",
          name: "packages",
          path: "packages",
        }),
      ]),
    );
  });

  it("lists direct workspace file children for folder browsing", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await mkdir(join(workspacePath, "apps", "mobile", "src"), { recursive: true });
    await writeFile(join(workspacePath, "apps", "mobile", "package.json"), "{}\n");
    await writeFile(join(workspacePath, "apps", "mobile", "src", "app.tsx"), "export {};\n");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request(
      `/v1/workspace/files?directory=${encodeURIComponent("apps/mobile")}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      directory: "apps/mobile",
      parentDirectory: "apps",
      query: "",
      workspacePath,
    });
    expect(body.files).toEqual([
      expect.objectContaining({
        directory: "apps/mobile",
        kind: "directory",
        name: "src",
        path: "apps/mobile/src",
      }),
      expect.objectContaining({
        directory: "apps/mobile",
        kind: "file",
        name: "package.json",
        path: "apps/mobile/package.json",
      }),
    ]);
  });

  it("hides paths matched by root gitignore from workspace file browsing", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await git(workspacePath, ["init", "-b", "main"]);
    await mkdir(join(workspacePath, "apps", "mobile"), { recursive: true });
    await mkdir(join(workspacePath, "ignored"), { recursive: true });
    await mkdir(join(workspacePath, "apps", "mobile", "dist"), { recursive: true });
    await mkdir(join(workspacePath, "dogfood-output-latest"), { recursive: true });
    await writeFile(
      join(workspacePath, ".gitignore"),
      "ignored/\n*.log\nnode_modules/\ndist/\ndogfood-output-*\n",
    );
    await writeFile(join(workspacePath, "apps", "mobile", "package.json"), "{}\n");
    await writeFile(join(workspacePath, "apps", "mobile", "dist", "bundle.js"), "bundle\n");
    await writeFile(join(workspacePath, "dogfood-output-latest", "report.md"), "report\n");
    await writeFile(join(workspacePath, "ignored", "cache.txt"), "cache\n");
    await writeFile(join(workspacePath, "debug.log"), "debug\n");
    await writeFile(join(workspacePath, "README.md"), "hello\n");
    await git(workspacePath, ["add", ".gitignore", "README.md", "apps/mobile/package.json"]);
    await git(workspacePath, ["add", "-f", "debug.log"]);
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace/files");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "directory",
          name: "apps",
          path: "apps",
        }),
        expect.objectContaining({
          kind: "file",
          name: "README.md",
          path: "README.md",
        }),
      ]),
    );
    expect(body.files).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("ignored"),
        }),
        expect.objectContaining({
          path: expect.stringContaining("dist"),
        }),
        expect.objectContaining({
          path: expect.stringContaining("dogfood-output"),
        }),
        expect.objectContaining({
          path: "debug.log",
        }),
      ]),
    );

    const nestedResponse = await app.request(
      `/v1/workspace/files?directory=${encodeURIComponent("apps/mobile")}`,
    );
    const nestedBody = await nestedResponse.json();

    expect(nestedResponse.status).toBe(200);
    expect(nestedBody.files).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "apps/mobile/dist",
        }),
      ]),
    );

    const searchResponse = await app.request("/v1/workspace/files?query=dogfood");
    const searchBody = await searchResponse.json();

    expect(searchResponse.status).toBe(200);
    expect(searchBody.files).toEqual([]);
  });

  it("reads workspace file content for preview", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "docs", "readme.md"), "# Hello\n\nWorkspace preview.\n");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request(
      `/v1/workspace/file?path=${encodeURIComponent("docs/readme.md")}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      binary: false,
      content: "# Hello\n\nWorkspace preview.\n",
      directory: "docs",
      language: "markdown",
      name: "readme.md",
      path: "docs/readme.md",
      truncated: false,
      workspacePath,
    });
    expect(body.size).toBeGreaterThan(0);
  });

  it("updates workspace file content for mobile editing", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "docs", "readme.md"), "# Hello\n");
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace/file", {
      body: JSON.stringify({
        content: "# Updated\n\nSaved from mobile.\n",
        path: "docs/readme.md",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      binary: false,
      content: "# Updated\n\nSaved from mobile.\n",
      directory: "docs",
      language: "markdown",
      name: "readme.md",
      path: "docs/readme.md",
      truncated: false,
      workspacePath,
    });
    await expect(readFile(join(workspacePath, "docs", "readme.md"), "utf8")).resolves.toBe(
      "# Updated\n\nSaved from mobile.\n",
    );
  });

  it("rejects workspace file updates outside the workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request("/v1/workspace/file", {
      body: JSON.stringify({
        content: "nope\n",
        path: "../outside.txt",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "invalid_workspace_file_path",
      },
    });
  });

  it("rejects workspace file previews outside the workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    const response = await app.request(
      `/v1/workspace/file?path=${encodeURIComponent("../outside.txt")}`,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "invalid_workspace_file_path",
      },
    });
  });

  it("streams concrete app-server plan content instead of a placeholder", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/plan/updated",
            params: {
              explanation: "plan",
              plan: ["Inspect README.md", "Update the title line", "Run formatting checks"],
              threadId: "app-thread-plan-content",
              turnId: "turn-plan-content",
            },
          });
          handler({
            method: "turn/completed",
            params: {
              status: "completed",
              threadId: "app-thread-plan-content",
              turnId: "turn-plan-content",
            },
          });
        }
      });
      return {
        completedAt: null,
        id: "turn-plan-content",
        items: [],
        startedAt: null,
        status: "completed",
      };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-plan-content",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Plan content",
        preview: "Plan content",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Plan content" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-plan-content/runs/stream", {
      method: "POST",
      body: JSON.stringify({ collaborationMode: "plan", prompt: "Plan README title update" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"kind":"plan"');
    expect(body).toContain("Inspect README.md");
    expect(body).toContain("Update the title line");
  });

  it("does not treat plain app-server agent messages as implementable plans", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const persistedThread = {
      id: "app-thread-mobile-plan-agent",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Mobile plan",
      preview: "Mobile plan",
      source: "app",
      status: "idle",
      turns: [
        {
          id: "turn-mobile-plan-agent",
          completedAt: now,
          items: [
            {
              id: "assistant-mobile-plan",
              type: "agentMessage",
              text: [
                "Concise plan: update only the README title.",
                "",
                "1. Inspect the current heading.",
                "2. Replace the first heading.",
                "3. Run checks.",
              ].join("\n"),
            },
          ],
          startedAt: now,
          status: "completed",
        },
      ],
      updatedAt: now,
    };
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => ({
      id: "turn-mobile-plan-agent",
      completedAt: now,
      items: persistedThread.turns[0].items,
      startedAt: now,
      status: "completed",
    }));
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        ...persistedThread,
        turns: [],
      })),
      startTurn,
      readThread: vi.fn<() => Promise<unknown>>(async () => persistedThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Mobile plan" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request(
      "/v1/threads/app-thread-mobile-plan-agent/runs/stream",
      {
        method: "POST",
        body: JSON.stringify({ collaborationMode: "plan", prompt: "Plan a README title update" }),
        headers: { "content-type": "application/json" },
      },
    );
    const streamBody = await streamResponse.text();
    const detailResponse = await app.request("/v1/threads/app-thread-mobile-plan-agent");
    const detailBody = await detailResponse.json();

    expect(streamResponse.status).toBe(200);
    expect(streamBody).not.toContain('"kind":"plan"');
    expect(streamBody).toContain("Concise plan: update only the README title.");
    expect(detailResponse.status).toBe(200);
    const assistantMessage = detailBody.messages.find(
      (message: { id: string }) => message.id === "assistant-mobile-plan",
    );
    expect(assistantMessage).toMatchObject({
      id: "assistant-mobile-plan",
      content: expect.stringContaining("Run checks."),
    });
    expect(assistantMessage.kind).not.toBe("plan");
  });

  it("maps proposed_plan app-server agent messages as implementable plans", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const persistedThread = {
      id: "app-thread-proposed-plan-agent",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Proposed plan",
      preview: "Proposed plan",
      source: "app",
      status: "idle",
      turns: [
        {
          id: "turn-proposed-plan-agent",
          completedAt: now,
          items: [
            {
              id: "assistant-proposed-plan",
              type: "agentMessage",
              text: [
                "<proposed_plan>",
                "# README Title Update",
                "",
                "## Summary",
                "Update only the README title.",
                "",
                "## Key Changes",
                "1. Inspect README.md.",
                "2. Replace the first heading.",
                "3. Run checks.",
                "</proposed_plan>",
              ].join("\n"),
            },
          ],
          startedAt: now,
          status: "completed",
        },
      ],
      updatedAt: now,
    };
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => persistedThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-proposed-plan-agent");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0]).toMatchObject({
      id: "assistant-proposed-plan",
      kind: "plan",
      content: expect.stringContaining("# README Title Update"),
    });
    expect(body.messages[0].content).not.toContain("<proposed_plan>");
  });

  it("maps persisted app-server plan items to their Markdown content", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-persisted-plan",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Persisted plan",
        preview: "Persisted plan",
        source: "app",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-persisted-plan",
            completedAt: now,
            items: [
              {
                id: "plan-item",
                type: "plan",
                explanation: "plan",
                plan: [
                  { status: "pending", step: "Inspect README.md" },
                  { status: "pending", step: "Update only the title" },
                ],
              },
            ],
            startedAt: now,
            status: "completed",
          },
        ],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-persisted-plan");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[0]).toMatchObject({
      kind: "plan",
      content: expect.stringContaining("Inspect README.md"),
    });
    expect(body.messages[0].content).toContain("Update only the title");
  });

  it("keeps app-server plan mode when no model override is provided", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async (_params) => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: { status: "completed", threadId: "app-thread-plan-default", turnId: "turn-1" },
          });
        }
      });
      return { id: "turn-1", items: [], status: "completed", startedAt: null, completedAt: null };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-plan-default",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Plan thread",
        preview: "Plan thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Plan thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-plan-default/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        collaborationMode: "plan",
        prompt: "Plan this without a model override",
      }),
      headers: { "content-type": "application/json" },
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: {
          mode: "plan",
          settings: {
            developer_instructions: null,
            model: "gpt-5.5",
            reasoning_effort: null,
          },
        },
        model: null,
      }),
    );
  });

  it("passes explicit app-server default collaboration mode", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async (_params) => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: { status: "completed", threadId: "app-thread-default-mode", turnId: "turn-1" },
          });
        }
      });
      return { id: "turn-1", items: [], status: "completed", startedAt: null, completedAt: null };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-default-mode",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Plan thread",
        preview: "Plan thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Plan thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-default-mode/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        collaborationMode: "default",
        prompt: "Implement plan",
      }),
      headers: { "content-type": "application/json" },
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: {
          mode: "default",
          settings: {
            developer_instructions: null,
            model: "gpt-5.5",
            reasoning_effort: null,
          },
        },
      }),
    );
  });

  it("does not treat app-server modelProvider as a runnable model", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: {
              status: "completed",
              threadId: "app-thread-provider",
              turnId: "turn-provider",
            },
          });
        }
      });
      return {
        id: "turn-provider",
        items: [],
        status: "running",
        startedAt: now,
        completedAt: null,
      };
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-provider",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "openai",
        name: "Provider thread",
        preview: "Provider thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        serviceTier: "priority",
        reasoningEffort: "max",
        runtimeMode: "default",
      }),
    });
    const createResponse = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Provider thread" }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createResponse.json();
    const streamResponse = await app.request("/v1/threads/app-thread-provider/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi" }),
      headers: { "content-type": "application/json" },
    });
    await streamResponse.text();

    expect(createResponse.status).toBe(201);
    expect(createBody.thread).not.toHaveProperty("model");
    expect(streamResponse.status).toBe(200);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        effort: "max",
        model: "gpt-5.6-luna",
        serviceTier: "priority",
      }),
    );
  });

  it("preserves app-server thread runtime metadata selected from mobile across refreshes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-runtime",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "base-model",
      name: "Runtime thread",
      preview: "Runtime thread",
      source: "app",
      status: "idle",
      turns: [],
      updatedAt: now,
    };
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: {
              status: "completed",
              threadId: "app-thread-runtime",
              turnId: "turn-runtime",
            },
          });
        }
      });
      return {
        id: "turn-runtime",
        items: [],
        status: "running",
        startedAt: null,
        completedAt: null,
      };
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [appThread]),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Runtime thread" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-runtime/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        approvalPolicy: "never",
        model: "gpt-5.5",
        prompt: "Use selected runtime",
        reasoningEffort: "high",
        runtimeMode: "auto",
        sandboxMode: "danger-full-access",
      }),
      headers: { "content-type": "application/json" },
    });
    await streamResponse.text();
    const listResponse = await app.request("/v1/threads");
    const listBody = await listResponse.json();

    expect(streamResponse.status).toBe(200);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalPolicy: "never",
        effort: "high",
        model: "gpt-5.5",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    );
    expect(listBody.threads[0]).toMatchObject({
      id: "app-thread-runtime",
      approvalPolicy: "never",
      model: "gpt-5.5",
      reasoningEffort: "high",
      runtimeMode: "auto",
      sandboxMode: "danger-full-access",
    });
  });

  it("interrupts the active app-server turn instead of only clearing local state", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers: Array<
      (notification: { method: string; params?: unknown }) => void
    > = [];
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-interrupt",
      preview: "Interruptible thread",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      cwd: workspacePath,
      source: "app-server",
      modelProvider: "openai",
      name: "Interruptible thread",
      turns: [],
    };
    const interruptTurn = vi.fn<() => Promise<void>>(async () => undefined);
    const startTurn = vi.fn<() => Promise<unknown>>(async () => ({
      id: "turn-interrupt",
      items: [],
      status: { type: "running" },
      startedAt: now,
      completedAt: null,
    }));
    const appServer = {
      interruptTurn,
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [appThread]),
      onNotification(handler: (notification: { method: string; params?: unknown }) => void) {
        notificationHandlers.push(handler);
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: { relayId: "relay-interrupt", serverEpoch: "process-interrupt" },
      threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Interruptible thread" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-interrupt/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        prompt: "Start long turn",
        runtimeMode: "full-access",
      }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(startTurn).toHaveBeenCalledTimes(1));

    const detailResponse = await app.request("/v1/threads/app-thread-interrupt");
    expect(await detailResponse.json()).toMatchObject({
      thread: { id: "app-thread-interrupt", ownerEpoch: 1 },
    });

    const staleInterruptResponse = await app.request(
      "/v1/threads/app-thread-interrupt/runs/interrupt",
      {
        method: "POST",
        body: JSON.stringify({ expectedOwnerEpoch: 2 }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(staleInterruptResponse.status).toBe(409);
    expect(await staleInterruptResponse.json()).toMatchObject({
      error: { code: "stale_owner_epoch" },
    });
    expect(interruptTurn).not.toHaveBeenCalled();

    const interruptResponse = await app.request("/v1/threads/app-thread-interrupt/runs/interrupt", {
      method: "POST",
      body: JSON.stringify({ expectedOwnerEpoch: 1 }),
      headers: { "content-type": "application/json" },
    });
    const interruptBody = await interruptResponse.json();

    expect(interruptResponse.status).toBe(200);
    expect(interruptTurn).toHaveBeenCalledWith({
      threadId: "app-thread-interrupt",
      turnId: "turn-interrupt",
    });
    expect(interruptBody.thread).toMatchObject({
      id: "app-thread-interrupt",
      state: "completed",
      runtimeMode: "full-access",
      sandboxMode: "danger-full-access",
    });
    const duplicateInterruptResponse = await app.request(
      "/v1/threads/app-thread-interrupt/runs/interrupt",
      {
        method: "POST",
        body: JSON.stringify({ expectedOwnerEpoch: 999 }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(duplicateInterruptResponse.status).toBe(200);
    await expect(duplicateInterruptResponse.json()).resolves.toMatchObject({
      thread: { id: "app-thread-interrupt", state: "completed" },
    });
    expect(interruptTurn).toHaveBeenCalledTimes(1);

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/cancelled",
        params: { status: "cancelled", threadId: "app-thread-interrupt", turnId: "turn-interrupt" },
      });
    }
    await streamResponse.text();
  });

  it("streams assistant items returned directly from app-server startTurn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-direct-turn",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Direct turn",
        preview: "Direct turn",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => ({
        id: "turn-direct",
        items: [{ id: "assistant-direct", text: "direct reply", type: "agentMessage" }],
        status: "completed",
        startedAt: now,
        completedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Direct turn" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-direct-turn/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Reply directly" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.message.created");
    expect(body).toContain("thread.message.completed");
    expect(body).toContain("direct reply");
    expect(body).toContain('"state":"completed"');
  });

  it("streams assistant items included only in app-server terminal turn notifications", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-terminal-items",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Terminal items",
        preview: "Terminal items",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-terminal-items",
                turn: {
                  id: "turn-terminal-items",
                  items: [
                    {
                      id: "assistant-terminal-items",
                      text: "final desktop reply",
                      type: "agentMessage",
                    },
                  ],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                },
              },
            });
          }
        });
        return {
          id: "turn-terminal-items",
          items: [],
          status: "running",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Terminal items" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-terminal-items/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Reply in terminal turn" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.message.completed");
    expect(body).toContain("final desktop reply");
    expect(body).not.toContain("codex_empty_response");
    expect(body).toContain('"state":"completed"');
  });

  it("streams the canonical app-server user message with its turn id", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-canonical-user",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Canonical user",
      preview: "Canonical user",
      source: "app",
      status: { type: "idle" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<(params: { clientUserMessageId?: string }) => Promise<unknown>>(
        async (params) => {
          queueMicrotask(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/started",
                params: {
                  threadId: appThread.id,
                  turn: { id: "turn-canonical-user" },
                },
              });
              handler({
                method: "item/started",
                params: {
                  item: {
                    id: "user-canonical",
                    clientId: params.clientUserMessageId,
                    content: [{ type: "text", text: "Remember the turn", text_elements: [] }],
                    type: "userMessage",
                  },
                  threadId: appThread.id,
                  turnId: "turn-canonical-user",
                },
              });
              handler({
                method: "item/completed",
                params: {
                  item: {
                    id: "user-canonical",
                    clientId: params.clientUserMessageId,
                    content: [{ type: "text", text: "Remember the turn", text_elements: [] }],
                    type: "userMessage",
                  },
                  threadId: appThread.id,
                  turnId: "turn-canonical-user",
                },
              });
              handler({
                method: "item/completed",
                params: {
                  item: {
                    id: "assistant-canonical",
                    text: "Remembered",
                    type: "agentMessage",
                  },
                  threadId: appThread.id,
                  turnId: "turn-canonical-user",
                },
              });
              handler({
                method: "turn/completed",
                params: {
                  threadId: appThread.id,
                  turnId: "turn-canonical-user",
                },
              });
            }
          });
          return {
            id: "turn-canonical-user",
            items: [],
            status: "inProgress",
            startedAt: now,
            completedAt: null,
          };
        },
      ),
    };
    const threadEvents = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadEvents,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Canonical user" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-canonical-user/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "4d27fc69-fc5a-49c8-a149-15f676837db7",
        prompt: "Remember the turn",
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const events = body.split("\n\n").flatMap((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      return data
        ? [
            JSON.parse(data.slice("data: ".length)) as {
              message?: {
                details?: { replacesMessageId?: string };
                id: string;
                role: string;
                semanticEventId?: string;
                turnId?: string;
              };
              type: string;
            },
          ]
        : [];
    });
    const userEvents = events.filter(
      (event) => event.type === "thread.message.created" && event.message?.role === "user",
    );

    expect(response.status).toBe(200);
    expect(appServer.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUserMessageId: "4d27fc69-fc5a-49c8-a149-15f676837db7",
      }),
    );
    expect(userEvents).toHaveLength(2);
    expect(userEvents.map((event) => event.message?.semanticEventId)).toEqual([
      "4d27fc69-fc5a-49c8-a149-15f676837db7",
      "4d27fc69-fc5a-49c8-a149-15f676837db7",
    ]);
    expect(userEvents[1]?.message).toMatchObject({
      id: "user-canonical",
      turnId: "turn-canonical-user",
      details: { replacesMessageId: userEvents[0]?.message?.id },
    });
    const durableUserEvents = (
      await threadEvents.listThreadEvents({ threadId: "app-thread-canonical-user" })
    ).events.filter(
      (event) =>
        event.event.type === "thread.message.created" && event.event.message.role === "user",
    );
    expect(durableUserEvents.map((event) => event.eventId)).toEqual([
      "semantic:v1:app-thread-canonical-user:input:4d27fc69-fc5a-49c8-a149-15f676837db7:user:accepted",
      "semantic:v1:app-thread-canonical-user:input:4d27fc69-fc5a-49c8-a149-15f676837db7:user:canonical",
    ]);
  });

  it("streams current app-server collaboration items as subagent activity", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "item/completed",
            params: {
              item: {
                id: "collab-spawn",
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                status: "completed",
                senderThreadId: "app-thread-subagents",
                receiverThreadIds: ["agent-thread-1"],
                prompt: "Inspect the package manager",
                model: "gpt-5.6-sol",
                reasoningEffort: "high",
                agentsStates: {
                  "agent-thread-1": { status: "running", message: null },
                },
              },
              threadId: "app-thread-subagents",
              turnId: "turn-subagents",
            },
          });
          handler({
            method: "item/completed",
            params: {
              item: {
                id: "subagent-started",
                type: "subAgentActivity",
                kind: "started",
                agentThreadId: "agent-thread-1",
                agentPath: "package-inspector",
              },
              threadId: "app-thread-subagents",
              turnId: "turn-subagents",
            },
          });
          handler({
            method: "item/completed",
            params: {
              item: { id: "assistant-subagents", text: "pnpm", type: "agentMessage" },
              threadId: "app-thread-subagents",
              turnId: "turn-subagents",
            },
          });
          handler({
            method: "turn/completed",
            params: {
              threadId: "app-thread-subagents",
              turnId: "turn-subagents",
            },
          });
        }
      });
      return {
        id: "turn-subagents",
        items: [],
        status: "inProgress",
        startedAt: now,
        completedAt: null,
      };
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-subagents",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "openai",
        name: "Subagent thread",
        preview: "Subagent thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Subagent thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-subagents/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        prompt: "Use a subagent to inspect the package manager",
        reasoningEffort: "ultra",
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
    const createdMessages = events
      .filter((event) => event.type === "thread.message.created")
      .map((event) => event.message);

    expect(response.status).toBe(200);
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({ effort: "ultra" }));
    expect(createdMessages).toContainEqual(
      expect.objectContaining({
        id: "collab-spawn",
        kind: "subagentAction",
        details: expect.objectContaining({
          receiverThreadIds: ["agent-thread-1"],
          status: "completed",
          tool: "spawnAgent",
        }),
      }),
    );
    expect(createdMessages).toContainEqual(
      expect.objectContaining({
        id: "subagent-started",
        kind: "subagentAction",
        details: expect.objectContaining({
          agentPath: "package-inspector",
          agentThreadId: "agent-thread-1",
          activityKind: "started",
        }),
      }),
    );
  });

  it("normalizes cumulative app-server deltas before streaming them to mobile", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-cumulative-delta",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Cumulative delta",
        preview: "Cumulative delta",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "Hello",
                itemId: "assistant-cumulative-delta",
                threadId: "app-thread-cumulative-delta",
                turnId: "turn-cumulative-delta",
              },
            });
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "Hello world",
                itemId: "assistant-cumulative-delta",
                threadId: "app-thread-cumulative-delta",
                turnId: "turn-cumulative-delta",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                status: "completed",
                threadId: "app-thread-cumulative-delta",
                turnId: "turn-cumulative-delta",
              },
            });
          }
        });
        return {
          id: "turn-cumulative-delta",
          items: [],
          status: "running",
          startedAt: null,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Cumulative delta" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-cumulative-delta/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Reply cumulatively" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"delta":"Hello"');
    expect(body).toContain('"delta":" world"');
    expect(body).not.toContain('"delta":"Hello world"');
    expect(body).toContain('"content":"Hello world"');
  });

  it("recovers missing assistant deltas from the completed app-server turn summary", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-summary-recovery",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Summary recovery",
        preview: "Summary recovery",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "Hello",
                itemId: "assistant-summary-recovery",
                threadId: "app-thread-summary-recovery",
                turnId: "turn-summary-recovery",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-summary-recovery",
                turn: {
                  id: "turn-summary-recovery",
                  items: [
                    {
                      id: "assistant-summary-recovery",
                      text: "Hello world",
                      type: "agentMessage",
                    },
                  ],
                  itemsView: "summary",
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                  durationMs: 1,
                },
              },
            });
          }
        });
        return {
          id: "turn-summary-recovery",
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Summary recovery" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-summary-recovery/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Recover the final response" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
    const completedMessageIndex = events.findIndex(
      (event) =>
        event.type === "thread.message.completed" &&
        (event.message as { id?: string } | undefined)?.id === "assistant-summary-recovery" &&
        (event.message as { content?: string } | undefined)?.content === "Hello world",
    );
    const completedStateIndex = events.findIndex(
      (event) =>
        event.type === "thread.state.changed" &&
        (event.thread as { state?: string } | undefined)?.state === "completed",
    );

    expect(response.status).toBe(200);
    expect(body).toContain('"delta":"Hello"');
    expect(body).not.toContain('"delta":" world"');
    expect(body).not.toContain("thread.error");
    expect(completedMessageIndex).toBeGreaterThan(-1);
    expect(completedStateIndex).toBeGreaterThan(completedMessageIndex);
    expect(events[completedMessageIndex]?.message).toMatchObject({
      content: "Hello world",
      id: "assistant-summary-recovery",
      state: "completed",
      turnId: "turn-summary-recovery",
    });
  });

  it("fails app-server streamed turns that complete without any response", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-empty-direct-turn",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Empty direct turn",
        preview: "Empty direct turn",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => ({
        id: "turn-empty-direct",
        items: [],
        status: "completed",
        startedAt: now,
        completedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Empty direct turn" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-empty-direct-turn/runs/stream", {
      method: "POST",
      body: JSON.stringify({ collaborationMode: "plan", prompt: "Plan this" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.error");
    expect(body).toContain("codex_empty_response");
    expect(body).toContain("Codex finished this turn without returning a plan or response.");
    expect(body).toContain('"state":"failed"');
  });

  it("fails asynchronously completed app-server turns without any response", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-empty-async-turn",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Empty async turn",
        preview: "Empty async turn",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-empty-async-turn",
                turn: {
                  id: "turn-empty-async",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                },
              },
            });
          }
        });
        return {
          id: "turn-empty-async",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Empty async turn" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-empty-async-turn/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Return a response" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.error");
    expect(body).toContain("codex_empty_response");
    expect(body).toContain("Codex finished this turn without returning a plan or response.");
    expect(body).toContain('"state":"failed"');
  });

  it("streams app-server usage-limit failures as persistent error messages", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const usageLimitMessage = "You've hit your usage limit. Try again later.";
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-usage-limited",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.6-sol",
        name: "Usage limited",
        preview: "Usage limited",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "error",
              params: {
                error: { message: usageLimitMessage },
                threadId: "app-thread-usage-limited",
                turnId: "turn-usage-limited",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-usage-limited",
                turn: {
                  id: "turn-usage-limited",
                  items: [],
                  status: "failed",
                  error: {
                    message: usageLimitMessage,
                    codexErrorInfo: "usageLimitExceeded",
                  },
                  startedAt: now,
                  completedAt: now,
                },
              },
            });
          }
        });
        return {
          id: "turn-usage-limited",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Usage limited" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-usage-limited/runs/stream", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-sol", prompt: "Return a response" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

    expect(response.status).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread.message.created",
        message: expect.objectContaining({ role: "error", content: usageLimitMessage }),
      }),
    );
    expect(body).toContain("thread.error");
    expect(body).toContain(usageLimitMessage);
    expect(body).toContain('"state":"failed"');
  });

  it("streams directly returned app-server failures as persistent error messages", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const failureMessage = "The selected model is temporarily unavailable.";
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-direct-failure",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.6-sol",
        name: "Direct failure",
        preview: "Direct failure",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => ({
        id: "turn-direct-failure",
        items: [],
        status: "failed",
        error: { message: failureMessage },
        startedAt: now,
        completedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Direct failure" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-direct-failure/runs/stream", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-sol", prompt: "Return a response" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.message.created");
    expect(body).toContain("thread.error");
    expect(body).toContain("codex_run_failed");
    expect(body).toContain(failureMessage);
    expect(body).not.toContain("codex_empty_response");
  });

  it("reports external active writer conflicts with a dedicated stream error code", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-active-writer",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Active writer",
        preview: "Active writer",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        throw new Error("thread app-thread-active-writer already has an active writer");
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Active writer" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-active-writer/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue from mobile" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.error");
    expect(body).toContain("thread_active_writer");
    expect(body).not.toContain("codex_run_failed");
  });

  it("rejects running-thread input when the active writer is external", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-external-input",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "External input",
        preview: "External input",
        source: "app",
        status: "running",
        turns: [],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "External input" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-external-input/input", {
      method: "POST",
      body: JSON.stringify({ prompt: "Should not queue" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(body).toContain("thread_active_writer");
  });

  it("hands off queued input after a directly returned terminal turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    let releaseFirstTurn: (() => void) | undefined;
    const firstTurnReleased = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let turnCount = 0;
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      turnCount += 1;
      if (turnCount === 1) {
        await firstTurnReleased;
      }
      return {
        id: `turn-direct-queue-${turnCount}`,
        items: [
          {
            id: `assistant-direct-queue-${turnCount}`,
            text: turnCount === 1 ? "first direct reply" : "queued direct reply",
            type: "agentMessage",
          },
        ],
        status: "completed",
        startedAt: now,
        completedAt: now,
      };
    });
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-direct-queue",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Direct queue",
        preview: "Direct queue",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Direct queue" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-direct-queue/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Initial direct run" }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(startTurn).toHaveBeenCalledTimes(1));
    const queuedResponse = await app.request("/v1/threads/app-thread-direct-queue/input", {
      method: "POST",
      body: JSON.stringify({ prompt: "Queued direct run" }),
      headers: { "content-type": "application/json" },
    });
    releaseFirstTurn?.();
    const body = await streamResponse.text();

    expect(queuedResponse.status).toBe(202);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(body).toContain("first direct reply");
    expect(body).toContain("queued direct reply");
    expect(body).not.toContain("thread.error");
    expect(body).toContain('"state":"completed"');
  });

  it("ignores a late completion from the previous turn after queued handoff", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    let releaseFirstTurn!: () => void;
    const firstTurnReleased = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let turnCount = 0;
    const threadId = "app-thread-late-previous-turn";
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      turnCount += 1;
      if (turnCount === 1) {
        await firstTurnReleased;
        return {
          id: "turn-previous",
          items: [{ id: "assistant-previous", text: "first direct reply", type: "agentMessage" }],
          status: "completed",
          startedAt: now,
          completedAt: now,
        };
      }
      queueMicrotask(() => {
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: "turn-previous",
                items: [
                  {
                    id: "assistant-stale-previous",
                    text: "stale previous summary",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
                error: null,
                startedAt: now,
                completedAt: now,
              },
            },
          });
          handler({
            method: "item/completed",
            params: {
              item: { id: "assistant-current", text: "current queued reply", type: "agentMessage" },
              threadId,
              turnId: "turn-current",
            },
          });
          handler({
            method: "turn/completed",
            params: { status: "completed", threadId, turnId: "turn-current" },
          });
        }
      });
      return {
        id: "turn-current",
        items: [],
        status: "running",
        startedAt: now,
        completedAt: null,
      };
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: threadId,
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Late previous turn",
        preview: "Late previous turn",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Late previous turn" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request(`/v1/threads/${threadId}/runs/stream`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Initial run" }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(startTurn).toHaveBeenCalledTimes(1));
    const queuedResponse = await app.request(`/v1/threads/${threadId}/input`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Queued run" }),
      headers: { "content-type": "application/json" },
    });
    releaseFirstTurn();
    const body = await streamResponse.text();

    expect(queuedResponse.status).toBe(202);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(body).toContain("first direct reply");
    expect(body).toContain("current queued reply");
    expect(body).not.toContain("stale previous summary");
  });

  it("does not stream terminal thread status before late assistant items", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-out-of-order",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Out of order",
        preview: "Out of order",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/started",
              params: { threadId: "app-thread-out-of-order", turnId: "turn-out-of-order" },
            });
            handler({
              method: "thread/status/changed",
              params: { status: { type: "idle" }, threadId: "app-thread-out-of-order" },
            });
            handler({
              method: "item/completed",
              params: {
                item: { id: "assistant-out-of-order", text: "late reply", type: "agentMessage" },
                threadId: "app-thread-out-of-order",
                turnId: "turn-out-of-order",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-out-of-order",
                turn: {
                  id: "turn-out-of-order",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                  durationMs: 1,
                },
              },
            });
          }
        });
        return {
          id: "turn-out-of-order",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Out of order" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-out-of-order/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Reply after idle" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();
    const assistantIndex = body.indexOf("late reply");
    const completedStateIndex = body.indexOf('"state":"completed"', assistantIndex);

    expect(response.status).toBe(200);
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(completedStateIndex).toBeGreaterThan(assistantIndex);
  });

  it("keeps async agent delivery out of the turn's final response", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const threadId = "app-thread-async-delivery";
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: threadId,
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Async delivery",
        preview: "Async delivery",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/started",
              params: { threadId, turnId: "turn-async-delivery" },
            });
            handler({
              method: "item/started",
              params: {
                item: { id: "assistant-final", text: "", type: "agentMessage" },
                threadId,
                turnId: "turn-async-delivery",
              },
            });
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "final answer",
                itemId: "assistant-final",
                threadId,
                turnId: "turn-async-delivery",
              },
            });
            handler({
              method: "item/completed",
              params: {
                item: { id: "assistant-final", text: "final answer", type: "agentMessage" },
                threadId,
                turnId: "turn-async-delivery",
              },
            });
            handler({
              method: "item/started",
              params: {
                item: {
                  delivery: "async",
                  id: "assistant-background",
                  text: "",
                  type: "agentMessage",
                },
                threadId,
                turnId: "turn-async-delivery",
              },
            });
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "background note",
                itemId: "assistant-background",
                threadId,
                turnId: "turn-async-delivery",
              },
            });
            handler({
              method: "item/completed",
              params: {
                item: {
                  delivery: "async",
                  id: "assistant-background",
                  text: "background note",
                  type: "agentMessage",
                },
                threadId,
                turnId: "turn-async-delivery",
              },
            });
            handler({
              method: "turn/completed",
              params: { status: "completed", threadId, turnId: "turn-async-delivery" },
            });
          }
        });
        return {
          id: "turn-async-delivery",
          items: [],
          status: "running",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Async delivery" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request(`/v1/threads/${threadId}/runs/stream`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Finish normally" }),
      headers: { "content-type": "application/json" },
    });
    await streamResponse.text();
    const detailResponse = await app.request(`/v1/threads/${threadId}`);
    const detailBody = await detailResponse.json();

    expect(detailResponse.status).toBe(200);
    expect(detailBody.thread.lastResult).toBe("final answer");
    expect(detailBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "assistant-final", content: "final answer" }),
        expect.objectContaining({ id: "assistant-background", content: "background note" }),
      ]),
    );
  });

  it("waits for late assistant notifications when startTurn returns completed without items", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-empty-completed",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Empty completed",
        preview: "Empty completed",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/completed",
              params: {
                item: {
                  id: "assistant-empty-completed",
                  text: "late completed reply",
                  type: "agentMessage",
                },
                threadId: "app-thread-empty-completed",
                turnId: "turn-empty-completed",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-empty-completed",
                turn: {
                  id: "turn-empty-completed",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                  durationMs: 1,
                },
              },
            });
          }
        });
        return {
          id: "turn-empty-completed",
          items: [],
          status: "completed",
          startedAt: now,
          completedAt: now,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Empty completed" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-empty-completed/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Reply after empty completed" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("late completed reply");
    expect(body).toContain('"state":"completed"');
  });

  it("reconciles a turn created after turn/start times out without dispatching twice", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    let turnWasDispatched = false;
    const appThread = () => ({
      id: "app-thread-ambiguous-start",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Ambiguous start",
      preview: "Ambiguous start",
      source: "app",
      status: turnWasDispatched ? "idle" : "idle",
      turns: turnWasDispatched
        ? [
            {
              id: "turn-ambiguous-start",
              items: [
                {
                  id: "user-ambiguous-start",
                  type: "userMessage",
                  content: [{ type: "text", text: "Run exactly once", text_elements: [] }],
                },
                {
                  id: "assistant-ambiguous-start",
                  text: "Recovered exactly once",
                  type: "agentMessage",
                },
              ],
              status: "completed",
              startedAt: Date.now() / 1000,
              completedAt: Date.now() / 1000,
            },
          ]
        : [],
      updatedAt: now,
    });
    const startTurn = vi.fn<() => Promise<never>>(async () => {
      turnWasDispatched = true;
      throw new AppServerRequestTimeoutError("turn/start");
    });
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread()),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread()),
      startTurn,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Ambiguous start" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-ambiguous-start/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "a4a55e53-78bf-4e22-8aeb-7a5e32d40b97",
        prompt: "Run exactly once",
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(body).toContain("Recovered exactly once");
    expect(body).not.toContain("thread.error");
    expect(
      await threadCoordinator.getActiveTurnClaim("app-thread-ambiguous-start"),
    ).toBeUndefined();
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "a4a55e53-78bf-4e22-8aeb-7a5e32d40b97",
      ),
    ).toMatchObject({ state: "completed" });
  });

  it("starts the first streamed turn when an app-server thread is not materialized yet", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => {
        throw new Error(
          "thread app-thread-unmaterialized is not materialized yet; includeTurns is unavailable before first user message",
        );
      }),
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-unmaterialized",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Unmaterialized",
        preview: "Unmaterialized",
        source: "app",
        status: { type: "active" },
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/completed",
              params: {
                item: {
                  id: "assistant-unmaterialized",
                  text: "first reply",
                  type: "agentMessage",
                },
                threadId: "app-thread-unmaterialized",
                turnId: "turn-unmaterialized",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-unmaterialized",
                turn: {
                  id: "turn-unmaterialized",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                  durationMs: 1,
                },
              },
            });
          }
        });
        return {
          id: "turn-unmaterialized",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Unmaterialized" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-unmaterialized/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "First prompt" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(appServer.readThread).toHaveBeenCalled();
    expect(appServer.startTurn).toHaveBeenCalledTimes(1);
    expect(body).toContain("first reply");
    expect(body).toContain('"state":"completed"');
  });

  it("resumes not-loaded app-server threads before continuing a streamed turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-not-loaded",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Past thread",
      preview: "First message",
      source: "app",
      status: { type: "notLoaded" },
      turns: [
        {
          id: "turn-existing",
          items: [
            {
              id: "existing-user",
              type: "userMessage",
              content: [{ type: "text", text: "First message", text_elements: [] }],
            },
            { id: "existing-assistant", text: "First reply", type: "agentMessage" },
          ],
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      ],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      resumeThread: vi.fn<() => Promise<unknown>>(async () => ({
        ...appThread,
        status: { type: "idle" },
      })),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "continued reply",
                itemId: "assistant-continued",
                threadId: "app-thread-not-loaded",
                turnId: "turn-continued",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: "app-thread-not-loaded",
                turn: {
                  id: "turn-continued",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                  durationMs: 1,
                },
              },
            });
          }
        });
        return {
          id: "turn-continued",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-not-loaded/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue this" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(appServer.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "app-thread-not-loaded",
      }),
    );
    expect(appServer.startTurn).toHaveBeenCalledTimes(1);
    expect(body).toContain("continued reply");
  });

  it("subscribes the Relay client before continuing a TUI-loaded shared thread", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    let subscribed = false;
    const appThread = {
      id: "app-thread-tui-loaded",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "TUI loaded thread",
      preview: "Existing TUI message",
      source: "cli",
      status: { type: "idle" },
      turns: [],
      updatedAt: now,
    };
    const resumeThread = vi.fn<() => Promise<unknown>>(async () => {
      subscribed = true;
      return appThread;
    });
    const appServer = {
      isThreadSubscribed: () => subscribed,
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      resumeThread,
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "reply visible on mobile",
                itemId: "assistant-tui-loaded",
                threadId: appThread.id,
                turnId: "turn-tui-loaded",
              },
            });
            handler({
              method: "turn/completed",
              params: {
                threadId: appThread.id,
                turn: {
                  id: "turn-tui-loaded",
                  items: [],
                  status: "completed",
                  error: null,
                  startedAt: now,
                  completedAt: now,
                },
              },
            });
          }
        });
        return {
          id: "turn-tui-loaded",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request(`/v1/threads/${appThread.id}/runs/stream`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue from mobile" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: appThread.id }));
    expect(body).toContain("reply visible on mobile");
    expect(body).toContain('"state":"completed"');
  });

  it("waits for an externally active app-server thread before starting a streamed turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    let readCount = 0;
    const appThread = {
      id: "app-thread-wait",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Wait thread",
      preview: "Wait thread",
      source: "app",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        ...appThread,
        status: readCount++ === 0 ? { type: "active" } : { type: "idle" },
      })),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: "pong",
                itemId: "assistant-wait",
                threadId: "app-thread-wait",
                turnId: "turn-wait",
              },
            });
            handler({
              method: "turn/completed",
              params: { status: "completed", threadId: "app-thread-wait", turnId: "turn-wait" },
            });
          }
        });
        return {
          id: "turn-wait",
          items: [],
          status: "running",
          startedAt: null,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Wait thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-wait/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Run after current turn" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(appServer.readThread).toHaveBeenCalledTimes(3);
    expect(appServer.startTurn).toHaveBeenCalledTimes(1);
    expect(appServer.readThread.mock.invocationCallOrder[1]).toBeLessThan(
      appServer.startTurn.mock.invocationCallOrder[0]!,
    );
    expect(body).toContain("thread.message.delta");
    expect(body).toContain("pong");
  });

  it("closes app-server streams when a turn is aborted", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-aborted",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Abort thread",
        preview: "Abort thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "turn/aborted",
              params: {
                reason: "Approval request timed out.",
                threadId: "app-thread-aborted",
                turnId: "turn-aborted",
              },
            });
          }
        });
        return {
          id: "turn-aborted",
          items: [],
          status: "running",
          startedAt: null,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Abort thread" }),
      headers: { "content-type": "application/json" },
    });
    const response = await app.request("/v1/threads/app-thread-aborted/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Run this" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("thread.error");
    expect(body).toContain("Approval request timed out.");
    expect(body).toContain('"state":"failed"');
  });

  it("treats duplicate app-server approval resolutions as already successful", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const now = Date.now() / 1000;
    let approvalRequested = false;
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const appThread = {
      id: "app-thread-approval",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Approval thread",
      preview: "Approval thread",
      source: "app",
      status: "idle",
      turns: [],
      updatedAt: now,
    };
    const respondToRequest = vi.fn<() => Promise<void>>(async () => {
      await responseReleased;
      for (const handler of notificationHandlers) {
        handler({
          method: "turn/completed",
          params: {
            status: "completed",
            threadId: "app-thread-approval",
            turnId: "turn-approval",
          },
        });
      }
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      respondToRequest,
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          approvalRequested = true;
          for (const handler of requestHandlers) {
            handler({
              id: 42,
              method: "item/commandExecution/requestApproval",
              params: {
                command: "echo approved",
                threadId: "app-thread-approval",
                turnId: "turn-approval",
              },
            });
          }
        });
        return {
          id: "turn-approval",
          items: [],
          status: "running",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Approval thread" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-approval/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Needs approval" }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(approvalRequested).toBe(true));

    const pendingDetailResponse = await app.request("/v1/threads/app-thread-approval");
    const pendingDetailBody = await pendingDetailResponse.json();
    const approvalId = pendingDetailBody.messages.find(
      (message: { details?: { approvalId?: string } }) => message.details?.approvalId,
    )?.details?.approvalId;
    expect(approvalId).toMatch(/^approval-[a-f0-9]{24}$/);

    const firstApproval = app.request(`/v1/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(respondToRequest).toHaveBeenCalledTimes(1));
    const duplicateApproval = app.request(`/v1/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" },
    });
    releaseResponse?.();

    const [firstResponse, duplicateResponse] = await Promise.all([
      firstApproval,
      duplicateApproval,
    ]);
    await streamResponse.text();
    const detailResponse = await app.request("/v1/threads/app-thread-approval");
    const detailBody = await detailResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);
    expect(respondToRequest).toHaveBeenCalledTimes(1);
    expect(detailBody.messages).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          approvalDecision: "approve",
          approvalResolved: true,
        }),
      }),
    );
  });

  it("recognizes a durable resolved approval after Relay restarts", async () => {
    const approvalStore = await createRelayStateStore(":memory:");
    await approvalStore.createPendingApproval({
      approvalId: "approval-durable-retry",
      kind: "commandExecution",
      method: "item/commandExecution/requestApproval",
      requestId: 42,
      threadId: "app-thread-approval-retry",
    });
    await approvalStore.resolvePendingApproval("approval-durable-retry");
    const app = createApp({
      approvalStore,
      codex: createMockCodex(),
    });

    const response = await app.request("/v1/approvals/approval-durable-retry", {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("persists app-server request resolution notifications on attached running streams", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const approvalStore = await createRelayStateStore(":memory:");
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-attached-request-resolution",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Attached request resolution",
      preview: "Attached request resolution",
      source: "app",
      status: "running",
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      rejectRequest: vi.fn<() => Promise<void>>(),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
    };
    const app = createApp({
      appServer: appServer as never,
      approvalStore,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Attached request resolution" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request(
      "/v1/threads/app-thread-attached-request-resolution/runs/stream",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    for (const handler of requestHandlers) {
      handler({
        id: 73,
        method: "item/tool/requestUserInput",
        params: {
          isBlocking: false,
          questions: [{ id: "scope", question: "What next?" }],
          threadId: "app-thread-attached-request-resolution",
          turnId: "turn-attached-request-resolution",
        },
      });
    }
    await vi.waitFor(async () => {
      await expect(approvalStore.listPendingApprovals()).resolves.toHaveLength(1);
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "serverRequest/resolved",
        params: {
          requestId: 73,
          threadId: "app-thread-attached-request-resolution",
        },
      });
    }
    for (const handler of notificationHandlers) {
      handler({
        method: "thread/status/changed",
        params: {
          status: "idle",
          threadId: "app-thread-attached-request-resolution",
        },
      });
    }

    await streamResponse.text();
    await expect(approvalStore.listPendingApprovals()).resolves.toEqual([]);
  });

  it("persists app-server request resolution notifications on relay-managed turn streams", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const approvalStore = await createRelayStateStore(":memory:");
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: "app-thread-managed-request-resolution",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Managed request resolution",
      preview: "Managed request resolution",
      source: "app",
      status: "idle",
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      rejectRequest: vi.fn<() => Promise<void>>(),
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<() => Promise<unknown>>(async () => ({
        completedAt: null,
        id: "turn-managed-request-resolution",
        items: [],
        startedAt: now,
        status: "running",
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      approvalStore,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Managed request resolution" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request(
      "/v1/threads/app-thread-managed-request-resolution/runs/stream",
      {
        method: "POST",
        body: JSON.stringify({ prompt: "Needs input" }),
        headers: { "content-type": "application/json" },
      },
    );
    await vi.waitFor(() => expect(appServer.startTurn).toHaveBeenCalledTimes(1));
    for (const handler of requestHandlers) {
      handler({
        id: 74,
        method: "item/tool/requestUserInput",
        params: {
          isBlocking: false,
          questions: [{ id: "scope", question: "What next?" }],
          threadId: "app-thread-managed-request-resolution",
          turnId: "turn-managed-request-resolution",
        },
      });
    }
    await vi.waitFor(async () => {
      await expect(approvalStore.listPendingApprovals()).resolves.toHaveLength(1);
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "serverRequest/resolved",
        params: {
          requestId: 74,
          threadId: "app-thread-managed-request-resolution",
        },
      });
    }
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-managed-request-resolution",
          turnId: "turn-managed-request-resolution",
        },
      });
    }

    await streamResponse.text();
    await expect(approvalStore.listPendingApprovals()).resolves.toEqual([]);
  });

  it("rejects an approval from a stale thread owner without resolving the request", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const relayState = await createRelayStateStore(":memory:");
    const capabilities = {
      approve: true,
      configure: true,
      interrupt: true,
      queue: true,
      send: true,
      steer: true,
      view: true,
    };
    const previousOwner = await relayState.acquireThreadOwner({
      capabilities,
      ownerId: "relay-owner",
      ownerInstanceId: "process-before-replacement",
      ownerType: "shared_app_server",
      threadId: "app-thread-stale-approval",
    });
    const replacementOwner = await relayState.acquireThreadOwner({
      capabilities,
      ownerId: "relay-owner",
      ownerInstanceId: "process-after-replacement",
      ownerType: "shared_app_server",
      threadId: "app-thread-stale-approval",
    });
    await relayState.createPendingApproval({
      approvalId: "approval-stale-owner",
      kind: "commandExecution",
      method: "item/commandExecution/requestApproval",
      requestId: 42,
      threadId: "app-thread-stale-approval",
      turnId: "turn-stale-approval",
    });
    const respondToRequest = vi.fn<() => Promise<void>>();
    const app = createApp({
      appServer: { respondToRequest } as never,
      approvalStore: relayState,
      codex: createMockCodex(),
      threadCoordinator: relayState,
      workspacePath,
    });

    const response = await app.request("/v1/approvals/approval-stale-owner", {
      method: "POST",
      body: JSON.stringify({
        decision: "approve",
        expectedOwnerEpoch: previousOwner.epoch,
      }),
      headers: { "content-type": "application/json" },
    });

    expect(replacementOwner.epoch).toBeGreaterThan(previousOwner.epoch);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "stale_owner_epoch" },
    });
    expect(respondToRequest).not.toHaveBeenCalled();
    await expect(relayState.listPendingApprovals()).resolves.toContainEqual(
      expect.objectContaining({ approvalId: "approval-stale-owner" }),
    );
  });

  it("resumes app-server turns after pending input request is answered", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const requestHandlers = new Set<(request: unknown) => void>();
    const now = Date.now() / 1000;
    let inputRequested = false;
    const appThread = {
      id: "app-thread-input",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Input thread",
      preview: "Input thread",
      source: "app",
      status: "idle",
      turns: [],
      updatedAt: now,
    };
    const respondToRequest = vi.fn<() => Promise<void>>(async () => {
      for (const handler of notificationHandlers) {
        handler({
          method: "turn/completed",
          params: {
            status: "completed",
            threadId: "app-thread-input",
            turnId: "turn-input",
          },
        });
      }
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest(handler: (request: unknown) => void) {
        requestHandlers.add(handler);
        return () => requestHandlers.delete(handler);
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      respondToRequest,
      startThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        queueMicrotask(() => {
          inputRequested = true;
          for (const handler of requestHandlers) {
            handler({
              id: "request-7",
              method: "item/tool/requestUserInput",
              params: {
                isBlocking: false,
                questions: [
                  {
                    header: "Scope",
                    id: "scope",
                    question: "What should Codex do next?",
                  },
                ],
                threadId: "app-thread-input",
                turnId: "turn-input",
              },
            });
          }
        });
        return {
          id: "turn-input",
          items: [],
          status: "running",
          startedAt: now,
          completedAt: null,
        };
      }),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Input thread" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-input/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Needs input" }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(inputRequested).toBe(true));

    const detailBeforeResponse = await app.request("/v1/threads/app-thread-input");
    const detailBeforeBody = await detailBeforeResponse.json();
    const pendingInputRequest = detailBeforeBody.pendingInputRequests[0];
    expect(detailBeforeBody.pendingInputRequests).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^approval-[a-f0-9]{24}$/),
        isBlocking: false,
        questions: [
          expect.objectContaining({
            id: "scope",
            question: "What should Codex do next?",
          }),
        ],
      }),
    );
    expect(detailBeforeBody.messages).not.toContainEqual(
      expect.objectContaining({ kind: "structuredUserInput" }),
    );

    const approvalResponse = await app.request(`/v1/approvals/${pendingInputRequest.id}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", answers: ["Restart Vite"] }),
      headers: { "content-type": "application/json" },
    });
    const streamBody = await streamResponse.text();
    const detailResponse = await app.request("/v1/threads/app-thread-input");
    const detailBody = await detailResponse.json();

    expect(approvalResponse.status).toBe(200);
    expect(streamBody).toContain("thread.input_request.created");
    expect(respondToRequest).toHaveBeenCalledWith("request-7", {
      answers: { scope: { answers: ["Restart Vite"] } },
    });
    expect(streamBody).toContain('"state":"completed"');
    expect(detailBody.messages).not.toContainEqual(
      expect.objectContaining({ kind: "structuredUserInput" }),
    );
  });

  it("restores durable approvals after a Relay restart and resolves the original request", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const approvalStore = await createRelayStateStore(":memory:");
    const timestamp = new Date().toISOString();
    await approvalStore.createPendingApproval({
      approvalId: "approval-41",
      kind: "structuredUserInput",
      method: "item/tool/requestUserInput",
      questions: [{ id: "scope", question: "What should happen next?" }],
      requestId: 41,
      threadId: "app-thread-recovered-approval",
      turnId: "turn-recovered-approval",
    });
    await approvalStore.createPendingApproval({
      approvalId: "approval-42",
      kind: "commandExecution",
      message: {
        id: "approval-message-42",
        threadId: "app-thread-recovered-approval",
        role: "status",
        kind: "approvalRequest",
        content: "pnpm test",
        details: { approvalId: "approval-42", approvalKind: "commandExecution" },
        createdAt: timestamp,
        state: "completed",
      },
      messageId: "approval-message-42",
      method: "item/commandExecution/requestApproval",
      requestId: 42,
      threadId: "app-thread-recovered-approval",
      turnId: "turn-recovered-approval",
    });
    const now = Date.now() / 1_000;
    const thread = {
      id: "app-thread-recovered-approval",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Recovered approval",
      preview: "Recovered approval",
      source: "app",
      status: "active",
      turns: [],
      updatedAt: now,
    };
    const respondToRequest = vi.fn<() => Promise<void>>();
    const app = createApp({
      appServer: {
        readThread: vi.fn<() => Promise<unknown>>(async () => thread),
        respondToRequest,
      } as never,
      approvalStore,
      codex: createMockCodex(),
      workspacePath,
    });

    const detailResponse = await app.request("/v1/threads/app-thread-recovered-approval");
    const detail = await detailResponse.json();
    const resolution = await app.request("/v1/approvals/approval-41", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", answers: ["Run tests"] }),
      headers: { "content-type": "application/json" },
    });

    expect(detailResponse.status).toBe(200);
    expect(detail.pendingInputRequests).toContainEqual(
      expect.objectContaining({
        id: "approval-41",
        questions: [expect.objectContaining({ id: "scope" })],
      }),
    );
    expect(detail.messages).toContainEqual(
      expect.objectContaining({ id: "approval-message-42", kind: "approvalRequest" }),
    );
    expect(resolution.status).toBe(200);
    expect(respondToRequest).toHaveBeenCalledWith(41, {
      answers: { scope: { answers: ["Run tests"] } },
    });
    await expect(approvalStore.listPendingApprovals()).resolves.toMatchObject([
      { approvalId: "approval-42" },
    ]);
  });

  it("reconciles an active app-server turn after shared socket reconnect", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const connectionStateHandlers = new Set<
      (event: { state: "disconnected" | "reconnected" }) => void
    >();
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    let reconciledState: "running" | "completed" = "running";
    let reconnectTurnStarted = false;
    const activeTurn = () => ({
      id: "turn-reconnect",
      items:
        reconciledState === "completed"
          ? [{ id: "assistant-reconnect", text: "Recovered after reconnect", type: "agentMessage" }]
          : [],
      status: reconciledState,
      startedAt: now,
      completedAt: reconciledState === "completed" ? now + 1 : null,
    });
    const readThread = vi.fn<
      (threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async () => ({
      id: "app-thread-reconnect",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Reconnect thread",
      preview: "Reconnect thread",
      source: "app",
      status: reconnectTurnStarted && reconciledState === "running" ? "active" : "idle",
      turns: [activeTurn()],
      updatedAt: now,
    }));
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      reconnectTurnStarted = true;
      return activeTurn();
    });
    const appServer = {
      onConnectionState(handler: (event: { state: "disconnected" | "reconnected" }) => void) {
        connectionStateHandlers.add(handler);
        return () => connectionStateHandlers.delete(handler);
      },
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-reconnect",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Reconnect thread",
        preview: "Reconnect thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Reconnect thread" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-reconnect/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "04f70ba3-d3f0-4db6-a17b-cfe7339e27cc",
        prompt: "Keep this turn alive",
      }),
      headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect(await threadCoordinator.getActiveTurnClaim("app-thread-reconnect")).toMatchObject({
        runtimeTurnId: "turn-reconnect",
        state: "active",
      }),
    );

    for (const handler of connectionStateHandlers) {
      handler({ state: "reconnected" });
    }
    await vi.waitFor(() =>
      expect(readThread).toHaveBeenCalledWith("app-thread-reconnect", { includeTurns: true }),
    );
    const reconciliationReadCount = readThread.mock.calls.filter(
      (call) => (call[1] as { includeTurns?: boolean } | undefined)?.includeTurns,
    ).length;
    expect(reconciliationReadCount).toBe(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(await threadCoordinator.getActiveTurnClaim("app-thread-reconnect")).toMatchObject({
      runtimeTurnId: "turn-reconnect",
      state: "active",
    });

    reconciledState = "completed";
    for (const handler of connectionStateHandlers) {
      handler({ state: "reconnected" });
    }
    const body = await streamResponse.text();

    expect(
      readThread.mock.calls.filter(
        (call) => (call[1] as { includeTurns?: boolean } | undefined)?.includeTurns,
      ),
    ).toHaveLength(2);
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(body).toContain("Recovered after reconnect");
    expect(await threadCoordinator.getActiveTurnClaim("app-thread-reconnect")).toBeUndefined();
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "04f70ba3-d3f0-4db6-a17b-cfe7339e27cc",
      ),
    ).toMatchObject({ state: "completed" });
    expect(connectionStateHandlers).toHaveLength(0);
  });

  it("finalizes a startup-recovered claim only for its exact runtime turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const threadCoordinator = await createRelayStateStore(":memory:");
    const previousOwner = await threadCoordinator.acquireThreadOwner({
      capabilities: {
        approve: true,
        configure: true,
        interrupt: true,
        queue: true,
        send: true,
        steer: true,
        view: true,
      },
      ownerId: "relay-recovered",
      ownerInstanceId: "process-before-restart",
      ownerType: "shared_app_server",
      threadId: "app-thread-startup-recovered",
    });
    await threadCoordinator.createThreadInput({
      clientId: "mobile-client",
      inputId: "input-startup-recovered",
      payload: { prompt: "survive relay restart" },
      state: "accepted",
      threadId: "app-thread-startup-recovered",
    });
    const acquired = await threadCoordinator.acquireTurnClaim({
      inputId: "input-startup-recovered",
      ownerEpoch: previousOwner.epoch,
      ownerId: previousOwner.ownerId,
      threadId: "app-thread-startup-recovered",
    });
    if (acquired.kind !== "acquired") {
      throw new Error("Expected the startup input to acquire a claim.");
    }
    const bound = await threadCoordinator.bindTurnClaimRuntimeTurn({
      claimId: acquired.claim.claimId,
      ownerEpoch: previousOwner.epoch,
      ownerId: previousOwner.ownerId,
      runtimeTurnId: "turn-startup-recovered",
    });
    if (bound.kind !== "updated") {
      throw new Error("Expected the startup claim to bind its runtime turn.");
    }
    const adopted = await threadCoordinator.adoptActiveTurnClaim({
      capabilities: previousOwner.capabilities,
      claimId: acquired.claim.claimId,
      ownerId: "relay-recovered",
      ownerInstanceId: "process-after-restart",
      ownerType: "shared_app_server",
      runtimeTurnId: "turn-startup-recovered",
      threadId: "app-thread-startup-recovered",
    });
    if (adopted.kind !== "adopted") {
      throw new Error("Expected the startup claim to be adopted.");
    }
    let recoveredTurnStatus = "running";
    let recoveredTurnCompletedAt: number | null = null;
    const startTurn = vi.fn<() => Promise<unknown>>();
    const readThread = vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(
      async () => ({
        id: "app-thread-startup-recovered",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Recovered thread",
        preview: "Recovered thread",
        source: "app",
        status: "active",
        turns: [
          {
            completedAt: recoveredTurnCompletedAt,
            id: "turn-startup-recovered",
            items: [
              {
                id: "assistant-startup-recovered",
                text: "Recovered assistant output",
                type: "agentMessage",
              },
            ],
            startedAt: now,
            status: recoveredTurnStatus,
          },
        ],
        updatedAt: now,
      }),
    );
    const appServer = {
      appServerMode: "socket",
      onConnectionState() {
        return () => undefined;
      },
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      readThread,
      startTurn,
    };

    createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: {
        relayId: "relay-recovered",
        serverEpoch: "process-after-restart",
      },
      recoveredTurnClaims: [{ claim: adopted.claim, input: adopted.input, owner: adopted.owner }],
      threadCoordinator,
      threadEvents: threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });
    await vi.waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-startup-recovered",
          turnId: "turn-other",
        },
      });
    }
    expect(
      await threadCoordinator.getActiveTurnClaim("app-thread-startup-recovered"),
    ).toMatchObject({ claimId: acquired.claim.claimId });

    recoveredTurnStatus = "cancelled";
    recoveredTurnCompletedAt = now;
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/cancelled",
        params: {
          status: "cancelled",
          threadId: "app-thread-startup-recovered",
          turnId: "turn-startup-recovered",
        },
      });
    }
    await vi.waitFor(async () =>
      expect(
        await threadCoordinator.getActiveTurnClaim("app-thread-startup-recovered"),
      ).toBeUndefined(),
    );

    expect(startTurn).not.toHaveBeenCalled();
    expect(
      await threadCoordinator.listThreadInputs({ threadId: "app-thread-startup-recovered" }),
    ).toMatchObject([{ state: "cancelled" }]);
    const recoveredEvents = await threadCoordinator.listThreadEvents({
      threadId: "app-thread-startup-recovered",
    });
    expect(recoveredEvents.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            content: "Recovered assistant output",
            id: "assistant-startup-recovered",
          }),
          type: "thread.message.completed",
        }),
        expect.objectContaining({
          thread: expect.objectContaining({ state: "failed" }),
          type: "thread.state.changed",
        }),
      ]),
    );
  });

  it("dispatches one durable queued input after a recovered turn completes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const threadId = "app-thread-recovery-queue";
    const threadCoordinator = await createRelayStateStore(":memory:");
    const previousOwner = await threadCoordinator.acquireThreadOwner({
      capabilities: {
        approve: true,
        configure: true,
        interrupt: true,
        queue: true,
        send: true,
        steer: true,
        view: true,
      },
      ownerId: "relay-recovery-queue",
      ownerInstanceId: "process-before-restart",
      ownerType: "shared_app_server",
      threadId,
    });
    await threadCoordinator.createThreadInput({
      clientId: "mobile-client",
      inputId: "input-recovery-active",
      payload: { prompt: "active before restart" },
      state: "accepted",
      threadId,
    });
    const acquired = await threadCoordinator.acquireTurnClaim({
      inputId: "input-recovery-active",
      ownerEpoch: previousOwner.epoch,
      ownerId: previousOwner.ownerId,
      threadId,
    });
    if (acquired.kind !== "acquired") {
      throw new Error("Expected the pre-restart input to acquire a claim.");
    }
    const bound = await threadCoordinator.bindTurnClaimRuntimeTurn({
      claimId: acquired.claim.claimId,
      ownerEpoch: previousOwner.epoch,
      ownerId: previousOwner.ownerId,
      runtimeTurnId: "turn-recovery-active",
    });
    if (bound.kind !== "updated") {
      throw new Error("Expected the pre-restart claim to bind its runtime turn.");
    }
    const adopted = await threadCoordinator.adoptActiveTurnClaim({
      capabilities: previousOwner.capabilities,
      claimId: acquired.claim.claimId,
      ownerId: "relay-recovery-queue",
      ownerInstanceId: "process-after-restart",
      ownerType: "shared_app_server",
      runtimeTurnId: "turn-recovery-active",
      threadId,
    });
    if (adopted.kind !== "adopted") {
      throw new Error("Expected the pre-restart claim to be adopted.");
    }
    await threadCoordinator.createThreadInput({
      clientId: "mobile-client",
      inputId: "input-recovery-queued",
      payload: {
        attachments: [],
        prompt: "queued after restart",
        runOptions: {},
        skills: [],
        workspacePath,
      },
      state: "queued",
      threadId,
    });

    const recoveredTurn = {
      completedAt: null as number | null,
      id: "turn-recovery-active",
      items: [
        {
          id: "assistant-recovery-active",
          text: "Recovered first output",
          type: "agentMessage",
        },
      ],
      startedAt: now,
      status: "running",
    };
    const turns: unknown[] = [recoveredTurn];
    const queuedTurn = {
      completedAt: now,
      id: "turn-recovery-queued",
      items: [
        {
          id: "assistant-recovery-queued",
          text: "Recovered queued output",
          type: "agentMessage",
        },
      ],
      startedAt: now,
      status: "completed",
    };
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      turns.push(queuedTurn);
      return queuedTurn;
    });
    const readThread = vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(
      async () => ({
        id: threadId,
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Recovery queue",
        preview: "Recovery queue",
        source: "app",
        status: turns.every((turn) => (turn as { status?: string }).status === "completed")
          ? "idle"
          : "active",
        turns,
        updatedAt: now,
      }),
    );
    const appServer = {
      appServerMode: "socket",
      onConnectionState() {
        return () => undefined;
      },
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      readThread,
      startTurn,
    };

    createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: {
        relayId: "relay-recovery-queue",
        serverEpoch: "process-after-restart",
      },
      recoveredTurnClaims: [{ claim: adopted.claim, input: adopted.input, owner: adopted.owner }],
      threadCoordinator,
      threadEvents: threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });
    await vi.waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));

    for (const handler of notificationHandlers) {
      handler({
        method: "item/completed",
        params: {
          item: recoveredTurn.items[0],
          threadId,
          turnId: recoveredTurn.id,
        },
      });
    }
    await vi.waitFor(async () => {
      const events = await threadCoordinator.listThreadEvents({ threadId, limit: 100 });
      expect(events.events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ content: "Recovered first output" }),
            type: "thread.message.completed",
          }),
        ]),
      );
    });
    expect(await threadCoordinator.getActiveTurnClaim(threadId)).toMatchObject({
      claimId: acquired.claim.claimId,
    });
    expect(startTurn).not.toHaveBeenCalled();

    recoveredTurn.completedAt = now;
    recoveredTurn.status = "completed";
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId, turnId: recoveredTurn.id },
      });
    }

    await vi.waitFor(async () => {
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(await threadCoordinator.getActiveTurnClaim(threadId)).toBeUndefined();
    });
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId, turnId: recoveredTurn.id },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(await threadCoordinator.listThreadInputs({ threadId })).toMatchObject([
      { inputId: "input-recovery-active", state: "completed" },
      { inputId: "input-recovery-queued", state: "completed" },
    ]);
    const recoveredEvents = await threadCoordinator.listThreadEvents({ threadId, limit: 100 });
    const assistantContents = recoveredEvents.events.flatMap((event) =>
      "message" in event.event && event.event.message?.role === "assistant"
        ? [event.event.message.content]
        : [],
    );
    expect(assistantContents).toEqual(
      expect.arrayContaining(["Recovered first output", "Recovered queued output"]),
    );
    expect(
      assistantContents.filter((content) => content === "Recovered first output"),
    ).toHaveLength(1);
  });

  it("keeps a recovery-dispatched claim active when runtime binding persistence fails", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const threadId = "app-thread-recovery-bind-failure";
    const store = await createRelayStateStore(":memory:");
    const adopted = await createAdoptedTestClaim({
      inputId: "input-recovery-bind-active",
      ownerId: "relay-recovery-bind",
      store,
      threadId,
      turnId: "turn-recovery-bind-active",
    });
    await store.createThreadInput({
      clientId: "mobile-client",
      inputId: "input-recovery-bind-queued",
      payload: {
        attachments: [],
        prompt: "queued bind failure",
        runOptions: {},
        skills: [],
        workspacePath,
      },
      state: "queued",
      threadId,
    });

    const recoveredTurn = {
      completedAt: null as number | null,
      id: "turn-recovery-bind-active",
      items: [],
      startedAt: now,
      status: "running",
    };
    const acceptedTurn = {
      completedAt: null,
      id: "turn-recovery-bind-accepted",
      items: [],
      startedAt: now,
      status: "running",
    };
    const startTurn = vi.fn<() => Promise<unknown>>(async () => acceptedTurn);
    const bindTurnClaimRuntimeTurn = vi.fn<typeof store.bindTurnClaimRuntimeTurn>(async () => {
      throw new Error("database temporarily unavailable");
    });
    const recoveryCoordinator = { ...store, bindTurnClaimRuntimeTurn };
    const readThread = vi.fn<(_threadId: string, _options: unknown) => Promise<unknown>>(
      async () => ({
        id: threadId,
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Recovery bind failure",
        preview: "Recovery bind failure",
        source: "app",
        status: recoveredTurn.status === "completed" ? "idle" : "active",
        turns: [recoveredTurn, acceptedTurn],
        updatedAt: now,
      }),
    );
    const appServer = {
      appServerMode: "socket",
      onConnectionState() {
        return () => undefined;
      },
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      readThread,
      startTurn,
    };

    createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: {
        relayId: "relay-recovery-bind",
        serverEpoch: "process-after-restart",
      },
      recoveredTurnClaims: [{ claim: adopted.claim, input: adopted.input, owner: adopted.owner }],
      threadCoordinator: recoveryCoordinator,
      threadEvents: store,
      threadInputs: store,
      workspacePath,
    });
    await vi.waitFor(() => expect(readThread).toHaveBeenCalledTimes(1));

    recoveredTurn.completedAt = now;
    recoveredTurn.status = "completed";
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId, turnId: recoveredTurn.id },
      });
    }
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(bindTurnClaimRuntimeTurn).toHaveBeenCalledTimes(1);
    });

    expect(await store.getActiveTurnClaim(threadId)).toMatchObject({
      inputId: "input-recovery-bind-queued",
      runtimeTurnId: undefined,
      state: "active",
    });
    expect(await store.listThreadInputs({ threadId })).toMatchObject([
      { inputId: "input-recovery-bind-active", state: "completed" },
      { inputId: "input-recovery-bind-queued", state: "running" },
    ]);
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId, turnId: recoveredTurn.id },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("recovers a missing app-server thread even after prior messages exist", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    let threadStartCount = 0;
    let turnCount = 0;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => {
        threadStartCount += 1;
        return {
          id: threadStartCount === 1 ? "app-thread-stale" : "app-thread-recovered",
          createdAt: now,
          cwd: workspacePath,
          modelProvider: "gpt-5.5",
          name: "Stale thread",
          preview: "Stale thread",
          source: "app",
          status: "idle",
          turns: [],
          updatedAt: now,
        };
      }),
      startTurn: vi.fn<(params: { threadId: string }) => Promise<unknown>>(async (params) => {
        turnCount += 1;
        if (turnCount === 2) {
          throw new Error("Thread not found");
        }
        const reply = turnCount === 1 ? "first reply" : "recovered reply";
        const turnId = `turn-stale-${turnCount}`;
        const itemId = `assistant-stale-${turnCount}`;
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "item/agentMessage/delta",
              params: {
                delta: reply,
                itemId,
                threadId: params.threadId,
                turnId,
              },
            });
            handler({
              method: "turn/completed",
              params: { status: "completed", threadId: params.threadId, turnId },
            });
          }
        });
        return {
          id: turnId,
          items: [],
          status: "running",
          startedAt: null,
          completedAt: null,
        };
      }),
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: { relayId: "relay-recovery", serverEpoch: "process-recovery" },
      threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Stale thread" }),
      headers: { "content-type": "application/json" },
    });
    const firstResponse = await app.request("/v1/threads/app-thread-stale/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "27cc6547-d51d-40d4-b60f-006e10c27cb8",
        prompt: "First run",
      }),
      headers: { "content-type": "application/json" },
    });
    await firstResponse.text();

    const secondResponse = await app.request("/v1/threads/app-thread-stale/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "b2a8e8fd-5681-4a94-974f-f1e72dbb73ce",
        prompt: "Continue existing thread",
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await secondResponse.text();

    expect(secondResponse.status).toBe(200);
    expect(appServer.startThread).toHaveBeenCalledTimes(2);
    expect(body).not.toContain("thread.error");
    expect(body).toContain("recovered reply");
    expect(body).toContain('"id":"app-thread-recovered"');
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "b2a8e8fd-5681-4a94-974f-f1e72dbb73ce",
      ),
    ).toMatchObject({ state: "completed", threadId: "app-thread-recovered" });
    expect(await threadCoordinator.getActiveTurnClaim("app-thread-stale")).toBeUndefined();
    expect(await threadCoordinator.getActiveTurnClaim("app-thread-recovered")).toBeUndefined();
  });

  it("hands off queued input when the active turn completes during input submission", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    let delayQueuedPreferenceRead = false;
    let releaseQueuedPreferenceRead: (() => void) | undefined;
    const queuedPreferenceRead = new Promise<void>((resolve) => {
      releaseQueuedPreferenceRead = resolve;
    });
    let signalQueuedPreferenceRead: (() => void) | undefined;
    const queuedPreferenceReadStarted = new Promise<void>((resolve) => {
      signalQueuedPreferenceRead = resolve;
    });
    const preferences: RuntimePreferencesStore = {
      async read() {
        if (delayQueuedPreferenceRead) {
          signalQueuedPreferenceRead?.();
          await queuedPreferenceRead;
        }
        return { runtimeMode: "default" };
      },
      async readByWorkspacePath() {
        return {};
      },
      async update() {
        return { runtimeMode: "default" };
      },
    };
    const now = Date.now() / 1000;
    let turnCount = 0;
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      turnCount += 1;
      return {
        id: `turn-queue-race-${turnCount}`,
        items: [],
        status: "running",
        startedAt: null,
        completedAt: null,
      };
    });
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-queue-race",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Queue race",
        preview: "Queue race",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      preferences,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Queue race" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-queue-race/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Initial run" }),
      headers: { "content-type": "application/json" },
    });
    await waitUntil(() => expect(startTurn).toHaveBeenCalledTimes(1));

    delayQueuedPreferenceRead = true;
    const queuedResponse = app.request("/v1/threads/app-thread-queue-race/input", {
      method: "POST",
      body: JSON.stringify({ prompt: "Queued after completion" }),
      headers: { "content-type": "application/json" },
    });
    await queuedPreferenceReadStarted;
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-queue-race",
          turnId: "turn-queue-race-1",
        },
      });
    }
    releaseQueuedPreferenceRead?.();

    await expect(queuedResponse).resolves.toHaveProperty("status", 202);
    await waitUntil(() => expect(startTurn).toHaveBeenCalledTimes(2));

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-queue-race",
          turnId: "turn-queue-race-2",
        },
      });
    }
    expect(await streamResponse.text()).toContain("thread.state.changed");
  });

  it("queues additional running-thread input on the server", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    let turnCount = 0;
    const startTurn = vi.fn<(params: unknown) => Promise<unknown>>(async () => {
      turnCount += 1;
      return {
        id: `turn-${turnCount}`,
        items: [],
        status: "running",
        startedAt: null,
        completedAt: null,
      };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-queue",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Queue thread",
        preview: "Queue thread",
        source: "app",
        status: turnCount > 0 ? "active" : "idle",
        turns: [],
        updatedAt: now,
      })),
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-queue",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Queue thread",
        preview: "Queue thread",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const threadInputs = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator: threadInputs,
      threadInputs,
      workspacePath,
    });
    const skillPath = join(workspacePath, ".agents", "skills", "dogfood", "SKILL.md");
    const imagePath = join(workspacePath, "queued.png");
    await writeFile(imagePath, Buffer.from("queued"));
    const attachment = {
      mimeType: "image/png",
      name: "queued.png",
      path: imagePath,
      type: "image" as const,
      url: "/v1/attachments/images/queued.png",
    };

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Queue thread" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-queue/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "fa924609-21bc-42ab-9f9e-e4ae6e75fd76",
        prompt: "Initial run",
      }),
      headers: {
        "content-type": "application/json",
        "x-codex-relay-client-session-id": "mobile-client-a",
      },
    });
    const duplicateStreamResponse = await app.request("/v1/threads/app-thread-queue/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "fa924609-21bc-42ab-9f9e-e4ae6e75fd76",
        prompt: "Initial run",
      }),
      headers: {
        "content-type": "application/json",
        "x-codex-relay-client-session-id": "mobile-client-a",
      },
    });

    const firstQueuedResponse = await app.request("/v1/threads/app-thread-queue/input", {
      method: "POST",
      body: JSON.stringify({
        approvalPolicy: "never",
        attachments: [attachment],
        clientEventId: "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
        model: "gpt-5.5",
        prompt: "Run after first",
        reasoningEffort: "high",
        runtimeMode: "auto",
        sandboxMode: "danger-full-access",
        skills: [{ name: "dogfood", path: skillPath }],
      }),
      headers: {
        "content-type": "application/json",
        "x-codex-relay-client-session-id": "mobile-client-a",
      },
    });
    const firstQueuedBody = await firstQueuedResponse.json();
    const duplicateQueuedResponse = await app.request("/v1/threads/app-thread-queue/input", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
        prompt: "A retry body is ignored after the first acceptance",
      }),
      headers: {
        "content-type": "application/json",
        "x-codex-relay-client-session-id": "mobile-client-a",
      },
    });
    const secondQueuedResponse = await app.request("/v1/threads/app-thread-queue/input", {
      method: "POST",
      body: JSON.stringify({ prompt: "Run after second" }),
      headers: { "content-type": "application/json" },
    });

    expect(firstQueuedResponse.status).toBe(202);
    expect(firstQueuedBody).toMatchObject({
      acceptedAs: "queued",
      clientEventId: "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
      deliveryState: "queued",
      inputId: expect.any(String),
      queueLength: 1,
      thread: {
        approvalPolicy: "never",
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "auto",
        sandboxMode: "danger-full-access",
      },
      input: {
        attachments: [attachment],
        clientEventId: "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
        skills: [{ name: "dogfood", path: skillPath }],
      },
    });
    expect(duplicateQueuedResponse.status).toBe(202);
    await expect(duplicateQueuedResponse.json()).resolves.toEqual(firstQueuedBody);
    expect(secondQueuedResponse.status).toBe(202);
    await expect(secondQueuedResponse.json()).resolves.toMatchObject({
      acceptedAs: "queued",
      queueLength: 2,
    });
    expect(startTurn).toHaveBeenCalledTimes(1);
    const initialInput = await threadInputs.getThreadInputByClientEvent(
      "mobile-client-a",
      "fa924609-21bc-42ab-9f9e-e4ae6e75fd76",
    );
    expect(initialInput).toMatchObject({
      payload: expect.objectContaining({ prompt: "Initial run" }),
      state: "running",
    });
    expect(await threadInputs.getActiveTurnClaim("app-thread-queue")).toMatchObject({
      inputId: initialInput?.inputId,
      runtimeTurnId: "turn-1",
      state: "active",
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "app-thread-queue", turnId: "turn-1" },
      });
    }
    expect(await duplicateStreamResponse.text()).not.toContain("codex_empty_response");
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(2);
    });
    const observedReadCount = appServer.readThread.mock.calls.length;
    const terminalRetryResponse = await app.request("/v1/threads/app-thread-queue/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "fa924609-21bc-42ab-9f9e-e4ae6e75fd76",
        prompt: "Initial run",
      }),
      headers: {
        "content-type": "application/json",
        "x-codex-relay-client-session-id": "mobile-client-a",
      },
    });
    expect(await terminalRetryResponse.text()).toBe("");
    expect(appServer.readThread).toHaveBeenCalledTimes(observedReadCount);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(
      await threadInputs.getThreadInputByClientEvent(
        "mobile-client-a",
        "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
      ),
    ).toMatchObject({ state: "running" });
    expect(await threadInputs.getActiveTurnClaim("app-thread-queue")).toMatchObject({
      inputId: firstQueuedBody.inputId,
      runtimeTurnId: "turn-2",
      state: "active",
    });
    expect(startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        approvalPolicy: "never",
        clientUserMessageId: "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
        effort: "high",
        model: "gpt-5.5",
        sandboxPolicy: { type: "dangerFullAccess" },
        threadId: "app-thread-queue",
        input: [
          { type: "text", text: "Run after first", text_elements: [] },
          { type: "localImage", path: imagePath },
          { type: "skill", name: "dogfood", path: skillPath },
        ],
      }),
    );

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "app-thread-queue", turnId: "turn-2" },
      });
    }
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(3);
    });
    expect(
      await threadInputs.getThreadInputByClientEvent(
        "mobile-client-a",
        "bea3b9d1-c9ce-43ce-a859-40a7d303d1ab",
      ),
    ).toMatchObject({ state: "completed" });
    expect(await threadInputs.getActiveTurnClaim("app-thread-queue")).toMatchObject({
      inputId: expect.not.stringMatching(firstQueuedBody.inputId),
      state: "active",
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: { status: "completed", threadId: "app-thread-queue", turnId: "turn-3" },
      });
    }
    expect(await streamResponse.text()).toContain("thread.state.changed");
    expect(await threadInputs.getActiveTurnClaim("app-thread-queue")).toBeUndefined();
  });

  it("does not cancel a queued input that became running after queue hydration", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const threadInputs = await createRelayStateStore(":memory:");
    await threadInputs.createThreadInput({
      clientId: "mobile-client-a",
      inputId: "queued-stale-input",
      payload: {
        attachments: [],
        id: "queued-stale-input",
        prompt: "Run after hydration",
        runOptions: { prompt: "Run after hydration" },
        skills: [],
        workspacePath,
      },
      state: "queued",
      threadId: "app-thread-stale-delete",
    });
    const now = Date.now() / 1000;
    const appServer = {
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-stale-delete",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Stale delete",
        preview: "Stale delete",
        source: "app",
        status: "running",
        turns: [],
        updatedAt: now,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadInputs,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Stale delete" }),
      headers: { "content-type": "application/json" },
    });
    const queued = await app.request("/v1/threads/app-thread-stale-delete/input");
    expect(await queued.json()).toMatchObject({
      inputs: [expect.objectContaining({ id: "queued-stale-input" })],
      queueLength: 1,
    });
    await threadInputs.updateThreadInputState("queued-stale-input", "running");

    const cancellation = await app.request(
      "/v1/threads/app-thread-stale-delete/input/queued-stale-input",
      {
        method: "DELETE",
      },
    );

    expect(cancellation.status).toBe(409);
    await expect(
      threadInputs.listThreadInputs({ threadId: "app-thread-stale-delete" }),
    ).resolves.toMatchObject([{ inputId: "queued-stale-input", state: "running" }]);
    await threadInputs.updateThreadInputState("queued-stale-input", "cancelled");
    const retry = await app.request(
      "/v1/threads/app-thread-stale-delete/input/queued-stale-input",
      { method: "DELETE" },
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ queueLength: 0 });
  });

  it("returns the current queue after a cancelled input is retried", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const threadInputs = await createRelayStateStore(":memory:");
    await threadInputs.createThreadInput({
      clientId: "mobile-client-a",
      inputId: "queued-cancel-retry",
      payload: {
        attachments: [],
        id: "queued-cancel-retry",
        prompt: "Cancel once",
        runOptions: { prompt: "Cancel once" },
        skills: [],
        workspacePath,
      },
      state: "queued",
      threadId: "app-thread-cancel-retry",
    });
    const now = Date.now() / 1000;
    const app = createApp({
      appServer: {
        startThread: vi.fn<() => Promise<unknown>>(async () => ({
          id: "app-thread-cancel-retry",
          createdAt: now,
          cwd: workspacePath,
          modelProvider: "gpt-5.5",
          name: "Cancel retry",
          preview: "Cancel retry",
          source: "app",
          status: "running",
          turns: [],
          updatedAt: now,
        })),
      } as never,
      codex: createMockCodex(),
      threadInputs,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Cancel retry" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/v1/threads/app-thread-cancel-retry/input");

    const first = await app.request(
      "/v1/threads/app-thread-cancel-retry/input/queued-cancel-retry",
      { method: "DELETE" },
    );
    const retried = await app.request(
      "/v1/threads/app-thread-cancel-retry/input/queued-cancel-retry",
      { method: "DELETE" },
    );

    expect(first.status).toBe(200);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ queueLength: 0 });
    await expect(
      threadInputs.listThreadInputs({ threadId: "app-thread-cancel-retry" }),
    ).resolves.toMatchObject([{ inputId: "queued-cancel-retry", state: "cancelled" }]);
  });

  it("treats a steer retry as successful after the durable input already ran", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const threadInputs = await createRelayStateStore(":memory:");
    await threadInputs.createThreadInput({
      clientId: "mobile-client-a",
      inputId: "queued-steer-retry",
      payload: {
        attachments: [],
        id: "queued-steer-retry",
        prompt: "Already steered",
        runOptions: { prompt: "Already steered" },
        skills: [],
        workspacePath,
      },
      state: "queued",
      threadId: "app-thread-steer-retry",
    });
    await threadInputs.createThreadInput({
      clientId: "mobile-client-a",
      inputId: "queued-steer-failed",
      payload: { prompt: "Dispatch failed" },
      state: "failed",
      threadId: "app-thread-steer-retry",
    });
    const now = Date.now() / 1000;
    const app = createApp({
      appServer: {
        startThread: vi.fn<() => Promise<unknown>>(async () => ({
          id: "app-thread-steer-retry",
          createdAt: now,
          cwd: workspacePath,
          modelProvider: "gpt-5.5",
          name: "Steer retry",
          preview: "Steer retry",
          source: "app",
          status: "idle",
          turns: [],
          updatedAt: now,
        })),
      } as never,
      codex: createMockCodex(),
      threadInputs,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Steer retry" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/v1/threads/app-thread-steer-retry/input");
    await threadInputs.updateThreadInputState("queued-steer-retry", "completed");
    const retried = await app.request(
      "/v1/threads/app-thread-steer-retry/input/queued-steer-retry/steer",
      { method: "POST" },
    );

    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toMatchObject({ queueLength: 0 });
    const failed = await app.request(
      "/v1/threads/app-thread-steer-retry/input/queued-steer-failed/steer",
      { method: "POST" },
    );
    expect(failed.status).toBe(404);
  });

  it("reacquires a thread owner after a stale terminal callback", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const dispatchOrder: string[] = [];
    let turnCount = 0;
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      dispatchOrder.push("start");
      turnCount += 1;
      return {
        id: `turn-owner-${turnCount}`,
        items: [],
        status: "running",
        startedAt: null,
        completedAt: null,
      };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-owner-epoch",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Owner epoch",
        preview: "Owner epoch",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    let replaceOwnerOnNextRead = false;
    const racingThreadCoordinator = {
      ...threadCoordinator,
      async getThreadOwner(threadId: string) {
        const owner = await threadCoordinator.getThreadOwner(threadId);
        if (replaceOwnerOnNextRead) {
          replaceOwnerOnNextRead = false;
          await threadCoordinator.acquireThreadOwner({
            capabilities: owner!.capabilities,
            ownerId: "relay-replacement",
            ownerInstanceId: "process-replacement",
            ownerType: "relay_app_server",
            threadId,
          });
        }
        return owner;
      },
      async markTurnClaimDispatch(
        input: Parameters<typeof threadCoordinator.markTurnClaimDispatch>[0],
      ) {
        dispatchOrder.push("mark");
        return threadCoordinator.markTurnClaimDispatch(input);
      },
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      connectionPlan: { relayId: "relay-primary", serverEpoch: "process-primary" },
      threadCoordinator: racingThreadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Owner epoch" }),
      headers: { "content-type": "application/json" },
    });
    const firstStream = await app.request("/v1/threads/app-thread-owner-epoch/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "1d5e155c-081b-48bd-a576-383f2d52d129",
        prompt: "First owner run",
      }),
      headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    expect(dispatchOrder).toEqual(["mark", "start"]);
    expect(await threadCoordinator.getThreadOwner("app-thread-owner-epoch")).toMatchObject({
      epoch: 1,
      ownerId: "relay-primary",
      ownerInstanceId: "process-primary",
    });

    replaceOwnerOnNextRead = true;
    const staleStream = await app.request("/v1/threads/app-thread-owner-epoch/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "73970ab9-47bf-49e0-aa29-a8736984c142",
        expectedOwnerEpoch: 1,
        prompt: "Must not run under the replacement owner",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(staleStream.status).toBe(409);
    expect(await staleStream.json()).toMatchObject({
      error: { code: "stale_owner_epoch" },
    });
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "73970ab9-47bf-49e0-aa29-a8736984c142",
      ),
    ).toBeUndefined();
    const replacementDetail = await app.request("/v1/threads/app-thread-owner-epoch");
    expect(await replacementDetail.json()).toMatchObject({
      thread: { id: "app-thread-owner-epoch", ownerEpoch: 2 },
    });
    const staleClaimStream = await app.request("/v1/threads/app-thread-owner-epoch/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "18cc7882-5105-457e-a1d8-37e37510e42d",
        expectedOwnerEpoch: 2,
        prompt: "Do not leave an accepted input after a stale claim",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(staleClaimStream.status).toBe(409);
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "18cc7882-5105-457e-a1d8-37e37510e42d",
      ),
    ).toMatchObject({ state: "failed" });
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-owner-epoch",
          turnId: "turn-owner-1",
        },
      });
    }
    await firstStream.text();

    const secondStream = await app.request("/v1/threads/app-thread-owner-epoch/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "35b6d0a0-fe5e-4d1f-85d0-a0d18de61dcc",
        prompt: "Second owner run",
      }),
      headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    expect(await threadCoordinator.getThreadOwner("app-thread-owner-epoch")).toMatchObject({
      epoch: 3,
      ownerId: "relay-primary",
      ownerInstanceId: "process-primary",
    });
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-owner-epoch",
          turnId: "turn-owner-2",
        },
      });
    }
    await secondStream.text();
    expect(await threadCoordinator.getActiveTurnClaim("app-thread-owner-epoch")).toBeUndefined();
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "35b6d0a0-fe5e-4d1f-85d0-a0d18de61dcc",
      ),
    ).toMatchObject({ state: "failed" });
  });

  it("queues a new stream prompt without observing the active turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    let turnCount = 0;
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      turnCount += 1;
      return {
        id: `turn-stream-queue-${turnCount}`,
        items: [],
        status: "running",
        startedAt: null,
        completedAt: null,
      };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-stream-queue",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Stream queue",
        preview: "Stream queue",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const threadCoordinator = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadCoordinator,
      threadInputs: threadCoordinator,
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Stream queue" }),
      headers: { "content-type": "application/json" },
    });
    const activeStream = await app.request("/v1/threads/app-thread-stream-queue/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "cb4ece86-fcdb-436a-863d-5e05422c826e",
        prompt: "Active prompt",
      }),
      headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));
    const queuedStream = await app.request("/v1/threads/app-thread-stream-queue/runs/stream", {
      method: "POST",
      body: JSON.stringify({
        clientEventId: "c3a6be8a-527f-4466-9a54-d1cbd98ab31e",
        prompt: "Queued prompt",
      }),
      headers: { "content-type": "application/json" },
    });
    const queuedBody = await queuedStream.text();

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(queuedBody).toContain("thread.state.changed");
    expect(queuedBody).not.toContain("thread.message.");
    expect(
      await threadCoordinator.getThreadInputByClientEvent(
        "unpaired-client",
        "c3a6be8a-527f-4466-9a54-d1cbd98ab31e",
      ),
    ).toMatchObject({ state: "queued" });

    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-stream-queue",
          turnId: "turn-stream-queue-1",
        },
      });
    }
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-stream-queue",
          turnId: "turn-stream-queue-2",
        },
      });
    }
    await activeStream.text();
  });

  it("validates empty responses independently for each queued app-server turn", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    let turnCount = 0;
    const startTurn = vi.fn<() => Promise<unknown>>(async () => {
      turnCount += 1;
      return {
        id: `turn-per-turn-output-${turnCount}`,
        items: [],
        status: "running",
        startedAt: null,
        completedAt: null,
      };
    });
    const now = Date.now() / 1000;
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      startThread: vi.fn<() => Promise<unknown>>(async () => ({
        id: "app-thread-per-turn-output",
        createdAt: now,
        cwd: workspacePath,
        modelProvider: "gpt-5.5",
        name: "Per-turn output",
        preview: "Per-turn output",
        source: "app",
        status: "idle",
        turns: [],
        updatedAt: now,
      })),
      startTurn,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Per-turn output" }),
      headers: { "content-type": "application/json" },
    });
    const streamResponse = await app.request("/v1/threads/app-thread-per-turn-output/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Initial output" }),
      headers: { "content-type": "application/json" },
    });
    const queuedResponse = await app.request("/v1/threads/app-thread-per-turn-output/input", {
      method: "POST",
      body: JSON.stringify({ prompt: "Queued empty output" }),
      headers: { "content-type": "application/json" },
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "item/completed",
        params: {
          item: { id: "assistant-first-output", text: "first output", type: "agentMessage" },
          threadId: "app-thread-per-turn-output",
          turnId: "turn-per-turn-output-1",
        },
      });
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-per-turn-output",
          turnId: "turn-per-turn-output-1",
        },
      });
    }
    await waitUntil(() => expect(startTurn).toHaveBeenCalledTimes(2));
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          status: "completed",
          threadId: "app-thread-per-turn-output",
          turnId: "turn-per-turn-output-2",
        },
      });
    }
    const body = await streamResponse.text();

    expect(queuedResponse.status).toBe(202);
    expect(body).toContain("first output");
    expect(body).toContain("codex_empty_response");
    expect(body).toContain('"state":"failed"');
  });

  it("runs a prompt on a known thread", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const appPath = join(workspacePath, "apps");
    await mkdir(appPath);
    const resumeOptions: Parameters<CodexClient["resumeThread"]>[1][] = [];
    const app = createApp({
      codex: createMockCodex({
        onResumeThread: (_threadId, options) => resumeOptions.push(options),
      }),
      workspacePath,
    });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Existing", workspacePath: appPath }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(resumeOptions[0]).toMatchObject({ workingDirectory: appPath });
    expect(body.result).toBe("result: Continue");
    expect(body.thread.state).toBe("completed");
    expect(body.messages).toHaveLength(2);
  });

  it("accepts image attachments on a thread run", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const imagePath = join(workspacePath, "sketch.png");
    await writeFile(imagePath, Buffer.from("hello"));
    const app = createApp({ codex: createMockCodex(), workspacePath });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Existing" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      body: JSON.stringify({
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "sketch.png",
            path: imagePath,
          },
        ],
        prompt: "Describe this",
      }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result).toContain("Describe this");
    expect(body.result).toContain("Attached image 1 (sketch.png):");
    expect(body.result).toContain(imagePath);
    expect(body.result).not.toContain("data:image/png;base64");
    expect(body.messages[0].details.attachments[0]).toMatchObject({
      mimeType: "image/png",
      name: "sketch.png",
      path: imagePath,
      type: "image",
    });
    expect(body.messages[0].details.attachments[0]).not.toHaveProperty("dataUri");
  });

  it("returns thread detail with message history", async () => {
    const app = createApp({ codex: createMockCodex() });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Existing" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/v1/threads/thread-1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread.messageCount).toBe(2);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("returns thread detail history with an explicit older-message state", async () => {
    const app = createApp({ codex: createMockCodex() });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Existing" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "First" }),
      headers: { "content-type": "application/json" },
    });
    await app.request("/v1/threads/thread-1/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Second" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/v1/threads/thread-1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.hasOlderMessages).toBe(false);
    expect(body).not.toHaveProperty("olderMessagesCursor");
    expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
      "First",
      "result: First",
      "Second",
      "result: Second",
    ]);
  });

  it("loads all app-server thread messages on thread detail", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const longThread = {
      id: "app-thread-long",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Long thread",
      preview: "Long thread",
      source: "app",
      status: { type: "idle" },
      turns: Array.from({ length: 121 }, (_value, index) => ({
        id: `turn-${index}`,
        completedAt: now,
        items: [
          {
            id: `user-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `Message ${index}`, text_elements: [] }],
          },
        ],
        startedAt: now,
        status: { type: "completed" },
      })),
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => ({
      ...longThread,
      turns: options?.includeTurns === false ? undefined : longThread.turns,
    }));
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [longThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    await app.request("/v1/threads");
    const response = await app.request("/v1/threads/app-thread-long");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(readThread).toHaveBeenNthCalledWith(1, "app-thread-long", { includeTurns: false });
    expect(readThread).toHaveBeenNthCalledWith(2, "app-thread-long", { includeTurns: true });
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(body.messages).toHaveLength(121);
    expect(body.messages.at(0)?.content).toBe("Message 0");
    expect(body.messages.at(-1)?.content).toBe("Message 120");
    expect(body.hasOlderMessages).toBe(false);
    expect(body).not.toHaveProperty("olderMessagesCursor");
  });

  it("preserves cached full items when refreshed app-server history is summary-only", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const fullTurn = {
      ...appServerTurn("turn-summary-history", "Full user message", now),
      itemsView: "full",
    };
    const summaryTurn = {
      ...fullTurn,
      items: [fullTurn.items[1]],
      itemsView: "summary",
    };
    const baseThread = appServerHistoryThread({
      id: "app-thread-summary-history",
      name: "Summary history",
      turns: [fullTurn],
      workspacePath,
    });
    let fullReadCount = 0;
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => {
      if (options?.includeTurns === false) {
        return { ...baseThread, turns: undefined };
      }
      fullReadCount += 1;
      return {
        ...baseThread,
        turns: fullReadCount === 1 ? [fullTurn] : [summaryTurn],
      };
    });
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [baseThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const initialResponse = await app.request("/v1/threads/app-thread-summary-history");
    const refreshedResponse = await app.request(
      "/v1/threads/app-thread-summary-history?refresh=true",
    );
    const initialBody = await initialResponse.json();
    const refreshedBody = await refreshedResponse.json();

    expect(initialResponse.status).toBe(200);
    expect(refreshedResponse.status).toBe(200);
    expect(initialBody.messages.map((message: { id: string }) => message.id)).toEqual([
      "turn-summary-history-user",
      "turn-summary-history-assistant",
    ]);
    expect(refreshedBody.messages.map((message: { id: string }) => message.id)).toEqual([
      "turn-summary-history-user",
      "turn-summary-history-assistant",
    ]);
    expect(refreshedBody.thread.messageCount).toBe(2);
  });

  it("limits very large thread detail responses to the latest messages", async () => {
    const previousLimit = process.env.CODEX_RELAY_THREAD_DETAIL_MESSAGE_LIMIT;
    process.env.CODEX_RELAY_THREAD_DETAIL_MESSAGE_LIMIT = "3";
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const longThread = {
      id: "app-thread-capped",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Capped thread",
      preview: "Capped thread",
      source: "app",
      status: { type: "idle" },
      turns: Array.from({ length: 5 }, (_value, index) => ({
        id: `turn-capped-${index}`,
        completedAt: now,
        items: [
          {
            id: `user-capped-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `Message ${index}`, text_elements: [] }],
          },
        ],
        startedAt: now,
        status: { type: "completed" },
      })),
      updatedAt: now,
    };
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [longThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<
        (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
      >(async (_threadId, options) => ({
        ...longThread,
        turns: options?.includeTurns === false ? undefined : longThread.turns,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      await app.request("/v1/threads");
      const response = await app.request("/v1/threads/app-thread-capped?limit=2");
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.thread.messageCount).toBe(5);
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "Message 3",
        "Message 4",
      ]);
      expect(body).toMatchObject({
        hasOlderMessages: true,
        olderMessagesCursor: "user-capped-3",
      });

      const olderResponse = await app.request(
        "/v1/threads/app-thread-capped?beforeMessageId=user-capped-3&limit=2",
      );
      const olderBody = await olderResponse.json();
      expect(olderResponse.status).toBe(200);
      expect(olderBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Message 1",
        "Message 2",
      ]);
      expect(olderBody).toMatchObject({
        hasOlderMessages: true,
        olderMessagesCursor: "user-capped-1",
      });

      const newerResponse = await app.request(
        "/v1/threads/app-thread-capped?afterMessageId=user-capped-1&limit=2",
      );
      const newerBody = await newerResponse.json();
      expect(newerBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Message 2",
        "Message 3",
      ]);
      expect(newerBody).toMatchObject({
        hasMoreMessages: true,
        messageCursor: "user-capped-3",
      });

      const newestResponse = await app.request(
        "/v1/threads/app-thread-capped?afterMessageId=user-capped-3&limit=2",
      );
      const newestBody = await newestResponse.json();
      expect(newestBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Message 4",
      ]);
      expect(newestBody).toMatchObject({
        hasMoreMessages: false,
        messageCursor: "user-capped-4",
      });

      const resetResponse = await app.request(
        "/v1/threads/app-thread-capped?afterMessageId=missing-message&limit=2",
      );
      const resetBody = await resetResponse.json();
      expect(resetBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Message 3",
        "Message 4",
      ]);
      expect(resetBody.messageCursorReset).toBe(true);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CODEX_RELAY_THREAD_DETAIL_MESSAGE_LIMIT;
      } else {
        process.env.CODEX_RELAY_THREAD_DETAIL_MESSAGE_LIMIT = previousLimit;
      }
    }
  });

  it("refreshes recent app-server history through turn pagination without a full read", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const turns = Array.from({ length: 6 }, (_value, index) => ({
      id: `turn-paged-${index}`,
      completedAt: now,
      items: [
        {
          id: `user-paged-${index}`,
          type: "userMessage",
          content: [{ type: "text", text: `Paged ${index}`, text_elements: [] }],
        },
      ],
      itemsView: "full",
      startedAt: now + index,
      status: { type: "completed" },
    }));
    const thread = {
      id: "app-thread-paged-refresh",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Paged refresh",
      preview: "Paged refresh",
      source: "app",
      status: { type: "idle" },
      turns: [],
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => {
      if (options?.includeTurns) {
        throw new Error("Full history read should not be used for a paginated refresh.");
      }
      return thread;
    });
    let latestTurnIndex = 4;
    const listThreadTurns = vi.fn<() => Promise<unknown>>(async () => ({
      data: [turns[latestTurnIndex], turns[latestTurnIndex - 1], turns[latestTurnIndex - 2]],
      nextCursor: "older-turns",
    }));
    const app = createApp({
      appServer: {
        listThreadTurns,
        onNotification() {
          return () => undefined;
        },
        onRequest() {
          return () => undefined;
        },
        readThread,
      } as never,
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-paged-refresh?refresh=true&limit=2");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(listThreadTurns).toHaveBeenCalledWith(
      thread.id,
      expect.objectContaining({ itemsView: "full", sortDirection: "desc" }),
    );
    expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
      "Paged 3",
      "Paged 4",
    ]);
    expect(body.hasOlderMessages).toBe(true);

    latestTurnIndex = 5;
    const cursorResponse = await app.request(
      "/v1/threads/app-thread-paged-refresh?refresh=true&afterMessageId=user-paged-4&limit=2",
    );
    const cursorBody = await cursorResponse.json();
    expect(cursorResponse.status).toBe(200);
    expect(cursorBody.messages.map((message: { content: string }) => message.content)).toEqual([
      "Paged 5",
    ]);
    expect(cursorBody.messageCursor).toBe("user-paged-5");
    expect(listThreadTurns).toHaveBeenCalledTimes(2);
  });

  it("loads a large paginated thread without an oversized thread/read response", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const turns = Array.from({ length: 3 }, (_value, index) => ({
      id: `turn-oversized-${index}`,
      completedAt: now + index,
      items: [
        {
          id: `user-oversized-${index}`,
          type: "userMessage",
          content: [{ type: "text", text: `Oversized ${index}`, text_elements: [] }],
        },
      ],
      itemsView: "full",
      startedAt: now + index,
      status: { type: "completed" },
    }));
    const thread = {
      id: "app-thread-oversized",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Oversized thread",
      preview: "Oversized thread",
      source: "app",
      status: { type: "idle" },
      turns: [],
      updatedAt: now,
    };
    const readThread = vi.fn<() => Promise<never>>(async () => {
      throw new Error("Max payload size exceeded");
    });
    const listThreadTurns = vi.fn<
      (_threadId: string, options: { cursor?: string }) => Promise<unknown>
    >(async (_threadId, options) =>
      options.cursor
        ? { data: [turns[0]], nextCursor: null }
        : { data: [turns[2], turns[1]], nextCursor: "older-turns" },
    );
    const app = createApp({
      appServer: {
        listThreads: vi.fn<() => Promise<unknown[]>>(async () => [thread]),
        listThreadTurns,
        onNotification() {
          return () => undefined;
        },
        onRequest() {
          return () => undefined;
        },
        readThread,
      } as never,
      workspacePath,
    });

    await app.request("/v1/threads");
    const recentResponse = await app.request("/v1/threads/app-thread-oversized?limit=2");
    const recentBody = await recentResponse.json();
    const olderResponse = await app.request(
      `/v1/threads/app-thread-oversized?beforeMessageId=${recentBody.olderMessagesCursor}&limit=2`,
    );
    const olderBody = await olderResponse.json();

    expect(recentResponse.status).toBe(200);
    expect(recentBody.messages.map((message: { content: string }) => message.content)).toEqual([
      "Oversized 1",
      "Oversized 2",
    ]);
    expect(recentBody).toMatchObject({
      hasOlderMessages: true,
      olderMessagesCursor: "user-oversized-1",
    });
    expect(olderResponse.status).toBe(200);
    expect(olderBody.messages.map((message: { content: string }) => message.content)).toEqual([
      "Oversized 0",
    ]);
    expect(olderBody.hasOlderMessages).toBe(false);
    expect(readThread).not.toHaveBeenCalled();
    expect(listThreadTurns).toHaveBeenCalledTimes(2);
  });

  it("loads app-server history from the rollout file when full thread reads hang", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: { turn_id: "turn-rollout", type: "task_started" },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: "hello from rollout", type: "user_message" },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: "loaded from rollout", type: "agent_message" },
          timestamp: "2026-05-02T00:00:02.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const now = Date.now() / 1000;
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Rollout backed thread",
      preview: "Rollout backed thread",
      source: "app",
      status: { type: "notLoaded" },
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async () => appThread);
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [appThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readThread).toHaveBeenNthCalledWith(1, threadId, { includeTurns: false });
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "hello from rollout",
        "loaded from rollout",
      ]);
      expect(body.messages.map((message: { turnId?: string }) => message.turnId)).toEqual([
        "turn-rollout",
        "turn-rollout",
      ]);
      expect(body).not.toHaveProperty("hasMoreMessages");
      expect(body).not.toHaveProperty("olderMessagesCursor");
      expect(body.thread.messageCount).toBe(2);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("prefers the app-server thread path when multiple rollout files share a thread id", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsRoot = join(codexHome, "sessions");
    const sessionsDir = join(sessionsRoot, "2026", "08", "26");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-selected-rollout";
    const decoyPath = join(sessionsRoot, `rollout-decoy-${threadId}.jsonl`);
    const selectedPath = join(
      sessionsDir,
      `rollout-2026-08-26T00-00-00-${threadId}_current-rollout.jsonl`,
    );
    const rolloutLines = (prompt: string, answer: string) =>
      [
        JSON.stringify({
          payload: { turn_id: "turn-selected-rollout", type: "task_started" },
          timestamp: "2026-08-26T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: prompt, type: "user_message" },
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: answer, type: "agent_message" },
          timestamp: "2026-08-26T00:00:02.000Z",
          type: "event_msg",
        }),
      ].join("\n");
    await writeFile(decoyPath, rolloutLines("old prompt", "old answer"));
    await writeFile(
      selectedPath,
      `${rolloutLines("current prompt", "current answer")}\n${JSON.stringify({
        payload: { message: "removed by revert", type: "agent_message" },
        timestamp: "2026-08-26T00:00:03.000Z",
        type: "event_msg",
      })}`,
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Selected rollout",
      path: selectedPath,
      preview: "Selected rollout",
      source: "app",
      status: { type: "notLoaded" },
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async () => appThread);
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [appThread]),
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "current prompt",
        "current answer",
        "removed by revert",
      ]);

      await writeFile(selectedPath, rolloutLines("reverted prompt", "reverted answer"));
      for (const handler of notificationHandlers) {
        handler({ method: "thread/reverted", params: { threadId } });
      }
      const revertedResponse = await app.request(`/v1/threads/${threadId}`);
      const revertedBody = await revertedResponse.json();

      expect(revertedResponse.status).toBe(200);
      expect(revertedBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "reverted prompt",
        "reverted answer",
      ]);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("replaces fallback rollout history when app-server later reports a different path", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsRoot = join(codexHome, "sessions");
    const selectedDir = join(sessionsRoot, "2026", "08", "26");
    await mkdir(selectedDir, { recursive: true });
    const threadId = "app-thread-late-rollout-path";
    const fallbackPath = join(sessionsRoot, `rollout-fallback-${threadId}.jsonl`);
    const selectedPath = join(selectedDir, `rollout-selected-${threadId}.jsonl`);
    const rolloutLines = (prompt: string, answer: string) =>
      [
        JSON.stringify({
          payload: { turn_id: `turn-${prompt}`, type: "task_started" },
          timestamp: "2026-08-26T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: prompt, type: "user_message" },
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: answer, type: "agent_message" },
          timestamp: "2026-08-26T00:00:02.000Z",
          type: "event_msg",
        }),
      ].join("\n");
    await writeFile(fallbackPath, rolloutLines("old prompt", "old answer"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const now = Date.now() / 1000;
    let detailReadCount = 0;
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Late rollout path",
      preview: "Late rollout path",
      source: "app",
      status: { type: "notLoaded" },
      updatedAt: now,
    };
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<unknown>>(async () => ({
        ...appThread,
        path: detailReadCount++ === 0 ? undefined : selectedPath,
      })),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const fallbackResponse = await app.request(`/v1/threads/${threadId}`);
      const fallbackBody = await fallbackResponse.json();
      expect(fallbackBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "old prompt",
        "old answer",
      ]);

      await writeFile(selectedPath, rolloutLines("current prompt", "current answer"));
      const selectedResponse = await app.request(`/v1/threads/${threadId}`);
      const selectedBody = await selectedResponse.json();

      expect(selectedResponse.status).toBe(200);
      expect(selectedBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "current prompt",
        "current answer",
      ]);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("uses canonical app-server history instead of projecting paginated rollout records", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "08", "26");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-paginated-rollout";
    const rolloutPath = join(
      sessionsDir,
      `rollout-2026-08-26T00-00-00-${threadId}_rollout-id.jsonl`,
    );
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          payload: { history_mode: "paginated", id: threadId },
          timestamp: "2026-08-26T00:00:00.000Z",
          type: "session_meta",
        }),
        JSON.stringify({
          payload: { message: "stale raw projection", type: "agent_message" },
          timestamp: "2026-08-26T00:00:01.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const now = Date.now() / 1000;
    const canonicalThread = {
      ...appServerHistoryThread({
        id: threadId,
        name: "Paginated history",
        turns: [appServerTurn("turn-paginated", "canonical prompt", now)],
        workspacePath,
      }),
      path: rolloutPath,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => ({
      ...canonicalThread,
      turns: options?.includeTurns === false ? undefined : canonicalThread.turns,
    }));
    const appServer = {
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readThread).toHaveBeenCalledTimes(2);
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "canonical prompt",
        "Reply: canonical prompt",
      ]);
      expect(body.messages).not.toContainEqual(
        expect.objectContaining({ content: "stale raw projection" }),
      );
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads rollout image attachments into mobile thread detail", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-image";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            images: ["data:image/png;base64,aW1hZ2U="],
            local_images: [],
            message: "이미지 테스트\n",
            text_elements: [],
            type: "user_message",
          },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: "이미지 잘 보입니다.", type: "agent_message" },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messages[0]).toMatchObject({
        content: "이미지 테스트\n",
        role: "user",
      });
      expect(body.messages[0].details.attachments[0]).toMatchObject({
        mimeType: "image/png",
        name: "image-1.png",
        path: expect.any(String),
        type: "image",
        url: expect.stringMatching(/^\/v1\/attachments\/images\/.+\.png\?v=\d+$/),
      });
      expect(body.messages[0].details.attachments[0]).not.toHaveProperty("dataUri");
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads rollout assistant markdown images into mobile thread detail", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const imagePath = join(workspacePath, "md-preview-chat.png");
    await writeFile(imagePath, Buffer.from("image"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-assistant-image";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            message: `증거 스크린샷:\n![WorkspacePreview on iPhone 17](${imagePath})\n\n완료`,
            type: "agent_message",
          },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messages[0]).toMatchObject({
        content: "증거 스크린샷:\n\n완료",
        role: "assistant",
      });
      expect(body.messages[0].details.attachments[0]).toMatchObject({
        mimeType: "image/png",
        name: "WorkspacePreview on iPhone 17",
        path: expect.any(String),
        type: "image",
        url: expect.stringMatching(/^\/v1\/attachments\/images\/.+\.png\?v=\d+$/),
      });
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads rollout patch apply events as mobile file change cards", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-patch";
    const changedPath = join(workspacePath, "src", "app.ts");
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            changes: {
              [changedPath]: {
                type: "update",
                unified_diff: patch,
              },
            },
            type: "patch_apply_end",
          },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messages[0]).toMatchObject({
        content: "1 file changed: src/app.ts",
        kind: "fileChange",
        role: "tool",
      });
      expect(body.messages[0].details.changes).toEqual([
        {
          kind: "modified",
          path: "src/app.ts",
        },
      ]);
      expect(body.messages[0].details.patch).toContain("+new");
      expect(body.messages[0].details.patchOriginalLength).toBe(patch.length);
      expect(body.messages[0].details.patchTruncated).toBe(false);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads rollout patch_apply_end bare hunks without duplicate apply_patch output cards", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-bare-patch-hunks";
    const readmePath = join(workspacePath, "README.md");
    const trademarkPath = join(workspacePath, "TRADEMARKS.md");
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            call_id: "call_apply_patch",
            changes: {
              [readmePath]: {
                type: "update",
                unified_diff: ["@@ -1 +1,2 @@", " hello", "+world"].join("\n"),
              },
              [trademarkPath]: {
                type: "update",
                unified_diff: ["@@ -3,2 +3 @@", "-old", " kept"].join("\n"),
              },
            },
            type: "patch_apply_end",
          },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: {
            call_id: "call_apply_patch",
            output: JSON.stringify({
              output: [
                "Success. Updated the following files:",
                `M ${readmePath}`,
                `M ${trademarkPath}`,
              ].join("\n"),
            }),
            type: "custom_tool_call_output",
          },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: { type: "task_complete" },
          timestamp: "2026-05-02T00:00:02.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();
      const fileChanges = body.messages.filter(
        (message: { kind: string }) => message.kind === "fileChange",
      );

      expect(response.status).toBe(200);
      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0].details.changes).toEqual([
        {
          kind: "modified",
          path: "README.md",
        },
        {
          kind: "modified",
          path: "TRADEMARKS.md",
        },
      ]);
      expect(fileChanges[0].details.patch).toContain("*** Update File: README.md");
      expect(fileChanges[0].details.patch).toContain("*** Update File: TRADEMARKS.md");
      expect(fileChanges[0].details.patch).toContain("+world");
      expect(fileChanges[0].details.patch).toContain("-old");
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads rollout apply_patch output as a file change card after the final answer", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-apply-patch";
    const addedPath = join(workspacePath, "apps", "mobile", "src", "components", "ui", "toast.tsx");
    const modifiedPath = join(
      workspacePath,
      "apps",
      "mobile",
      "src",
      "components",
      "ui",
      "status-toast.tsx",
    );
    const patch = [
      "*** Begin Patch",
      `*** Add File: ${addedPath}`,
      "+export function AppToast() {",
      "+  return null;",
      "+}",
      `*** Update File: ${modifiedPath}`,
      "@@",
      '-import { View } from "react-native";',
      '+import { AppToast } from "@/components/ui/toast";',
      "*** End Patch",
    ].join("\n");
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            call_id: "call_apply_patch",
            input: patch,
            name: "apply_patch",
            type: "custom_tool_call",
          },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call_apply_patch",
            output: JSON.stringify({
              output: [
                "Success. Updated the following files:",
                `A ${addedPath}`,
                `M ${modifiedPath}`,
              ].join("\n"),
            }),
            type: "custom_tool_call_output",
          },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            message: "토스트를 재사용 가능한 구조로 분리해뒀습니다.",
            type: "agent_message",
          },
          timestamp: "2026-05-02T00:00:02.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { type: "task_complete" },
          timestamp: "2026-05-02T00:00:03.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(
        body.messages.map((message: { kind: string; role: string }) => [
          message.role,
          message.kind,
        ]),
      ).toEqual([
        ["assistant", "chat"],
        ["tool", "fileChange"],
      ]);
      expect(body.messages[1]).toMatchObject({
        content:
          "2 files changed: apps/mobile/src/components/ui/toast.tsx, apps/mobile/src/components/ui/status-toast.tsx",
        kind: "fileChange",
        role: "tool",
      });
      expect(body.messages[1].details.changes).toEqual([
        {
          kind: "added",
          path: "apps/mobile/src/components/ui/toast.tsx",
        },
        {
          kind: "modified",
          path: "apps/mobile/src/components/ui/status-toast.tsx",
        },
      ]);
      expect(body.messages[1].details.patch).toContain("*** Add File");
      expect(body.messages[1].details.patchOriginalLength).toBe(patch.length);
      expect(body.messages[1].details.patchTruncated).toBe(false);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("hides Codex-injected context from rollout user message history", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-injected-context";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            content: codexInjectedContextBlocks(workspacePath).map((text) => ({
              text,
              type: "input_text",
            })),
            role: "user",
            type: "message",
          },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            content: [{ text: "ㅎㅇ", type: "input_text" }],
            id: "user-1",
            role: "user",
            type: "message",
          },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            content: [{ text: "안녕하세요", type: "output_text" }],
            id: "assistant-1",
            role: "assistant",
            type: "message",
          },
          timestamp: "2026-05-02T00:00:02.000Z",
          type: "response_item",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.thread.messageCount).toBe(2);
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "ㅎㅇ",
        "안녕하세요",
      ]);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("keeps app-server running state while loading full rollout messages", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-running-rollout";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: { message: "running prompt", type: "user_message" },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: "streaming answer", type: "agent_message" },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const now = Date.now() / 1000;
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Running rollout backed thread",
      preview: "Running rollout backed thread",
      source: "app",
      status: { type: "active" },
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async () => appThread);
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [appThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(readThread).toHaveBeenNthCalledWith(1, threadId, { includeTurns: false });
      expect(body.thread.state).toBe("running");
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "running prompt",
        "streaming answer",
      ]);
      expect(body).not.toHaveProperty("hasMoreMessages");
      expect(body).not.toHaveProperty("olderMessagesCursor");
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("treats an interrupted app-server turn without completedAt as terminal", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const threadId = "app-thread-interrupted-terminal";
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Interrupted terminal thread",
      preview: "Interrupted terminal thread",
      source: "cli",
      status: { type: "notLoaded" },
      updatedAt: now,
    };
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [appThread]),
      listThreadTurns: vi.fn<() => Promise<unknown>>(async () => ({
        data: [
          {
            completedAt: null,
            id: "turn-interrupted-terminal",
            items: [],
            itemsView: "full",
            startedAt: now,
            status: "interrupted",
          },
        ],
        nextCursor: null,
      })),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread: vi.fn<() => Promise<typeof appThread>>(async () => appThread),
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request(`/v1/threads/${threadId}?refresh=true`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.thread.state).toBe("idle");
  });

  it("deduplicates cached live messages when rollout history arrives with different ids", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const createResponse = await app.request("/v1/threads", {
        method: "POST",
        body: JSON.stringify({ title: "Deduped rollout" }),
        headers: { "content-type": "application/json" },
      });
      const createBody = await createResponse.json();
      const threadId = createBody.thread.id;
      await app.request(`/v1/threads/${threadId}/runs/stream`, {
        method: "POST",
        body: JSON.stringify({ prompt: "Hi" }),
        headers: { "content-type": "application/json" },
      });
      const cachedResponse = await app.request(`/v1/threads/${threadId}`);
      const cachedBody = await cachedResponse.json();
      const [userMessage, assistantMessage] = cachedBody.messages;
      await writeFile(
        join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
        [
          JSON.stringify({
            payload: { message: userMessage.content, type: "user_message" },
            timestamp: userMessage.createdAt,
            type: "event_msg",
          }),
          JSON.stringify({
            payload: { message: assistantMessage.content, type: "agent_message" },
            timestamp: assistantMessage.createdAt,
            type: "event_msg",
          }),
        ].join("\n"),
      );

      const detailResponse = await app.request(`/v1/threads/${threadId}`);
      const detailBody = await detailResponse.json();

      expect(detailResponse.status).toBe(200);
      expect(detailBody.messages.map((message: { content: string }) => message.content)).toEqual([
        "Hi",
        "streamed: Hi",
      ]);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("preserves known running state when rollout history is already available", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-known-running-rollout";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: { message: "known running prompt", type: "user_message" },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const now = Date.now() / 1000;
    const listedThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Known running rollout backed thread",
      preview: "Known running rollout backed thread",
      source: "app",
      status: { type: "active" },
      updatedAt: now,
    };
    const staleDetailThread = {
      ...listedThread,
      status: { type: "idle" },
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async () => staleDetailThread);
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [listedThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      await app.request("/v1/threads");
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(readThread).toHaveBeenNthCalledWith(1, threadId, { includeTurns: false });
      expect(body.thread.state).toBe("running");
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "known running prompt",
      ]);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads current response-item rollout messages while a thread is running", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "08", "15");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-running-response-items";
    await writeFile(
      join(sessionsDir, `rollout-2026-08-15T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: {
            content: [{ text: "current rollout prompt", type: "input_text" }],
            id: "msg-user-current",
            role: "user",
            type: "message",
          },
          timestamp: "2026-08-15T00:00:00.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            content: [{ text: "internal instructions", type: "input_text" }],
            id: "msg-developer-current",
            role: "developer",
            type: "message",
          },
          timestamp: "2026-08-15T00:00:01.000Z",
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            content: [{ text: "current rollout answer", type: "output_text" }],
            id: "msg-assistant-current",
            phase: "final_answer",
            role: "assistant",
            type: "message",
          },
          timestamp: "2026-08-15T00:00:02.000Z",
          type: "response_item",
        }),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const now = Date.now() / 1000;
    const runningThread = {
      id: threadId,
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Running response-item thread",
      preview: "Running response-item thread",
      source: "app",
      status: { type: "active" },
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => {
      if (options?.includeTurns === true) {
        return new Promise(() => undefined);
      }
      return runningThread;
    });
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [runningThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(readThread).toHaveBeenCalledWith(threadId, { includeTurns: false });
      expect(body.thread.state).toBe("running");
      expect(
        body.messages.map((message: { content: string; id: string; role: string }) => ({
          content: message.content,
          id: message.id,
          role: message.role,
        })),
      ).toEqual([
        { content: "current rollout prompt", id: "msg-user-current", role: "user" },
        {
          content: "current rollout answer",
          id: "msg-assistant-current",
          role: "assistant",
        },
      ]);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads the full readable rollout conversation when tool events are newest", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const codexHome = await mkdtemp(join(tmpdir(), "codex-relay-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "05", "02");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "app-thread-rollout-tool-tail";
    await writeFile(
      join(sessionsDir, `rollout-2026-05-02T00-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          payload: { message: "older prompt", type: "user_message" },
          timestamp: "2026-05-02T00:00:00.000Z",
          type: "event_msg",
        }),
        JSON.stringify({
          payload: { message: "useful answer", type: "agent_message" },
          timestamp: "2026-05-02T00:00:01.000Z",
          type: "event_msg",
        }),
        ...[1, 2, 3, 4].map((index) =>
          JSON.stringify({
            payload: {
              call_id: `call_${index}`,
              command: ["/bin/echo", String(index)],
              exit_code: 0,
              type: "exec_command_end",
            },
            timestamp: `2026-05-02T00:00:0${index + 1}.000Z`,
            type: "event_msg",
          }),
        ),
      ].join("\n"),
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const app = createApp({
      codex: createMockCodex(),
      workspacePath,
    });

    try {
      const response = await app.request(`/v1/threads/${threadId}`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
        "older prompt",
        "useful answer",
        "/bin/echo 1",
        "/bin/echo 2",
        "/bin/echo 3",
        "/bin/echo 4",
      ]);
      expect(body).not.toHaveProperty("hasMoreMessages");
      expect(body).not.toHaveProperty("olderMessagesCursor");
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("loads app-server history in the background while a thread is running", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const now = Date.now() / 1000;
    const runningThread = {
      id: "app-thread-running-long",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Running long thread",
      preview: "Running long thread",
      source: "app",
      status: { type: "active" },
      updatedAt: now,
    };
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) => {
      if (options?.includeTurns === true) {
        return new Promise(() => undefined);
      }
      return runningThread;
    });
    const appServer = {
      listThreads: vi.fn<() => Promise<unknown[]>>(async () => [runningThread]),
      onNotification() {
        return () => undefined;
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const response = await app.request("/v1/threads/app-thread-running-long");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(readThread).toHaveBeenNthCalledWith(1, "app-thread-running-long", {
      includeTurns: false,
    });
    expect(readThread).toHaveBeenNthCalledWith(2, "app-thread-running-long", {
      includeTurns: true,
    });
    expect(body.thread.state).toBe("running");
    expect(body.messages).toEqual([]);
    expect(body).not.toHaveProperty("hasMoreMessages");
    expect(body).not.toHaveProperty("olderMessagesCursor");
  });

  it("does not let a stale background history read overwrite a live completed item", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const runningThread = {
      id: "app-thread-background-race",
      createdAt: now,
      cwd: workspacePath,
      modelProvider: "gpt-5.5",
      name: "Background race",
      preview: "Background race",
      source: "app",
      status: { type: "active" },
      updatedAt: now,
    };
    let resolveHistory!: (thread: unknown) => void;
    const history = new Promise<unknown>((resolve) => {
      resolveHistory = resolve;
    });
    const readThread = vi.fn<
      (_threadId: string, options?: { includeTurns?: boolean }) => Promise<unknown>
    >(async (_threadId, options) =>
      options?.includeTurns === true ? history : Promise.resolve(runningThread),
    );
    const appServer = {
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread,
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      workspacePath,
    });

    const initialResponse = await app.request("/v1/threads/app-thread-background-race");
    expect(initialResponse.status).toBe(200);
    expect(readThread).toHaveBeenCalledWith("app-thread-background-race", {
      includeTurns: true,
    });

    for (const handler of notificationHandlers) {
      handler({
        method: "item/completed",
        params: {
          item: {
            id: "assistant-background-race",
            text: "fresh live answer",
            type: "agentMessage",
          },
          threadId: "app-thread-background-race",
          turnId: "turn-background-race",
        },
      });
    }
    resolveHistory({
      ...runningThread,
      turns: [
        {
          id: "turn-background-race",
          items: [
            {
              id: "assistant-background-race",
              text: "stale snapshot answer",
              type: "agentMessage",
            },
          ],
          itemsView: "full",
          status: { type: "completed" },
          startedAt: now,
          completedAt: now,
        },
      ],
    });
    await vi.waitFor(() => expect(readThread).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    const settledResponse = await app.request("/v1/threads/app-thread-background-race");
    const settledBody = await settledResponse.json();

    expect(settledResponse.status).toBe(200);
    expect(settledBody.messages).toEqual([
      expect.objectContaining({ id: "assistant-background-race", content: "fresh live answer" }),
    ]);
  });

  it("streams run events for a known thread", async () => {
    const app = createApp({ codex: createMockCodex() });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Streaming" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/v1/threads/thread-1/runs/stream", {
      method: "POST",
      body: JSON.stringify({ prompt: "Stream this" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("thread.message.created");
    expect(body).toContain("streamed: Stream this");
  });

  it("uses the last completed SDK agent message as the final response", async () => {
    let thread: CodexThread;
    thread = {
      id: null,
      async run() {
        return { finalResponse: "Final answer" };
      },
      async runStreamed() {
        async function* events() {
          thread.id = "sdk-final-thread";
          yield { type: "thread.started", thread_id: "sdk-final-thread" };
          yield {
            type: "item.started",
            item: {
              id: "file-change",
              type: "file_change",
              changes: [],
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: "file-change",
              type: "file_change",
              changes: [{ kind: "update", path: "src/example.ts" }],
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: "todo-list",
              type: "todo_list",
              items: [{ completed: true, text: "Verify the response" }],
            },
          };
          yield {
            type: "item.completed",
            item: { id: "commentary", type: "agent_message", text: "Working on it" },
          };
          yield {
            type: "item.completed",
            item: { id: "final", type: "agent_message", text: "Final answer" },
          };
          yield { type: "turn.completed" };
        }

        return { events: events() };
      },
    };
    const codex: CodexClient = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    const app = createApp({ appServer: null, codex });

    const createResponse = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "SDK final response" }),
      headers: { "content-type": "application/json" },
    });
    const created = await createResponse.json();
    const response = await app.request(`/v1/threads/${created.thread.id}/runs/stream`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Answer this" }),
      headers: { "content-type": "application/json" },
    });
    await response.text();
    const detailResponse = await app.request("/v1/threads/sdk-final-thread");
    const detail = await detailResponse.json();

    expect(
      detail.messages.find((message: { role: string }) => message.role === "assistant"),
    ).toMatchObject({
      content: "Final answer",
      role: "assistant",
      state: "completed",
    });
    expect(detail.messages).toContainEqual(
      expect.objectContaining({
        content: "1 file changed: src/example.ts",
        kind: "fileChange",
        role: "tool",
      }),
    );
    expect(detail.messages).toContainEqual(
      expect.objectContaining({
        content: "[x] Verify the response",
        kind: "plan",
        role: "status",
      }),
    );
    expect(
      detail.messages.filter((message: { id: string }) => message.id === "file-change"),
    ).toHaveLength(1);
  });

  it("rejects invalid payloads with a structured error", async () => {
    const app = createApp({ codex: createMockCodex() });

    const response = await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ prompt: "" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.issues[0]).toContain("prompt");
  });

  it("lists locally known threads", async () => {
    const app = createApp({ codex: createMockCodex() });

    await app.request("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ title: "Listed thread" }),
      headers: { "content-type": "application/json" },
    });

    const response = await app.request("/v1/threads");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].title).toBe("Listed thread");
  });
});
