/** The board: renders the town, previews who a villager would tell, and animates a whisper. */
import type { InitResponse, TileView } from '../shared/api.ts';
import { KIND_NAME } from '../shared/daily.ts';
import {
  freshState,
  knowCount,
  targetsOf,
  villagerCount,
  whisper,
  type Board,
  type Kind,
  type TownState,
} from '../shared/engine.ts';
import { treeSvg, villagerSvg } from './art.ts';
import * as sound from './sound.ts';

/** All a board needs to draw itself; the practice towns pass just this. */
export type TownData = Pick<InitResponse, 'w' | 'h' | 'tiles'>;

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const GASPS = ['psst!', 'no!', 'really?', 'gasp!', 'never!', 'ooh!', 'who said?', 'I knew it'];
const ASKS = ['huh?', 'tell me!', 'what?', 'psst?'];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SVG = 'http://www.w3.org/2000/svg';

interface Route {
  d: string;
  ex: number;
  ey: number;
  angle: number;
  far: boolean;
}

export class TownView {
  readonly el: HTMLElement;
  readonly board: Board;
  readonly total: number;
  state: TownState;
  selected: number | null = null;
  busy = false;
  onSelect: (index: number | null) => void = () => undefined;

  private readonly tiles: (HTMLElement | null)[] = [];
  private readonly trails: SVGSVGElement;
  private readonly wires: SVGSVGElement;
  private readonly fx: HTMLElement;
  private hurry = false;
  private notes = 0;

