export interface Snapshot {
  installed: boolean;
  dependencies: boolean;
  configured: boolean;
  running: boolean;
  portBusy: boolean;
  version: string;
  port: number;
  url: string;
  baseUrl: string;
  keyHint: string;
  stRoot: string;
  nodeLabel: string;
  openBrowser: boolean;
  logFile: string;
  appVersion: string;
}

export interface ProgressEvent {
  stage: string;
  status: "run" | "ok" | "fail" | "skip";
  message: string;
  percent: number;
}

export interface InstallBody {
  baseUrl: string;
  key: string;
  port: number;
  stRoot: string;
  openBrowser: boolean;
  startAfter: boolean;
}

export interface SaveBody {
  baseUrl: string;
  key: string;
  port: number;
  stRoot: string;
  openBrowser: boolean;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Snapshot>("snapshot");
}

export async function installTavern(body: InstallBody): Promise<Snapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Snapshot>("install", { req: body });
}

export async function startTavern(): Promise<Snapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Snapshot>("start_tavern");
}

export async function stopTavern(): Promise<Snapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Snapshot>("stop_tavern");
}

export async function saveSettings(body: SaveBody): Promise<Snapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Snapshot>("save_settings", { req: body });
}

export async function openUrl(url: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_url", { url });
}

export async function openFolder(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_folder", { path });
}

export async function onProgress(handler: (event: ProgressEvent) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ProgressEvent>("progress", (event) => handler(event.payload));
}

export async function pickDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Каталог SillyTavern" });
  return typeof picked === "string" ? picked : null;
}

export async function windowAction(action: "min" | "max" | "close"): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const current = getCurrentWindow();
  if (action === "min") await current.minimize();
  else if (action === "max") await current.toggleMaximize();
  else await current.close();
}
