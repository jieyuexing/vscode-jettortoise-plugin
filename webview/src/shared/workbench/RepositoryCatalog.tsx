import { useCallback, useEffect, useState } from "react";
import { VcsRepositoryList } from "../../../../packages/vcs-ui/src";
import { t } from "../i18n";
import { workbenchRequest } from "./transport";

type Entry = {
  repository: { id: string; root: string; kind: "git" | "cvs" };
  hidden: boolean;
  availability: string;
  unavailableReason?: string;
  activity?: { ref?: string; status?: string; message?: string };
};
type Snapshot = {
  entries: Entry[];
  scanning: boolean;
  scanIncomplete: boolean;
};
const empty: Snapshot = { entries: [], scanning: false, scanIncomplete: false };
export function RepositoryCatalog() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [error, setError] = useState("");
  let currentId: string | undefined;
  try {
    currentId = JSON.parse(
      document.getElementById("root")?.dataset.repository ?? "null",
    )?.id;
  } catch {
    /* Host may be absent in a fixture. */
  }
  const action = useCallback((action: string, repositoryId?: string) => {
    setError("");
    void workbenchRequest<Snapshot>("jettortoiseCatalog", {
      action,
      ...(repositoryId ? { repositoryId } : {}),
    })
      .then((result) => {
        if (result?.entries) setSnapshot(result);
      })
      .catch((error: Error) => setError(error.message));
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.data?.type === "jettortoiseCatalogSnapshot" &&
        Array.isArray(event.data.data?.entries)
      )
        setSnapshot(event.data.data);
    };
    window.addEventListener("message", receive);
    action("snapshot");
    return () => window.removeEventListener("message", receive);
  }, [action]);
  const entries = snapshot.entries.filter((entry) => !entry.hidden);
  const items = entries.map((entry) => {
    const repo = entry.repository;
    const ancestors = entries.filter((other) =>
      repo.root.startsWith(other.repository.root + "/"),
    );
    const parent = [...ancestors].sort(
      (a, b) => b.repository.root.length - a.repository.root.length,
    )[0];
    const name = repo.root.split("/").pop() || repo.root;
    const duplicates =
      entries.filter((other) => other.repository.root.split("/").pop() === name)
        .length > 1;
    return {
      id: repo.id,
      name,
      kind: repo.kind,
      ref: entry.activity?.ref,
      path: repo.root,
      relativePath: parent
        ? repo.root.slice(parent.repository.root.length + 1)
        : duplicates
          ? repo.root
          : undefined,
      depth: ancestors.length,
      current: currentId === repo.id,
      unavailableReason: entry.unavailableReason,
      statusMessage: entry.activity?.message,
      status: (entry.activity?.status === "running"
        ? "updating"
        : (entry.activity?.status ?? "idle")) as
        | "updating"
        | "idle"
        | "success"
        | "error",
    };
  });
  return (
    <>
      <VcsRepositoryList
        items={items}
        currentId={currentId}
        labels={{
          search: t("catalog.search"),
          add: t("catalog.add"),
          scan: t("catalog.scan"),
          restore: t("catalog.restore"),
          open: t("catalog.open"),
          openCommit: t("catalog.commit"),
          update: t("catalog.update"),
          refresh: t("catalog.refresh"),
          copyPath: t("catalog.copy"),
          remove: t("catalog.remove"),
          unavailable: t("catalog.unavailable"),
          empty: t("catalog.empty"),
        }}
        onOpen={(id) => action("open", id)}
        onOpenCommit={(id) => action("commit", id)}
        onUpdate={(id) => action("update", id)}
        onRefresh={(id) => action("refresh", id)}
        onCopyPath={(id) => action("copy", id)}
        onRemove={(id) => action("remove", id)}
        onAdd={() => action("add")}
        onScan={() => action("scan")}
        onRestore={() => action("restore")}
      />
      {snapshot.scanning && (
        <div className="vcs-ui-catalog-feedback" role="status">
          {t("catalog.scanning")}{" "}
          <button type="button" onClick={() => action("cancelScan")}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {!snapshot.scanning && snapshot.scanIncomplete && (
        <p className="vcs-ui-catalog-feedback" role="status">
          {t("catalog.incomplete")}
        </p>
      )}
      {error && (
        <p role="alert" className="vcs-ui-catalog-feedback">
          {error}
        </p>
      )}
    </>
  );
}
