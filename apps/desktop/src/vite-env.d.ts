/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "dojix" | "greenwick", from .env.<brand> (vite --mode <brand>). */
  readonly VITE_BRAND: string;
  /** "mock" in mock builds (dev, Playwright); unset in the app. */
  readonly VITE_IPC?: string;
}
