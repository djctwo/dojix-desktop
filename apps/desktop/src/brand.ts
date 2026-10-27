import { dojix } from "@dojix-desktop/brands/dojix";
import { greenwick } from "@dojix-desktop/brands/greenwick";
import { type BrandConfig, parseBrandId } from "@dojix-desktop/core";

// Fails loudly if the build was made without a valid --mode.
parseBrandId(import.meta.env.VITE_BRAND);

// VITE_BRAND is replaced with a literal at build time, so this comparison is constant-folded
// and the other brand's module is dropped from the bundle.
export const brand: BrandConfig = import.meta.env.VITE_BRAND === "greenwick" ? greenwick : dojix;
