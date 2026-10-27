/**
 * Parity switch (SPEC §3.2, §10.4). `swift` reproduces the Mac apps, bugs included, and exists
 * only while Phase 2 proves parity; `fixed` applies the approved PARITY.md fixes and is what
 * the app ships.
 */
export type CompatMode = "swift" | "fixed";
