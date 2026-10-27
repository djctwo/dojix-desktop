import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BRANDS = ["dojix", "greenwick"];

// The brand is chosen at build time with `vite build --mode <brand>` (see .env.<brand>).
export default defineConfig(({ mode }) => {
  if (mode !== "test" && !BRANDS.includes(mode)) {
    throw new Error(`Build with --mode dojix or --mode greenwick (got "${mode}")`);
  }
  return {
    plugins: [react()],
    clearScreen: false,
    server: { port: 5173, strictPort: true },
    build: {
      target: ["es2022", "chrome120", "safari16"],
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
