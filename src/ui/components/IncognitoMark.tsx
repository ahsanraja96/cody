import { HatGlasses } from 'lucide-react';

/** A tab folded from Incognito: it stays on this computer and reopens only in Incognito. */
export function IncognitoMark({ size = 14 }: { size?: number }) {
  return (
    <span
      role="img"
      aria-label="Incognito"
      title="Folded from Incognito. Reopens in Incognito and stays on this computer."
      className="inline-flex flex-none text-text-3"
    >
      <HatGlasses size={size} strokeWidth={1.75} aria-hidden />
    </span>
  );
}
