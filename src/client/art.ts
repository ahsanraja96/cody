/**
 * The townsfolk, drawn as two-ink paper cut-outs. Everything is inline SVG so a
 * villager can be "inked in" with nothing but a class change.
 */
import type { TileView } from '../shared/api.ts';
import type { Kind } from '../shared/engine.ts';

const POINTER = '<path class="ptr" d="M50 3 62 17H38Z"/>';
const DOUBLE = '<path class="ptr" d="M50 -5 61 8H39Z"/><path class="ptr" d="M50 5 62 19H38Z"/>';

function pointers(kind: Kind, dir: number): string {
  const turn = (d: number, shape: string) => `<g transform="rotate(${d * 90} 50 50)">${shape}</g>`;
  if (kind === 'shy') return '';
  if (kind === 'gossip') return [0, 1, 2, 3].map((d) => turn(d, POINTER)).join('');
  return turn(dir, kind === 'crier' ? DOUBLE : POINTER);
}

/** Headwear for ordinary whisperers, picked by the villager's `look`. */
const HATS = [
  // flat cap
  '<path class="ink" d="M29 27c2-13 14-19 25-17 10 2 16 8 18 15l9 3-2 5H31Z"/>',
  // bun
  '<circle class="ink" cx="50" cy="11" r="8"/><path class="ink" d="M30 30c0-14 9-20 20-20s20 6 20 20c-8-7-32-7-40 0Z"/>',
  // bowler
  '<path class="ink" d="M33 26c0-12 8-18 17-18s17 6 17 18h9v6H24v-6Z"/>',
  // beanie
  '<circle class="pop" cx="50" cy="7" r="5"/><path class="ink" d="M30 31c-1-14 8-22 20-22s21 8 20 22Z"/>',
  // one stubborn curl
  '<path class="line" d="M50 16c-2-8 5-12 9-8"/>',
  // bow
  '<path class="pop" d="M50 17 36 8v16Zm0 0 14-9v16Z"/><circle class="ink" cx="50" cy="17" r="3.5"/>',
  // side parting
  '<path class="ink" d="M30 34c-3-16 8-25 21-24 12 1 20 9 19 21-10-9-22-12-40 3Z"/>',
];

function costume(tile: TileView): { hat: string; extra: string; eyes: string } {
  const ex = [0, 4.5, 0, -4.5][tile.dir] ?? 0;
  const ey = [-3.5, 0, 3.5, 0][tile.dir] ?? 0;
  const open = `<circle class="eye" cx="${43 + ex}" cy="${35 + ey}" r="3.3"/><circle class="eye" cx="${57 + ex}" cy="${35 + ey}" r="3.3"/>`;
  switch (tile.kind) {
    case 'gossip':
      return {
        hat: '<path class="ink" d="M28 33c-7-6-3-15 4-15 0-8 9-11 14-6 5-6 15-3 15 5 8-1 12 9 6 15-9-8-30-8-39 1Z"/>',
        extra: '',
        eyes: `<circle class="eye" cx="42" cy="35" r="4"/><circle class="eye" cx="58" cy="35" r="4"/>`,
      };
    case 'crier':
      return {
        hat: '<path class="ink" d="M22 28 50 6l28 22-9 3H31Z"/><path class="pop" d="M44 19h12v6H44Z"/>',
        extra: '',
        eyes: open,
      };
    case 'skeptic':
      return {
        hat: HATS[tile.look % 3] as string,
        extra:
          '<path class="line" d="M33 76c11 7 23 7 34 0M36 84c9-5 19-5 28 0"/>' +
          `<path class="line thin" d="M${37 + ex} ${27 + ey}l10 3M${63 + ex} ${25 + ey}l-10 3"/>`,
        eyes: `<circle class="specs" cx="${42 + ex}" cy="${36 + ey}" r="6.5"/><circle class="specs" cx="${58 + ex}" cy="${36 + ey}" r="6.5"/>${open}`,
      };
    case 'shy':
      return {
        hat: HATS[(tile.look % 4) + 3] as string,
        extra:
          '<path class="book" d="M27 44 50 49l23-5v24l-23 5-23-5Z"/><path class="line thin" d="M50 49v24"/>',
        eyes: '<path class="line thin" d="M38 35c3 3 6 3 9 0M53 35c3 3 6 3 9 0"/>',
      };
    case 'penpal':
      return {
        hat: '<path class="ink" d="M31 27c1-11 9-17 19-17s18 6 19 17l8 2v5H29v-5Z"/><path class="pop" d="M45 16h10v7H45Z"/>',
        extra: '',
        eyes: open,
      };
    default:
      return { hat: HATS[tile.look % HATS.length] as string, extra: '', eyes: open };
  }
}

