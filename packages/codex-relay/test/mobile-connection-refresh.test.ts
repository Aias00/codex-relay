import { describe, expect, it } from "vitest";

import { connectionRefreshActionPresentation } from "../../../apps/mobile/src/components/chat/connection-refresh.js";

describe("mobile connection refresh presentation", () => {
  it("uses a stable warning action while a paired Relay is unavailable", () => {
    expect(connectionRefreshActionPresentation("offline")).toEqual({
      icon: "warning",
      label: "Offline. Retry connection",
    });
    expect(connectionRefreshActionPresentation("checking")).toEqual({
      icon: "warning",
      label: "Checking connection",
    });
  });

  it("restores the normal refresh action when connected", () => {
    expect(connectionRefreshActionPresentation("connected")).toEqual({
      icon: "refresh",
      label: "Refresh chat",
    });
  });
});
