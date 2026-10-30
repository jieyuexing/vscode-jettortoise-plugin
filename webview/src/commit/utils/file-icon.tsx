import type React from "react";
import { getFileIcon } from "../../panel/utils/file-icons";

// IDEA-style text file icon (three horizontal lines) for unknown file types
function TextFileIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={style}>
      <path
        d="M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h7"
        stroke="var(--vscode-descriptionForeground)"
        strokeLinecap="round"
      />
    </svg>
  );
}

const KNOWN_EXTS = new Set([
  "ts",
  "mts",
  "cts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "json",
  "css",
  "html",
  "htm",
  "md",
  "mdx",
  "py",
  "go",
  "rs",
  "vue",
  "yaml",
  "yml",
  "sh",
  "bash",
  "zsh",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "less",
  "scss",
  "sass",
  "java",
  "kt",
  "kts",
  "swift",
  "xml",
  "toml",
  "zip",
]);

const SPECIAL_FILES = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  "Cargo.toml",
  "go.mod",
  "go.sum",
]);

/** Get file icon — uses vscode-icons for known types, IDEA text icon for unknown */
export function getCommitFileIcon(filePath: string) {
  const fileName = filePath.split("/").pop() ?? filePath;
  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "";

  if (SPECIAL_FILES.has(fileName) || KNOWN_EXTS.has(ext)) {
    return getFileIcon(filePath);
  }

  return TextFileIcon;
}
