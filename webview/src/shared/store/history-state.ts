/** Only view preferences and revision identifiers are persisted, never file content. */
export interface HistoryViewState {
  version: 1;
  filter: {
    searchQuery: string;
    branch: string;
    author: string;
    dateRange: string;
    file: string;
  };
  selectedCommitHashes: string[];
  visibleColumns: { author: boolean; date: boolean; hash: boolean };
}

export function readHistoryState(value: unknown): HistoryViewState {
  const result: HistoryViewState = {
    version: 1,
    filter: {
      searchQuery: "",
      branch: "",
      author: "",
      dateRange: "",
      file: "",
    },
    selectedCommitHashes: [],
    visibleColumns: { author: true, date: true, hash: true },
  };
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1
  ) {
    return result;
  }
  const saved = value as Partial<HistoryViewState>;
  for (const key of Object.keys(
    result.filter,
  ) as (keyof HistoryViewState["filter"])[]) {
    const text = saved.filter?.[key];
    if (typeof text === "string" && text.length <= 8192)
      result.filter[key] = text;
  }
  if (Array.isArray(saved.selectedCommitHashes)) {
    result.selectedCommitHashes = saved.selectedCommitHashes
      .filter(
        (hash): hash is string =>
          typeof hash === "string" && /^[a-f0-9]{40,64}$/i.test(hash),
      )
      .slice(0, 200);
  }
  for (const key of ["author", "date", "hash"] as const) {
    const visible = saved.visibleColumns?.[key];
    if (typeof visible === "boolean") result.visibleColumns[key] = visible;
  }
  return result;
}
