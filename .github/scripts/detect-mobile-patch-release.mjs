import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMobileShipRelease } from "../../scripts/mobile-release-version.mjs";

const packagePath = "apps/mobile/package.json";

function main() {
  const currentVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const beforeSha = process.env.BEFORE_SHA;
  let previousVersion;

  if (beforeSha && !/^0+$/.test(beforeSha)) {
    try {
      const previousPackage = execFileSync("git", ["show", `${beforeSha}:${packagePath}`], {
        encoding: "utf8",
      });
      previousVersion = JSON.parse(previousPackage).version;
    } catch (error) {
      console.warn(`Could not read the previous mobile version: ${error.message}`);
    }
  }

  const deploy = isMobileShipRelease(previousVersion, currentVersion);

  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `deploy=${deploy}\nprevious-version=${previousVersion ?? "unknown"}\ncurrent-version=${currentVersion}\n`,
  );
  console.log(
    deploy
      ? `Detected @codex-relay/mobile ship release: ${previousVersion} -> ${currentVersion}`
      : `No mobile ship release detected: ${previousVersion ?? "unknown"} -> ${currentVersion}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
