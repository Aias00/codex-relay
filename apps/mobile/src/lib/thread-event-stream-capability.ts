let unavailableForCurrentSession = false;

export function shouldUseThreadEventStream(afterSequence: number | undefined) {
  return (
    !unavailableForCurrentSession &&
    typeof afterSequence === "number" &&
    Number.isInteger(afterSequence) &&
    afterSequence > 0
  );
}

export function markThreadEventStreamUnavailable() {
  unavailableForCurrentSession = true;
}

export function resetThreadEventStreamCapabilityForTests() {
  unavailableForCurrentSession = false;
}
