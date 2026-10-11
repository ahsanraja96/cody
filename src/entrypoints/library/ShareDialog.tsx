import { useEffect, useId, useState } from 'react';
import { Copy, Link, LoaderCircle, X } from 'lucide-react';
import { send } from '@/lib/messages';
import type { FolderRecord } from '@/lib/types';
import { Switch } from '@/ui/components/Controls';
import { Modal } from '@/ui/components/Modal';
import { toast, ToastViewport } from '@/ui/components/Toast';
import { copyText } from '@/ui/hooks';
import { handleCommandError } from './folderActions';
import { count } from './format';

type Info = { url: string; views: number; live: boolean };

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * "Share “Client sites”" (Mx-Share, Pro): a public link to the folder's pages. Nothing is shared
 * until "Create link"; then Copy link, "Keep it up to date", how many times it was viewed, and
 * Stop sharing.
 */
export function ShareDialog({ folder, pages, onClose }: { folder: FolderRecord; pages: number; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(!!folder.shareId);
  const [live, setLive] = useState(folder.shareLive ?? true);
  const [busy, setBusy] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!folder.shareId) return;
    let alive = true;
    send({ type: 'share-info', folderId: folder.id })
      .then((result) => {
        if (!alive) return;
        setInfo(result);
        if (result) setLive(result.live);
      })
      .catch((error) => alive && handleCommandError(error))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [folder.id, folder.shareId]);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    try {
      await task();
    } catch (error) {
      handleCommandError(error);
    } finally {
      setBusy(null);
    }
  };

  const create = () =>
    run('create', async () => {
      const { url } = await send({ type: 'share-create', folderId: folder.id, live });
      setInfo({ url, views: 0, live });
      const ok = await copyText(url);
      toast(ok ? 'Link created and copied' : 'Link created', { tone: 'success' });
    });

  const toggleLive = (on: boolean) => {
    setLive(on);
    if (!info) return;
    void run('live', async () => setInfo(await send({ type: 'share-update', folderId: folder.id, live: on })));
  };

  const stop = () =>
    run('stop', async () => {
      await send({ type: 'share-stop', folderId: folder.id });
      onClose();
      toast(`Stopped sharing “${folder.name}”. The link no longer works.`);
    });

  const privacy = `Anyone with the link sees ${pages === 1 ? 'this page’s title and address' : `these ${pages.toLocaleString()} pages’ titles and addresses`}. They can’t change your folder, and nothing else of yours is shared.`;

  return (
    <Modal open onClose={onClose} labelledBy={titleId} width={400} toasts>
      <div className="flex flex-col gap-3.5 px-[22px] pt-5 pb-5">
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="m-0 min-w-0 flex-1 text-[17px] font-semibold">
            Share “{folder.name}”
          </h2>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="-mt-1 -mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-2 hover:bg-hover hover:text-text"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        {loading ? (
          <p role="status" className="m-0 flex items-center gap-2 text-small text-text-3">
            <LoaderCircle size={14} aria-hidden className="tf-spin" />
            Getting the link…
          </p>
        ) : (
          info && (
            <div className="flex gap-2">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-border-strong bg-surface px-2.5 font-mono text-small">
                <Link size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-text-3" />
                <input
                  readOnly
                  aria-label="Share link"
                  value={shortUrl(info.url)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-text outline-none"
                />
              </div>
              <button
                type="button"
                data-autofocus
                onClick={async () => {
                  const ok = await copyText(info.url);
                  toast(ok ? 'Link copied' : 'Couldn’t copy the link. Select it and copy it instead.', ok ? { tone: 'success' } : { tone: 'error' });
                }}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control bg-accent px-3.5 font-semibold text-on-accent hover:bg-accent-hover"
              >
                <Copy size={15} strokeWidth={1.75} aria-hidden />
                Copy link
              </button>
            </div>
          )
        )}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Keep it up to date</div>
            <div className="text-small text-text-3">The page changes when the folder does. Off: it stays as it is now.</div>
          </div>
          <Switch checked={live} onChange={toggleLive} disabled={busy === 'live'} label="Keep it up to date" />
        </div>
        <p className="m-0 text-small text-text-2">{privacy}</p>
        {info ? (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <button type="button" disabled={busy !== null} onClick={() => void stop()} className="text-small font-semibold text-red hover:underline disabled:opacity-60">
              Stop sharing
            </button>
            <span className="text-small text-text-3">{info.views > 0 ? `Viewed ${count(info.views, 'time')}` : 'Not viewed yet'}</span>
          </div>
        ) : (
          !loading && (
            <div className="flex justify-end gap-2 border-t border-border pt-3.5">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-8 items-center rounded-control border border-border-strong bg-surface px-3.5 text-text hover:bg-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                data-autofocus
                disabled={busy !== null || pages === 0}
                onClick={() => void create()}
                className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3.5 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {busy === 'create' ? <LoaderCircle size={14} aria-hidden className="tf-spin" /> : <Link size={14} strokeWidth={1.75} aria-hidden />}
                Create link
              </button>
            </div>
          )
        )}
      </div>
      <ToastViewport inDialog />
    </Modal>
  );
}
