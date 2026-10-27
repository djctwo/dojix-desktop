export interface PlaceholderScreenProps {
  title: string;
}

/** Stand-in for screens that later phases build. */
export function PlaceholderScreen({ title }: PlaceholderScreenProps) {
  return (
    <section className="screen" aria-labelledby="screen-title">
      <header className="screen-header">
        <h1 id="screen-title" data-testid="screen-title">
          {title}
        </h1>
      </header>
      <div className="empty" data-testid="screen-placeholder">
        <h2>Not built yet</h2>
        <p>This screen arrives in a later build of the Windows and Linux edition.</p>
      </div>
    </section>
  );
}
