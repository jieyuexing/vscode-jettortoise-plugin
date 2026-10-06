export type VcsUiLocale = "en" | "zh-cn";
export type VcsUiParams = Record<string, string | number>;

export const vcsUiEn = {
  "repository.nested": "Independent child repositories",
  "repository.open": "Open",
  "repository.add": "Add and open",
  "layout.showCommit": "Show Commit Area",
  "layout.hideCommit": "Hide Commit Area",
  "layout.resizeCommit": "Resize Commit Area",
  "layout.resizeNavigation": "Resize Navigation",
  "layout.resizeDetail": "Resize Details",
  "common.unknownLabel": "Unknown label",
  "common.cancel": "Cancel",
  "common.loading": "Loading...",
  "common.file": "{count} file{plural}",
  "common.files": "Files",
  "history.revisions": "Revisions",
  "history.details": "Details",
  "history.selectRevision": "Select a revision to view details",
  "commit.noChanges": "No changes detected",
  "menu.copyRevision": "Copy Revision Number",
  "menu.checkoutRevision": "Checkout Revision",
} as const;

export const vcsUiZhCn: Partial<Record<keyof typeof vcsUiEn, string>> = {
  "repository.nested": "独立子仓库",
  "repository.open": "打开",
  "repository.add": "添加并打开",
  "layout.showCommit": "显示提交区",
  "layout.hideCommit": "隐藏提交区",
  "layout.resizeCommit": "调整提交区宽度",
  "layout.resizeNavigation": "调整导航宽度",
  "layout.resizeDetail": "调整详情宽度",
  "common.unknownLabel": "未知标签",
  "common.cancel": "取消",
  "common.loading": "正在加载…",
  "common.file": "{count} 个文件",
  "common.files": "文件",
  "history.revisions": "修订记录",
  "history.details": "详情",
  "history.selectRevision": "选择修订记录以查看详情",
  "commit.noChanges": "未检测到更改",
  "menu.copyRevision": "复制修订号",
  "menu.checkoutRevision": "检出修订版本",
};

export type VcsUiKey = keyof typeof vcsUiEn;

export function normalizeVcsUiLanguage(language?: string): VcsUiLocale {
  const normalized = language?.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "zh" || normalized === "zh-cn" || normalized === "zh-tw"
    ? "zh-cn"
    : "en";
}

export function createVcsTranslator(language?: string) {
  const locale = normalizeVcsUiLanguage(language);
  return (key: VcsUiKey, params: VcsUiParams = {}): string => {
    const template =
      (locale === "zh-cn" ? vcsUiZhCn[key] : undefined) ??
      vcsUiEn[key] ??
      (locale === "zh-cn" ? vcsUiZhCn["common.unknownLabel"] : undefined) ??
      vcsUiEn["common.unknownLabel"];
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : match,
    );
  };
}
