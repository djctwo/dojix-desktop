// WCAG 2.x contrast for the design tokens (used by the token tests and available to screens
// that compute colours). Accepts #rrggbb and rgba(r, g, b, a); translucent colours are
// composited over the given background first.

type Rgb = readonly [number, number, number];

function parse(color: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color.trim());
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`unsupported colour ${color}`);
}

/** Composites `color` over the opaque `background`. */
export function composite(color: string, background: string): Rgb {
  const fg = parse(color);
  const bg = parse(background).rgb;
  const a = fg.alpha;
  return [0, 1, 2].map((i) => Math.round((fg.rgb[i] as number) * a + (bg[i] as number) * (1 - a))) as unknown as Rgb;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** Contrast ratio of `foreground` on the opaque `background` (1 … 21). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(composite(foreground, background));
  const b = relativeLuminance(parse(background).rgb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
