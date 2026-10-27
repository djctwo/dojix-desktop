// Screenshot file-name rules of both Macs (only "<UUID>.jpg" names the apps create are valid).

import { macTagList, swiftCount } from "@dojix-desktop/core";

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** `Trade.screenshotList`: the comma list split, trimmed, empty names dropped (same rule as tags). */
export function screenshotList(raw: string): string[] {
  return macTagList(raw);
}

/** Dojix `ScreenshotManager.isValidFilename` (Components/TradeScreenshots.swift:57-62). */
export function isValidDojixScreenshotName(name: string): boolean {
  if (swiftCount(name) !== 40 || !name.endsWith(".jpg")) return false;
  return UUID_RE.test(name.slice(0, -4));
}

/** Greenwick `ScreenshotManager.isValidFilename` (Services/Screenshots/ScreenshotManager.swift:62-65). */
export function isValidGreenwickScreenshotName(name: string): boolean {
  if (swiftCount(name) !== 40 || !name.toLowerCase().endsWith(".jpg")) return false;
  return UUID_RE.test(name.slice(0, -4));
}
