import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { ListWorkspacesResponseSchema, apiPaths } from "../src/api-schema.js";
import { CodexAppServerClient, type AppServerThread } from "../src/app-server.js";
import { createApp } from "../src/app.js";
import { createTursoPairingSessionStore } from "../src/pairing-store.js";
import { createRelayStateStore } from "../src/relay-state-store.js";

describe("workspace registry API", () => {
  it("lists the configured startup workspace without changing path-based status", async () => {
    const workspacePath = await mkdtemp(`${tmpdir()}/codex-relay-api-workspace-`);

    try {
      const registry = await createRelayStateStore(":memory:");
      const registered = await registry.registerWorkspace({
        path: workspacePath,
        source: "relay_startup",
      });
      const app = createApp({ appServer: null, workspacePath, workspaceRegistry: registry });

      const workspacesResponse = await app.request(apiPaths.workspaces);
      const statusResponse = await app.request(apiPaths.status);
      const workspaces = ListWorkspacesResponseSchema.parse(await workspacesResponse.json());
      const status = await statusResponse.json();

      expect(workspacesResponse.status).toBe(200);
      expect(workspaces.workspaces).toEqual([registered]);
      expect(statusResponse.status).toBe(200);
      expect(status).toMatchObject({
        workspaceId: registered.workspaceId,
        workspacePath,
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("keeps workspace discovery behind pairing authentication", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const registry = await createRelayStateStore(":memory:");
    const app = createApp({
      appServer: null,
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        sessions,
      },
      workspaceRegistry: registry,
    });

    const response = await app.request(apiPaths.workspaces);

    expect(response.status).toBe(401);
  });

  it("flushes app-server thread workspace discovery before listing workspaces", async () => {
    const workspacePath = await mkdtemp(`${tmpdir()}/codex-relay-thread-workspace-`);

    try {
      const now = Date.now() / 1000;
      const thread = {
        id: "thread-workspace-discovery",
        parentThreadId: null,
        preview: "Discovered workspace",
        createdAt: now,
        updatedAt: now,
        status: { type: "idle" },
        cwd: workspacePath,
        source: "cli",
        modelProvider: "openai",
        name: "Discovered workspace",
        turns: [],
      } satisfies AppServerThread;
      const appServer = new CodexAppServerClient();
      vi.spyOn(appServer, "listThreads").mockResolvedValue([thread]);
      const registry = await createRelayStateStore(":memory:");
      const app = createApp({ appServer, workspaceRegistry: registry });

      const threadsResponse = await app.request(apiPaths.threads);
      const workspacesResponse = await app.request(apiPaths.workspaces);
      const workspaces = ListWorkspacesResponseSchema.parse(await workspacesResponse.json());

      expect(threadsResponse.status).toBe(200);
      expect(workspaces.workspaces).toMatchObject([
        { displayName: workspacePath.split("/").at(-1), state: "available" },
      ]);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("discovers every app-server workspace before filtering a scoped thread list", async () => {
    const firstPath = await mkdtemp(`${tmpdir()}/codex-relay-scoped-workspace-a-`);
    const secondPath = await mkdtemp(`${tmpdir()}/codex-relay-scoped-workspace-b-`);

    try {
      const now = Date.now() / 1000;
      const registry = await createRelayStateStore(":memory:");
      const selectedWorkspace = await registry.registerWorkspace({
        path: firstPath,
        source: "relay_startup",
      });
      const appServer = new CodexAppServerClient();
      vi.spyOn(appServer, "listThreads").mockResolvedValue([
        appServerThread("thread-a", selectedWorkspace.canonicalPath, now),
        appServerThread("thread-b", await realpath(secondPath), now),
      ]);
      const app = createApp({
        appServer,
        workspacePath: firstPath,
        workspaceRegistry: registry,
      });

      const threadsResponse = await app.request(
        `${apiPaths.threads}?workspaceId=${encodeURIComponent(selectedWorkspace.workspaceId)}`,
      );
      const threads = await threadsResponse.json();
      const workspacesResponse = await app.request(apiPaths.workspaces);
      const workspaces = ListWorkspacesResponseSchema.parse(await workspacesResponse.json());

      expect(threadsResponse.status).toBe(200);
      expect(threads).toMatchObject({ threads: [{ id: "thread-a" }] });
      expect(workspaces.workspaces.map((workspace) => workspace.canonicalPath).sort()).toEqual(
        [selectedWorkspace.canonicalPath, await realpath(secondPath)].sort(),
      );
    } finally {
      await Promise.all([
        rm(firstPath, { force: true, recursive: true }),
        rm(secondPath, { force: true, recursive: true }),
      ]);
    }
  });

  it("selects registered workspaces by id while preserving path compatibility", async () => {
    const firstPath = await mkdtemp(`${tmpdir()}/codex-relay-workspace-id-a-`);
    const secondPath = await mkdtemp(`${tmpdir()}/codex-relay-workspace-id-b-`);

    try {
      const registry = await createRelayStateStore(":memory:");
      const first = await registry.registerWorkspace({
        path: firstPath,
        source: "relay_startup",
      });
      const second = await registry.registerWorkspace({
        path: secondPath,
        source: "thread_cwd",
      });
      const previousFirstPath = `${firstPath}-previous-location`;
      await registry.addWorkspaceAlias({
        path: previousFirstPath,
        source: "operator",
        workspaceId: first.workspaceId,
      });
      await writeFile(`${firstPath}/README.md`, "workspace identity\n");
      const now = Date.now() / 1000;
      const appServerThreads = [
        appServerThread("thread-a", first.canonicalPath, now),
        appServerThread("thread-b", second.canonicalPath, now),
      ];
      const appServer = new CodexAppServerClient();
      vi.spyOn(appServer, "listThreads").mockResolvedValue(appServerThreads);
      vi.spyOn(appServer, "startThread").mockImplementation(async (input) =>
        appServerThread("created-thread", String(input.cwd), now),
      );
      const app = createApp({
        appServer,
        workspacePath: first.canonicalPath,
        workspaceRegistry: registry,
      });

      const statusById = await app.request(
        `${apiPaths.status}?workspaceId=${encodeURIComponent(first.workspaceId)}`,
      );
      const threadsById = await app.request(
        `${apiPaths.threads}?workspaceId=${encodeURIComponent(first.workspaceId)}`,
      );
      const createById = await app.request(apiPaths.threads, {
        method: "POST",
        body: JSON.stringify({ title: "Created by workspace id", workspaceId: first.workspaceId }),
        headers: { "content-type": "application/json" },
      });
      const statusByLegacyPath = await app.request(
        `${apiPaths.status}?workspacePath=${encodeURIComponent(firstPath)}`,
      );
      const statusByIdAndMissingAlias = await app.request(
        `${apiPaths.status}?workspaceId=${encodeURIComponent(first.workspaceId)}&workspacePath=${encodeURIComponent(previousFirstPath)}`,
      );
      const fileById = await app.request(
        `${apiPaths.workspaceFileContent}?workspaceId=${encodeURIComponent(first.workspaceId)}&path=README.md`,
      );
      const preferencesById = await app.request(apiPaths.preferences, {
        method: "PATCH",
        body: JSON.stringify({ model: "gpt-5.5", workspaceId: first.workspaceId }),
        headers: { "content-type": "application/json" },
      });

      expect(await statusById.json()).toMatchObject({
        workspaceId: first.workspaceId,
        workspacePath: first.canonicalPath,
      });
      expect(await threadsById.json()).toMatchObject({
        threads: [{ id: "thread-a", workspaceId: first.workspaceId, cwd: first.canonicalPath }],
      });
      expect(await createById.json()).toMatchObject({
        thread: {
          id: "created-thread",
          workspaceId: first.workspaceId,
          cwd: first.canonicalPath,
        },
      });
      expect(await statusByLegacyPath.json()).toMatchObject({
        workspaceId: first.workspaceId,
        workspacePath: firstPath,
      });
      expect(await statusByIdAndMissingAlias.json()).toMatchObject({
        workspaceId: first.workspaceId,
        workspacePath: first.canonicalPath,
      });
      expect(await fileById.json()).toMatchObject({
        content: "workspace identity\n",
        workspaceId: first.workspaceId,
        workspacePath: first.canonicalPath,
      });
      expect(await preferencesById.json()).toMatchObject({
        preferences: { model: "gpt-5.5" },
        workspaceId: first.workspaceId,
        workspacePath: first.canonicalPath,
      });
      expect(appServer.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: first.canonicalPath }),
      );
    } finally {
      await Promise.all([
        rm(firstPath, { force: true, recursive: true }),
        rm(secondPath, { force: true, recursive: true }),
      ]);
    }
  });

  it("rejects unknown or mismatched workspace identities", async () => {
    const firstPath = await mkdtemp(`${tmpdir()}/codex-relay-workspace-mismatch-a-`);
    const secondPath = await mkdtemp(`${tmpdir()}/codex-relay-workspace-mismatch-b-`);

    try {
      const registry = await createRelayStateStore(":memory:");
      const first = await registry.registerWorkspace({
        path: firstPath,
        source: "relay_startup",
      });
      await registry.registerWorkspace({ path: secondPath, source: "thread_cwd" });
      const app = createApp({
        appServer: null,
        workspacePath: firstPath,
        workspaceRegistry: registry,
      });

      const unknown = await app.request(`${apiPaths.status}?workspaceId=unknown-workspace`);
      const mismatched = await app.request(
        `${apiPaths.status}?workspaceId=${encodeURIComponent(first.workspaceId)}&workspacePath=${encodeURIComponent(secondPath)}`,
      );

      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({
        error: { code: "invalid_workspace_selection" },
      });
      expect(mismatched.status).toBe(400);
      expect(await mismatched.json()).toMatchObject({
        error: { code: "invalid_workspace_selection" },
      });
    } finally {
      await Promise.all([
        rm(firstPath, { force: true, recursive: true }),
        rm(secondPath, { force: true, recursive: true }),
      ]);
    }
  });
});

function appServerThread(id: string, cwd: string, now: number): AppServerThread {
  return {
    id,
    parentThreadId: null,
    preview: id,
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
    cwd,
    source: "cli",
    modelProvider: "openai",
    name: id,
    turns: [],
  };
}
