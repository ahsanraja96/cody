# Psst! — the daily rumor

A daily puzzle for Reddit, built on Devvit Web for the Game of the Day hackathon.

Every midnight (UTC) a new town opens with a new rumor. Whisper it to one
villager and watch it travel: whisperers tell the neighbour they face, gossips
tell everyone around them, town criers shout down the row, skeptics need to hear
it twice, pen pals write across town, and bookworms tell no one. One perfect
whisper always reaches the whole town. Fewer whispers is better.

What makes it a Reddit game:

- **The town is the community.** Solve today and you are cast as a villager in
  tomorrow's town, snoovatar and all.
- **The town writes its own rumors.** Each result page has a vote on tomorrow's rumor.
- **A new post every day**, with a comment thread, streak flair, a leaderboard,
  and a result you can post to the comments in one tap.
- Towns grow through the week: Sunday is a sleepy 5×5, Saturday is a 6×7 uproar.
- Devvit Journeys events are sent for ready, start, each whisper, and the finish.

## How to play

1. **Open today's post and press Play.** The post shows today's rumor and a small
   demo of it passing down a row of villagers.
2. **First time? Two tiny practice towns teach it by playing.** The first
   shows that a rumor follows the arrows. The second shows that the puzzle is
   choosing who hears it first. You can skip them, or replay them from the **?** button.
3. **Tap a villager.** A yellow path shows who they would tell, and the card under
   the town names them and explains what kind of villager they are.
4. **Press Whisper.** The rumor runs from villager to villager along the arrows.
   Everyone who hears it turns red, and the route it took stays drawn on the board.
5. **Reach the whole town.** If the rumor fizzles out, the villagers who missed it
   are outlined. Whisper again to one of them and carry on until everyone knows.
6. **Fewer whispers is better.** One whisper is a perfect solve and earns three
   stars. A second whisper costs a star, and three or more leaves you with one.
   Every town has at least one perfect whisper.

After the last villager hears it you get the front page of *The Daily Whisper*:
your stars, streak and best score, how many whispers other players needed, a vote
on tomorrow's rumor, the day's top whisperers, and a button that posts your result
to the comments. **See the town** shows the solved board with a crown on the
perfect whisper.

### Who's who

Special villagers stand on a coloured pad, and the chips under the town list every
kind living there today. Tap a chip to see its rule and make those villagers hop.

| Villager | What they do with a rumor |
| --- | --- |
| Whisperer | Tells the one neighbour they face. |
| Gossip | Tells everyone standing next to them. |
| Town Crier | Shouts down the whole row, as far as the next tree. |
| Skeptic | Only believes it from two villagers. Your own whisper always convinces. |
| Pen Pal | Tells the neighbour they face and writes to their pen pal across town. |
| Bookworm | Hears it, then goes back to the book. Tells no one. |

Trees are just trees, but a town crier cannot shout past one.

## Run it

Needs Node 24.18+.

```sh
npm install
npm run login      # once, connects your Reddit account
npm run dev        # playtest in your dev subreddit
npm run deploy     # checks, then uploads a private build
```

The app name in `devvit.json` is `psst-daily`; change it if that name is taken.
Installing the app posts today's town. After that a scheduled job posts a new one
at 00:00 UTC, and moderators can use **Psst! Open today's town** in the subreddit menu.

## Work on it without Reddit

```sh
npm run build && npm run local
```

Then open `http://localhost:5173/index.html?as=ann` (the feed view) or
`/game.html?as=ann&day=5&crowd=1` (the game, on day 5, with pretend players).
Leave out `as` to see the logged-out experience.

`npm run check` type-checks and runs the tests. `npx tsx tools/spread.ts` prints
how far every possible first whisper travels in upcoming towns, which is how the
generator's difficulty was tuned.

## Layout

- `src/shared` — the rules, the town generator, and daily content. Runs on both sides.
- `src/server` — Express routes and game state in Redis. The server replays every whisper.
- `src/client` — the web view. No framework; villagers are inline SVG.
- `tools` — local preview server and an in-memory Redis/Reddit used by the tests.

Typeface: Fraunces, SIL Open Font License (see `src/client/fonts`).
