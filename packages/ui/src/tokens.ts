import { type BrandConfig, type BrandTokens, tokenVar } from "@dojix-desktop/core";

/** Writes a brand's colour tokens onto an element as CSS custom properties. */
export function applyBrandTokens(brand: BrandConfig, root: HTMLElement): void {
  for (const name of Object.keys(brand.tokens) as (keyof BrandTokens)[]) {
    root.style.setProperty(tokenVar(name), brand.tokens[name]);
  }
  root.dataset["brand"] = brand.id;
}
