export type DesktopSettings = {
  environment: "native" | "wsl";
  distribution: string;
  provider: "deepseek" | "openai" | "anthropic";
  model: string;
  baseURL: string;
  configured: boolean;
  hasKey?: boolean;
  apiKey?: string;
};
export type DesktopState = {
  phase: "starting" | "ready" | "error";
  message: string;
  active: number;
  settings: DesktopSettings;
  distributions: string[];
  version: string;
};
export type DesktopAPI = {
  getState(): Promise<DesktopState>;
  configure(settings: DesktopSettings): Promise<DesktopState>;
  selectDirectory(): Promise<string | null>;
  restart(): Promise<DesktopState>;
  openLogs(): Promise<void>;
  onState(callback: (state: DesktopState) => void): () => void;
};
declare global {
  interface Window {
    thrushDesktop?: DesktopAPI;
  }
}
