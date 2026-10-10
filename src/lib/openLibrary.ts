import { browser } from 'wxt/browser';
import { extUrl } from './extUrl';

/** Focus the library tab if one is open (jumping to `hash`), otherwise open it. */
export async function openLibrary(hash = ''): Promise<void> {
  const base = extUrl('/library.html');
  const url = `${base}${hash}`;
  const existing = await browser.tabs.query({ url: `${base}*` });
  const tab = existing.find((t) => !t.incognito);
  if (tab?.id !== undefined) {
    await browser.tabs.update(tab.id, { active: true, ...(hash ? { url } : {}) });
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url });
}
