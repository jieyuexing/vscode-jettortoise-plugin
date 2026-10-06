export class CvsError extends Error {
  code: string;
  constructor(code: string);
}
export class CvsProcess {
  constructor(
    executable?: string,
    options?: { timeoutMs?: number; maxBytes?: number },
  );
  run(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    allowed?: number[],
    options?: { stdoutOnly?: boolean; maxBytes?: number },
  ): Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;
}
export class SerialQueue {
  controllers: Set<AbortController>;
  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancel(): void;
}
export interface CvsFile {
  newPath: string;
  entryRevision: string;
  state: string;
}
export class CvsAdapter {
  constructor(root: string, process?: CvsProcess);
  root: string;
  status(signal?: AbortSignal): Promise<CvsFile[]>;
  getNestedBoundaries(): Array<{ kind: "git" | "cvs"; root: string }>;
  log(
    name: string,
    signal?: AbortSignal,
  ): Promise<Array<{ revisionId: string; [key: string]: unknown }>>;
  file(name: string): Promise<CvsFile>;
  content(
    name: string,
    revision: string,
    signal?: AbortSignal,
    options?: { maxBytes?: number },
  ): Promise<Buffer>;
  update(signal?: AbortSignal): Promise<void>;
  commit(names: string[], message: string, signal?: AbortSignal): Promise<void>;
  rollback(name: string, signal?: AbortSignal): Promise<string>;
}
export function relativeFile(value: string): string;
export function revision(value: string): string;
