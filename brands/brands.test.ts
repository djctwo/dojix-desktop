import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_IDS, validateBrand } from "@dojix-desktop/core";
import { ALL_BRANDS } from "./index";

const tauriDir = fileURLToPath(new URL("../apps/desktop/src-tauri/", import.meta.url));

interface TauriOverlay {
  productName: string;
  mainBinaryName: string;
  identifier: string;
  app: { windows: { title: string; backgroundColor: string }[] };
  bundle: { icon: string[] };
}

function overlay(brand: string): TauriOverlay {
  return JSON.parse(readFileSync(`${tauriDir}tauri.${brand}.conf.json`, "utf8")) as TauriOverlay;
}

describe.each(BRAND_IDS)("brand %s", (id) => {
  const brand = ALL_BRANDS[id];

  it("is a valid brand config", () => {
    expect(validateBrand(brand)).toEqual([]);
    expect(brand.id).toBe(id);
  });

  it("matches its Tauri config overlay", () => {
    const conf = overlay(id);
    expect(conf.identifier).toBe(brand.identifier);
    expect(conf.productName).toBe(brand.productName);
    expect(conf.mainBinaryName).toBe(id);
    expect(conf.app.windows[0]?.title).toBe(brand.productName);
    expect(conf.app.windows[0]?.backgroundColor.toLowerCase()).toBe(brand.tokens.bgApp);
    expect(conf.bundle.icon.every((p) => p.includes(`/brands/${id}/icons/`))).toBe(true);
  });
});

describe("the two brands", () => {
  it("never share an identifier or accent", () => {
    expect(ALL_BRANDS.dojix.identifier).not.toBe(ALL_BRANDS.greenwick.identifier);
    expect(ALL_BRANDS.dojix.tokens.accent).toBe("#e8b44c");
    expect(ALL_BRANDS.dojix.tokens.bgApp).toBe("#0e0d0b");
    expect(ALL_BRANDS.greenwick.tokens.accent).toBe("#00d4aa");
  });

  it("use the right instrument vocabulary", () => {
    expect(ALL_BRANDS.dojix.instrument.qtyLabel).toBe("Lots");
    expect(ALL_BRANDS.greenwick.instrument.qtyLabel).toBe("Shares");
  });
});
