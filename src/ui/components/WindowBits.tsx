import { AppWindow, HatGlasses } from 'lucide-react';
import { displayHost } from '@/lib/urls';
import { tabUrl, type WindowInfo } from '@/ui/windows';
import { Favicon } from './Favicon';

/** The first few sites open in a window, as small icons. */
export function SiteStrip({ tabs, max = 3, size = 14 }: { tabs: WindowInfo['tabs']; max?: number; size?: number }) {
  const urls: string[] = [];
  const hosts = new Set<string>();
  for (const tab of tabs) {
    const url = tabUrl(tab);
    const host = displayHost(url);
    if (!host || hosts.has(host)) continue;
    hosts.add(host);
    urls.push(url);
    if (urls.length >= max) break;
  }
  return (
    <span aria-hidden="true" className="flex flex-none gap-[3px]">
      {urls.map((url) => (
        <Favicon key={url} url={url} size={size} />
      ))}
    </span>
  );
}

export function WindowIcon({ info, size = 16, className }: { info: WindowInfo; size?: number; className?: string }) {
  const Icon = info.incognito ? HatGlasses : AppWindow;
  return <Icon size={size} strokeWidth={1.75} aria-hidden className={className} />;
}
