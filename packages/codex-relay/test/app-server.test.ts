import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/debug-log.js", () => ({
  relayDebugLog: vi.fn<(event: string, fields?: Record<string, unknown>) => void>(),
}));

import {
  AppServerRequestTimeoutError,
  CodexAppServerClient,
  type AppServerConnectionStateEvent,
} from "../src/app-server.js";
import { relayDebugLog } from "../src/debug-log.js";

type JsonRpcRequest = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type SharedSocketServer = {
  close: () => Promise<void>;
  connections: WebSocket[];
  requests: JsonRpcRequest[];
};

const socketTempRoot = process.platform === "darwin" ? "/tmp" : tmpdir();

describe("CodexAppServerClient shared socket mode", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("initializes without overriding the Codex app-server originator or user agent", async () => {
    const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-app-server-identity-"));
    const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const server = await startSharedSocketServer(socketPath);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
    const client = new CodexAppServerClient({
      startSharedServer: async () => {
        throw new Error("Expected the client to attach to the existing shared app-server.");
      },
    });

    try {
      await client.initialize();

      expect(server.requests.find((request) => request.method === "initialize")?.params).toEqual({
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
        clientInfo: {
          name: "codex_app_server_daemon",
          title: null,
          version: "",
        },
      });
    } finally {
      client.close();
      await server.close();
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("reconnects after its shared socket resets without starting another app-server", async () => {
    const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-app-server-"));
    const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const server = await startSharedSocketServer(socketPath);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
    const startSharedServer = vi.fn<() => Promise<never>>(async () => {
      throw new Error("Expected the client to attach to the existing shared app-server.");
    });
    const client = new CodexAppServerClient({ startSharedServer });
    const connectionStates: AppServerConnectionStateEvent[] = [];
    client.onConnectionState(() => {
      throw new Error("broken connection listener");
    });
    client.onConnectionState((event) => connectionStates.push(event));

    try {
      await client.initialize();
      expect(server.connections).toHaveLength(1);
      await vi.waitFor(() => {
        expect(server.requests.filter((request) => request.method === "initialized")).toHaveLength(
          1,
        );
      });
      expect(startSharedServer).not.toHaveBeenCalled();
      expect(relayDebugLog).toHaveBeenCalledWith("app_server.shared_socket.connected", {
        ownership: "attached",
        socketPath,
      });
      expect(relayDebugLog).toHaveBeenCalledWith("app_server.shared_socket.attached", {
        ownership: "attached",
        socketPath,
      });
      await client.resumeThread({ threadId: "thread-active" });

      server.connections[0]?.terminate();

      await vi.waitFor(
        () => {
          expect(server.connections).toHaveLength(2);
        },
        { timeout: 5_000 },
      );
      await expect(client.listModels()).resolves.toEqual([]);
      expect(server.requests.filter((request) => request.method === "initialize")).toHaveLength(2);
      expect(server.requests.filter((request) => request.method === "thread/resume")).toHaveLength(
        2,
      );
      expect(
        server.requests.filter((request) => request.method === "thread/resume").at(-1)?.params,
      ).toEqual({
        excludeTurns: true,
        initialTurnsPage: { itemsView: "summary", limit: 1, sortDirection: "desc" },
        threadId: "thread-active",
      });
      await vi.waitFor(() => {
        expect(server.requests.filter((request) => request.method === "initialized")).toHaveLength(
          2,
        );
      });
      expect(startSharedServer).not.toHaveBeenCalled();
      expect(client.appServerMode).toBe("socket");
      expect(relayDebugLog).toHaveBeenCalledWith(
        "app_server.shared_socket.disconnected",
        expect.objectContaining({ ownership: "attached" }),
      );
      expect(relayDebugLog).toHaveBeenCalledWith("app_server.shared_socket.reconnected", {
        ownership: "attached",
        socketPath,
      });
      expect(connectionStates).toEqual([
        { mode: "socket", ownership: "attached", state: "disconnected" },
        { mode: "socket", ownership: "attached", state: "reconnected" },
      ]);
      expect(relayDebugLog).toHaveBeenCalledWith("app_server.connection_state_handler.failed", {
        message: "broken connection listener",
        ownership: "attached",
        state: "disconnected",
      });
      expect(relayDebugLog).toHaveBeenCalledWith("app_server.connection_state_handler.failed", {
        message: "broken connection listener",
        ownership: "attached",
        state: "reconnected",
      });
    } finally {
      client.close();
      await server.close();
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("replays a turn that completed while the shared socket was disconnected", async () => {
    const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-app-server-gap-"));
    const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const now = Date.now() / 1_000;
    let resumedTurn: {
      id: string;
      items: Array<Record<string, unknown>>;
      itemsView: string;
      status: string;
      error: null;
      startedAt: number;
      completedAt: number | null;
      durationMs: number | null;
    } = {
      id: "turn-gap",
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: now,
      completedAt: null,
      durationMs: null,
    };
    const server = await startSharedSocketServer(socketPath, (request) => {
      if (request.method !== "thread/resume") {
        return request.method === "model/list" ? { data: [] } : {};
      }
      return {
        initialTurnsPage: { data: [resumedTurn] },
        thread: {
          id: "thread-gap",
          status: { type: resumedTurn.status === "inProgress" ? "active" : "idle" },
          turns: [],
        },
      };
    });
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
    const client = new CodexAppServerClient({
      startSharedServer: async () => {
        throw new Error("Expected the client to attach to the existing shared app-server.");
      },
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    client.onNotification((notification) => notifications.push(notification));

    try {
      await client.initialize();
      await client.resumeThread({ excludeTurns: true, threadId: "thread-gap" });
      resumedTurn = {
        ...resumedTurn,
        items: [
          {
            id: "assistant-gap",
            text: "Recovered after reconnect",
            type: "agentMessage",
          },
        ],
        itemsView: "summary",
        status: "completed",
        completedAt: now + 1,
        durationMs: 1_000,
      };

      server.connections[0]?.terminate();

      await vi.waitFor(
        () => {
          expect(notifications).toContainEqual({
            method: "turn/completed",
            params: {
              threadId: "thread-gap",
              turn: resumedTurn,
            },
          });
        },
        { timeout: 5_000 },
      );
      expect(
        server.requests.filter((request) => request.method === "thread/resume").at(-1)?.params,
      ).toEqual({
        excludeTurns: true,
        initialTurnsPage: { itemsView: "summary", limit: 1, sortDirection: "desc" },
        threadId: "thread-gap",
      });
    } finally {
      client.close();
      await server.close();
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("lists every root thread page without rescanning rollout files after the first page", async () => {
    const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-app-server-pages-"));
    const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const server = await startSharedSocketServer(socketPath, (request) => {
      if (request.method !== "thread/list") {
        return {};
      }
      return request.params?.cursor === "page-2"
        ? { data: [{ id: "thread-older" }], nextCursor: null }
        : { data: [{ id: "thread-newer" }], nextCursor: "page-2" };
    });
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
    const client = new CodexAppServerClient({
      startSharedServer: async () => {
        throw new Error("Expected the client to attach to the existing shared app-server.");
      },
    });

    try {
      const threads = await client.listThreads(1);
      const requests = server.requests.filter((request) => request.method === "thread/list");

      expect(threads.map((thread) => thread.id)).toEqual(["thread-newer", "thread-older"]);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.params).toMatchObject({
        limit: 1,
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
      });
      expect(requests[0]?.params).not.toHaveProperty("useStateDbOnly");
      expect(requests[1]?.params).toMatchObject({
        cursor: "page-2",
        useStateDbOnly: true,
      });
    } finally {
      client.close();
      await server.close();
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("loads a full-detail page of recent thread turns", async () => {
    const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-app-server-turn-pages-"));
    const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const server = await startSharedSocketServer(socketPath, (request) =>
      request.method === "thread/turns/list"
        ? { data: [{ id: "turn-recent", items: [] }], nextCursor: "older" }
        : {},
    );
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
    const client = new CodexAppServerClient({
      startSharedServer: async () => {
        throw new Error("Expected the client to attach to the existing shared app-server.");
      },
    });

    try {
      const options = {
        cursor: "cursor-1",
        itemsView: "full" as const,
        limit: 12,
        sortDirection: "desc" as const,
      };
      const [page, duplicatePage] = await Promise.all([
        client.listThreadTurns("thread-1", options),
        client.listThreadTurns("thread-1", options),
      ]);
      const requests = server.requests.filter(
        (candidate) => candidate.method === "thread/turns/list",
      );
      const request = requests[0];

      expect(page).toMatchObject({ data: [{ id: "turn-recent" }], nextCursor: "older" });
      expect(duplicatePage).toEqual(page);
      expect(requests).toHaveLength(1);
      expect(request?.params).toEqual({
        cursor: "cursor-1",
        itemsView: "full",
        limit: 12,
        sortDirection: "desc",
        threadId: "thread-1",
      });
    } finally {
      client.close();
      await server.close();
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it("classifies a late turn/start response as an ambiguous timeout", async () => {
    const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-app-server-timeout-"));
    const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
    const server = await startSharedSocketServer(socketPath, async (request) => {
      if (request.method === "turn/start") {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
        return { turn: { id: "turn-late", items: [], status: "running" } };
      }
      return request.method === "model/list" ? { data: [] } : {};
    });
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
    const client = new CodexAppServerClient({
      startSharedServer: async () => {
        throw new Error("Expected the client to attach to the existing shared app-server.");
      },
      turnStartTimeoutMs: 10,
    });

    try {
      await client.initialize();
      await expect(
        client.startTurn({
          approvalPolicy: "never",
          input: [{ type: "text", text: "Run once", text_elements: [] }],
          sandboxPolicy: { type: "dangerFullAccess" },
          threadId: "thread-timeout",
        }),
      ).rejects.toEqual(expect.any(AppServerRequestTimeoutError));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 60));
      await expect(client.listModels()).resolves.toEqual([]);
      expect(server.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    } finally {
      client.close();
      await server.close();
      await rm(codexHome, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "replaces a stale Unix socket after a slow shared app-server startup",
    async () => {
      // Given: a stale socket path and a real child that needs four seconds before listening.
      const codexHome = await mkdtemp(join(socketTempRoot, "codex-relay-slow-app-server-"));
      const fakeCodexBinary = join(codexHome, "fake-codex");
      const socketPath = join(codexHome, "app-server-control", "app-server-control.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      await writeFile(socketPath, "");
      await writeFile(
        fakeCodexBinary,
        `#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { WebSocketServer } from ${JSON.stringify(import.meta.resolve("ws"))};

await setTimeout(4_000);
const socketPath = join(process.env.CODEX_HOME, "app-server-control", "app-server-control.sock");
await mkdir(join(process.env.CODEX_HOME, "app-server-control"), { recursive: true });
await rm(socketPath, { force: true });
const server = createServer();
const webSocketServer = new WebSocketServer({ server });
webSocketServer.on("connection", (socket) => {
  socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    socket.send(JSON.stringify({
      id: request.id,
      result: request.method === "model/list" ? { data: [] } : {},
    }));
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, () => {
    server.off("error", reject);
    resolve();
  });
});
process.stdin.resume();
`,
      );
      await chmod(fakeCodexBinary, 0o755);
      vi.stubEnv("CODEX_BIN", fakeCodexBinary);
      vi.stubEnv("CODEX_HOME", codexHome);
      vi.stubEnv("CODEX_RELAY_APP_SERVER_MODE", "socket");
      const client = new CodexAppServerClient();

      try {
        // When: the relay initializes its shared app-server client.
        await client.initialize();

        // Then: it waits for a real listener instead of treating the stale path as ready.
        await expect(client.listModels()).resolves.toEqual([]);
      } finally {
        client.close();
        await rm(codexHome, { force: true, recursive: true });
      }
    },
    12_000,
  );
});

async function startSharedSocketServer(
  socketPath: string,
  responseForRequest: (request: JsonRpcRequest) => unknown | Promise<unknown> = (request) =>
    request.method === "model/list"
      ? { data: [] }
      : request.method === "thread/resume"
        ? { thread: { id: request.params?.threadId } }
        : {},
): Promise<SharedSocketServer> {
  await mkdir(dirname(socketPath), { recursive: true });
  const connections: WebSocket[] = [];
  const requests: JsonRpcRequest[] = [];
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  webSocketServer.on("connection", (socket) => {
    connections.push(socket);
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as JsonRpcRequest;
      requests.push(request);
      if (typeof request.id !== "number") {
        return;
      }
      void Promise.resolve(responseForRequest(request)).then((result) => {
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
  });
  await listen(server, socketPath);

  return {
    connections,
    requests,
    async close() {
      for (const socket of connections) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}

function listen(server: Server, socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
