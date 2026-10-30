import * as vscode from "vscode";

/** 仅翻译扩展的固定错误；CLI 原文、路径和修订号保持原值。 */
export function localizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const fixed: Record<string, string> = {
    "A non-empty repository-relative path is required": vscode.l10n.t(
      "A non-empty repository-relative path is required",
    ),
    "Absolute paths are not allowed": vscode.l10n.t(
      "Absolute paths are not allowed",
    ),
    "Command is not available from this view.": vscode.l10n.t(
      "Command is not available from this view.",
    ),
    "Dangling symbolic links are not allowed": vscode.l10n.t(
      "Dangling symbolic links are not allowed",
    ),
    "Enter a commit message.": vscode.l10n.t("Enter a commit message."),
    "Git metadata paths are not allowed": vscode.l10n.t(
      "Git metadata paths are not allowed",
    ),
    "Invalid CVS revision.": vscode.l10n.t("Invalid CVS revision."),
    "Invalid amend flag.": vscode.l10n.t("Invalid amend flag."),
    "Invalid message envelope": vscode.l10n.t("Invalid message envelope"),
    "Invalid repository ID.": vscode.l10n.t("Invalid repository ID."),
    "Invalid request ID": vscode.l10n.t("Invalid request ID"),
    "Invalid selected file.": vscode.l10n.t("Invalid selected file."),
    "Invalid selection surface.": vscode.l10n.t("Invalid selection surface."),
    "Path is outside the repository": vscode.l10n.t(
      "Path is outside the repository",
    ),
    "Path parent resolves outside the repository": vscode.l10n.t(
      "Path parent resolves outside the repository",
    ),
    "Path resolves outside the repository": vscode.l10n.t(
      "Path resolves outside the repository",
    ),
    "Path traversal is not allowed": vscode.l10n.t(
      "Path traversal is not allowed",
    ),
    "Remote name is invalid": vscode.l10n.t("Remote name is invalid"),
    "Repository refresh failed.": vscode.l10n.t("Repository refresh failed."),
    "Request failed.": vscode.l10n.t("Request failed."),
    "Select changed files.": vscode.l10n.t("Select changed files."),
    "Select files.": vscode.l10n.t("Select files."),
    "Shelf names cannot contain path separators": vscode.l10n.t(
      "Shelf names cannot contain path separators",
    ),
    "Unable to read workspace.": vscode.l10n.t("Unable to read workspace."),
    "Unexpected message field": vscode.l10n.t("Unexpected message field"),
    "Unknown command": vscode.l10n.t("Unknown command"),
    "Unknown error": vscode.l10n.t("Unknown error"),
    "Repository boundary validation is incomplete": vscode.l10n.t(
      "Repository boundary validation is incomplete",
    ),
    "Unable to read directory": vscode.l10n.t("Unable to read directory"),
    "Git content exceeds the comparison preview limit": vscode.l10n.t(
      "Git content exceeds the comparison preview limit",
    ),
    "Git ref is invalid": vscode.l10n.t("Git ref is invalid"),
    "Git revision is invalid": vscode.l10n.t("Git revision is invalid"),
    "Git content revision is invalid": vscode.l10n.t(
      "Git content revision is invalid",
    ),
    "Object id is invalid": vscode.l10n.t("Object id is invalid"),
    "History ref is invalid": vscode.l10n.t("History ref is invalid"),
    "Left revision is invalid": vscode.l10n.t("Left revision is invalid"),
    "Right revision is invalid": vscode.l10n.t("Right revision is invalid"),
    "Commit hash is invalid": vscode.l10n.t("Commit hash is invalid"),
    "Start point is invalid": vscode.l10n.t("Start point is invalid"),
    "Remote branch is invalid": vscode.l10n.t("Remote branch is invalid"),
    "Rebase target is invalid": vscode.l10n.t("Rebase target is invalid"),
    "Target branch is invalid": vscode.l10n.t("Target branch is invalid"),
    "Shelf directory cannot be a symbolic link": vscode.l10n.t(
      "Shelf directory cannot be a symbolic link",
    ),
    "Shelf patch cannot be a symbolic link": vscode.l10n.t(
      "Shelf patch cannot be a symbolic link",
    ),
    "Shelf metadata cannot be a symbolic link": vscode.l10n.t(
      "Shelf metadata cannot be a symbolic link",
    ),
  };
  if (Object.hasOwn(fixed, message)) return fixed[message];
  const nested = /^Nested repositories block this operation: (.*)\.$/.exec(
    message,
  );
  if (nested) {
    const boundaries = (error as { boundaries?: unknown[] })?.boundaries;
    const more =
      Array.isArray(boundaries) && boundaries.length > 3
        ? /^(.*) and (\d+) more$/.exec(nested[1])
        : null;
    return more
      ? vscode.l10n.t(
          "Nested repositories block this operation: {0} and {1} more.",
          more[1],
          more[2],
        )
      : vscode.l10n.t(
          "Nested repositories block this operation: {0}.",
          nested[1],
        );
  }
  const field = /^(Unexpected|Missing) request field: (.*)$/.exec(message);
  if (field)
    return field[1] === "Missing"
      ? vscode.l10n.t("Missing request field: {0}", field[2])
      : vscode.l10n.t("Unexpected request field: {0}", field[2]);
  const invalid = /^(Invalid|Forbidden) request field: (.*)$/.exec(message);
  if (invalid)
    return invalid[1] === "Invalid"
      ? vscode.l10n.t("Invalid request field: {0}", invalid[2])
      : vscode.l10n.t("Forbidden request field: {0}", invalid[2]);
  return message;
}
