export type RepositoryKind = "git" | "cvs";
export interface RepositoryDescriptor {
  id: string;
  kind: RepositoryKind;
  root: string;
  title: string;
}
