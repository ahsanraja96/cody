/** A tiny synth: no audio files, nothing plays before the first tap. */
const SCALE = [0, 2, 4, 7, 9];
const KEY = 'psst:muted';

let audio: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem(KEY) === '1';
} catch {
  /* storage can be unavailable in a web view */
}

export const isMuted = (): boolean => muted;

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(KEY, next ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (next) void audio?.suspend();
}

/** Call from a tap handler so the browser allows sound. */
export function wake(): void {
  if (muted) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) void audio?.suspend();
});

function tone(freq: number, at: number, length: number, type: OscillatorType, gain: number): void {
  if (!audio || muted || audio.state !== 'running') return;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  const start = audio.currentTime + at;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(amp).connect(audio.destination);
  osc.start(start);
  osc.stop(start + length + 0.03);
}

const pitch = (stepIndex: number): number => {
  const octave = Math.floor(stepIndex / SCALE.length);
  const semitone = (SCALE[stepIndex % SCALE.length] as number) + 12 * octave;
  return 293.66 * 2 ** (semitone / 12);
};

/** Each villager who hears it plays the next note up, so a long chain climbs. */
export function pluck(count: number): void {
  const note = pitch(Math.min(count, 19));
  tone(note, 0, 0.22, 'triangle', 0.16);
  tone(note * 2, 0, 0.09, 'sine', 0.05);
}

export const tap = (): void => tone(520, 0, 0.06, 'sine', 0.08);
export const doubt = (): void => tone(196, 0, 0.16, 'square', 0.035);

export function fizzle(): void {
  tone(330, 0, 0.18, 'triangle', 0.1);
  tone(247, 0.14, 0.3, 'triangle', 0.1);
}

export function bells(): void {
  [0, 4, 7, 12, 7, 12, 16].forEach((semitone, i) => {
    const freq = 392 * 2 ** (semitone / 12);
    tone(freq, i * 0.11, 0.9, 'sine', 0.12);
    tone(freq * 2.01, i * 0.11, 0.5, 'sine', 0.04);
  });
}
