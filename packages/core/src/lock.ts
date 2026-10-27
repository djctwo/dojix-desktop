// App Lock, older-copy, backup and restore shapes exchanged with the Rust shell (SPEC 6).
// Pure types plus small helpers. No secret ever crosses IPC in this direction: the shell
// never returns a key or a password.

export interface ThrottleStatus {
  /** Wrong passwords since the last right one. */
  attempts: number;
  /** Seconds before another password may be checked (0 = none). */
  waitSeconds: number;
  /** The count or the wait can't be read: no password is checked (fail closed). */
  unreadable: boolean;
  message: string | null;
}

export type LockPhase =
  | { phase: "unlocked" }
  | { phase: "locked"; vaultUnreadable: boolean; held: boolean }
  | {
      phase: "olderCopy";
      fileSavedAtMs: number;
      fileGeneration: number;
      recordSavedAtMs: number;
      recordGeneration: number;
      needsPassword: boolean;
    }
  | { phase: "setup" }
  | { phase: "failed"; code: string; message: string };

export type LockStatus = LockPhase & {
  lockEnabled: boolean;
  /** App Lock can't be turned off (Linux without a Secret Service). */
  lockRequired: boolean;
  vaultBackend: string;
  throttle: ThrottleStatus;
  idleLockMinutes: number;
  saveFailing: boolean;
  setAside: boolean;
};

/** An error from the shell. `message` is written for the user. */
export interface OpError {
  code: string;
  message: string;
}

export type RotationOutcome = "complete" | "finishesOnNextUnlock";

export type BackupKind =
  | "desktop"
  | "plain"
  | "macDojix"
  | "macDojixLegacy"
  | "macGreenwick"
  | "macGreenwickLegacy"
  | "unknown";

export interface PickedBackup {
  fileName: string;
  kind: BackupKind;
  needsPassword: boolean;
}

export interface RestoreSummary {
  source: "desktop" | "macDojix" | "macGreenwick";
  trades: number;
  checkpoints: number;
  settings: number;
  notices: string[];
}

/** "Lock when idle" choices in minutes; 0 = Off. The default is 15. */
export const IDLE_CHOICES = [0, 1, 5, 15, 30, 60] as const;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * The password rule for App Lock and backups (8–128 Unicode scalars, confirmed). The shell
 * checks it again; this copy only gives instant feedback.
 */
export function passwordProblem(password: string, confirmation: string): string | null {
  const length = [...password].length;
  if (password.length === 0) return "Password cannot be empty.";
  if (password !== confirmation) return "Passwords do not match.";
  if (length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function isOpError(value: unknown): value is OpError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OpError).code === "string" &&
    typeof (value as OpError).message === "string"
  );
}

/** A message for any rejected IPC call. */
export function errorMessage(error: unknown): string {
  if (isOpError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | null {
  return isOpError(error) ? error.code : null;
}

/** "Off", "1 minute", "15 minutes". */
export function idleLabel(minutes: number): string {
  if (minutes === 0) return "Off";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function backupKindLabel(kind: BackupKind): string {
  switch (kind) {
    case "desktop":
      return "Password-protected backup";
    case "plain":
      return "Unencrypted backup";
    case "macDojix":
    case "macDojixLegacy":
      return "Dojix for Mac backup";
    case "macGreenwick":
    case "macGreenwickLegacy":
      return "Greenwick for Mac backup";
    case "unknown":
      return "Not a backup";
  }
}
