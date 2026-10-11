import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { category, type SiteKinds } from '@/lib/categories';
import { send } from '@/lib/messages';
import { Favicon } from '@/ui/components/Favicon';
import { ColorDot } from '@/ui/components/FolderIcon';
import { handleCommandError, putSiteBack, undoToast } from './folderActions';
import { count } from './format';

/**
 * Settings › Your tabs › "Sites you moved" (Up-Move-States): each site moved to another kind,
 * with Put back, and Put all back. Moves follow the person to their other computers.
 */
export function SitesYouMoved({ siteKinds }: { siteKinds: SiteKinds }) {
  const [busy, setBusy] = useState(false);
  const sites = Object.entries(siteKinds).sort((a, b) => b[1].at - a[1].at);
  if (sites.length === 0) return null;

  const putAllBack = async () => {
    setBusy(true);
    const ids: Array<string | null> = [];
    try {
      for (const [host] of sites) ids.push((await send({ type: 'site-kind-set', host, kind: null })).actionId);
      undoToast(`Put ${count(ids.length, 'site')} back`, ids);
    } catch (error) {
      if (ids.length) undoToast(`Put ${count(ids.length, 'site')} back`, ids);
      handleCommandError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-card border border-border bg-surface px-3.5 pt-3 pb-1">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">Sites you moved</div>
          <div className="text-small text-text-3">Their tabs go to the group you chose, on every computer.</div>
        </div>
        {sites.length > 1 && (
          <button type="button" disabled={busy} onClick={() => void putAllBack()} className="shrink-0 text-small font-semibold whitespace-nowrap text-accent-text hover:underline">
            Put all back
          </button>
        )}
      </div>
      <ul className="m-0 list-none p-0">
        {sites.map(([host, { kind }]) => {
          const c = category(kind);
          return (
            <li key={host} className="flex h-10 items-center gap-2.5 border-t border-border px-1">
              <Favicon url={`https://${host}/`} size={16} />
              <span className="min-w-0 flex-1 truncate">{host}</span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-text-2">
                <ArrowRight size={14} strokeWidth={1.75} aria-hidden className="text-text-3" />
                <ColorDot color={c.color} size={8} />
                {c.name}
              </span>
              <button
                type="button"
                aria-label={`Put ${host} back`}
                onClick={() => void putSiteBack(host)}
                className="ml-3 inline-flex h-7 shrink-0 items-center rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover"
              >
                Put back
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
