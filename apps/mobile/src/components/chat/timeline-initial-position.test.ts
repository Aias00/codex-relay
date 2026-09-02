import { describe, expect, it, vi } from "vitest";

import {
  scheduleInitialTimelineEndPosition,
  shouldPositionInitialTimelineAtEnd,
} from "./timeline-initial-position";

describe("shouldPositionInitialTimelineAtEnd", () => {
  it("positions cached messages at the end when a thread first becomes active", () => {
    expect(
      shouldPositionInitialTimelineAtEnd({
        hasRows: true,
        positionedTimelineKey: undefined,
        timelineKey: "thread-1",
      }),
    ).toBe(true);
  });

  it("does not reposition a timeline that has already completed initial positioning", () => {
    expect(
      shouldPositionInitialTimelineAtEnd({
        hasRows: true,
        positionedTimelineKey: "thread-1",
        timelineKey: "thread-1",
      }),
    ).toBe(false);
  });
});

describe("scheduleInitialTimelineEndPosition", () => {
  it("scrolls after two layout frames and settles when scrolling resolves", async () => {
    const frames: Array<() => void> = [];
    const scrollToEnd = vi.fn<() => Promise<void>>(async () => undefined);
    const onSettled = vi.fn<() => void>();

    scheduleInitialTimelineEndPosition({
      cancelFrame: vi.fn<(frame: number) => void>(),
      onSettled,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      scrollToEnd,
    });

    frames.shift()?.();
    frames.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("settles when the list rejects the initial scroll request", async () => {
    const frames: Array<() => void> = [];
    const onSettled = vi.fn<() => void>();

    scheduleInitialTimelineEndPosition({
      cancelFrame: vi.fn<(frame: number) => void>(),
      onSettled,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      scrollToEnd: vi.fn<() => Promise<void>>(async () => {
        throw new Error("not laid out");
      }),
    });

    frames.shift()?.();
    frames.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("cancels stale positioning before a switched timeline can scroll", () => {
    const frames: Array<() => void> = [];
    const cancelFrame = vi.fn<(frame: number) => void>();
    const scrollToEnd = vi.fn<() => Promise<void>>(async () => undefined);
    const onSettled = vi.fn<() => void>();

    const cancel = scheduleInitialTimelineEndPosition({
      cancelFrame,
      onSettled,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      scrollToEnd,
    });
    cancel();
    frames.forEach((frame) => frame());

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
