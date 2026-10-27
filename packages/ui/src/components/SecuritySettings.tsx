import { useState, type FormEvent } from "react";
import {
  backupKindLabel,
  errorCode,
  errorMessage,
  idleLabel,
  IDLE_CHOICES,
  passwordProblem,
  type LockStatus,
  type PickedBackup,
  type RestoreSummary,
  type RotationOutcome,
} from "@dojix-desktop/core";
import { EraseForm } from "./LockScreens";

export interface SecurityActions {
  enableLock(password: string, confirmation: string): Promise<RotationOutcome>;
  changePassword(current: string, password: string, confirmation: string): Promise<RotationOutcome>;
  disableLock(password: string): Promise<LockStatus>;
  lockNow(): Promise<unknown>;
  setIdleMinutes(minutes: number): Promise<void>;
  exportBackup(password: string | null, confirmation: string | null): Promise<string | null>;
  pickBackup(): Promise<PickedBackup | null>;
  restoreBackup(password: string | null): Promise<RestoreSummary>;
  eraseAll(confirmation: string): Promise<LockStatus>;
}

export interface SecuritySettingsProps {
  productName: string;
  status: LockStatus;
  actions: SecurityActions;
  /** Called after anything that changes the lock status, so the app can refresh it. */
  onChanged: () => void;
}

type Mode = "idle" | "enable" | "change" | "disable";

const rotationNote = (outcome: RotationOutcome) =>
  outcome === "complete"
    ? null
    : "The new password is in force. Some files are still being re-encrypted; that finishes at the next unlock.";

