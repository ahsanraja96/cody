import { describe, expect, it } from 'vitest';

import { recipeFor, rumorChoices, townFor } from '../src/shared/daily.ts';
import { freshState, knowCount, reachFrom, whisper, type Board } from '../src/shared/engine.ts';
import { generateTown } from '../src/shared/generate.ts';

const board = (w: number, h: number, rows: string): Board => ({
  w,
  h,
  tiles: rows
    .trim()
    .split(/\s+/)
    .map((cell) => {
      if (cell === '##') return null;
      const kind = { w: 'whisperer', G: 'gossip', C: 'crier', S: 'skeptic', z: 'shy' }[cell[0] as string];
      return { kind, dir: '^>v<'.indexOf(cell[1] as string) } as never;
    }),
});

describe('rules', () => {
  it('a whisperer tells only the neighbour they face', () => {
    const b = board(3, 1, 'w> w> z.'.replace('z.', 'z^'));
    expect(reachFrom(b, 0).reach).toBe(3);
    expect(reachFrom(b, 1).reach).toBe(2);
  });

  it('a gossip tells every neighbour', () => {
    const b = board(3, 3, 'z^ z^ z^  z^ G^ z^  z^ z^ z^');
    expect(reachFrom(b, 4).reach).toBe(5);
  });

  it('a crier is stopped by a tree', () => {
    const b = board(5, 1, 'C> z^ z^ ## z^');
    expect(reachFrom(b, 0).reach).toBe(3);
  });

  it('a skeptic needs two tellers, but a direct whisper convinces', () => {
    const b = board(3, 2, 'w> S> z^  w> w^ z^');
    expect(reachFrom(b, 0).reach).toBe(1);
    expect(reachFrom(b, 1).reach).toBe(2);
    const state = freshState(b);
    whisper(b, state, 0);
    expect(state.heard[1]).toBe(1);
    whisper(b, state, 3);
    expect(state.knows[1]).toBe(true);
    expect(knowCount(state)).toBe(5);
  });
});

describe('daily towns', () => {
  it('every town for four months has a perfect whisper and matches its recipe', () => {
    for (let day = 1; day <= 120; day++) {
      const town = townFor(day);
      const recipe = recipeFor(day);
      expect(town.perfect.length).toBeGreaterThanOrEqual(recipe.perfect[0]);
      expect(town.perfect.length).toBeLessThanOrEqual(recipe.perfect[1]);
      for (const index of town.perfect) expect(reachFrom(town.board, index).reach).toBe(town.villagers);
      expect(town.rounds).toBeLessThanOrEqual(recipe.rounds[1]);
    }
  });

  it('is deterministic', () => {
    const a = generateTown('same', recipeFor(5));
    const b = generateTown('same', recipeFor(5));
    expect(a).toEqual(b);
  });

  it('offers three different rumors and never repeats one within three weeks', () => {
    const seen = new Set<string>();
    for (let day = 1; day <= 21; day++) {
      const claims = rumorChoices(day);
      expect(new Set(claims).size).toBe(3);
      for (const claim of claims) {
        const tail = claim.split(' ').slice(-4).join(' ');
        expect(seen.has(tail)).toBe(false);
        seen.add(tail);
      }
    }
  });
});
