import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiFailed,
  cleanTabs,
  clip,
  createModel,
  InvalidOutput,
  readName,
  readOrganise,
  readSummary,
  type AiTab,
  type CallJson,
} from '../../server/supabase/functions/tabfold/ai.ts';
import { RUN_LIMIT_REACHED } from '../../server/supabase/functions/tabfold/app.ts';
import { createServer, NOW, type Server } from './fakes';

const tab = (n: number, extra: Partial<AiTab> = {}): AiTab => ({
  id: `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`,
  title: `Tab ${n}`,
  host: `site${n % 3}.example.com`,
  ...extra,
});
const tabs = (count: number) => Array.from({ length: count }, (_, i) => tab(i + 1));

/** The user prompt of the nth model call. */
const promptOf = (callJson: ReturnType<typeof vi.fn<CallJson>>, call = 0) => callJson.mock.calls[call]![1];

describe('input checks', () => {
  it('keeps at most 300 tabs, each id once, titles cut to 200 characters', () => {
    const input = [tab(1), tab(1, { title: 'Again' }), ...tabs(400).slice(1)];
    input[2] = tab(2, { title: `  ${'é'.repeat(250)}\n`, host: ' Docs.Example.COM ' });
    const clean = cleanTabs(input)!;
    expect(clean).toHaveLength(300);
    expect(new Set(clean.map((t) => t.id)).size).toBe(300);
    expect(clean[0]!.title).toBe('Tab 1');
    expect(clean[1]).toEqual({ id: tab(2).id, title: 'é'.repeat(200), host: 'docs.example.com' });
  });

  it('cuts by characters, never splitting an emoji', () => {
    const [clean] = cleanTabs([tab(1, { title: '😀'.repeat(201) })])!;
    expect(Array.from(clean!.title)).toHaveLength(200);
    expect(clean!.title).toBe('😀'.repeat(200));
  });

  it.each([
    ['not a list', { id: 'a' }],
    ['a tab without an id', [{ title: 'x', host: 'y' }]],
    ['an empty id', [{ id: '', title: 'x', host: 'y' }]],
    ['a title that isn’t text', [{ id: 'a', title: 5, host: 'y' }]],
    ['a tab that isn’t an object', ['a']],
  ])('refuses %s', (_name, raw) => {
    expect(cleanTabs(raw)).toBeNull();
  });
});

