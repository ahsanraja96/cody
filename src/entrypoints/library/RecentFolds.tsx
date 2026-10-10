import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Copy, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { send, type RestoreFailure } from '@/lib/messages';
import type { SessionRecord } from '@/lib/types';
import { toast } from '@/ui/components/Toast';
import { copyText, currentScreen, useActiveRestore } from '@/ui/hooks';
import { errorText } from './actions';
import { count, foldTime } from './format';

type Result =
  | { kind: 'partial'; sessionId: string; opened: number; total: number; failed: RestoreFailure[] }
  | { kind: 'already'; sessionId: string; windowIds: number[]; openTabs: number; totalTabs: number };

const SECONDARY_SM =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-small font-semibold text-text hover:bg-hover disabled:cursor-default disabled:text-text-3';

const CHROME_PAGE = /^(chrome|edge|about|chrome-extension):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

function failureText(failed: RestoreFailure[]): string {
  const files = failed.filter((f) => f.reason === 'file-access' || (!f.reason && /^file:/i.test(f.url))).length;
  const blocked = failed.filter((f) => f.reason === 'blocked');
  const other = failed.length - files - blocked.length;
  const parts: string[] = [];
  if (blocked.length) {
    const chrome = blocked.every((f) => CHROME_PAGE.test(f.url));
    const noun = chrome ? 'Chrome page' : 'page';
    parts.push(`${count(blocked.length, noun)} can’t be opened by extensions`);
  }
  if (files) parts.push(`${count(files, 'local file')} need file access, which is off for Tabfold`);
  if (other) parts.push(`${count(other, 'page')} didn’t open`);
  return parts.join(' · ');
}

/**
 * "Recent folds" (Min-List): the last three folds, each with Reopen, which brings the fold back as
 * its original windows (lazily: tabs load when you click them). Pages Chrome won't let extensions
 * open and folds that are already open get one small line under the strip (Min-States).
 */
export function RecentFolds({ folds }: { folds: SessionRecord[] }) {
  const active = useActiveRestore();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const reopen = async (fold: SessionRecord, force = false) => {
    setBusy(fold.id);
    setResult(null);
    try {
      const current = await browser.windows.getCurrent().catch(() => undefined);
      const outcome = await send({
        type: 'restore',
        sessionId: fold.id,
        mode: 'original',
        currentWindowId: current?.id,
        screen: currentScreen(),
        force,
        background: true,
      });
      if (outcome.alreadyOpen || outcome.alreadyOpenWindowId !== undefined) {
        setResult({
          kind: 'already',
          sessionId: fold.id,
          windowIds: outcome.alreadyOpen?.windowIds ?? (outcome.alreadyOpenWindowId !== undefined ? [outcome.alreadyOpenWindowId] : []),
          openTabs: outcome.alreadyOpen?.openTabs ?? fold.tabCount,
          totalTabs: outcome.alreadyOpen?.totalTabs ?? fold.tabCount,
        });
      } else if (outcome.failed.length > 0) {
        setResult({ kind: 'partial', sessionId: fold.id, opened: outcome.opened, total: outcome.opened + outcome.failed.length, failed: outcome.failed });
      } else if (outcome.cancelled) {
        toast(`Stopped. ${count(outcome.opened, 'tab')} reopened, the rest are still in your list.`);
      } else {
        toast(`Reopened ${count(outcome.opened, 'tab')}${fold.windowCount > 1 ? ` in ${fold.windowCount} windows` : ''}.`);
      }
    } catch (error) {
      toast(errorText(error), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const showWindows = async (windowIds: number[]) => {
    for (const id of windowIds.slice(0, 1)) await browser.windows.update(id, { focused: true }).catch(() => undefined);
  };

  if (folds.length === 0) return null;
  const resultFold = result ? folds.find((f) => f.id === result.sessionId) : undefined;

  return (
    <section aria-labelledby="rf-h">
      <div className="mb-3 flex items-baseline justify-between gap-4 px-0.5">
        <h2 id="rf-h" className="label-caps m-0">
          Recent folds
        </h2>
        <span className="text-small text-text-3 max-[560px]:hidden">Reopen brings back the original windows</span>
      </div>
      <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
        {folds.map((fold) => {
          const running = active?.sessionId === fold.id ? active : undefined;
          const working = busy === fold.id || !!running;
          return (
            <div key={fold.id} className="flex items-center gap-3 rounded-card border border-border bg-surface py-3 pr-3 pl-4">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{foldTime(fold.createdAt)}</div>
                <div className="truncate text-small text-text-3">
                  {count(fold.tabCount, 'tab')} · {count(fold.windowCount, 'window')}
                </div>
              </div>
              <button
                type="button"
                title="Reopens these tabs as the original windows"
                aria-label={`Reopen the fold from ${foldTime(fold.createdAt)}, ${count(fold.tabCount, 'tab')} in ${count(fold.windowCount, 'window')}`}
                disabled={working}
                onClick={() => void reopen(fold)}
                className={SECONDARY_SM}
              >
                {working && <LoaderCircle size={14} aria-hidden className="tf-spin" />}
                {running && running.total > 0 ? `${running.done} of ${running.total}` : 'Reopen'}
              </button>
            </div>
          );
        })}
      </div>

      {result?.kind === 'partial' && (
        <div role="status" className="mt-3 flex items-start gap-2.5 rounded-card border border-amber-line bg-amber-soft py-3 pr-3 pl-3.5">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-amber" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              Reopened {result.opened} of {result.total}
            </div>
            <div className="text-small text-text-2">{failureText(result.failed)}</div>
          </div>
          <button
            type="button"
            className={SECONDARY_SM}
            onClick={async () => {
              const ok = await copyText(result.failed.map((f) => f.url).join('\n'));
              toast(ok ? 'Links copied. Paste them into the address bar.' : 'Couldn’t copy the links.', ok ? {} : { tone: 'error' });
            }}
          >
            <Copy size={14} strokeWidth={1.75} aria-hidden className="text-text-2" />
            Copy links
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setResult(null)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}

      {result?.kind === 'already' && resultFold && (
        <div role="status" className="mt-3 flex items-center gap-2.5 rounded-card border border-border bg-bg-subtle py-2 pr-1.5 pl-3.5">
          <Info size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-2" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold">Already open.</span>{' '}
            <span className="text-text-2">
              {result.openTabs === result.totalTabs
                ? `The tabs from ${foldTime(resultFold.createdAt)} are open in ${result.windowIds.length > 1 ? 'other windows' : 'another window'}.`
                : `${result.openTabs} of ${result.totalTabs} tabs from ${foldTime(resultFold.createdAt)} are open.`}
            </span>
          </div>
          {result.windowIds.length > 0 && (
            <button type="button" className={SECONDARY_SM} onClick={() => void showWindows(result.windowIds)}>
              Show {result.windowIds.length > 1 ? 'them' : 'it'}
            </button>
          )}
          <button type="button" className={SECONDARY_SM} onClick={() => void reopen(resultFold, true)}>
            Reopen anyway
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setResult(null)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}
    </section>
  );
}
