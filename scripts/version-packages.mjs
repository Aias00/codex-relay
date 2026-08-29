import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nextMobileShipVersion } from "./mobile-release-version.mjs";

const mobilePackageName = "@codex-relay/mobile";
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const mobileRoot = resolve(workspaceRoot, "apps/mobile");
const mobilePackagePath = resolve(workspaceRoot, "apps/mobile/package.json");
const mobileChangelogPath = resolve(workspaceRoot, "apps/mobile/CHANGELOG.md");
const iosProjectPath = resolve(
  workspaceRoot,
  "apps/mobile/ios/CodexRelay.xcodeproj/project.pbxproj",
);
const changesetDirectory = resolve(workspaceRoot, ".changeset");
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
  const mixedChangesets = splitMixedChangesets(status.changesets, ignoredPackages);
  try {
    for (const changeset of mixedChangesets) {
      writeChangeset(changeset.id, changeset.selectedReleases, changeset.summary);
    }
    execFileSync("pnpm", ["changeset", "version", ...ignoreArguments], {
      cwd: workspaceRoot,
      stdio: "inherit",
    });
  } catch (error) {
    for (const changeset of mixedChangesets) {
      writeChangeset(changeset.id, changeset.originalReleases, changeset.summary);
    }
    throw error;
  }
  for (const changeset of mixedChangesets) {
    writeChangeset(changeset.id, changeset.remainingReleases, changeset.summary);
  }

  if (targetMobileVersion) {
    applyMobileShipVersion(targetMobileVersion);
    syncIosMarketingVersion(readConfiguredAppVersion());
  }
}

export function splitMixedChangesets(changesets, ignoredPackages) {
  return changesets.flatMap(({ id, releases, summary }) => {
    const selectedReleases = releases.filter(({ name }) => !ignoredPackages.includes(name));
    const remainingReleases = releases.filter(({ name }) => ignoredPackages.includes(name));
    if (selectedReleases.length === 0 || remainingReleases.length === 0) {
      return [];
    }
    return [{ id, originalReleases: releases, remainingReleases, selectedReleases, summary }];
  });
}

function writeChangeset(id, releases, summary) {
  const frontmatter = releases.map(({ name, type }) => `"${name}": ${type}`).join("\n");
  writeFileSync(
    resolve(changesetDirectory, `${id}.md`),
    `---\n${frontmatter}\n---\n\n${summary}\n`,
  );
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

export function syncIosMarketingVersion(appVersion) {
  if (!existsSync(iosProjectPath)) {
    return false;
  }
  const xcodeProject = readFileSync(iosProjectPath, "utf8");
  writeFileSync(iosProjectPath, replaceIosMarketingVersions(xcodeProject, appVersion));
  return true;
}

export function replaceIosMarketingVersions(xcodeProject, appVersion) {
  if (!/MARKETING_VERSION = [^;]+;/.test(xcodeProject)) {
    throw new Error("Could not find MARKETING_VERSION in apps/mobile/ios project.");
  }
  return xcodeProject.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${appVersion};`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
