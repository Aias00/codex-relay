import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appVersionPattern = /^\d+\.\d+\.\d+$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const shipVersionPattern = /^(\d+\.\d+\.\d+)-ship\.(\d+)$/;

export function nextMobileShipVersion(currentVersion, appVersion, releaseType) {
  if (releaseType !== "patch") {
    throw new TypeError(
      `@codex-relay/mobile changesets must use patch; received ${releaseType ?? "none"}`,
    );
  }

  if (!semverPattern.test(currentVersion) || !appVersionPattern.test(appVersion)) {
    throw new TypeError(`Invalid mobile release versions: ${currentVersion}, ${appVersion}`);
  }

  const currentShipVersion = parseShipVersion(currentVersion);
  const nextShipNumber =
    currentShipVersion?.appVersion === appVersion ? currentShipVersion.shipNumber + 1 : 1;

  return `${appVersion}-ship.${nextShipNumber}`;
}

export function isMobileShipRelease(previousVersion, currentVersion) {
  if (!semverPattern.test(previousVersion ?? "")) {
    return false;
  }

  const previousShipVersion = parseShipVersion(previousVersion);
  const currentShipVersion = parseShipVersion(currentVersion);
  if (!currentShipVersion) {
    return false;
  }

  if (previousShipVersion?.appVersion === currentShipVersion.appVersion) {
    return currentShipVersion.shipNumber === previousShipVersion.shipNumber + 1;
  }

  return currentShipVersion.shipNumber === 1;
}

export function formatReleasePullRequestTitle(relayVersion, mobileVersion, appVersion) {
  const releases = [];
  if (relayVersion) {
    releases.push(`codex-relay@${relayVersion}`);
  }
  if (mobileVersion) {
    releases.push(`@codex-relay/mobile@${mobileVersion} (app-version ${appVersion})`);
  }

  return `chore: release ${releases.join(" + ")}`;
}

function parseShipVersion(version) {
  const match = shipVersionPattern.exec(version ?? "");
  if (!match) {
    return undefined;
  }

  return {
    appVersion: match[1],
    shipNumber: Number(match[2]),
  };
}

function main() {
  const [command, firstValue, secondValue, thirdValue] = process.argv.slice(2);
  if (command === "title") {
    console.log(formatReleasePullRequestTitle(firstValue, secondValue, thirdValue));
    return;
  }

  if (command !== "next" || !firstValue || !secondValue || !thirdValue) {
    console.error(
      "Usage: node scripts/mobile-release-version.mjs next <current> <app-version> <release-type>",
    );
    process.exitCode = 1;
    return;
  }

  console.log(nextMobileShipVersion(firstValue, secondValue, thirdValue));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
