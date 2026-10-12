import { describe, expect, it } from 'vitest';
import { planSync as plan10 } from '@/lib/sync/merge';
import { CLOUD_LIMITS, decodeNoteItem, diffItems as diff10, FOLDERS_KEY, NOTES_KEY, SYNC_LIMITS, unpack as unpack10, type SyncLimits } from '@/lib/sync/records';
import type { FolderRecord } from '@/lib/types';
import { planSync as plan06 } from './fixtures/v06sync/merge';
import { diffItems as diff06, unpack as unpack06 } from './fixtures/v06sync/records';

// A 1.0 computer (A) and a 0.6 computer (Z) share one copy (Chrome sync, or the Tabfold account).
// Both have the same folded tabs and folders; A has a folder note and a star, which 0.6 doesn't
// know. The copy must settle (no writes after a few rounds) with the same records on both sides:
// 1.0 never takes room from the records for what only it writes, and never writes back a notes
// item 0.6 removed for that alone.

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

function tabs(n: number, titleLen: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${String(i).padStart(5, '0')}`,
    url: `https://example-site-number-${i}.com/some/longer/path/to/a/page?id=${i}`,
    title: `${'A fairly long page title that people tend to have '.repeat(4).slice(0, titleLen)} ${i}`,
    savedAt: NOW - (i + 1) * 60_000,
    keywords: [] as string[],
  }));
}

const folderA: FolderRecord = {
  id: 'folder000001',
  name: 'Client work',
  color: 'blue',
  order: 0,
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  deletedAt: 0,
  note: 'Waiting on the client’s feedback about the second draft',
  noteAt: NOW - 3_600_000,
  starredAt: NOW - 86_400_000,
};
const { note: _n, noteAt: _na, starredAt: _s, ...folderZ } = folderA;

interface Run {
  writes: string[];
  items: Record<string, unknown>;
  recordsA: string[];
  recordsZ: string[];
}

/**
 * Rounds of: A plans and writes what differs, then Z does. `engine`: A carries `lastNotes` from run
 * to run as its sync engine does; without it, A's planner gets no memory of what it shared.
 */
function run(options: { n: number; titleLen: number; limits?: SyncLimits; engine?: boolean; rounds?: number; noteChangeAt?: number }): Run {
  const limits = options.limits ?? SYNC_LIMITS;
  const local = tabs(options.n, options.titleLen);
  let items: Record<string, unknown> = {};
  const stateA = { known: {} as Record<string, string>, mine: {} as Record<string, number>, lastNotes: null as string | null };
  const stateZ = { known: {} as Record<string, string>, mine: {} as Record<string, number> };
  const writes: string[] = [];
  let recordsA: string[] = [];
  let recordsZ: string[] = [];
  let folder = folderA;
  for (let round = 0; round < (options.rounds ?? 6); round += 1) {
    if (round === options.noteChangeAt) folder = { ...folder, note: 'Signed off', noteAt: NOW + round * 1000 };
    {
      const p = plan10({
        local,
        remote: unpack10(items, limits),
        known: stateA.known,
        mine: stateA.mine,
        floor: 0,
        now: NOW + round * 1000,
        limits,
        folders: { folders: [folder], kinds: {}, removals: {} },
        ...(options.engine ? { lastNotes: stateA.lastNotes } : {}),
      });
      const d = diff10(items, p.packed.items);
      if (Object.keys(d.set).length || d.remove.length) {
        writes.push(`A sets [${Object.keys(d.set).join(',')}] removes [${d.remove.join(',')}] records=${p.packed.records.length}`);
        const next = { ...items, ...d.set };
        for (const k of d.remove) delete next[k];
        items = next;
      }
      stateA.known = p.known;
      stateA.mine = p.mine;
      stateA.lastNotes = p.notesHash;
      recordsA = p.packed.records.map((r) => r.id);
    }
    {
      const p = plan06({
        local,
        remote: unpack06(items, limits),
        known: stateZ.known,
        mine: stateZ.mine,
        floor: 0,
        now: NOW + round * 1000 + 500,
        limits,
        folders: { folders: [folderZ], kinds: {}, removals: {} },
      });
      const d = diff06(items, p.packed.items);
      if (Object.keys(d.set).length || d.remove.length) {
        writes.push(`Z sets [${Object.keys(d.set).join(',')}] removes [${d.remove.join(',')}] records=${p.packed.records.length}`);
        const next = { ...items, ...d.set };
        for (const k of d.remove) delete next[k];
        items = next;
      }
      stateZ.known = p.known;
      stateZ.mine = p.mine;
      recordsZ = p.packed.records.map((r) => r.id);
    }
  }
  return { writes, items, recordsA, recordsZ };
}

