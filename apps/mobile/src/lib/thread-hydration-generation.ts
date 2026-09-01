export type ThreadHydrationGenerationGate = {
  current(key: string): number;
  invalidate(key: string): number;
  isCurrent(key: string, generation: number): boolean;
};

export function createThreadHydrationGenerationGate(): ThreadHydrationGenerationGate {
  const generations = new Map<string, number>();
  return {
    current(key) {
      return generations.get(key) ?? 0;
    },
    invalidate(key) {
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      return generation;
    },
    isCurrent(key, generation) {
      return (generations.get(key) ?? 0) === generation;
    },
  };
}
