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
