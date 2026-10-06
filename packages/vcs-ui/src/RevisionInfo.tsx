import type { VcsReference, VcsRevision } from "./types";

export interface RevisionInfoProps {
  revision: VcsRevision;
  /** Keeps date formatting under the host's VS Code display-language policy. */
  formatDate: (timestamp: string) => string;
  /** Host-supplied localized phrase, such as "authored on {date}". */
  formatAuthoredOn: (date: string) => string;
}

/** Renders text with URLs highlighted as safe clickable links. */
function Linkify({ text }: { text: string }) {
  const urlRegex = /(https?:\/\/[^\s<>]+)/g;
  const parts = text.split(urlRegex);

  return (
    <>
      {parts.map((part, index) =>
        urlRegex.test(part) ? (
          <a
            key={`link-${index}-${part.slice(0, 20)}`}
            href={part}
            style={{ color: "#3574f0", textDecoration: "none" }}
            target="_blank"
            rel="noopener noreferrer"
          >
            {part}
          </a>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

const referenceColors: Record<VcsReference["kind"], string> = {
  branch: "#59a869",
  remote: "#9b7dd4",
  tag: "#c4a000",
  head: "#e06c75",
  other: "#59a869",
};

/** VCS-neutral revision detail with the original JetTortoise visual treatment. */
export function RevisionInfo({
  revision,
  formatDate,
  formatAuthoredOn,
}: RevisionInfoProps) {
  const displayId = revision.shortRevisionId || revision.revisionId;
  const visibleReferences = revision.references?.filter(
    (reference) =>
      !(reference.kind === "remote" && reference.name.endsWith("/HEAD")),
  );

  return (
    <div>
      <div
        style={{
          fontWeight: 600,
          fontSize: "1.05em",
          lineHeight: 1.4,
          marginBottom: 4,
        }}
      >
        <Linkify text={revision.subject} />
      </div>
      {revision.body && (
        <div
          style={{
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
            color: "var(--description-fg)",
            marginBottom: 8,
          }}
        >
          <Linkify text={revision.body} />
        </div>
      )}
      <div
        style={{
          fontSize: "0.92em",
          color: "var(--description-fg)",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--editor-font)",
            fontSize: "var(--editor-font-size)",
          }}
        >
          {displayId}
        </span>{" "}
        {revision.author?.name}{" "}
        {revision.author?.email && (
          <>
            <a
              href={`mailto:${revision.author.email}`}
              style={{ color: "#3574f0", textDecoration: "none" }}
            >
              &lt;{revision.author.email}&gt;
            </a>{" "}
          </>
        )}
        {revision.timestamp && formatAuthoredOn(formatDate(revision.timestamp))}
      </div>
      {visibleReferences && visibleReferences.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {visibleReferences.map((reference, index) => {
            const color = referenceColors[reference.kind];
            const label = reference.kind === "head" ? "HEAD" : reference.name;
            return (
              <span
                key={`${reference.kind}:${reference.name}:${index}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  fontSize: "0.85em",
                  whiteSpace: "nowrap",
                }}
                title={reference.name}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2.5 3.5C2.5 2.95 2.95 2.5 3.5 2.5H7.09c.27 0 .52.1.71.3l5.41 5.41c.39.39.39 1.02 0 1.41l-3.59 3.59c-.39.39-1.02.39-1.41 0L2.79 7.8a1 1 0 0 1-.29-.71V3.5z"
                    fill="var(--app-bg, #fff)"
                    stroke={color}
                    strokeWidth="1.2"
                  />
                  <circle cx="5" cy="5" r="0.9" fill={color} />
                </svg>
                <span>{label}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
