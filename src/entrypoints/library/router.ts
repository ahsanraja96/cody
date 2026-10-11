import { useEffect, useState } from 'react';

/**
 * The full list's hash routes, shared with the popup's links: #/ the list, #/settings opens
 * Settings over it, #/how is "How Tabfold frees memory", #/import opens Import from OneTab over the
 * list, #/pro is the plans page (Pro-Plans), #/pro/welcome the page a Stripe checkout tab turns
 * into after paying (Stripe-Welcome), #/room opens "Make room" over the list (the popup's full
 * card links there). Anything unknown is the list.
 */
export type Route = 'list' | 'settings' | 'how' | 'import' | 'pro' | 'welcome' | 'room';

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0]!.split('/');
  const path = parts[0];
  if (path === 'pro' && parts[1] === 'welcome') return 'welcome';
  return path === 'settings' || path === 'how' || path === 'import' || path === 'pro' || path === 'room' ? path : 'list';
}

export function hashOf(route: Route): string {
  return route === 'list' ? '#/' : route === 'welcome' ? '#/pro/welcome' : `#/${route}`;
}

/** Closing a dialog replaces its entry, so Back doesn't reopen it. */
export function useRoute(): [Route, (route: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('popstate', onHash);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('popstate', onHash);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const navigate = (next: Route, options: { replace?: boolean } = {}) => {
    if (options.replace) history.replaceState(null, '', hashOf(next));
    else if (next !== parseHash(location.hash)) history.pushState(null, '', hashOf(next));
    setRoute(next);
  };
  return [route, navigate];
}

/** Go to the plans page from anywhere in the full list (Settings, menus, notices). */
export function goToPlans(): void {
  if (parseHash(location.hash) !== 'pro') location.hash = hashOf('pro');
}