/** Settings → Security & Data: App Lock, idle lock, backups, erase (SPEC 2.6). */
export function SecuritySettings({ productName, status, actions, onChanged }: SecuritySettingsProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reset = () => {
    setMode("idle");
    setCurrent("");
    setPassword("");
    setConfirmation("");
    setMessage(null);
  };

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    setNote(null);
    try {
      const done = await action();
      reset();
      setNote(done);
      onChanged();
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "enable" || mode === "change") {
      const problem = passwordProblem(password, confirmation);
      if (problem) {
        setMessage(problem);
        return;
      }
    }
    if (mode === "enable") {
      void run(async () => rotationNote(await actions.enableLock(password, confirmation)) ?? "App Lock is on.");
    } else if (mode === "change") {
      void run(
        async () =>
          rotationNote(await actions.changePassword(current, password, confirmation)) ??
          "Password changed.",
      );
    } else if (mode === "disable") {
      void run(async () => {
        await actions.disableLock(current);
        return "App Lock is off.";
      });
    }
  };

  return (
    <section className="screen" aria-labelledby="screen-title" data-testid="settings-security">
      <header className="screen-header">
        <h1 id="screen-title" data-testid="screen-title">
          Settings
        </h1>
      </header>

      <div className="card">
        <h2>App Lock</h2>
        <p className="muted">
          {status.lockEnabled
            ? `On. Your journal's key is stored only wrapped with your password, so ${productName} asks for it at launch and after locking.`
            : `Off. Your journal is encrypted, but anyone signed in to this computer as you can open ${productName}.`}
        </p>
        {status.lockRequired && (
          <p className="muted" data-testid="lock-required">
            No system keyring was found, so App Lock can&apos;t be turned off. The wrong-password
            limit and the older-copy check are kept in the data folder.
          </p>
        )}
        {note && (
          <p className="form-note" role="status" data-testid="security-note">
            {note}
          </p>
        )}
        {mode === "idle" ? (
          <div className="actions actions-start">
            {status.lockEnabled ? (
              <>
                <button type="button" className="button" onClick={() => setMode("change")}>
                  Change password
                </button>
                {!status.lockRequired && (
                  <button type="button" className="button" onClick={() => setMode("disable")}>
                    Turn off
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  onClick={() => void actions.lockNow()}
                  data-testid="lock-now"
                >
                  Lock now
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button button-primary"
                onClick={() => setMode("enable")}
                data-testid="enable-lock"
              >
                Turn on App Lock
              </button>
            )}
          </div>
        ) : (
          <form onSubmit={submit} className="stack" data-testid={`lock-form-${mode}`}>
            {(mode === "change" || mode === "disable") && (
              <label className="field">
                <span>Current password</span>
                <input
                  type="password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  autoComplete="current-password"
                  disabled={busy}
                />
              </label>
            )}
            {(mode === "enable" || mode === "change") && (
              <>
                <label className="field">
                  <span>New password (8 to 128 characters)</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  <span>Confirm new password</span>
                  <input
                    type="password"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </label>
                <p className="muted">There is no way to recover a forgotten password. Keep a backup.</p>
              </>
            )}
            {message && (
              <p className="form-error" role="alert" data-testid="security-message">
                {message}
              </p>
            )}
            <div className="actions actions-start">
              <button type="button" className="button" onClick={reset} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="button button-primary" disabled={busy}>
                {mode === "enable" ? "Turn on" : mode === "change" ? "Change password" : "Turn off"}
              </button>
            </div>
          </form>
        )}

        <label className="field field-inline">
          <span>Lock when idle</span>
          <select
            value={status.idleLockMinutes}
            disabled={!status.lockEnabled}
            onChange={(e) => {
              void actions.setIdleMinutes(Number(e.target.value)).then(onChanged, (err: unknown) =>
                setMessage(errorMessage(err)),
              );
            }}
            data-testid="idle-select"
          >
            {IDLE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {idleLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {productName} also locks when you lock the computer, put it to sleep, switch user or
          minimize the window.
        </p>
      </div>

      <BackupCard productName={productName} status={status} actions={actions} onChanged={onChanged} />

      <div className="card">
        <h2>Erase all local data</h2>
        <EraseForm productName={productName} onErase={actions.eraseAll} />
      </div>
    </section>
  );
}

function BackupCard({ productName, status, actions, onChanged }: SecuritySettingsProps) {
  const [protect, setProtect] = useState(status.lockEnabled);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [picked, setPicked] = useState<PickedBackup | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);

  const exportBackup = async () => {
    setMessage(null);
    if (protect) {
      const problem = passwordProblem(password, confirmation);
      if (problem) {
        setMessage(problem);
        return;
      }
    }
    setBusy(true);
    try {
      const name = await actions.exportBackup(protect ? password : null, protect ? confirmation : null);
      if (name) {
        setPassword("");
        setConfirmation("");
        setMessage(`Saved ${name}${protect ? "" : " (not encrypted)"}.`);
      }
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    setMessage(null);
    setSummary(null);
    try {
      setPicked(await actions.pickBackup());
    } catch (err) {
      setMessage(errorMessage(err));
    }
  };

  const restore = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await actions.restoreBackup(picked?.needsPassword ? restorePassword : null);
      setSummary(result);
      setPicked(null);
      setRestorePassword("");
      onChanged();
    } catch (err) {
      setMessage(
        errorCode(err) === "password_required"
          ? "This backup is protected with a password. Enter it to restore."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="backup-card">
      <h2>Backups</h2>
      <p className="muted">
        A backup holds every trade, note and setting, but not screenshots. Restoring replaces
        the journal with the backup after every row is checked; a backup is never copied over
        the journal.
      </p>
      <label className="check">
        <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
        <span>Protect the backup with a password (recommended)</span>
      </label>
      {protect ? (
        <div className="row">
          <input
            type="password"
            placeholder="Backup password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="Confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="new-password"
          />
        </div>
      ) : (
        <p className="form-warning">
          Without a password the backup file is an unencrypted copy of your journal. Anyone who
          gets the file can read it.
        </p>
      )}
      <div className="actions actions-start">
        <button type="button" className="button" disabled={busy} onClick={() => void exportBackup()}>
          Export backup…
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void choose()}>
          Restore backup…
        </button>
      </div>
      {picked && (
        <div className="stack" data-testid="restore-picked">
          <p>
            <strong>{picked.fileName}</strong> — {backupKindLabel(picked.kind)}. Restoring replaces
            the trades in your {productName} journal.
          </p>
          {picked.needsPassword && (
            <input
              type="password"
              placeholder="Backup password"
              value={restorePassword}
              onChange={(e) => setRestorePassword(e.target.value)}
              autoComplete="off"
            />
          )}
          <div className="actions actions-start">
            <button type="button" className="button" onClick={() => setPicked(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="button button-primary" onClick={() => void restore()} disabled={busy}>
              Restore
            </button>
          </div>
        </div>
      )}
      {summary && (
        <div className="form-note" role="status" data-testid="restore-summary">
          <p>
            Restored {summary.trades} trade{summary.trades === 1 ? "" : "s"}
            {summary.checkpoints > 0 ? `, ${summary.checkpoints} checkpoint(s)` : ""}.
          </p>
          {summary.notices.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
        </div>
      )}
      {message && (
        <p className="form-error" role="alert" data-testid="backup-message">
          {message}
        </p>
      )}
    </div>
  );
}
