/**
 * Builds a town for a given seed. Every town is grown outward from one
 * villager, so a single perfect whisper is guaranteed to exist; the generator
 * then checks every possible whisper to confirm how many perfect ones there are.
 */
import type { Board, Dir, Kind, Tile, Villager } from './engine.ts';
import { reachFrom, step, targetsOf, villagerCount } from './engine.ts';
import { makeRng, pick, randInt, shuffle, type Rng } from './rng.ts';

export interface Recipe {
  w: number;
  h: number;
  trees: number;
  gossips: number;
  criers: number;
  skeptics: number;
  shy: number;
  /** Pen pal pairs. */
  pals: number;
  /** Allowed number of perfect whispers. */
  perfect: [number, number];
  /** Allowed number of rounds the perfect whisper takes to finish. */
  rounds: [number, number];
}

export interface Town {
  board: Board;
  /** Every villager whose whisper alone reaches the whole town. */
  perfect: number[];
  /** Rounds the best perfect whisper takes. */
  rounds: number;
  villagers: number;
}

const DIRS: Dir[] = [0, 1, 2, 3];

function connected(board: Board): boolean {
  const start = board.tiles.findIndex((t) => t !== null);
  if (start < 0) return false;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.pop() as number;
    for (const d of DIRS) {
      const n = step(board, at, d);
      if (n >= 0 && board.tiles[n] && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen.size === villagerCount(board);
}

function lineFrom(board: Board, index: number, dir: Dir): number[] {
  const out: number[] = [];
  let i = step(board, index, dir);
  while (i >= 0 && board.tiles[i]) {
    out.push(i);
    i = step(board, i, dir);
  }
  return out;
}

function attempt(rng: Rng, recipe: Recipe): Board | null {
  const size = recipe.w * recipe.h;
  // A placeholder marks "someone lives here, role not decided yet".
  const tiles: Tile[] = Array.from({ length: size }, () => ({ kind: 'whisperer', dir: 0 }) as Villager);
  for (const i of shuffle(rng, [...tiles.keys()]).slice(0, recipe.trees)) tiles[i] = null;
  const board: Board = { w: recipe.w, h: recipe.h, tiles };
  if (!connected(board)) return null;

  const people = [...tiles.keys()].filter((i) => tiles[i]);
  const root = pick(rng, people);
  const reached = new Set([root]);
  /** Who first told each villager, so chain ends can avoid looping back on their own chain. */
  const toldBy = new Map<number, number>();
  const decided = new Set<number>();
  const palOf = new Map<number, number>();
  const active = [root];
  const left = { gossip: recipe.gossips, crier: recipe.criers, pals: recipe.pals };
  const loopsAllowed = recipe.perfect[1] > 1;
  const freshNeighbours = (i: number) =>
    DIRS.filter((d) => {
      const n = step(board, i, d);
      return n >= 0 && tiles[n] && !reached.has(n);
    });
  const touchesRoot = (i: number) => DIRS.some((d) => step(board, i, d) === root);

  while (active.length) {
    // Mostly follow the newest villager so the rumor winds through town in long chains.
    const slot = rng() < 0.72 ? active.length - 1 : randInt(rng, active.length);
    const at = active[slot] as number;
    active.splice(slot, 1);
    const fresh = freshNeighbours(at);
    const isPal = palOf.has(at);
    type Option = { kind: Kind; dir: Dir; weight: number; pal?: number };
    const options: Option[] = [];
    for (const d of fresh) options.push({ kind: isPal ? 'penpal' : 'whisperer', dir: d, weight: 3 });
    if (!isPal && at !== root) {
      if (left.gossip > 0 && fresh.length >= 2 && (loopsAllowed || !touchesRoot(at))) {
        options.push({ kind: 'gossip', dir: 0, weight: 5 });
      }
      if (left.crier > 0) {
        for (const d of DIRS) {
          const line = lineFrom(board, at, d);
          const gain = line.filter((i) => !reached.has(i)).length;
          if (gain >= 2 && (loopsAllowed || !line.includes(root))) {
            options.push({ kind: 'crier', dir: d, weight: 2 + gain });
          }
        }
      }
      if (left.pals > 0 && fresh.length >= 1) {
        const ax = at % board.w;
        const ay = Math.floor(at / board.w);
        const far = people.filter((i) => {
          if (reached.has(i)) return false;
          return Math.abs((i % board.w) - ax) + Math.abs(Math.floor(i / board.w) - ay) >= 3;
        });
        if (far.length) options.push({ kind: 'penpal', dir: pick(rng, fresh), weight: 4, pal: pick(rng, far) });
      }
    }
    if (!options.length) continue; // Nobody new to tell: decided later.

    let roll = rng() * options.reduce((sum, o) => sum + o.weight, 0);
    const choice = options.find((o) => (roll -= o.weight) < 0) ?? (options[0] as Option);
    const villager: Villager = { kind: choice.kind, dir: choice.dir };
    if (choice.kind === 'gossip') left.gossip--;
    if (choice.kind === 'crier') left.crier--;
    if (choice.pal !== undefined) {
      left.pals--;
      palOf.set(at, choice.pal);
      palOf.set(choice.pal, at);
      tiles[choice.pal] = { kind: 'penpal', dir: 0, pal: at };
    }
    if (palOf.has(at)) villager.pal = palOf.get(at);
    tiles[at] = villager;
    decided.add(at);
    for (const to of targetsOf(board, at)) {
      if (!reached.has(to)) {
        reached.add(to);
        toldBy.set(to, at);
        active.push(to);
      }
    }
  }
  if (reached.size !== people.length) return null;

  // Villagers at the end of a chain: some keep quiet, the rest pass it back into town.
  const loose = shuffle(rng, people.filter((i) => !decided.has(i)));
  let shyLeft = recipe.shy;
  const upstream = (i: number): Set<number> => {
    const chain = new Set<number>();
    for (let at = toldBy.get(i); at !== undefined; at = toldBy.get(at)) chain.add(at);
    return chain;
  };
  for (const i of loose) {
    const chain = upstream(i);
    const open = shuffle(rng, DIRS).filter((d) => {
      const n = step(board, i, d);
      return n >= 0 && tiles[n] && (loopsAllowed || n !== root);
    });
    // Facing someone on a different branch keeps the town from becoming one big loop.
    const sideways = open.filter((d) => !chain.has(step(board, i, d)));
    const dirs = sideways.length && rng() < 0.85 ? sideways : open;
    if (palOf.has(i)) {
      tiles[i] = { kind: 'penpal', dir: dirs[0] ?? pick(rng, DIRS), pal: palOf.get(i) as number };
    } else if ((shyLeft > 0 && i !== root) || !dirs.length) {
      shyLeft--;
      tiles[i] = { kind: 'shy', dir: pick(rng, DIRS) };
    } else {
      tiles[i] = { kind: 'whisperer', dir: dirs[0] as Dir };
    }
  }

  // Skeptics need to hear it twice, so only villagers with two tellers qualify.
  const tellers = new Map<number, number>();
  for (const i of people) for (const to of targetsOf(board, i)) tellers.set(to, (tellers.get(to) ?? 0) + 1);
  let skepticsLeft = recipe.skeptics;
  for (const i of shuffle(rng, people)) {
    if (skepticsLeft <= 0) break;
    const v = tiles[i] as Villager;
    if (i === root || v.kind !== 'whisperer' || (tellers.get(i) ?? 0) < 2) continue;
    v.kind = 'skeptic';
    if (reachFrom(board, root).reach === people.length) skepticsLeft--;
    else v.kind = 'whisperer';
  }
  return board;
}

function measure(board: Board): Town & { score: number } {
  const villagers = villagerCount(board);
  const perfect: number[] = [];
  const reaches: number[] = [];
  let rounds = Infinity;
  board.tiles.forEach((tile, i) => {
    if (!tile) return;
    const run = reachFrom(board, i);
    if (run.reach === villagers) {
      perfect.push(i);
      rounds = Math.min(rounds, run.rounds);
    } else if (tile.kind !== 'shy') {
      reaches.push(run.reach);
    }
  });
  // A good town gives every wrong whisper a different, readable outcome: some
  // fizzle fast, some travel far, and few of them end in exactly the same place.
  const tally = new Map<number, number>();
  for (const reach of reaches) tally.set(reach, (tally.get(reach) ?? 0) + 1);
  const clump = Math.max(0, ...tally.values()) / Math.max(1, reaches.length);
  const mean = reaches.reduce((a, b) => a + b, 0) / Math.max(1, reaches.length) / villagers;
  const duds = reaches.filter((reach) => reach <= 2).length / Math.max(1, reaches.length);
  const nearly = reaches.filter((reach) => reach >= villagers - 2).length;
  const score = -clump * 10 - Math.abs(mean - 0.4) * 8 - duds * 3 - Math.max(0, nearly - 2) * 1.5;
  return { board, perfect, rounds, villagers, score };
}

function uses(board: Board, recipe: Recipe): boolean {
  const count = (kind: Kind) => board.tiles.filter((t) => t?.kind === kind).length;
  return (
    count('gossip') >= Math.min(recipe.gossips, 1) &&
    count('crier') >= Math.min(recipe.criers, 1) &&
    count('skeptic') >= Math.min(recipe.skeptics, 1) &&
    count('penpal') === recipe.pals * 2
  );
}

/** Deterministic: the same seed and recipe always produce the same town. */
export function generateTown(seed: string, recipe: Recipe): Town {
  const rng = makeRng(seed);
  let best: (Town & { score: number }) | null = null;
  let kept = 0;
  for (let tries = 0; tries < 3000 && kept < 60; tries++) {
    const board = attempt(rng, recipe);
    if (!board) continue;
    const m = measure(board);
    const ok =
      m.perfect.length >= recipe.perfect[0] &&
      m.perfect.length <= recipe.perfect[1] &&
      m.rounds >= recipe.rounds[0] &&
      m.rounds <= recipe.rounds[1] &&
      uses(board, recipe);
    if (!ok) continue;
    kept++;
    if (!best || m.score > best.score) best = m;
  }
  if (best) return { board: best.board, perfect: best.perfect, rounds: best.rounds, villagers: best.villagers };
  // Practically unreachable, but a daily game must never fail to produce a puzzle.
  return fallbackTown(recipe);
}

/** One long snake of whisperers: always solvable from its first villager. */
export function fallbackTown(recipe: Recipe): Town {
  const tiles: Tile[] = [];
  for (let y = 0; y < recipe.h; y++) {
    for (let x = 0; x < recipe.w; x++) {
      const eastward = y % 2 === 0;
      const atEnd = eastward ? x === recipe.w - 1 : x === 0;
      const last = y === recipe.h - 1 && atEnd;
      tiles.push(last ? { kind: 'shy', dir: 0 } : { kind: 'whisperer', dir: atEnd ? 2 : eastward ? 1 : 3 });
    }
  }
  const board: Board = { w: recipe.w, h: recipe.h, tiles };
  return { board, perfect: [0], rounds: tiles.length - 1, villagers: tiles.length };
}
