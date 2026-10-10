/** Tabfold mark: tabs folding into a card. Same proportions as the PNG icons (scripts/make-icons.mjs). */
export function Logo({ size = 24 }: { size?: number }) {
  const glyph = Math.round(size * 0.62);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center bg-accent text-on-accent"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.22) }}
    >
      <svg width={glyph} height={glyph} viewBox="0 0.6 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="9" width="16" height="11" rx="2.5" />
        <path d="M7 5.5h10" />
        <path d="M9.5 2.5h5" />
      </svg>
    </span>
  );
}
