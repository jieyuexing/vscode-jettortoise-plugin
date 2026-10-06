import { t } from "../i18n";
import type {
  Bridge,
  EventMessage,
  RequestMessage,
  ResponseMessage,
} from "./types";

import { getVSCodeApi } from "./vscode-api";

export function createVSCodeBridge(): Bridge {
  const vscode = getVSCodeApi();
  const pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const eventHandlers = new Set<(event: string, data: unknown) => void>();

  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === "response") {
      const resp = msg as ResponseMessage;
      const pending = pendingRequests.get(resp.id);
      if (pending) {
        pendingRequests.delete(resp.id);
        if (resp.success) {
          pending.resolve(resp.data);
        } else {
          pending.reject(
            new Error(resp.error?.message ?? t("common.unknownError")),
          );
        }
      }
    } else if (msg.type === "event") {
      const evt = msg as EventMessage;
      for (const h of eventHandlers) {
        h(evt.event, evt.data);
      }
    }
  });

  return {
    getState: () => vscode.getState(),
    setState: (state) => vscode.setState(state),
    notifyHistoryReady: () =>
      vscode.postMessage({ type: "jettortoiseHistoryReady" }),
    request(command, params = {}) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(t("common.requestTimedOut", { command })));
        }, 10_000);

        pendingRequests.set(id, {
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });

        const msg: RequestMessage = { type: "request", id, command, params };
        vscode.postMessage(msg);
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
  };
}
