import type * as vscode from "vscode";

export type RepositoryKind = "git" | "cvs";
export interface RepositoryDescriptor {
  id: string;
  kind: RepositoryKind;
  root: string;
  title: string;
  capabilities: Readonly<Partial<Record<string, boolean>>>;
}
export type RepositoryOrigin = "manual" | "auto";
export type RepositoryAvailability = "available" | "unavailable";
export interface RepositoryCatalogEntry {
  repository: RepositoryDescriptor;
  origin: RepositoryOrigin;
  hidden: boolean;
  availability: RepositoryAvailability;
  /** A short, non-sensitive reason for a currently unavailable saved root. */
  unavailableReason?: string;
  /** Optional presentation data collected by an adapter, never a command input. */
  activity?: {
    ref?: string;
    status?: "idle" | "running" | "success" | "error";
    message?: string;
  };
}
export interface RepositoryCatalogSnapshot {
  version: 1;
  entries: readonly RepositoryCatalogEntry[];
  scanning: boolean;
  scanIncomplete: boolean;
  scannedAt?: number;
}
export interface RepositorySession {
  open(file?: string, commit?: boolean): void;
  restore(panel: vscode.WebviewPanel): void | Promise<void>;
  refresh(): void | Promise<void>;
  update?(): Promise<void>;
  cancel?(): void;
  execute?(command: string, ...args: unknown[]): unknown;
  provideContent(uri: vscode.Uri): Promise<string>;
  readFile?(uri: vscode.Uri): Promise<Uint8Array>;
  dispose(): void;
}

export interface RepositoryRegistrationState {
  version: 2;
  repositories: Array<{
    kind: RepositoryKind;
    root: string;
    identity?: string;
    origin: RepositoryOrigin;
    hidden?: boolean;
    ref?: string;
  }>;
  scan?: { incomplete?: boolean; scannedAt?: number };
}
export interface LegacyRepositoryRegistrationState {
  version: 1;
  repositories: Array<{
    kind: RepositoryKind;
    root: string;
    identity?: string;
  }>;
}
