export type VcsAuxiliaryPane = "commit" | "navigation" | "detail";

export interface VcsLayoutState {
  /** Version 1 was the original four-column history layout. */
  version: 1 | 2;
  widths: Record<VcsAuxiliaryPane, number>;
  collapsed: Record<VcsAuxiliaryPane, boolean>;
  /** Percentage of the right hand work area used by the read-only preview. */
  diffHeight?: number;
  /** A presentation preference only; it never changes a commit draft. */
  diffMaximized?: boolean;
}

export const VCS_PANE_LIMITS = {
  commit: { min: 240, max: 500, initial: 280 },
  navigation: { min: 140, max: 500, initial: 220 },
  detail: { min: 220, max: 600, initial: 260 },
} as const;

export function readVcsLayoutState(value: unknown): VcsLayoutState {
  const result: VcsLayoutState = {
    version: 2,
    widths: { commit: 280, navigation: 220, detail: 260 },
    collapsed: { commit: false, navigation: false, detail: false },
    diffHeight: 55,
    diffMaximized: false,
  };
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    (value.version !== 1 && value.version !== 2)
  )
    return result;
  const saved = value as Partial<VcsLayoutState>;
  for (const pane of Object.keys(VCS_PANE_LIMITS) as VcsAuxiliaryPane[]) {
    const width = saved.widths?.[pane];
    const limits = VCS_PANE_LIMITS[pane];
    if (typeof width === "number" && Number.isFinite(width)) {
      result.widths[pane] = Math.round(
        Math.max(limits.min, Math.min(limits.max, width)),
      );
    }
    if (typeof saved.collapsed?.[pane] === "boolean")
      result.collapsed[pane] = saved.collapsed[pane];
  }
  const diffHeight = (saved as Partial<VcsLayoutState>).diffHeight;
  if (typeof diffHeight === "number" && Number.isFinite(diffHeight)) {
    result.diffHeight = Math.round(Math.max(25, Math.min(75, diffHeight)));
  }
  if (typeof (saved as Partial<VcsLayoutState>).diffMaximized === "boolean") {
    result.diffMaximized = (saved as Partial<VcsLayoutState>).diffMaximized;
  }
  return result;
}

/** Temporary responsive visibility never changes the saved user preferences. */
export function getVcsPaneVisibility(
  layout: VcsLayoutState,
  availableWidth: number,
  protectedPanes: VcsAuxiliaryPane[] = [],
): Record<VcsAuxiliaryPane, boolean> {
  const visible = {
    commit: !layout.collapsed.commit,
    navigation: !layout.collapsed.navigation,
    detail: !layout.collapsed.detail,
  };
  const required = () =>
    320 +
    (Object.keys(visible) as VcsAuxiliaryPane[]).reduce(
      (sum, pane) => sum + (visible[pane] ? layout.widths[pane] : 28),
      0,
    );
  if (availableWidth > 0) {
    for (const pane of ["detail", "navigation"] as const) {
      if (required() <= availableWidth) break;
      if (!protectedPanes.includes(pane)) visible[pane] = false;
    }
  }
  return visible;
}
