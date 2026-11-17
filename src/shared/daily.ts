/** Everything that changes from one day to the next: the town, the rumor, the cast. */
import type { Kind } from './engine.ts';
import { generateTown, type Recipe, type Town } from './generate.ts';
import { makeRng, shuffle } from './rng.ts';

/** Town #1 opened on this UTC day. A new town opens every midnight UTC. */
export const EPOCH_MS = Date.UTC(2026, 10, 17);
export const DAY_MS = 86_400_000;

export const dayNumber = (now: number): number => Math.floor((now - EPOCH_MS) / DAY_MS) + 1;
export const dayStart = (day: number): number => EPOCH_MS + (day - 1) * DAY_MS;
export const msUntilNextDay = (now: number): number => dayStart(dayNumber(now) + 1) - now;

export function dayLabel(day: number): string {
  return new Date(dayStart(day)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Sunday is the gentlest town; each day adds a little, and Saturday is the big one. */
const WEEK: Recipe[] = [
  { w: 5, h: 5, trees: 2, gossips: 2, criers: 0, skeptics: 0, shy: 2, pals: 0, perfect: [2, 4], rounds: [6, 12] },
  { w: 5, h: 5, trees: 2, gossips: 2, criers: 1, skeptics: 0, shy: 2, pals: 0, perfect: [1, 3], rounds: [6, 12] },
  { w: 5, h: 6, trees: 3, gossips: 2, criers: 1, skeptics: 1, shy: 2, pals: 0, perfect: [1, 2], rounds: [7, 14] },
  { w: 5, h: 6, trees: 3, gossips: 2, criers: 2, skeptics: 1, shy: 2, pals: 1, perfect: [1, 2], rounds: [7, 14] },
  { w: 6, h: 6, trees: 3, gossips: 3, criers: 2, skeptics: 2, shy: 3, pals: 1, perfect: [1, 1], rounds: [8, 15] },
  { w: 6, h: 6, trees: 3, gossips: 3, criers: 2, skeptics: 2, shy: 3, pals: 2, perfect: [1, 1], rounds: [8, 16] },
  { w: 6, h: 7, trees: 4, gossips: 3, criers: 3, skeptics: 3, shy: 3, pals: 2, perfect: [1, 1], rounds: [9, 17] },
];

export const DIFFICULTY = ['Sleepy', 'Easy', 'Breezy', 'Chatty', 'Tricky', 'Tangled', 'Uproar'] as const;

export const weekday = (day: number): number => new Date(dayStart(day)).getUTCDay();
export const recipeFor = (day: number): Recipe => WEEK[weekday(day)] as Recipe;
export const difficultyFor = (day: number): string => DIFFICULTY[weekday(day)] as string;

const towns = new Map<number, Town>();
export function townFor(day: number): Town {
  let town = towns.get(day);
  if (!town) {
    town = generateTown(`psst-town-${day}`, recipeFor(day));
    if (towns.size > 16) towns.clear();
    towns.set(day, town);
  }
  return town;
}

export const KIND_NAME: Record<Kind, string> = {
  whisperer: 'Whisperer',
  gossip: 'Gossip',
  crier: 'Town Crier',
  skeptic: 'Skeptic',
  shy: 'Bookworm',
  penpal: 'Pen Pal',
};

export const KIND_RULE: Record<Kind, string> = {
  whisperer: 'Tells the one neighbour they face.',
  gossip: 'Tells everyone standing next to them.',
  crier: 'Shouts down the whole row, as far as the next tree.',
  skeptic: 'Only believes it from two villagers. Your own whisper always convinces.',
  shy: 'Hears it, then goes back to the book. Tells no one.',
  penpal: 'Tells the neighbour they face and writes to their pen pal.',
};

const SUBJECTS = [
  'the mayor', 'the baker', 'the lighthouse keeper', 'the librarian', 'the new vicar', 'old Mabel',
  'the postman', 'the blacksmith', 'the cheesemonger', 'the schoolmaster', 'the town clerk',
  'the ferry captain', 'the beekeeper', 'the clockmaker', 'the choir director', 'the butcher',
  'the fishmonger', 'the florist', 'the night watchman', 'the only dentist in town', 'the barber',
  'the innkeeper', 'the tailor', 'the candle maker', 'the stable hand', 'the organist', 'the cobbler',
  'the miller', 'the tavern bard', 'Grandpa Otis', 'the mushroom forager', 'the pumpkin farmer',
  'the map maker', 'the bell ringer', 'the goose that guards the bridge', 'the scarecrow in the north field',
  'the travelling tinker', 'the well digger', 'the jam lady', 'the constable',
];

const CLAIMS = [
  'is really three raccoons in a long coat',
  'has been knitting tiny jumpers for the pigeons',
  'won the pie contest with a shop-bought pie',
  'has never finished a single book',
  'talks to the moon and says it answers',
  'keeps a second, secret hat under the first hat',
  'is training a goose to deliver the post',
  'sleeps standing up, like a horse',
  'buried a treasure and forgot where',
  'cannot whistle and has been faking it for years',
  'has a twin that nobody has seen in the same room',
  'is the one leaving turnips on every doorstep',
  'taught the church bell to ring off-key on purpose',
  'wins at cards by reading the dog’s face',
  'is afraid of the scarecrow, and the scarecrow knows',
  'writes love poems to a loaf of sourdough',
  'walks backwards on Tuesdays for luck',
  'is building a boat in the attic with no way to get it out',
  'sold the same goat four times this month',
  'swaps the sugar and the salt every April',
  'eats soup with a fork out of pure stubbornness',
  'thinks the well is haunted by a very polite ghost',
  'owns a map to a place that does not exist',
  'has been using the town fountain as a bathtub',
  'is in a long feud with one particular crow',
  'counts the same sheep each night and gets a new number',
  'hides the good biscuits when company comes',
  'takes secret dancing lessons behind the forge',
  'invented a new cheese and is too scared to taste it',
  'lost a staring contest to a portrait',
  'wears the same lucky socks to every wedding',
  'has given a name to every stone on the bridge',
  'keeps bees purely for the conversation',
  'moved the town clock forward to close up early',
  'reads every postcard before it is delivered',
  'is growing a pumpkin so big it needs its own address',
  'once clapped at the end of a sermon',
  'has rehearsed one surprise speech for nine years',
  'laughs at jokes a full day late',
  'is writing a tell-all book about the vegetable show',
  'owes money to the tooth fairy',
  'is composing an opera about the turnip shortage',
  'can only fall asleep with one boot on',
  'borrowed the bishop’s hat and wears it at home',
  'is banned from the cheese shop for excessive sampling',
  'has a favourite cloud and visits it daily',
  'claims to have invented the sandwich',
  'taught a parrot to say “no refunds”',
  'argues with the mirror, and loses',
  'paid for a cow with a very good drawing of money',
  'waters the wooden tulips every morning',
  'starts every single rumor in this town',
  'keeps a diary about everyone else’s diaries',
  'has never been to the next village, only heard it described',
  'is terrified of butterflies',
  'runs a midnight book club for owls',
  'wears a wig underneath the other wig',
  'says the wind is a personal friend',
  'has been repainting the town sign one letter a year',
  'trained the cat to fetch and tells no one',
  'keeps the lost-and-found for personal use',
  'once got lost in a one-room house',
  'has a cellar full of unopened birthday presents',
  'yodels in the bath and blames the neighbours',
];

/**
 * The three rumors the town votes between for a given day. Both lists are
 * walked in a fixed shuffled order so nothing repeats for weeks.
 */
const SUBJECT_ORDER = shuffle(makeRng('psst-subjects'), SUBJECTS);
const CLAIM_ORDER = shuffle(makeRng('psst-claims'), CLAIMS);
export function rumorChoices(day: number): string[] {
  return [0, 1, 2].map((k) => {
    const at = (day - 1) * 3 + k;
    const lap = Math.floor(at / CLAIM_ORDER.length);
    const subject = SUBJECT_ORDER[(at + lap * 7) % SUBJECT_ORDER.length] as string;
    return `${subject} ${CLAIM_ORDER[at % CLAIM_ORDER.length] as string}`;
  });
}

export const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const NAMES = [
  'Mabel', 'Otis', 'Agnes', 'Gus', 'Winnie', 'Barnaby', 'Dot', 'Enid', 'Clem', 'Hattie', 'Rufus', 'Pearl',
  'Silas', 'Maud', 'Ira', 'Nell', 'Cecil', 'Opal', 'Ferris', 'Tilly', 'Amos', 'Birdie', 'Hugo', 'Ines',
  'Jasper', 'Kit', 'Lottie', 'Mose', 'Nora', 'Orla', 'Percy', 'Queenie', 'Rollo', 'Sadie', 'Tobias', 'Una',
  'Vern', 'Wilma', 'Yara', 'Zeke', 'Flora', 'Basil', 'Greta', 'Hank', 'Ivy', 'Jonah', 'Lena', 'Milo',
  'Olive', 'Pip', 'Ruth', 'Sol', 'Tess', 'Abel', 'Bea', 'Cora', 'Dell', 'Edie', 'Finn', 'Gil',
];

/** A stable townsfolk name for every tile of a day's board. */
export function townsfolk(day: number, count: number): string[] {
  return shuffle(makeRng(`psst-names-${day}`), NAMES).slice(0, count);
}

/** A stable look (skin of the paper cut-out) for every tile. */
export function looks(day: number, count: number): number[] {
  const rng = makeRng(`psst-looks-${day}`);
  return Array.from({ length: count }, () => Math.floor(rng() * 1000));
}

/** Which tiles yesterday's solvers move into. Deterministic for a given guest list. */
export function seatGuests(day: number, tiles: readonly unknown[], guests: number): number[] {
  const seats = tiles.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  return shuffle(makeRng(`psst-seats-${day}`), seats).slice(0, guests);
}

export const TITLES = ['Perfect whisper', 'Smooth talker', 'Chatterbox', 'Busybody', 'Megaphone'] as const;
export const titleFor = (whispers: number): string =>
  TITLES[Math.min(whispers, TITLES.length) - 1] ?? TITLES[0];
