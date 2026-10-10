import { Check } from 'lucide-react';
import { create } from 'zustand';
import { Button } from './Button';
import { Dialog } from './Dialog';

/**
 * "What Pro adds", shown when a Free user clicks something marked Pro. v1 ships Free only, so this
 * explains rather than sells: nothing already saved is ever locked.
 */

const PRO_FEATURES = [
  'Sync across up to 5 devices, and automatic cloud backup',
  'Unlimited named sessions and tags',
  'Search filters by tag, date, domain, device and window',
  'Merge, split, dedupe and close-by-domain tools',
  'Rules: suspend or save automatically by site or time',
  'Version history for 30 days, and the last 20 snapshots',
  'Export as JSON, Markdown and CSV',
];

const useProInfo = create<{ feature: string | null; open: boolean; show: (feature?: string) => void; hide: () => void }>(
  (set) => ({
    feature: null,
    open: false,
    show: (feature) => set({ open: true, feature: feature ?? null }),
    hide: () => set({ open: false }),
  }),
);

/** Open the dialog, optionally naming the feature the user clicked (e.g. "Merging sessions"). */
export function showProInfo(feature?: string): void {
  useProInfo.getState().show(feature);
}

/** Mount once per page (popup, library). */
export function ProInfoHost() {
  const { open, feature, hide } = useProInfo();
  return (
    <Dialog
      open={open}
      onClose={hide}
      title="What Pro adds"
      width={440}
      footer={
        <Button variant="primary" onClick={hide} autoFocus>
          Got it
        </Button>
      }
    >
      {feature && <p className="font-semibold">{feature} comes with Pro.</p>}
      <p className="text-text-2">Free stays genuinely useful. Pro adds sync, backup and power tools for $5/month or $48/year.</p>
      <ul className="flex flex-col gap-1.5">
        {PRO_FEATURES.map((item) => (
          <li key={item} className="flex items-start gap-2 text-text-2">
            <Check size={16} aria-hidden className="mt-0.5 shrink-0 text-accent-text" />
            {item}
          </li>
        ))}
      </ul>
      <p className="text-meta text-text-3">
        Pro is coming soon. Everything you save on Free stays readable and exportable, whatever you choose.
      </p>
    </Dialog>
  );
}
