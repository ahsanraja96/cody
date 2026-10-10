import { browser, type Browser } from 'wxt/browser';
import type { GroupLike } from '../capture';
import { groupsUnavailable } from '../state';

export function ownOrigin(): string {
  return browser.runtime.getURL('/');
}

/** Every normal window with its tabs. Incognito windows are filtered later by the capture rules. */
export async function getNormalWindows(): Promise<Browser.windows.Window[]> {
  return browser.windows.getAll({ populate: true, windowTypes: ['normal'] });
}

/** Last known value of the groupsUnavailable flag in this worker's life, so it is written only when it changes. */
let groupsBlocked: boolean | undefined;

async function noteGroupsAvailable(available: boolean): Promise<void> {
  try {
    groupsBlocked ??= await groupsUnavailable.get();
    if (groupsBlocked === !available) return;
    groupsBlocked = !available;
    await groupsUnavailable.set(!available);
  } catch {
    // The flag only drives a notice.
  }
}

export async function getGroups(): Promise<Map<number, GroupLike>> {
  let groups: Browser.tabGroups.TabGroup[];
  try {
    groups = await browser.tabGroups.query({});
  } catch {
    // Enterprise policy or older browsers without tab groups: tabs are saved without their groups.
    await noteGroupsAvailable(false);
    return new Map();
  }
  await noteGroupsAvailable(true);
  return new Map(groups.map((g) => [g.id, { id: g.id, title: g.title, color: g.color, collapsed: g.collapsed }]));
}

/** For tests: forget the cached flag. */
export function resetGroupsFlagCache(): void {
  groupsBlocked = undefined;
}

/**
 * The window the user is working in (popups and devtools windows don't count): a normal one, or
 * with `incognito` an Incognito one. Tabs never cross between the two.
 */
export async function currentNormalWindowId(incognito = false): Promise<number | undefined> {
  try {
    const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    if (window.id !== undefined && window.incognito === incognito) return window.id;
  } catch {
    // No window focused yet.
  }
  const all = await browser.windows.getAll({ windowTypes: ['normal'] });
  return all.find((w) => w.incognito === incognito)?.id;
}

/** True for an open normal window of that mode (normal by default, Incognito with `incognito`). */
export async function windowExists(windowId: number | undefined, incognito = false): Promise<boolean> {
  if (windowId === undefined) return false;
  try {
    const window = await browser.windows.get(windowId);
    return window.type === 'normal' && window.incognito === incognito;
  } catch {
    return false;
  }
}

/** "Allow in Incognito" is on for Tabfold in chrome://extensions. */
export async function incognitoAllowed(): Promise<boolean> {
  try {
    return await browser.extension.isAllowedIncognitoAccess();
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tell open extension pages about progress. No page listening is fine. */
export function broadcast(event: unknown): void {
  browser.runtime.sendMessage({ __tabfoldEvent: true, event }).catch(() => undefined);
}

export async function setAttentionBadge(on: boolean): Promise<void> {
  try {
    await browser.action.setBadgeText({ text: on ? '1' : '' });
    if (on) await browser.action.setBadgeBackgroundColor({ color: '#9A5A06' });
  } catch {
    // Badge is cosmetic.
  }
}
