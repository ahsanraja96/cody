import { useEffect, useState } from 'react';

export type LibraryView = 'all' | 'pinned' | 'recent' | 'tag' | 'snapshots' | 'trash' | 'settings' | 'search';

export interface Route {
  view: LibraryView;
  tag?: string;
  query?: string;
  sessionId?: string;
  section?: string;
}

/**
 * Hash routes: #/all, #/pinned, #/recent, #/tag/<tag>, #/snapshots, #/trash, #/settings[/<section>],
 * #/search/<query>, #/session/<id>. Any view can carry ?session=<id> for the open detail panel.
 */
export function parseHash(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').map((p) => decodeURIComponent(p));
  const sessionId = new URLSearchParams(search).get('session') ?? undefined;
  switch (parts[0]) {
    case 'pinned':
    case 'recent':
    case 'snapshots':
    case 'trash':
      return { view: parts[0], sessionId };
    case 'settings':
      return { view: 'settings', section: parts[1] };
    case 'tag':
      return parts[1] ? { view: 'tag', tag: parts[1], sessionId } : { view: 'all', sessionId };
    case 'search':
      return { view: 'search', query: parts.slice(1).join('/'), sessionId };
    case 'session':
      return { view: 'all', sessionId: parts[1] };
    default:
      return { view: 'all', sessionId };
  }
}

export function toHash(route: Route): string {
  let path: string;
  switch (route.view) {
    case 'tag':
      path = `tag/${encodeURIComponent(route.tag ?? '')}`;
      break;
    case 'search':
      path = `search/${encodeURIComponent(route.query ?? '')}`;
      break;
    case 'settings':
      path = route.section ? `settings/${route.section}` : 'settings';
      break;
    default:
      path = route.view;
  }
  const query = route.sessionId && route.view !== 'settings' ? `?session=${encodeURIComponent(route.sessionId)}` : '';
  return `#/${path}${query}`;
}

export function useRoute(): [Route, (route: Route, options?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = (next: Route, options: { replace?: boolean } = {}) => {
    const hash = toHash(next);
    if (options.replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
    setRoute(next);
  };
  return [route, navigate];
}
