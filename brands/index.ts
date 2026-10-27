import type { BrandConfig, BrandId } from "@dojix-desktop/core";
import { dojix } from "./dojix/brand";
import { greenwick } from "./greenwick/brand";

export { dojix, greenwick };

export const ALL_BRANDS: Readonly<Record<BrandId, BrandConfig>> = { dojix, greenwick };
