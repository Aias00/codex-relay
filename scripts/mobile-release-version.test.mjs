import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isMobileShipRelease, nextMobileShipVersion } from "./mobile-release-version.mjs";

test("starts ship numbering from the configured app version", () => {
  assert.equal(nextMobileShipVersion("1.0.0", "1.4.0", "patch"), "1.4.0-ship.1");
});

test("increments ship numbering while the app version stays the same", () => {
  assert.equal(nextMobileShipVersion("1.4.0-ship.1", "1.4.0", "patch"), "1.4.0-ship.2");
});

test("resets ship numbering when the app version changes", () => {
  assert.equal(nextMobileShipVersion("1.4.0-ship.8", "1.5.0", "patch"), "1.5.0-ship.1");
});

test("rejects non-patch mobile changesets before versioning", () => {
  assert.throws(() => nextMobileShipVersion("1.4.0-ship.2", "1.4.0", "minor"), TypeError);
});

test("detects only sequential ship releases", () => {
  assert.equal(isMobileShipRelease("1.0.0", "1.4.0-ship.1"), true);
  assert.equal(isMobileShipRelease("1.4.0-ship.1", "1.4.0-ship.2"), true);
  assert.equal(isMobileShipRelease("1.4.0-ship.8", "1.5.0-ship.1"), true);
  assert.equal(isMobileShipRelease("1.4.0-ship.1", "1.4.0-ship.3"), false);
  assert.equal(isMobileShipRelease("1.4.0-ship.1", "1.4.1"), false);
});

test("keeps unrelated private packages out of Changesets versioning", () => {
  const releaseConfig = JSON.parse(
    readFileSync(new URL("../.changeset/config.json", import.meta.url), "utf8"),
  );

  assert.deepEqual(releaseConfig.ignore, ["react-native-direct-fetch"]);
});
