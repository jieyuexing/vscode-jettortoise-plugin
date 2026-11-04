import { bridge } from "./index";

/**
 * 请求失败时把原文写进日志并弹出宿主通知。直接把 Error 交给 console 时，
 * 宿主转发 webview 日志会把它序列化成 `{}`，界面上也没有任何反应。
 */
export function reportError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${action} failed: ${message}`);
  bridge.request("showErrorNotification", { message }).catch(() => {});
}
