import type { TabfoldDB } from '../db';
import type { SearchDoc } from './engine';

/** Every saved tab as a search document. Tabs in Trash are included and marked, for "Search in Trash". */
export async function loadSavedDocs(database: TabfoldDB): Promise<SearchDoc[]> {
  const sessions = await database.sessions.toArray();
  const info = new Map(sessions.map((s) => [s.id, s]));
  const docs: SearchDoc[] = [];
  await database.tabs.each((tab) => {
    const session = info.get(tab.sessionId);
    if (!session) return;
    docs.push({
      id: `saved:${tab.id}`,
      kind: 'saved',
      title: tab.title,
      url: tab.url,
      keywords: tab.keywords ?? [],
      favIconUrl: tab.favIconUrl,
      tabRecordId: tab.id,
      sessionId: session.id,
      sessionName: session.name,
      savedAt: tab.savedAt,
      deleted: session.deletedAt > 0,
      ...(tab.incognito ? { incognito: true } : {}),
    });
  });
  return docs;
}

/** Keywords picked for an address, so an open tab that was also saved is found by its keywords too. */
export function keywordsByUrl(docs: SearchDoc[]): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const doc of docs) {
    if (doc.deleted || doc.keywords.length === 0) continue;
    const set = map.get(doc.url) ?? new Set<string>();
    for (const keyword of doc.keywords) set.add(keyword);
    map.set(doc.url, set);
  }
  return new Map([...map.entries()].map(([url, set]) => [url, [...set]]));
}