describe('output checks', () => {
  const sent = tabs(6);

  it('keeps only sent tabs, each once, and drops empty groups', () => {
    const groups = readOrganise(
      {
        groups: [
          { name: 'Checkout app', tabs: [1, 2, 99, 0, -1, 2.5, 2] },
          { name: 'Holiday in Lisbon', tabs: [3, 1, 4] },
          { name: 'Nothing real', tabs: [42, 1] },
          { name: 'Empty', tabs: [] },
        ],
      },
      sent,
    );
    expect(groups).toEqual([
      { name: 'Checkout app', tabIds: [sent[0]!.id, sent[1]!.id] },
      { name: 'Holiday in Lisbon', tabIds: [sent[2]!.id, sent[3]!.id] },
    ]);
  });

  it('ignores ids given as text (the model only knows numbers)', () => {
    const groups = readOrganise({ groups: [{ name: 'A', tabs: [sent[0]!.id, 1] }, { name: 'B', tabs: ['2', 2] }] }, sent);
    expect(groups.map((g) => g.tabIds)).toEqual([[sent[0]!.id], [sent[1]!.id]]);
  });

  it('cuts names to 32 characters and merges groups with the same name', () => {
    const groups = readOrganise(
      {
        groups: [
          { name: '  “A very long project name that goes on and on”  ', tabs: [1] },
          { name: 'Taxes', tabs: [2] },
          { name: 'taxes ', tabs: [3] },
        ],
      },
      sent,
    );
    expect(groups[0]!.name.length).toBeLessThanOrEqual(32);
    expect(groups[0]!.name).toBe('A very long project name that');
    expect(groups[1]).toEqual({ name: 'Taxes', tabIds: [sent[1]!.id, sent[2]!.id] });
  });

  it('keeps the 8 largest of more than 8 groups, in the model’s order', () => {
    const many = tabs(20);
    const raw = {
      groups: [
        { name: 'G1', tabs: [1] },
        ...Array.from({ length: 8 }, (_, i) => ({ name: `Big ${i}`, tabs: [2 * i + 2, 2 * i + 3] })),
        { name: 'G10', tabs: [19] },
      ],
    };
    const groups = readOrganise(raw, many);
    expect(groups.map((g) => g.name)).toEqual(Array.from({ length: 8 }, (_, i) => `Big ${i}`));
  });

  it.each([
    ['no groups', {}],
    ['one group', { groups: [{ name: 'Only', tabs: [1, 2, 3] }] }],
    ['groups of invented tabs only', { groups: [{ name: 'A', tabs: [10] }, { name: 'B', tabs: [11] }] }],
    ['a group without a name', { groups: [{ name: '  ', tabs: [1] }, { name: 'B', tabs: [2] }] }],
    ['a malformed group', { groups: [{ name: 'A' }, { name: 'B', tabs: [2] }] }],
    ['text', 'Here are your groups'],
  ])('refuses %s', (_name, raw) => {
    expect(() => readOrganise(raw, sent)).toThrow(InvalidOutput);
  });

  it('keeps names under 40 and summaries under 300 characters', () => {
    expect(readName({ name: 'Checkout app · Stripe webhooks' })).toBe('Checkout app · Stripe webhooks');
    const long = readName({ name: 'Planning the kitchen renovation with quotes from three builders' });
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe('Planning the kitchen renovation with');
    const summary = readSummary({ summary: 'word '.repeat(100) });
    expect(Array.from(summary).length).toBeLessThanOrEqual(300);
    expect(summary.endsWith('…')).toBe(true);
    expect(() => readName({ name: '' })).toThrow(InvalidOutput);
    expect(() => readSummary({ text: 'x' })).toThrow(InvalidOutput);
  });

  it('clips at a word break near the end', () => {
    expect(clip('Holiday in Lisbon', 32)).toBe('Holiday in Lisbon');
    expect(clip('Holiday   in\nLisbon', 10)).toBe('Holiday in');
    expect(clip('Supercalifragilistic', 5)).toBe('Super');
  });
});

describe('the model wrapper', () => {
  const good = { groups: [{ name: 'A', tabs: [1] }, { name: 'B', tabs: [2] }] };

  it('sends only titles and sites, numbered, never ids or addresses', async () => {
    const callJson = vi.fn<CallJson>().mockResolvedValue(good);
    await createModel(callJson).organise([tab(1, { title: 'Stripe webhooks' }), tab(2, { host: 'github.com' })]);
    const [system, user, schema] = callJson.mock.calls[0]!;
    expect(system).toContain('project');
    expect(user).toContain('1. [site1.example.com] Stripe webhooks');
    expect(user).toContain('2. [github.com] Tab 2');
    expect(user).not.toContain(tab(1).id);
    expect(user).not.toContain('http');
    expect(schema).toMatchObject({ type: 'object', required: ['groups'], additionalProperties: false });
  });

  it('asks once more after an invalid answer', async () => {
    const callJson = vi.fn<CallJson>().mockResolvedValueOnce({ groups: [] }).mockResolvedValueOnce(good);
    const groups = await createModel(callJson).organise(tabs(2));
    expect(groups).toHaveLength(2);
    expect(callJson).toHaveBeenCalledTimes(2);
  });

  it('asks once more after a failed call', async () => {
    const callJson = vi.fn<CallJson>().mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON')).mockResolvedValueOnce({ name: 'Taxes' });
    expect(await createModel(callJson).name(tabs(2))).toBe('Taxes');
  });

  it('gives up after two bad answers', async () => {
    const callJson = vi.fn<CallJson>().mockResolvedValue({ groups: 'none' });
    await expect(createModel(callJson).organise(tabs(3))).rejects.toThrow(AiFailed);
    expect(callJson).toHaveBeenCalledTimes(2);
  });

  it('doesn’t retry a refusal', async () => {
    const callJson = vi.fn<CallJson>().mockRejectedValue(new AiFailed('refused'));
    await expect(createModel(callJson).context('Taxes', tabs(2))).rejects.toThrow('refused');
    expect(callJson).toHaveBeenCalledTimes(1);
  });

  it('gives the context task the group’s name', async () => {
    const callJson = vi.fn<CallJson>().mockResolvedValue({ summary: 'Filing the 2026 tax return.' });
    expect(await createModel(callJson).context('Taxes 2026', tabs(2))).toBe('Filing the 2026 tax return.');
    expect(callJson.mock.calls[0]![1]).toContain('Group name: Taxes 2026');
  });
});

