interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;
let api: VSCodeApi | undefined;
/** One acquisition shared by the Git request bridge and the CVS view. */
export function getVSCodeApi(): VSCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}
