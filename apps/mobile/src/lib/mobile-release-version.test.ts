import { describe, expect, it } from "vitest";

import { formatMobileReleaseVersion } from "./mobile-release-version";

describe("formatMobileReleaseVersion", () => {
  it("renders a matching ship version as human-readable copy", () => {
    expect(formatMobileReleaseVersion("1.4.0", "1.4.0-ship.1")).toBe("1.4.0 · Ship 1");
  });

  it("keeps the native app version when no matching ship label exists", () => {
    expect(formatMobileReleaseVersion("1.4.0", "1.0.0")).toBe("1.4.0");
    expect(formatMobileReleaseVersion("1.5.0", "1.4.0-ship.8")).toBe("1.5.0");
  });
});
