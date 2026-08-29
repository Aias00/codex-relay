import { beforeEach, describe, expect, it } from "vitest";

import {
  markThreadEventStreamUnavailable,
  resetThreadEventStreamCapabilityForTests,
  shouldUseThreadEventStream,
} from "../../../apps/mobile/src/lib/thread-event-stream-capability.js";

describe("mobile durable thread event stream capability", () => {
  beforeEach(() => {
    resetThreadEventStreamCapabilityForTests();
  });

  it("uses the durable stream only for threads with a persisted cursor", () => {
    expect(shouldUseThreadEventStream(undefined)).toBe(false);
    expect(shouldUseThreadEventStream(0)).toBe(false);
    expect(shouldUseThreadEventStream(12)).toBe(true);
  });

  it("falls back for the rest of the current app session after a capability failure", () => {
    markThreadEventStreamUnavailable();

    expect(shouldUseThreadEventStream(12)).toBe(false);
  });
});