describe('a 0.6 and a 1.0 computer on one Chrome sync copy', () => {
  for (const engine of [false, true]) {
    const how = engine ? 'as the engines run' : 'planners only';
    it(`settle with the same records when the copy is full by bytes (${how})`, () => {
      const result = run({ n: 600, titleLen: 110, engine });
      // A writes the copy, Z writes it back the way 0.6 does (no notes item, no star), and that's all.
      expect(result.writes.length).toBeLessThanOrEqual(2);
      expect(result.recordsA).toEqual(result.recordsZ);
      expect(result.recordsA.length).toBeLessThan(500);
    });

    it(`settle when the copy is full by count, 500 records (${how})`, () => {
      const result = run({ n: 600, titleLen: 20, engine });
      expect(result.writes.length).toBeLessThanOrEqual(2);
      expect(result.recordsA).toEqual(result.recordsZ);
      expect(result.recordsA).toHaveLength(500);
    });
  }

  it('never pack different records, whatever the titles’ length', { timeout: 60_000 }, () => {
    for (let len = 60; len <= 120; len += 3) {
      const result = run({ n: 600, titleLen: len, rounds: 4 });
      expect(result.recordsA, `titles of ${len}`).toEqual(result.recordsZ);
      expect(result.writes.length, `titles of ${len}: ${result.writes.join(' | ')}`).toBeLessThanOrEqual(2);
    }
  });

  it('a changed note is written again (once), even though 0.6 takes it out again', () => {
    const result = run({ n: 100, titleLen: 40, engine: true, rounds: 6, noteChangeAt: 3 });
    const aWrites = result.writes.filter((w) => w.startsWith('A'));
    expect(aWrites).toHaveLength(2);
    expect(aWrites[1]).toContain(NOTES_KEY);
    expect(result.writes.length).toBeLessThanOrEqual(4);
  });
});

describe('a 0.6 and a 1.0 computer on one Tabfold account copy', () => {
  it('settle with the same records (0.6 removes tf.n; it isn’t written back for that alone)', () => {
    const result = run({ n: 800, titleLen: 110, limits: CLOUD_LIMITS, engine: true });
    expect(result.writes.length).toBeLessThanOrEqual(2);
    expect(result.recordsA).toEqual(result.recordsZ);
    expect(result.recordsA).toHaveLength(800);
    expect(result.writes[1] ?? '').toContain(`removes [${NOTES_KEY}]`);
  });
});

describe('1.0 alone', () => {
  it('writes the star and the note in the room the records leave, and nothing more after', () => {
    const local = tabs(50, 40);
    let items: Record<string, unknown> = {};
    let state = { known: {} as Record<string, string>, mine: {} as Record<string, number>, lastNotes: null as string | null };
    let writes = 0;
    for (let round = 0; round < 4; round += 1) {
      const p = plan10({ local, remote: unpack10(items), ...state, floor: 0, now: NOW + round * 1000, folders: { folders: [folderA], kinds: {}, removals: {} } });
      const d = diff10(items, p.packed.items);
      if (Object.keys(d.set).length || d.remove.length) {
        writes += 1;
        items = { ...items, ...d.set };
        for (const k of d.remove) delete items[k];
      }
      state = { known: p.known, mine: p.mine, lastNotes: p.notesHash };
    }
    expect(writes).toBe(1);
    expect((items[FOLDERS_KEY] as { f: unknown[][] }).f[0]).toHaveLength(7);
    expect(decodeNoteItem(items[NOTES_KEY])![0]!.note).toBe(folderA.note);
  });

  it('leaves the notes out (on this computer) rather than a record when the copy is full', () => {
    const local = tabs(600, 110);
    const p = plan10({ local, remote: unpack10({}), known: {}, mine: {}, floor: 0, now: NOW, folders: { folders: [folderA], kinds: {}, removals: {} } });
    const p06 = plan06({ local, remote: unpack06({}), known: {}, mine: {}, floor: 0, now: NOW, folders: { folders: [folderZ], kinds: {}, removals: {} } });
    expect(p.packed.records.map((r) => r.id)).toEqual(p06.packed.records.map((r) => r.id));
    // The extras only go in when they fit in what's left; either way, never instead of a record.
    if (!p.packed.extras?.notes) expect(p.packed.items[NOTES_KEY]).toBeUndefined();
  });
});
