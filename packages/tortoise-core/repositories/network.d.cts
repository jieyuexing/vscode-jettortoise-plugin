export function runNetwork<T>(
  job: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T>;
