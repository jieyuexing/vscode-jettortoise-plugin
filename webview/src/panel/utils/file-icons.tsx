import type React from "react";
import type { ComponentType, SVGProps } from "react";
import IconDefault from "~icons/vscode-icons/default-file";
import IconCss from "~icons/vscode-icons/file-type-css";
import IconDocker from "~icons/vscode-icons/file-type-docker2";
import IconGit from "~icons/vscode-icons/file-type-git";
import IconGo from "~icons/vscode-icons/file-type-go";
import IconHtml from "~icons/vscode-icons/file-type-html";
import IconImage from "~icons/vscode-icons/file-type-image";
import IconJava from "~icons/vscode-icons/file-type-java";
import IconJavaScript from "~icons/vscode-icons/file-type-js";
import IconJson from "~icons/vscode-icons/file-type-json";
import IconKotlin from "~icons/vscode-icons/file-type-kotlin";
import IconLess from "~icons/vscode-icons/file-type-less";
import IconMarkdown from "~icons/vscode-icons/file-type-markdown";
import IconPython from "~icons/vscode-icons/file-type-python";
import IconJavaScriptReact from "~icons/vscode-icons/file-type-reactjs";
import IconTypeScriptReact from "~icons/vscode-icons/file-type-reactts";
import IconRust from "~icons/vscode-icons/file-type-rust";
import IconSass from "~icons/vscode-icons/file-type-sass";
import IconShell from "~icons/vscode-icons/file-type-shell";
import IconSvg from "~icons/vscode-icons/file-type-svg";
import IconSwift from "~icons/vscode-icons/file-type-swift";
import IconToml from "~icons/vscode-icons/file-type-toml";
// --- File type icons (vscode-icons) ---
import IconTypeScript from "~icons/vscode-icons/file-type-typescript";
import IconVue from "~icons/vscode-icons/file-type-vue";
import IconXml from "~icons/vscode-icons/file-type-xml";
import IconYaml from "~icons/vscode-icons/file-type-yaml";

// --- Folder icons (IntelliJ IDEA style) ---
export function IconFolder({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        verticalAlign: "middle",
        color: "var(--vscode-descriptionForeground)",
        ...style,
      }}
    >
      <path
        d="M8.10584 4.34613L8.25344 4.5H8.46667H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.9529 13.932 13.5 13.3667 13.5H2.63333C2.06804 13.5 1.5 12.9529 1.5 12.1333V3.86667C1.5 3.04707 2.06804 2.5 2.63333 2.5H6.1217C6.25792 2.5 6.38824 2.55557 6.48253 2.65387L8.10584 4.34613Z"
        fill="currentColor"
        fillOpacity={0.15}
        stroke="currentColor"
      />
    </svg>
  );
}

export function IconFolderOpen({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        verticalAlign: "middle",
        color: "var(--vscode-descriptionForeground)",
        ...style,
      }}
    >
      <path
        d="M8.10584 4.34613L8.25344 4.5H8.46667H13C13.8284 4.5 14.5 5.17157 14.5 6V12.1333C14.5 12.9529 13.932 13.5 13.3667 13.5H2.63333C2.06804 13.5 1.5 12.9529 1.5 12.1333V3.86667C1.5 3.04707 2.06804 2.5 2.63333 2.5H6.1217C6.25792 2.5 6.38824 2.55557 6.48253 2.65387L8.10584 4.34613Z"
        fill="currentColor"
        fillOpacity={0.15}
        stroke="currentColor"
      />
    </svg>
  );
}

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// Special file name → icon
const SPECIAL_FILES: Record<string, IconComponent> = {
  Dockerfile: IconDocker,
  "docker-compose.yml": IconDocker,
  "docker-compose.yaml": IconDocker,
  ".dockerignore": IconDocker,
  ".gitignore": IconGit,
  ".gitattributes": IconGit,
  ".gitmodules": IconGit,
  "Cargo.toml": IconRust,
  "go.mod": IconGo,
  "go.sum": IconGo,
};

// Extension → icon
const EXT_MAP: Record<string, IconComponent> = {
  ts: IconTypeScript,
  mts: IconTypeScript,
  cts: IconTypeScript,
  tsx: IconTypeScriptReact,
  js: IconJavaScript,
  mjs: IconJavaScript,
  cjs: IconJavaScript,
  jsx: IconJavaScriptReact,
  json: IconJson,
  css: IconCss,
  html: IconHtml,
  htm: IconHtml,
  md: IconMarkdown,
  mdx: IconMarkdown,
  py: IconPython,
  go: IconGo,
  rs: IconRust,
  vue: IconVue,
  yaml: IconYaml,
  yml: IconYaml,
  sh: IconShell,
  bash: IconShell,
  zsh: IconShell,
  svg: IconSvg,
  png: IconImage,
  jpg: IconImage,
  jpeg: IconImage,
  gif: IconImage,
  webp: IconImage,
  less: IconLess,
  scss: IconSass,
  sass: IconSass,
  java: IconJava,
  kt: IconKotlin,
  kts: IconKotlin,
  swift: IconSwift,
  xml: IconXml,
  toml: IconToml,
};

export function getFileIcon(filePath: string): IconComponent {
  const fileName = filePath.split("/").pop() ?? filePath;

  // Check special file names first
  if (SPECIAL_FILES[fileName]) {
    return SPECIAL_FILES[fileName];
  }

  // Check extension
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = fileName.slice(dotIdx + 1).toLowerCase();
    if (EXT_MAP[ext]) {
      return EXT_MAP[ext];
    }
  }

  return IconDefault;
}
