import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  startTailcatSidecar,
  stopStaleTailcatSidecar,
  type TailcatSidecarSpawn,
} from "../src/tailcat-sidecar.js";

describe("Tailcat sidecar", () => {
  it("publishes a candidate only after the address file is ready and never exposes process output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-"));
    const addressPath = join(directory, "address.token");
    const token = "tco2_test_token_that_must_not_enter_diagnostics";
    await writeFile(join(directory, "server.private.json"), "test-key", { mode: 0o600 });
    const child = fakeChild(token);
    const spawnProcess = vi.fn<TailcatSidecarSpawn>(() => {
      writeFileSync(addressPath, token, { mode: 0o600 });
      return child;
    });

    const sidecar = await startTailcatSidecar({
      addressPath,
      binaryPath: "/usr/local/bin/tailcat",
      keyPath: join(directory, "server.private.json"),
      localTargetPort: 8788,
      spawnProcess,
      startTimeoutMs: 1_000,
    });

    try {
      expect(sidecar.candidate()).toMatchObject({
        localTargetPort: 8788,
        token,
        transport: "tailcat",
      });
      expect(sidecar.diagnostics()).toMatchObject({ status: "healthy" });
      expect(JSON.stringify(sidecar.diagnostics())).not.toContain(token);
      expect(await readFile(`${addressPath}.pid`, "utf8")).toBe("1234\n");
      expect((await stat(`${addressPath}.pid`)).mode & 0o777).toBe(0o600);
    } finally {
      await sidecar.close();
      await expect(readFile(`${addressPath}.pid`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates a custom PID parent directory with private permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-pid-parent-"));
    const addressPath = join(directory, "address.token");
    const pidDirectory = join(directory, "runtime", "tailcat");
    const pidPath = join(pidDirectory, "sidecar.pid");
    const token = "tco2_test_token_with_custom_pid_parent";
    await writeFile(join(directory, "server.private.json"), "test-key", { mode: 0o600 });
    const child = fakeChild(token);
    const spawnProcess = vi.fn<TailcatSidecarSpawn>(() => {
      writeFileSync(addressPath, token, { mode: 0o600 });
      return child;
    });

    const sidecar = await startTailcatSidecar({
      addressPath,
      binaryPath: "/usr/local/bin/tailcat",
      keyPath: join(directory, "server.private.json"),
      localTargetPort: 8788,
      pidPath,
      spawnProcess,
      startTimeoutMs: 1_000,
    });

    try {
      expect(await readFile(pidPath, "utf8")).toBe("1234\n");
      expect((await stat(pidDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(pidPath)).mode & 0o777).toBe(0o600);
    } finally {
      await sidecar.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("terminates the child and removes the address file when PID persistence fails after spawn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-pid-failed-"));
    const addressPath = join(directory, "address.token");
    const token = "tco2_test_token_for_pid_write_failure";
    await writeFile(join(directory, "server.private.json"), "test-key", { mode: 0o600 });
    const child = fakeChild(token);
    const spawnProcess = vi.fn<TailcatSidecarSpawn>(() => {
      writeFileSync(addressPath, token, { mode: 0o600 });
      return child;
    });

    try {
      await expect(
        startTailcatSidecar({
          addressPath,
          binaryPath: "/usr/local/bin/tailcat",
          keyPath: join(directory, "server.private.json"),
          localTargetPort: 8788,
          pidPath: directory,
          spawnProcess,
          startTimeoutMs: 1_000,
        }),
      ).rejects.toThrow("Tailcat sidecar failed before publishing a valid address.");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await expect(readFile(addressPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("cleans a matching stale sidecar without signaling an unrelated process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-stale-"));
    const pidPath = join(directory, "sidecar.pid");
    await writeFile(pidPath, "4321\n", { mode: 0o600 });
    let running = true;
    const signalProcess = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid) => {
      expect(pid).toBe(4321);
      running = false;
    });

    try {
      await expect(
        stopStaleTailcatSidecar({
          binaryPath: "/usr/local/bin/tailcat",
          inspectProcessCommand: async () =>
            "/usr/local/bin/tailcat --key=/tmp/server.private.json --serve=8788",
          isProcessRunning: () => running,
          keyPath: "/tmp/server.private.json",
          localTargetPort: 8788,
          pidPath,
          signalProcess,
        }),
      ).resolves.toBe(true);
      expect(signalProcess).toHaveBeenCalledWith(4321, "SIGTERM");
      await expect(readFile(pidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(pidPath, "4322\n", { mode: 0o600 });
      await expect(
        stopStaleTailcatSidecar({
          binaryPath: "/usr/local/bin/tailcat",
          inspectProcessCommand: async () => "/usr/bin/other-service --serve=8788",
          isProcessRunning: () => true,
          keyPath: "/tmp/server.private.json",
          localTargetPort: 8788,
          pidPath,
          signalProcess,
        }),
      ).resolves.toBe(false);
      expect(signalProcess).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails without including secret child output in the error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-failed-"));
    const secret = "tailcat-secret-child-output";
    await writeFile(join(directory, "server.private.json"), "test-key", { mode: 0o600 });
    const child = fakeChild(secret);
    const spawnProcess = vi.fn<TailcatSidecarSpawn>(() => {
      queueMicrotask(() => {
        (child as unknown as { exitCode: number | null }).exitCode = 7;
        child.emit("exit", 7, null);
      });
      return child;
    });

    try {
      await expect(
        startTailcatSidecar({
          addressPath: join(directory, "address.token"),
          binaryPath: "/usr/local/bin/tailcat",
          keyPath: join(directory, "server.private.json"),
          localTargetPort: 8788,
          spawnProcess,
          startTimeoutMs: 1_000,
        }),
      ).rejects.not.toThrow(secret);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function fakeChild(output: string) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.end(output);
  stderr.end(output);
  Object.assign(child, {
    exitCode: null,
    kill: vi.fn<(signal?: number | NodeJS.Signals) => boolean>(() => {
      (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      return true;
    }),
    pid: 1234,
    signalCode: null,
    stderr,
    stdout,
  });
  return child;
}
