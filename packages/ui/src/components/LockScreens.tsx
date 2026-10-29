import { useState, type FormEvent, type ReactNode } from "react";
import { errorMessage, passwordProblem, type LockStatus } from "@dojix-desktop/core";
import { Dialog } from "../feedback/Dialog";

/** Full-window frame for the lock, older-copy and setup screens (no sidebar, no journal). */
function Gate({
  productName,
  testId,
  title,
  children,
}: {
  productName: string;
  testId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="gate" data-testid={testId}>
      <section className="gate-card" aria-labelledby={`${testId}-title`}>
        <div className="wordmark gate-wordmark">
          <span className="wordmark-mark" aria-hidden="true" />
          <span className="wordmark-name">{productName}</span>
        </div>
        <h1 id={`${testId}-title`}>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, setMessage, run };
}

export interface EraseFormProps {
  productName: string;
  onErase: (confirmation: string) => Promise<unknown>;
  onCancel?: () => void;
}

/** "Erase all local data": the only way past a forgotten password (SPEC 6.6). */
export function EraseForm({ productName, onErase, onCancel }: EraseFormProps) {
  const [typed, setTyped] = useState("");
  const { busy, message, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => onErase(typed));
  };
  return (
    <form className="erase-form" onSubmit={submit} data-testid="erase-form">
      <p>
        There is no way to recover a forgotten password. Erasing deletes this computer&apos;s
        journal, snapshots, screenshots and every key {productName} stored, then starts an empty
        journal. A backup you exported can be restored afterwards.
      </p>
      <label className="field">
        <span>
          Type <strong>{productName}</strong> to confirm
        </span>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-testid="erase-confirm"
        />
      </label>
      {message && (
        <p className="form-error" role="alert" data-testid="erase-message">
          {message}
        </p>
      )}
      <div className="actions">
        {onCancel && (
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="button button-danger"
          disabled={busy || typed !== productName}
          data-testid="erase-submit"
        >
          Erase all local data
        </button>
      </div>
    </form>
  );
}

export interface LockScreenProps {
  productName: string;
  status: LockStatus;
  onUnlock: (password: string) => Promise<unknown>;
  onErase: (confirmation: string) => Promise<unknown>;
}

export function LockScreen({ productName, status, onUnlock, onErase }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [forgot, setForgot] = useState(false);
  const { busy, message, run } = useAction();
  const vaultUnreadable = status.phase === "locked" && status.vaultUnreadable;
  const held = status.phase === "locked" && status.held;
  const notice = message ?? status.throttle.message;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const entered = password;
    setPassword("");
    void run(() => onUnlock(entered));
  };

  return (
    <Gate productName={productName} testId="lock-screen" title={`${productName} is locked`}>
      {forgot ? (
        <EraseForm productName={productName} onErase={onErase} onCancel={() => setForgot(false)} />
      ) : (
        <form onSubmit={submit}>
          {vaultUnreadable && (
            <p className="form-warning" role="status">
              {productName} can&apos;t read the system keyring right now. Nothing was changed.
            </p>
          )}
          {held && (
            <p className="form-warning" role="status" data-testid="lock-held">
              Your latest changes couldn&apos;t be saved before locking. They are kept in memory and
              are saved again when you unlock.
            </p>
          )}
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              disabled={busy}
              data-testid="lock-password"
            />
          </label>
          {notice && (
            <p className="form-error" role="alert" data-testid="lock-message">
              {notice}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="button button-link"
              onClick={() => setForgot(true)}
              disabled={busy}
              data-testid="forgot-password"
            >
              Forgot password?
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy || password.length === 0}
              data-testid="lock-submit"
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </form>
      )}
    </Gate>
  );
}

export interface OlderCopyScreenProps {
  productName: string;
  status: LockStatus;
  onOpen: (password: string | null) => Promise<unknown>;
  onQuit: () => void;
  /** Formats a Unix time in ms for display. */
  formatTime?: (ms: number) => string;
}

const defaultFormat = (ms: number) => new Date(ms).toLocaleString();

/** The journal file is older than the last save this computer recorded (SPEC 6.5). */
export function OlderCopyScreen({
  productName,
  status,
  onOpen,
  onQuit,
  formatTime = defaultFormat,
}: OlderCopyScreenProps) {
  const [password, setPassword] = useState("");
  const [understood, setUnderstood] = useState(false);
  const { busy, message, run } = useAction();
  if (status.phase !== "olderCopy") return null;
  const needsPassword = status.needsPassword;
  const notice = message ?? (needsPassword ? status.throttle.message : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const entered = password;
    setPassword("");
    void run(() => onOpen(needsPassword ? entered : null));
  };

  return (
    <Gate productName={productName} testId="older-copy" title="This is an older copy of your journal">
      <p>
        The journal file on this computer was saved on{" "}
        <strong>{formatTime(status.fileSavedAtMs)}</strong>, but {productName} last saved a newer
        one on <strong>{formatTime(status.recordSavedAtMs)}</strong>. An older copy may have been
        put back, for example from a file backup.
      </p>
      <p className="muted">
        Opening it continues from this copy: changes made after it was saved are not in it.
        Nothing has been opened or changed yet.
      </p>
      <form onSubmit={submit}>
        {needsPassword ? (
          <label className="field">
            <span>App Lock password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              data-testid="older-password"
            />
          </label>
        ) : (
          <label className="check">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              data-testid="older-confirm"
            />
            <span>I understand: open this older copy</span>
          </label>
        )}
        {notice && (
          <p className="form-error" role="alert" data-testid="older-message">
            {notice}
          </p>
        )}
        <div className="actions">
          <button type="button" className="button" onClick={onQuit} disabled={busy}>
            Quit
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || (needsPassword ? password.length === 0 : !understood)}
            data-testid="older-open"
          >
            Open this copy
          </button>
        </div>
      </form>
    </Gate>
  );
}

