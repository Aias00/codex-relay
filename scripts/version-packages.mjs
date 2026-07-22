import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nextMobileShipVersion } from "./mobile-release-version.mjs";

const mobilePackageName = "@codex-relay/mobile";
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const mobileRoot = resolve(workspaceRoot, "apps/mobile");
const mobilePackagePath = resolve(workspaceRoot, "apps/mobile/package.json");
const mobileChangelogPath = resolve(workspaceRoot, "apps/mobile/CHANGELOG.md");
const ignoredPackagesByTarget = {
  npm: [mobilePackageName, "react-native-direct-fetch"],
  mobile: ["codex-relay", "react-native-direct-fetch"],
};

function main() {
  const target = process.argv[2];
  const ignoredPackages = ignoredPackagesByTarget[target];
  if (!ignoredPackages) {
    throw new Error("Usage: node scripts/version-packages.mjs <npm|mobile>");
  }

  const status = readChangesetStatus();
  const mobileRelease =
    target === "mobile"
      ? status.releases.find(({ name }) => name === mobilePackageName)
      : undefined;
  let targetMobileVersion;

  if (mobileRelease) {
    const currentMobileVersion = readJson(mobilePackagePath).version;
    const appVersion = readConfiguredAppVersion();
    targetMobileVersion = nextMobileShipVersion(
      currentMobileVersion,
      appVersion,
      mobileRelease.type,
    );
  }

  const ignoreArguments = ignoredPackages.flatMap((packageName) => ["--ignore", packageName]);
  execFileSync("pnpm", ["changeset", "version", ...ignoreArguments], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });

  if (targetMobileVersion) {
    applyMobileShipVersion(targetMobileVersion);
  }
}

function readChangesetStatus() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-relay-release-"));
  const statusPath = join(temporaryDirectory, "status.json");

  try {
    execFileSync("pnpm", ["changeset", "status", `--output=${statusPath}`], {
      cwd: workspaceRoot,
      stdio: "inherit",
    });
    return readJson(statusPath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readConfiguredAppVersion() {
  const expoConfig = execFileSync("pnpm", ["expo", "config", "--json"], {
    cwd: mobileRoot,
    encoding: "utf8",
  });
  return JSON.parse(expoConfig).version;
}

function applyMobileShipVersion(targetVersion) {
  const mobilePackage = readJson(mobilePackagePath);
  const generatedVersion = mobilePackage.version;
  mobilePackage.version = targetVersion;
  writeFileSync(mobilePackagePath, `${JSON.stringify(mobilePackage, null, 2)}\n`);

  const changelog = readFileSync(mobileChangelogPath, "utf8");
  const generatedHeading = `## ${generatedVersion}`;
  if (!changelog.includes(generatedHeading)) {
    throw new Error(`Could not find ${generatedHeading} in apps/mobile/CHANGELOG.md`);
  }
  writeFileSync(mobileChangelogPath, changelog.replace(generatedHeading, `## ${targetVersion}`));

  console.log(`Versioned ${mobilePackageName} as ${targetVersion}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

main();
