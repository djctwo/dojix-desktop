import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const BRANDS = ["dojix", "greenwick"];
const MOCK_MODES = BRANDS.map((b) => `${b}-mock`);

// The brand is chosen at build time with `vite build --mode <brand>` (see .env.<brand>).
// `--mode <brand>-mock` builds the same app on the mock IPC with fictional fixtures, for the
// browser (Playwright, UI development); it is never packaged (dist-mock/, not dist/).
export default defineConfig(({ mode }) => {
  if (mode !== "test" && !BRANDS.includes(mode) && !MOCK_MODES.includes(mode)) {
    throw new Error(`Build with --mode dojix, greenwick, dojix-mock or greenwick-mock (got "${mode}")`);
  }
  const mock = MOCK_MODES.includes(mode);
  // Mock builds freeze Object.prototype before any module runs, as Tauri's `freezePrototype`
  // does in the real app, so the browser specs catch libraries that break under it. A classic
  // script in <head> runs before every module script (an import would run after shared chunks).
  // Mock builds are never served under the app's CSP.
  const freezeFirst: Plugin = {
    name: "freeze-prototype-first",
    transformIndexHtml: () =>
      mock ? [{ tag: "script", children: "Object.freeze(Object.prototype);", injectTo: "head-prepend" }] : [],
  };
  return {
    plugins: [react(), freezeFirst],
    clearScreen: false,
    server: { port: mock ? 5174 : 5173, strictPort: true },
    preview: { port: mode.startsWith("greenwick") ? 4174 : 4173, strictPort: true },
    worker: { format: "es" },
    build: {
      target: ["es2022", "chrome120", "safari16"],
      outDir: mock ? `dist-mock/${mode.replace("-mock", "")}` : "dist",
      emptyOutDir: true,
      sourcemap: false,
      // Fonts and fixtures are files, never inlined as data: URLs.
      assetsInlineLimit: 0,
      // A desktop app loads its bundle from disk; ECharts alone is ~500 kB.
      chunkSizeWarningLimit: 1500,
    },
  };
});
