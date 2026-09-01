import { describe, expect, it } from "vitest";

import { createThreadHydrationGenerationGate } from "../../../apps/mobile/src/lib/thread-hydration-generation.js";

describe("mobile older-history hydration generation", () => {
  it("invalidates only the targeted thread generation", () => {
    const gate = createThreadHydrationGenerationGate();
    const threadOne = gate.current("relay-1:thread-1");
    const threadTwo = gate.current("relay-1:thread-2");

    gate.invalidate("relay-1:thread-1");

    expect(gate.isCurrent("relay-1:thread-1", threadOne)).toBe(false);
    expect(gate.isCurrent("relay-1:thread-2", threadTwo)).toBe(true);
  });
});