const envelope = (seal: number): string =>
  `<g class="mail"><path class="env" d="M67 62h29v20H67Z"/><path class="line thin" d="M67 62l14.5 10.5 14.5-10.5"/>` +
  (seal % 2
    ? '<path class="seal" d="M81.5 73l5 5-5 5-5-5Z"/>'
    : '<circle class="seal" cx="81.5" cy="78" r="4.5"/>') +
  '</g>';

export function villagerSvg(tile: TileView, seal: number): string {
  const { hat, extra, eyes } = costume(tile);
  const mouth =
    tile.kind === 'shy'
      ? ''
      : '<path class="line thin calm" d="M45 45h10"/><ellipse class="gasp" cx="50" cy="46" rx="4.5" ry="5.5"/>';
  return (
    `<svg viewBox="0 0 100 100" aria-hidden="true">` +
    `<g class="fig"><g transform="translate(50 49) scale(.66) translate(-50 -50)">` +
    `<ellipse class="shade" cx="50" cy="93" rx="30" ry="5"/>` +
    `<path class="body" d="M19 94c0-30 11-45 31-45s31 15 31 45Z"/>` +
    `<circle class="body head" cx="50" cy="35" r="21"/>` +
    `<g class="face">${eyes}${mouth}</g>` +
    `<g class="hat">${hat}</g>${extra}</g></g>` +
    pointers(tile.kind, tile.dir) +
    (tile.kind === 'skeptic'
      ? '<g class="pips"><circle class="pip" cx="14" cy="15" r="6"/><circle class="pip" cx="30" cy="15" r="6"/></g>'
      : '') +
    (tile.kind === 'penpal' ? envelope(seal) : '') +
    `</svg>`
  );
}

export function treeSvg(look: number): string {
  const pine = look % 3 === 0;
  return (
    `<svg viewBox="0 0 100 100" aria-hidden="true"><ellipse class="shade" cx="50" cy="88" rx="24" ry="5"/>` +
    `<path class="trunk" d="M45 62h10v26H45Z"/>` +
    (pine
      ? '<path class="leaf" d="M50 12 72 44H60l16 24H24l16-24H28Z"/>'
      : '<path class="leaf" d="M50 14c12 0 20 8 19 18 9 2 13 11 9 19-4 9-14 11-22 8-4 4-12 4-16-1-9 2-18-3-19-12-1-8 5-14 12-15 0-10 7-17 17-17Z"/>') +
    `<circle class="dot" cx="42" cy="38" r="2"/><circle class="dot" cx="56" cy="30" r="2"/><circle class="dot" cx="58" cy="48" r="2"/><circle class="dot" cx="44" cy="52" r="2"/>` +
    `</svg>`
  );
}

/** The masthead mark: a cupped hand of sound lines. */
export const LOGO =
  '<svg viewBox="0 0 64 40" aria-hidden="true"><path class="line" d="M6 20c8-12 20-12 28 0M12 30c5-7 12-7 16 0"/><path class="pop" d="M44 6l14 6-14 6Z"/><path class="ink" d="M44 22l14 6-14 6Z"/></svg>';