  constructor(private readonly data: TownData) {
    this.board = {
      w: data.w,
      h: data.h,
      tiles: data.tiles.map((t) =>
        t ? { kind: t.kind, dir: t.dir, ...(t.pal === undefined ? {} : { pal: t.pal }) } : null,
      ),
    };
    this.total = villagerCount(this.board);
    this.state = freshState(this.board);

    this.el = document.createElement('div');
    this.el.className = 'town';
    this.el.style.setProperty('--cols', String(data.w));
    this.el.style.setProperty('--rows', String(data.h));

    const seals = new Map<number, number>();
    data.tiles.forEach((tile, i) => {
      if (tile?.kind === 'penpal' && tile.pal !== undefined && !seals.has(i)) {
        const seal = new Set(seals.values()).size;
        seals.set(i, seal).set(tile.pal, seal);
      }
    });

    data.tiles.forEach((tile, i) => {
      // Distance from the top-left corner: the order tiles arrive in, and cheer in.
      const order = (i % data.w) + Math.floor(i / data.w);
      if (!tile) {
        const tree = document.createElement('div');
        tree.className = 'tile tree';
        tree.style.setProperty('--order', String(order));
        tree.innerHTML = treeSvg(i);
        this.el.append(tree);
        this.tiles.push(null);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tile folk ${tile.kind}${tile.me ? ' me' : ''}`;
      button.dataset.i = String(i);
      button.style.setProperty('--order', String(order));
      button.innerHTML = villagerSvg(tile, seals.get(i) ?? 0);
      if (tile.avatar) this.addFace(button, tile.avatar);
      button.addEventListener('click', () => this.tap(i));
      this.el.append(button);
      this.tiles.push(button);
      this.label(i);
    });

    const layer = (name: string): SVGSVGElement => {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('class', name);
      svg.setAttribute('viewBox', `0 0 ${data.w * 100} ${data.h * 100}`);
      svg.setAttribute('aria-hidden', 'true');
      return svg;
    };
    this.trails = layer('wires trails');
    this.wires = layer('wires');
    this.fx = document.createElement('div');
    this.fx.className = 'fx';
    this.el.append(this.trails, this.wires, this.fx);
    this.el.addEventListener('pointerdown', () => {
      if (this.busy) this.hurry = true;
    });

    // The town assembles itself, corner to corner, the first time it is shown.
    if (!reducedMotion()) {
      this.el.classList.add('enter');
      setTimeout(() => this.el.classList.remove('enter'), 1100);
      this.fidget();
    }
  }

  /**
   * Now and then a villager shifts their weight and blinks. Only a couple move
   * at once, so the town feels alive without the page animating all the time.
   */
  private fidget(): void {
    const folk = this.tiles.filter((el): el is HTMLElement => el !== null);
    let shown = false;
    const timer = setInterval(() => {
      if (!this.el.isConnected) {
        // Not on screen yet, or gone for good once it has been.
        if (shown) clearInterval(timer);
        return;
      }
      shown = true;
      if (this.busy || document.hidden) return;
      for (let n = Math.ceil(folk.length / 14); n > 0; n--) {
        const el = folk[Math.floor(Math.random() * folk.length)] as HTMLElement;
        if (el.classList.contains('fidget')) continue;
        el.classList.add('fidget');
        setTimeout(() => el.classList.remove('fidget'), 720);
      }
    }, 620);
  }

  get known(): number {
    return knowCount(this.state);
  }

  tile(index: number): TileView {
    return this.data.tiles[index] as TileView;
  }

  /** Everyone `index` would tell directly, in board order. */
  targets(index: number): number[] {
    return targetsOf(this.board, index);
  }

  private addFace(button: HTMLElement, src: string): void {
    const img = document.createElement('img');
    img.className = 'face-img';
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => button.classList.add('has-face'));
    img.addEventListener('error', () => img.remove());
    img.src = src;
    button.append(img);
  }

  private label(index: number): void {
    const tile = this.tile(index);
    const heard = this.state.knows[index]
      ? 'knows the rumor'
      : tile.kind === 'skeptic' && this.state.heard[index]
        ? 'has heard it once'
        : 'has not heard';
    this.tiles[index]?.setAttribute('aria-label', `${tile.name}, ${KIND_NAME[tile.kind]}, ${heard}`);
  }

  /** Draws the eye to one villager until the player's first tap. */
  nudge(index: number): void {
    this.tiles[index]?.classList.add('nudge');
  }

  /** Makes every villager of one kind hop, so a legend entry points at real people. */
  spotlight(kind: Kind | null): void {
    this.tiles.forEach((el, i) => {
      if (!el) return;
      el.classList.remove('spot');
      if (kind && this.tile(i).kind === kind) {
        void el.offsetWidth; // restart the hop when the same kind is tapped twice
        el.classList.add('spot');
      }
    });
  }

  private tap(index: number): void {
    if (this.busy) return;
    this.el.querySelector('.nudge')?.classList.remove('nudge');
    sound.wake();
    sound.tap();
    this.select(this.selected === index ? null : index);
  }

  select(index: number | null): void {
    this.selected = index;
    this.tiles.forEach((el, i) => {
      el?.classList.toggle('sel', i === index);
      el?.classList.remove('target', 'spot');
    });
    this.wires.innerHTML = '';
    if (index !== null) {
      for (const to of targetsOf(this.board, index)) {
        this.tiles[to]?.classList.add('target');
        this.wire(index, to);
      }
    }
    this.onSelect(index);
  }

  private centre(index: number): [number, number] {
    return [(index % this.board.w) * 100 + 50, Math.floor(index / this.board.w) * 100 + 50];
  }

  /** The line from one villager to another: straight for neighbours, an arc for pen pals. */
  private route(from: number, to: number, leave: number, arrive: number): Route {
    const [x1, y1] = this.centre(from);
    const [x2, y2] = this.centre(to);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / length;
    const uy = (y2 - y1) / length;
    const far = this.tile(from).kind === 'penpal' && to === this.tile(from).pal;
    const sx = x1 + ux * leave;
    const sy = y1 + uy * leave;
    const ex = x2 - ux * arrive;
    const ey = y2 - uy * arrive;
    const bend = far ? 0.22 * length : 0;
    const cx = (sx + ex) / 2 - uy * bend;
    const cy = (sy + ey) / 2 + ux * bend;
    return {
      d: `M${sx} ${sy}Q${cx} ${cy} ${ex} ${ey}`,
      ex,
      ey,
      angle: (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI,
      far,
    };
  }

  private wire(from: number, to: number): void {
    const { d, ex, ey, angle, far } = this.route(from, to, 34, 30);
    this.wires.insertAdjacentHTML(
      'beforeend',
      `<path class="wire under" d="${d}"/><path class="wire${far ? ' far' : ''}" d="${d}"/>` +
        `<path class="wire-tip" transform="translate(${ex} ${ey}) rotate(${angle})" d="M10 0-10-13v26Z"/>`,
    );
  }

  /** Inks in the step the rumor just took, so the route it travelled stays on the board. */
  private trail(from: number, to: number, animate: boolean): void {
    const far = this.tile(from).kind === 'penpal' && to === this.tile(from).pal;
    let start = from;
    if (!far) {
      // A town crier's shout is drawn as hops down the row, not one line across everyone's face.
      const [fx, fy] = this.centre(from);
      const [tx, ty] = this.centre(to);
      const back = Math.sign(tx - fx) + Math.sign(ty - fy) * this.board.w;
      start = to - back;
    }
    const { d, ex, ey, angle } = this.route(start, to, far ? 30 : 45, far ? 30 : 27);
    const draw = animate && !reducedMotion() ? ' draw' : '';
    this.trails.insertAdjacentHTML(
      'beforeend',
      `<path class="trail${far ? ' far' : ''}${draw}" pathLength="1" d="${d}"/>` +
        `<path class="trail-tip${draw}" transform="translate(${ex} ${ey}) rotate(${angle})" d="M7 0-6-8v16Z"/>`,
    );
  }

  /** Restores earlier whispers with no animation. */
  restore(whispers: readonly number[]): void {
    this.state = freshState(this.board);
    this.trails.innerHTML = '';
    this.clearLeft();
    for (const index of whispers) {
      for (const round of whisper(this.board, this.state, index)) {
        for (const tell of round) if (tell.lands) this.trail(tell.from, tell.to, false);
      }
    }
    this.tiles.forEach((el, i) => {
      if (!el) return;
      el.classList.toggle('knows', Boolean(this.state.knows[i]));
      el.classList.toggle('half', !this.state.knows[i] && (this.state.heard[i] ?? 0) > 0);
      this.label(i);
    });
  }

  private inform(index: number): void {
    const el = this.tiles[index];
    if (!el) return;
    el.classList.remove('half');
    el.classList.add('knows', 'pop');
    setTimeout(() => el.classList.remove('pop'), 420);
    sound.pluck(this.notes++);
    this.label(index);
    this.ring(index);
    if (this.notes % 2 === 1) this.say(index, GASPS[(index + this.notes) % GASPS.length] as string);
  }

  /** A little reaction floats up from a villager. */
  private say(index: number, text: string): void {
    if (reducedMotion()) return;
    const [x, y] = this.centre(index);
    const bubble = document.createElement('i');
    bubble.className = 'say';
    bubble.textContent = text;
    bubble.style.left = `${x / this.board.w}cqw`;
    bubble.style.top = `${(y - 38) / this.board.w}cqw`;
    this.fx.append(bubble);
    bubble
      .animate(
        [
          { opacity: 0, translate: '-50% 0', scale: 0.6 },
          { opacity: 1, translate: '-50% -70%', scale: 1, offset: 0.25 },
          { opacity: 1, translate: '-50% -90%', scale: 1, offset: 0.75 },
          { opacity: 0, translate: '-50% -130%', scale: 0.9 },
        ],
        { duration: 900, easing: 'ease-out' },
      )
      .finished.finally(() => bubble.remove());
  }

  /** A ripple under a villager the moment they hear it. */
  private ring(index: number): void {
    if (reducedMotion()) return;
    const [x, y] = this.centre(index);
    const ring = document.createElement('i');
    ring.className = 'ring';
    ring.style.left = `${x / this.board.w}cqw`;
    ring.style.top = `${y / this.board.w}cqw`;
    this.fx.append(ring);
    ring
      .animate(
        [
          { scale: 0.35, opacity: 0.85 },
          { scale: 1.55, opacity: 0 },
        ],
        { duration: 520, easing: 'ease-out' },
      )
      .finished.finally(() => ring.remove());
  }

  private dart(from: number, to: number, ms: number): void {
    if (reducedMotion()) return;
    const [x1, y1] = this.centre(from);
    const [x2, y2] = this.centre(to);
    const dot = document.createElement('i');
    dot.className = 'dart';
    this.fx.append(dot);
    const at = (x: number, y: number) => `translate(${x / this.board.w}cqw, ${y / this.board.w}cqw)`;
    dot
      .animate(
        [
          { transform: `${at(x1, y1)} scale(.6)`, opacity: 0.9 },
          { transform: `${at(x2, y2)} scale(1.1)`, opacity: 1 },
        ],
        { duration: ms, easing: 'cubic-bezier(.3,.7,.4,1)' },
      )
      .finished.finally(() => dot.remove());
  }

  /** Whispers to `index` and plays the rumor out. Resolves when the town is quiet again. */
  async play(index: number, onCount: (known: number) => void): Promise<void> {
    this.busy = true;
    this.hurry = false;
    this.notes = Math.min(this.known, 6);
    this.select(null);
    this.clearLeft();
    this.el.classList.add('live');
    const rounds = whisper(this.board, this.state, index);
    let known = this.known - rounds.flat().filter((tell) => tell.lands).length;
    this.inform(index);
    onCount(known);
    for (const round of rounds) {
      const pace = this.hurry || reducedMotion() ? 60 : Math.max(170, 300 - rounds.length * 6);
      for (const tell of round) {
        this.tiles[tell.from]?.classList.add('telling');
        this.dart(tell.from, tell.to, pace * 0.8);
      }
      await sleep(pace);
      for (const tell of round) {
        this.tiles[tell.from]?.classList.remove('telling');
        const el = this.tiles[tell.to];
        if (tell.lands) {
          known++;
          this.trail(tell.from, tell.to, true);
          this.inform(tell.to);
        } else if (el && !el.classList.contains('knows')) {
          el.classList.add('half', 'doubt');
          setTimeout(() => el.classList.remove('doubt'), 400);
          sound.doubt();
          this.label(tell.to);
        }
      }
      onCount(known);
    }
    await sleep(this.hurry ? 80 : 260);
    this.el.classList.remove('live');
    this.busy = false;
  }

  /** After a whisper fizzles: point out who is still in the dark. */
  markLeft(): void {
    const left: number[] = [];
    this.tiles.forEach((el, i) => {
      if (!el) return;
      const out = !this.state.knows[i];
      el.classList.toggle('left', out);
      if (out) left.push(i);
    });
    left
      .filter((_, n) => n % Math.max(1, Math.ceil(left.length / 3)) === 0)
      .slice(0, 3)
      .forEach((index, n) => setTimeout(() => this.say(index, ASKS[(index + n) % ASKS.length] as string), 200 + n * 220));
  }

  clearLeft(): void {
    this.tiles.forEach((el) => el?.classList.remove('left'));
  }

  /** Stamps a short verdict across the board, then lifts it away. */
  banner(big: string, small: string, tone: 'win' | 'miss'): void {
    this.fx.querySelector('.banner')?.remove();
    const el = document.createElement('div');
    el.className = `banner ${tone}`;
    const title = document.createElement('b');
    title.textContent = big;
    const sub = document.createElement('span');
    sub.textContent = small;
    el.append(title, sub);
    this.fx.append(el);
    const hold = tone === 'win' ? 1500 : 1250;
    if (reducedMotion()) {
      setTimeout(() => el.remove(), hold);
      return;
    }
    el.animate(
      [
        { opacity: 0, scale: 1.7, rotate: '-10deg' },
        { opacity: 1, scale: 1, rotate: '-4deg', offset: 0.16 },
        { opacity: 1, scale: 1, rotate: '-4deg', offset: 0.8 },
        { opacity: 0, scale: 0.92, rotate: '-4deg' },
      ],
      { duration: hold, easing: 'cubic-bezier(.2,.9,.3,1)' },
    ).finished.finally(() => el.remove());
  }

  /** After the town is solved: crown the perfect whisper and show where the crowd started. */
  reveal(perfect: readonly number[], first: Record<string, number>): void {
    this.select(null);
    this.clearLeft();
    this.el.classList.add('solved');
    for (const index of perfect) {
      const el = this.tiles[index];
      if (el && !el.querySelector('.crown')) {
        el.classList.add('answer');
        el.insertAdjacentHTML(
          'beforeend',
          '<svg class="crown" viewBox="0 0 40 26" aria-hidden="true"><path d="M3 23 1 6l10 8L20 2l9 12 10-8-2 17Z"/></svg>',
        );
      }
    }
    const most = Math.max(1, ...Object.values(first));
    for (const [index, count] of Object.entries(first)) {
      const el = this.tiles[Number(index)];
      if (!el || !count) continue;
      el.querySelector('.firsts')?.remove();
      const badge = document.createElement('span');
      badge.className = 'firsts';
      badge.textContent = String(count);
      badge.style.setProperty('--heat', String(0.35 + 0.65 * (count / most)));
      el.append(badge);
    }
  }

  celebrate(): void {
    if (reducedMotion()) return;
    const colours = ['var(--hot)', 'var(--ink)', 'var(--sun)', 'var(--gossip)', 'var(--crier)'];
    for (let i = 0; i < 70; i++) {
      const bit = document.createElement('i');
      bit.className = 'bit';
      bit.style.background = colours[i % colours.length] as string;
      bit.style.left = `${Math.random() * 100}%`;
      this.fx.append(bit);
      const drift = (Math.random() - 0.5) * 160;
      bit
        .animate(
          [
            { transform: 'translate(0,-20px) rotate(0deg)', opacity: 1 },
            { transform: `translate(${drift}px, ${this.el.clientHeight + 40}px) rotate(${720 * Math.random()}deg)`, opacity: 0.9 },
          ],
          { duration: 1300 + Math.random() * 900, delay: Math.random() * 350, easing: 'cubic-bezier(.2,.6,.6,1)' },
        )
        .finished.finally(() => bit.remove());
    }
    // The whole town jumps for joy, in a wave.
    this.tiles.forEach((el) => {
      if (!el) return;
      el.classList.add('cheer');
      setTimeout(() => el.classList.remove('cheer'), 1800);
    });
  }
}
