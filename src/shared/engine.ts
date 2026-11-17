/**
 * The rules of the town. Shared by the client (to animate a whisper the moment
 * it is tapped) and the server (to re-run every whisper before it counts).
 */

/** 0 = north, 1 = east, 2 = south, 3 = west. */
export type Dir = 0 | 1 | 2 | 3;

export type Kind = 'whisperer' | 'gossip' | 'crier' | 'skeptic' | 'shy' | 'penpal';

export interface Villager {
  kind: Kind;
  dir: Dir;
  /** Board index of this villager's pen pal. */
  pal?: number;
}

/** `null` is a tree: nobody lives there and a town crier cannot shout past it. */
export type Tile = Villager | null;

export interface Board {
  w: number;
  h: number;
  tiles: Tile[];
}

export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export function step(board: Board, index: number, dir: Dir): number {
  const x = (index % board.w) + DX[dir];
  const y = Math.floor(index / board.w) + DY[dir];
  if (x < 0 || y < 0 || x >= board.w || y >= board.h) return -1;
  return y * board.w + x;
}

/** Everyone `index` passes the rumor to, once they believe it. */
export function targetsOf(board: Board, index: number): number[] {
  const v = board.tiles[index];
  if (!v) return [];
  const out: number[] = [];
  const add = (i: number) => {
    if (i >= 0 && board.tiles[i] && !out.includes(i)) out.push(i);
  };
  switch (v.kind) {
    case 'shy':
      break;
    case 'gossip':
      for (let d = 0; d < 4; d++) add(step(board, index, d as Dir));
      break;
    case 'crier': {
      let i = step(board, index, v.dir);
      while (i >= 0 && board.tiles[i]) {
        add(i);
        i = step(board, i, v.dir);
      }
      break;
    }
    case 'penpal':
      add(step(board, index, v.dir));
      if (v.pal !== undefined) add(v.pal);
      break;
    default:
      add(step(board, index, v.dir));
  }
  return out;
}

export interface Tell {
  from: number;
  to: number;
  /** True when this is the tell that makes `to` believe the rumor. */
  lands: boolean;
  /** How many times `to` has now heard it. */
  heard: number;
}

export interface TownState {
  /** Per tile: has this villager started spreading the rumor? */
  knows: boolean[];
  /** Per tile: how many times they have been told. */
  heard: number[];
}

export function freshState(board: Board): TownState {
  return {
    knows: board.tiles.map(() => false),
    heard: board.tiles.map(() => 0),
  };
}

export const villagerCount = (board: Board): number =>
  board.tiles.reduce((n, t) => n + (t ? 1 : 0), 0);

export const knowCount = (state: TownState): number =>
  state.knows.reduce((n, k) => n + (k ? 1 : 0), 0);

const needed = (v: Villager): number => (v.kind === 'skeptic' ? 2 : 1);

/**
 * Whisper to one villager and let the rumor run until it dies out. Mutates
 * `state` and returns the tells grouped by round, ready to animate.
 * A direct whisper always convinces, even a skeptic.
 */
export function whisper(board: Board, state: TownState, index: number): Tell[][] {
  const rounds: Tell[][] = [];
  if (!board.tiles[index] || state.knows[index]) return rounds;
  state.knows[index] = true;
  state.heard[index] = Math.max(state.heard[index] ?? 0, 1);
  let wave = [index];
  while (wave.length) {
    const round: Tell[] = [];
    const next: number[] = [];
    for (const from of wave) {
      for (const to of targetsOf(board, from)) {
        const v = board.tiles[to] as Villager;
        const heard = (state.heard[to] = (state.heard[to] ?? 0) + 1);
        const lands = !state.knows[to] && heard >= needed(v);
        if (lands) {
          state.knows[to] = true;
          next.push(to);
        }
        round.push({ from, to, lands, heard });
      }
    }
    if (round.length) rounds.push(round);
    wave = next;
  }
  return rounds;
}

/** How many villagers know after whispering to `index` in a quiet town. */
export function reachFrom(board: Board, index: number): { reach: number; rounds: number } {
  const state = freshState(board);
  const rounds = whisper(board, state, index);
  return { reach: knowCount(state), rounds: rounds.length };
}

/** Replays a list of whispers; used by the server to trust nothing. */
export function replay(board: Board, whispers: readonly number[]): TownState {
  const state = freshState(board);
  for (const index of whispers) whisper(board, state, index);
  return state;
}

export function isValidWhisper(board: Board, state: TownState, index: number): boolean {
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < board.tiles.length &&
    !!board.tiles[index] &&
    !state.knows[index]
  );
}
