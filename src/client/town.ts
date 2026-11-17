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
  type TownState,
} from '../shared/engine.ts';
import { treeSvg, villagerSvg } from './art.ts';
import * as sound from './sound.ts';

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const GASPS = ['psst!', 'no!', 'really?', 'gasp!', 'never!', 'ooh!', 'who said?', 'I knew it'];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TownView {
  readonly el: HTMLElement;
  readonly board: Board;
  readonly total: number;
  state: TownState;
  selected: number | null = null;
  busy = false;
  onSelect: (index: number | null) => void = () => undefined;

  private readonly tiles: (HTMLElement | null)[] = [];
  private readonly wires: SVGSVGElement;
  private readonly fx: HTMLElement;
  private hurry = false;
  private notes = 0;

  constructor(private readonly data: InitResponse) {
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
      if (!tile) {
        const tree = document.createElement('div');
        tree.className = 'tile tree';
        tree.innerHTML = treeSvg(i);
        this.el.append(tree);
        this.tiles.push(null);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tile folk ${tile.kind}${tile.me ? ' me' : ''}`;
      button.dataset.i = String(i);
      button.innerHTML = villagerSvg(tile, seals.get(i) ?? 0);
      if (tile.avatar) this.addFace(button, tile.avatar);
      button.addEventListener('click', () => this.tap(i));
      this.el.append(button);
      this.tiles.push(button);
      this.label(i);
    });

    this.wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.wires.setAttribute('class', 'wires');
    this.wires.setAttribute('viewBox', `0 0 ${data.w * 100} ${data.h * 100}`);
    this.wires.setAttribute('aria-hidden', 'true');
    this.fx = document.createElement('div');
    this.fx.className = 'fx';
    this.el.append(this.wires, this.fx);
    this.el.addEventListener('pointerdown', () => {
      if (this.busy) this.hurry = true;
    });
  }

  get known(): number {
    return knowCount(this.state);
  }

  tile(index: number): TileView {
    return this.data.tiles[index] as TileView;
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
      el?.classList.remove('target');
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

  private wire(from: number, to: number): void {
    const [x1, y1] = this.centre(from);
    const [x2, y2] = this.centre(to);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / length;
    const uy = (y2 - y1) / length;
    const far = this.tile(from).kind === 'penpal' && to === this.tile(from).pal;
    const sx = x1 + ux * 34;
    const sy = y1 + uy * 34;
    const ex = x2 - ux * 30;
    const ey = y2 - uy * 30;
    const bend = far ? 0.22 * length : 0;
    const cx = (sx + ex) / 2 - uy * bend;
    const cy = (sy + ey) / 2 + ux * bend;
    const path = `M${sx} ${sy}Q${cx} ${cy} ${ex} ${ey}`;
    const angle = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
    this.wires.insertAdjacentHTML(
      'beforeend',
      `<path class="wire under" d="${path}"/><path class="wire${far ? ' far' : ''}" d="${path}"/>` +
        `<path class="wire-tip" transform="translate(${ex} ${ey}) rotate(${angle})" d="M10 0-10-13v26Z"/>`,
    );
  }

  /** Restores earlier whispers with no animation. */
  restore(whispers: readonly number[]): void {
    this.state = freshState(this.board);
    for (const index of whispers) whisper(this.board, this.state, index);
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
    if (this.notes % 3 === 1) this.say(index);
  }

  /** A little reaction floats up from every few villagers who hear it. */
  private say(index: number): void {
    if (reducedMotion()) return;
    const [x, y] = this.centre(index);
    const bubble = document.createElement('i');
    bubble.className = 'say';
    bubble.textContent = GASPS[(index + this.notes) % GASPS.length] as string;
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

  /** After the town is solved: crown the perfect whisper and show where the crowd started. */
  reveal(perfect: readonly number[], first: Record<string, number>): void {
    this.select(null);
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
    const colours = ['var(--hot)', 'var(--ink)', 'var(--sun)'];
    for (let i = 0; i < 46; i++) {
      const bit = document.createElement('i');
      bit.className = 'bit';
      bit.style.background = colours[i % 3] as string;
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
  }
}