describe('POST /ai', () => {
  let server: Server;
  const ai = (body: unknown, key = 'proAiMonthly') => server.request('POST', '/ai', { key, body });

  beforeEach(() => {
    server = createServer();
  });

  describe('organise', () => {
    it('returns groups by the ids sent and counts one run', async () => {
      server.callJson.mockResolvedValue({
        groups: [
          { name: 'Checkout app', tabs: [1, 3, 77] },
          { name: 'Holiday in Lisbon', tabs: [2, 1] },
        ],
      });
      const sent = tabs(4);
      const res = await ai({ task: 'organise', tabs: sent });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        groups: [
          { name: 'Checkout app', tabIds: [sent[0]!.id, sent[2]!.id] },
          { name: 'Holiday in Lisbon', tabIds: [sent[1]!.id] },
        ],
        runs: { used: 1, limit: 300, resetsAt: Date.UTC(2026, 10, 1) },
      });
      expect(await server.store.usageOf('ai@example.com')).toEqual({ runs: 1, light: 0 });
    });

    it('sends at most 300 tabs with titles cut to 200 characters', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'A', tabs: [1] }, { name: 'B', tabs: [300, 301] }] });
      const many = tabs(350);
      many[0] = tab(1, { title: 'T'.repeat(500) });
      const res = await ai({ task: 'organise', tabs: many });
      expect(res.status).toBe(200);
      const prompt = promptOf(server.callJson);
      expect(prompt.match(/^\d+\. /gm)).toHaveLength(300);
      expect(prompt).toContain(`1. [site1.example.com] ${'T'.repeat(200)}\n`);
      expect(prompt).not.toContain('T'.repeat(201));
      expect(res.json.groups[1].tabIds).toEqual([many[299]!.id]);
    });

    it('doesn’t count a run when the answer is invalid twice (502)', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'Only one', tabs: [1, 2] }] });
      const res = await ai({ task: 'organise', tabs: tabs(3) });
      expect(res.status).toBe(502);
      expect(res.json).toEqual({ error: 'ai-failed', message: expect.any(String) });
      expect(server.callJson).toHaveBeenCalledTimes(2);
      expect(await server.store.usageOf('ai@example.com')).toEqual({ runs: 0, light: 0 });
    });

    it('doesn’t count a refused run (502 after one call)', async () => {
      server.callJson.mockRejectedValue(new AiFailed('refused'));
      const res = await ai({ task: 'organise', tabs: tabs(3) });
      expect(res.status).toBe(502);
      expect(server.callJson).toHaveBeenCalledTimes(1);
      expect((await server.store.usageOf('ai@example.com')).runs).toBe(0);
    });

    it('never logs tab titles', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'Secret project', tabs: [1] }] });
      await ai({ task: 'organise', tabs: [tab(1, { title: 'Secret title' }), tab(2)] });
      expect(server.log).toHaveBeenCalled();
      expect(JSON.stringify(server.log.mock.calls)).not.toMatch(/Secret/);
    });

    it('stops at 300 runs a month with 429 and the runs', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'A', tabs: [1] }, { name: 'B', tabs: [2] }] });
      await server.store.setUsage('ai@example.com', { runs: 299 });
      const last = await ai({ task: 'organise', tabs: tabs(2) });
      expect(last.json.runs.used).toBe(300);
      const res = await ai({ task: 'organise', tabs: tabs(2) });
      expect(res.status).toBe(429);
      expect(res.json).toEqual({
        error: 'runs-used-up',
        message: expect.stringContaining('1 November'),
        runs: { used: 300, limit: 300, resetsAt: Date.UTC(2026, 10, 1) },
      });
      expect(server.callJson).toHaveBeenCalledTimes(1);
    });

    it('starts again on the 1st (UTC)', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'A', tabs: [1] }, { name: 'B', tabs: [2] }] });
      await server.store.setUsage('ai@example.com', { runs: 300 });
      server.clock.now = Date.UTC(2026, 10, 1, 0, 0, 0);
      const res = await ai({ task: 'organise', tabs: tabs(2) });
      expect(res.json.runs).toEqual({ used: 1, limit: 300, resetsAt: Date.UTC(2026, 11, 1) });
    });

    it('answers 429 when another computer took the last run meanwhile', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'A', tabs: [1] }, { name: 'B', tabs: [2] }] });
      server.store.takeRun = vi.fn().mockResolvedValue(RUN_LIMIT_REACHED);
      const res = await ai({ task: 'organise', tabs: tabs(2) });
      expect(res.status).toBe(429);
      expect(res.json.runs.used).toBe(300);
    });

    it('needs at least two tabs', async () => {
      expect((await ai({ task: 'organise', tabs: tabs(1) })).status).toBe(400);
      expect(server.callJson).not.toHaveBeenCalled();
    });

    it('works during the trial', async () => {
      server.callJson.mockResolvedValue({ groups: [{ name: 'A', tabs: [1] }, { name: 'B', tabs: [2] }] });
      const res = await ai({ task: 'organise', tabs: tabs(2) }, 'trialRunning');
      expect(res.status).toBe(200);
      expect(res.json.runs.used).toBe(1);
    });
  });

  describe('name and context', () => {
    it('names a fold without counting a run', async () => {
      server.callJson.mockResolvedValue({ name: 'Checkout app · Stripe webhooks and more words here' });
      const res = await ai({ task: 'name', tabs: tabs(3) });
      expect(res.status).toBe(200);
      expect(res.json.name.length).toBeLessThanOrEqual(40);
      expect(await server.store.usageOf('ai@example.com')).toEqual({ runs: 0, light: 1 });
    });

    it('summarises a group for Copy as context', async () => {
      server.callJson.mockResolvedValue({ summary: 'Building the checkout for the shop with Stripe.' });
      const res = await ai({ task: 'context', name: 'Checkout app', tabs: tabs(3) });
      expect(res.json).toEqual({ summary: 'Building the checkout for the shop with Stripe.' });
      expect(await server.store.usageOf('ai@example.com')).toEqual({ runs: 0, light: 1 });
    });

    it('caps names and summaries at 1,000 a month together', async () => {
      server.callJson.mockResolvedValue({ name: 'Taxes' });
      await server.store.setUsage('ai@example.com', { runs: 7, light: 999 });
      expect((await ai({ task: 'name', tabs: tabs(2) })).status).toBe(200);
      const res = await ai({ task: 'context', name: 'Taxes', tabs: tabs(2) });
      expect(res.status).toBe(429);
      expect(res.json.error).toBe('runs-used-up');
      expect(res.json.runs.used).toBe(7);
      expect(server.callJson).toHaveBeenCalledTimes(1);
    });

    it('doesn’t count a failed name', async () => {
      server.callJson.mockResolvedValue({ name: '   ' });
      expect((await ai({ task: 'name', tabs: tabs(2) })).status).toBe(502);
      expect((await server.store.usageOf('ai@example.com')).light).toBe(0);
    });
  });

  it.each([
    ['an unknown task', { task: 'translate', tabs: tabs(2) }],
    ['no tabs', { task: 'name' }],
    ['an empty list', { task: 'name', tabs: [] }],
    ['malformed tabs', { task: 'name', tabs: [{ id: 1 }] }],
    ['context without a name', { task: 'context', tabs: tabs(2) }],
    ['a list body', [1]],
  ])('refuses %s with 400', async (_name, body) => {
    const res = await ai(body);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('server');
    expect(server.callJson).not.toHaveBeenCalled();
  });

  it('uses the month of the request (UTC) for counting', async () => {
    server.callJson.mockResolvedValue({ name: 'Taxes' });
    server.clock.now = NOW;
    await ai({ task: 'name', tabs: tabs(2) });
    expect([...server.store.usage.keys()]).toEqual(['account-1|2026-10']);
  });
});
