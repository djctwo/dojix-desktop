export interface StartupErrorProps {
  productName: string;
  message: string;
}

/** Shown instead of the journal when storage could not be opened safely. */
export function StartupError({ productName, message }: StartupErrorProps) {
  return (
    <section className="screen" role="alert" data-testid="startup-error" aria-labelledby="startup-error-title">
      <header className="screen-header">
        <h1 id="startup-error-title">{productName} could not open your journal</h1>
      </header>
      <div className="empty empty-error">
        <p>{message}</p>
        <p className="muted">Nothing was changed or deleted.</p>
      </div>
    </section>
  );
}
