import { townFor } from '../src/shared/daily.ts';
import { reachFrom } from '../src/shared/engine.ts';
for (let day = 1; day <= 14; day++) {
  const town = townFor(day);
  const reach = town.board.tiles.flatMap((t, i) => (t && t.kind !== 'shy' ? [reachFrom(town.board, i).reach] : [])).sort((a, b) => a - b);
  const mean = reach.reduce((a, b) => a + b, 0) / reach.length / town.villagers;
  // expected whispers for a player who whispers at random among the unreached non-shy
  console.log(`day ${day} v=${town.villagers} perfect=${town.perfect.length} rounds=${town.rounds} mean=${(mean * 100).toFixed(0)}% :: ${reach.join(' ')}`);
}
