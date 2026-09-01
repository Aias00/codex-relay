import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  rotateTailcatServerKey,
  type TailcatKeyRotationSpawn,
} from "../src/tailcat-key-rotation.js";

describe("Tailcat key rotation", () => {
  it("atomically rotates a key, preserves one rollback copy, and discards token output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-key-"));
    const keyPath = join(directory, "default.private.json");
    const oldKey = JSON.stringify({ private: "old-private-key" });
    const newKey = JSON.stringify({ private: "new-private-key" });
    const secretToken = "tailcat-connection-token-that-must-not-be-returned";
    await writeFile(keyPath, oldKey, { mode: 0o600 });
    const spawnProcess = vi.fn<TailcatKeyRotationSpawn>((_command, args, options) => {
      const keyArg = args.find((arg) => arg.startsWith("--key="));
      if (!keyArg) {
        throw new Error("missing generated key path");
      }
      expect(options.stdio).toBe("ignore");
      const child = new EventEmitter() as ChildProcess;
      void writeFile(keyArg.slice("--key=".length), newKey, { mode: 0o600 }).then(() =>
        child.emit("exit", 0, null),
      );
      return child;
    });

    try {
      const result = await rotateTailcatServerKey({
        binaryPath: "/usr/local/bin/tailcat",
        keyPath,
        region: "derp.example.com",
        spawnProcess,
      });

      expect(await readFile(keyPath, "utf8")).toBe(newKey);
      expect(await readFile(`${keyPath}.previous`, "utf8")).toBe(oldKey);
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${keyPath}.previous`)).mode & 0o777).toBe(0o600);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(spawnProcess.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining(["genkey", "--force", "--region=derp.example.com"]),
      );
      expect(spawnProcess.mock.calls[1]?.[1]).toEqual([
        expect.stringMatching(/^--key=/),
        "printpub",
      ]);
      expect(JSON.stringify(result)).not.toContain(secretToken);
      expect(result).toMatchObject({ backupPath: `${keyPath}.previous`, keyPath });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("leaves the active key unchanged and omits child output when generation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-key-failed-"));
    const keyPath = join(directory, "default.private.json");
    const oldKey = JSON.stringify({ private: "old-private-key" });
    const childSecret = "secret stderr from tailcat";
    await writeFile(keyPath, oldKey, { mode: 0o600 });
    const spawnProcess = vi.fn<TailcatKeyRotationSpawn>(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 7, null));
      return child;
    });

    try {
      await expect(
        rotateTailcatServerKey({
          binaryPath: "/usr/local/bin/tailcat",
          keyPath,
          region: "derp.example.com",
          spawnProcess,
        }),
      ).rejects.not.toThrow(childSecret);
      expect(await readFile(keyPath, "utf8")).toBe(oldKey);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
