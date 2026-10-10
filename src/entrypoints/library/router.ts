import { useEffect, useState } from 'react';

/**
 * The full list's hash routes, shared with the popup's links: #/ the list, #/settings opens
 * Settings over it, #/how is "How Tabfold frees memory", #/import opens Import from OneTab over the
 * list. Anything unknown is the list.
 */
export type Route = 'list' | 'settings' | 'how' | 'import';

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  return path === 'settings' || path === 'how' || path === 'import' ? path : 'list';
}

export function hashOf(route: Route): string {
  return route === 'list' ? '#/' : `#/${route}`;
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
