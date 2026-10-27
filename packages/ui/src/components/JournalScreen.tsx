import type { BrandConfig, JournalRow } from "@dojix-desktop/core";

export interface JournalScreenProps {
  brand: BrandConfig;
  /** null while loading. */
  rows: JournalRow[] | null;
}

export function JournalScreen({ brand, rows }: JournalScreenProps) {
  return (
    <section className="screen" aria-labelledby="screen-title">
      <header className="screen-header">
        <h1 id="screen-title" data-testid="screen-title">
          Journal
        </h1>
      </header>
      {rows === null ? (
        <p className="muted" data-testid="journal-loading">
          Opening your journal…
        </p>
      ) : rows.length === 0 ? (
        <JournalEmpty brand={brand} />
      ) : (
        <table className="journal-table" data-testid="journal-table">
          <thead>
            <tr>
              <th scope="col">{brand.instrument.symbolNoun}</th>
              <th scope="col">Side</th>
              <th scope="col">Closed</th>
              <th scope="col" className="num">
                Net P&amp;L
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.symbol}</td>
                <td>{row.direction}</td>
                <td>{row.closeTime}</td>
                <td className="num">{row.netProfit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function JournalEmpty({ brand }: { brand: BrandConfig }) {
  return (
    <div className="empty" data-testid="journal-empty">
      <svg className="empty-icon" viewBox="0 0 48 48" aria-hidden="true">
        <rect x="9" y="7" width="30" height="34" rx="4" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M16 17h16M16 24h16M16 31h9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <h2>No trades yet</h2>
      <p>
        Your {brand.productName} journal is ready and encrypted on this computer. Trades you import
        will appear here.
      </p>
    </div>
  );
}
