export function shouldPositionInitialTimelineAtEnd(input: {
  hasRows: boolean;
  positionedTimelineKey: string | undefined;
  timelineKey: string;
}) {
  return input.hasRows && input.positionedTimelineKey !== input.timelineKey;
}

export function scheduleInitialTimelineEndPosition(input: {
  cancelFrame: (frame: number) => void;
  onSettled: () => void;
  scheduleFrame: (callback: () => void) => number;
  scrollToEnd: () => Promise<void>;
}) {
  let cancelled = false;
  let scrollFrame: number | undefined;
  const layoutFrame = input.scheduleFrame(() => {
    if (cancelled) {
      return;
    }
    scrollFrame = input.scheduleFrame(() => {
      if (cancelled) {
        return;
      }
      void input
        .scrollToEnd()
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) {
            input.onSettled();
          }
        });
    });
  });
  return () => {
    cancelled = true;
    input.cancelFrame(layoutFrame);
    if (scrollFrame !== undefined) {
      input.cancelFrame(scrollFrame);
    }
  };
}
