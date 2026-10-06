export interface VcsRepositoryBoundary {
  id: string;
  kind: "git" | "cvs";
  path: string;
  added: boolean;
}
export function VcsRepositoryBoundaries({items,title,openLabel,addLabel,onOpen}: {items: VcsRepositoryBoundary[]; title: string; openLabel: string; addLabel: string; onOpen: (id: string) => void}) {
  if (!items.length) return null;
  return <div className="vcs-repository-boundaries" aria-label={title}>
    <div>{title}</div>
    {items.map(item => <div key={item.id} className="vcs-repository-boundary">
      <span title={item.path}>{item.path} [{item.kind.toUpperCase()}]</span>
      <button type="button" onClick={() => onOpen(item.id)}>{item.added ? openLabel : addLabel}</button>
    </div>)}
  </div>;
}
