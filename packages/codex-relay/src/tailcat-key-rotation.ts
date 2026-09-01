import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access, chmod, copyFile, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const maximumTailcatKeyBytes = 128 * 1024;

export type TailcatKeyRotationSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type TailcatKeyRotationResult = {
  backupPath: string;
  keyPath: string;
  restartRequired: true;
};

export async function rotateTailcatServerKey(input: {
  binaryPath: string;
  derpMapUrl?: string;
  embedDerpMap?: boolean;
  keyPath: string;
  region: string;
  spawnProcess?: TailcatKeyRotationSpawn;
}): Promise<TailcatKeyRotationResult> {
  const keyPath = resolve(input.keyPath);
  const region = normalizedRegion(input.region);
  const directory = dirname(keyPath);
  const backupPath = `${keyPath}.previous`;
  const temporaryKeyPath = `${directory}/.${basename(keyPath)}.rotate-${randomUUID()}.private.json`;
  const temporaryBackupPath = `${directory}/.${basename(keyPath)}.backup-${randomUUID()}`;

  await access(keyPath);
  await validateTailcatKeyFile(keyPath);
  await mkdir(directory, { mode: 0o700, recursive: true });

  try {
    const args = [
      ...(input.derpMapUrl ? [`--derpmap-url=${input.derpMapUrl}`] : []),
      "genkey",
      `--key=${temporaryKeyPath}`,
      "--force",
      `--region=${region}`,
      ...(input.embedDerpMap ? ["--embed-derp-map"] : []),
    ];
    const child = (input.spawnProcess ?? spawn)(input.binaryPath, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForSuccessfulTailcatCommand(child, "generation");
    await validateTailcatKeyFile(temporaryKeyPath);
    const validationChild = (input.spawnProcess ?? spawn)(
      input.binaryPath,
      [`--key=${temporaryKeyPath}`, "printpub"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    await waitForSuccessfulTailcatCommand(validationChild, "validation");
    await chmod(temporaryKeyPath, 0o600);

    await copyFile(keyPath, temporaryBackupPath);
    await chmod(temporaryBackupPath, 0o600);
    await rename(temporaryBackupPath, backupPath);
    await rename(temporaryKeyPath, keyPath);

    return { backupPath, keyPath, restartRequired: true };
  } finally {
    await Promise.all([
      rm(temporaryKeyPath, { force: true }),
      rm(temporaryBackupPath, { force: true }),
    ]);
  }
}

function normalizedRegion(value: string) {
  const region = value.trim();
  if (!region || region.length > 512 || hasControlCharacter(region)) {
    throw new TypeError("Tailcat region must be a non-empty region ID, code, or DERP hostname.");
  }
  return region;
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

async function validateTailcatKeyFile(path: string) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > maximumTailcatKeyBytes
  ) {
    throw new Error("Tailcat key file is not a bounded regular file.");
  }
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Number(info.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) {
      throw new Error("Tailcat key file could not be read completely.");
    }
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tailcat key file is not a JSON object.");
    }
  } finally {
    await file.close();
  }
}

function waitForSuccessfulTailcatCommand(child: ChildProcess, operation: string) {
  return new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error(`Tailcat key ${operation} failed to start.`)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Tailcat key ${operation} failed (${signal ? "signal" : "exit"} ${signal ?? code ?? "unknown"}).`,
        ),
      );
    });
  });
}