export interface SetupPasswordScreenProps {
  productName: string;
  onSetup: (password: string, confirmation: string) => Promise<unknown>;
}

/** Linux without a Secret Service: App Lock is required from the start (SPEC 6.4). */
export function SetupPasswordScreen({ productName, onSetup }: SetupPasswordScreenProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { busy, message, setMessage, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password, confirmation);
    if (problem) {
      setMessage(problem);
      return;
    }
    void run(() => onSetup(password, confirmation));
  };
  return (
    <Gate productName={productName} testId="setup-screen" title="Choose an App Lock password">
      <p>
        No system keyring (Secret Service) was found on this computer, so {productName} keeps its
        encryption key in its data folder, locked with a password. App Lock is required, and the
        wrong-password limit and older-copy check are kept in the data folder too.
      </p>
      <p className="muted">
        There is no way to recover a forgotten password: keep a backup. Installing a keyring
        (for example GNOME Keyring or KWallet) does not change an existing journal.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          <span>Password (8 to 128 characters)</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            disabled={busy}
            data-testid="setup-password"
          />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            data-testid="setup-confirm"
          />
        </label>
        {message && (
          <p className="form-error" role="alert" data-testid="setup-message">
            {message}
          </p>
        )}
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy}
            data-testid="setup-submit"
          >
            Create encrypted journal
          </button>
        </div>
      </form>
    </Gate>
  );
}

export interface SaveIssueBannerProps {
  onRetry: () => Promise<unknown>;
}

/** The "Database issue" banner: a save failed, the change is only in memory (SPEC 6.3). */
export function SaveIssueBanner({ onRetry }: SaveIssueBannerProps) {
  const { busy, message, run } = useAction();
  return (
    <div className="banner banner-danger" role="alert" data-testid="save-issue">
      <span>
        Your latest change is kept in memory but could not be saved to disk. Check that the disk
        has space, then try again.
        {message && <> {message}</>}
      </span>
      <button type="button" className="button" disabled={busy} onClick={() => void run(onRetry)}>
        Try again
      </button>
    </div>
  );
}

export interface UnsavedQuitDialogProps {
  onRetry: () => Promise<unknown>;
  onQuitAnyway: () => void;
  onCancel: () => void;
}

/** Quitting with unsaved changes asks first: Try again / Quit anyway (SPEC 6.3). */
export function UnsavedQuitDialog({ onRetry, onQuitAnyway, onCancel }: UnsavedQuitDialogProps) {
  const { busy, message, run } = useAction();
  return (
    <Dialog
      open
      onClose={onCancel}
      role="alertdialog"
      title="Your latest changes are not saved"
      testId="unsaved-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button button-danger" onClick={onQuitAnyway}>
            Quit anyway
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => void run(onRetry)}
          >
            Try again
          </button>
        </>
      }
    >
      <p>
        The journal could not be saved to disk. If you quit now, changes since the last
        successful save are lost.
      </p>
      {message && (
        <p className="form-error" role="alert">
          {message}
        </p>
      )}
    </Dialog>
  );
}
