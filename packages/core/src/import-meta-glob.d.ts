// The subset of Vite's `import.meta.glob` the tests use (Vitest runs on Vite). Declared here so
// the package keeps `"types": []` and needs neither Node nor Vite client typings.
interface ImportMeta {
  glob<T = unknown>(
    patterns: string | readonly string[],
    options: { eager: true; import?: string; query?: string },
  ): Record<string, T>;
}
