// Suggest merges (suggest.ts) with a stand-in for Claude Code: a small script that answers good
// JSON, JSON in a fence, bad JSON, an error, or nothing in time. Nothing here runs the real agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from './store.ts'
import { stubAgent } from './test/stub-agent.ts'
import { AGENT_ARGS, agentTasks, dismissSuggestion, NOTES_CHARS, claudeCandidates, pairKeys, parseSuggestions, readDismissed, SuggestError, suggestMerges, suggestPrompt, withoutDismissed, type AgentTask } from './suggest.ts'

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-suggest-'))
  const store = new TaskStore({ home })
  const memo = (await store.add({ title: 'Send the board memo', notes: 'x'.repeat(NOTES_CHARS + 50), source: 'chat:1', tags: ['board'], project: 'planning' })).task
  const memo2 = (await store.add({ title: 'Board memo: send it to Bob', source: 'meeting:q4' })).task
  const other = (await store.add({ title: 'Reply to Alice' })).task
  const done = await store.setDone((await store.add({ title: 'Old memo' })).task.id, true)
  const agent = await stubAgent(home)
  const seen = join(home, 'seen.json')
  return { home, store, memo, memo2, other, done, agent, seen, env: (mode: string) => ({ ...process.env, STUB_MODE: mode, STUB_SEEN: seen }), stop: () => rm(home, { recursive: true, force: true }) }
}

test('only open tasks go to the agent, with only their title, notes (cut), sources, tags, project, due and status', async () => {
  const t = await setup()
  try {
    const tasks = (await t.store.read()).tasks
    const { tasks: given, leftOut } = agentTasks(tasks)
    assert.equal(leftOut, 0)
    assert.deepEqual(given.map((g) => g.id).sort(), [t.memo.id, t.memo2.id, t.other.id].sort(), 'not the done one')
    const memo = given.find((g) => g.id === t.memo.id) as AgentTask
    assert.deepEqual(Object.keys(memo).sort(), ['due', 'id', 'notes', 'project', 'sources', 'status', 'tags', 'title'])
    assert.equal(memo.notes.length, NOTES_CHARS + 1, 'notes cut short')
    assert.deepEqual([memo.sources, memo.tags, memo.project, memo.status], [['chat:1'], ['board'], 'planning', 'To Do'])
    assert.equal(agentTasks(tasks, 2).leftOut, 1, 'at most MAX_TASKS, the most recently changed')
    const prompt = suggestPrompt(given)
    assert.match(prompt, /Answer with JSON only/)
    assert.ok(prompt.includes(JSON.stringify(given)))
  } finally {
    await t.stop()
  }
})

test('good JSON: the groups, only known ids, keeper first; the agent runs with no tools, no MCP, in the temp folder', async () => {
  const t = await setup()
  try {
    const result = await suggestMerges((await t.store.read()).tasks, t.home, { command: t.agent, env: t.env('good') })
    assert.equal(result.considered, 3)
    assert.equal(result.suggestions.length, 1, 'a group with a made-up id and one real one is dropped')
    const [s] = result.suggestions
    assert.equal(s.ids.length, 2)
    assert.equal(s.ids[0], s.keep)
    assert.deepEqual([s.reason, s.confidence], ['Both ask for the Q4 memo', 0.92])
    const seen = JSON.parse(await readFile(t.seen, 'utf8'))
    assert.deepEqual(seen.args, AGENT_ARGS)
    assert.deepEqual(seen.args.slice(-2), ['--tools', ''], 'no tools: it cannot read files or run anything')
    assert.ok(seen.args.includes('--strict-mcp-config') && seen.args.includes('--no-session-persistence'))
    assert.ok(!seen.prompt.includes('Old memo'), 'closed tasks are not sent')
    assert.ok(!seen.prompt.includes(t.home), 'no paths')
    // Fenced and worded confidence.
    const fenced = await suggestMerges(await t.store.list(), t.home, { command: t.agent, env: t.env('fenced') })
    assert.deepEqual([fenced.suggestions.length, fenced.suggestions[0].confidence], [1, 0.9])
    assert.deepEqual((await suggestMerges(await t.store.list(), t.home, { command: t.agent, env: t.env('none') })).suggestions, [])
  } finally {
    await t.stop()
  }
})

test('bad JSON, an error, a timeout and a missing agent each say what happened', async () => {
  const t = await setup()
  const tasks = await t.store.list()
  const fails = async (options: Parameters<typeof suggestMerges>[2], code: string, message: RegExp) => {
    await assert.rejects(suggestMerges(tasks, t.home, options), (error: unknown) => error instanceof SuggestError && error.code === code && message.test(error.message))
  }
  try {
    await fails({ command: t.agent, env: t.env('bad') }, 'bad_json', /did not answer with the JSON it was asked for; it said: I think t-1/)
    await fails({ command: t.agent, env: t.env('fail') }, 'agent_failed', /stopped with an error: Invalid API key/)
    const started = Date.now()
    await fails({ command: t.agent, env: t.env('slow'), timeoutMs: 400 }, 'timeout', /did not answer within 0 s/)
    assert.ok(Date.now() - started < 10_000, 'stopped at the timeout')
    await fails({ command: join(t.home, 'no-such-claude'), env: t.env('good') }, 'agent_missing', /was not found\. Install Claude Code/)
    // Without a command: claude on PATH, then where Claude Code installs itself (Orca started from
    // the Dock has a short PATH). Not run here: it could be the real one.
    assert.deepEqual(claudeCandidates({ HOME: '/Users/me' }), ['claude', '/Users/me/.claude/local/claude', '/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
    // Fewer than two open tasks: nothing to compare, the agent is not run.
    assert.deepEqual((await suggestMerges(tasks.slice(0, 1), t.home, { command: join(t.home, 'no-such-claude') })).suggestions, [])
  } finally {
    await t.stop()
  }
})

test('parsing: shapes, confidences, overlaps and unknown ids', () => {
  const known = ['t-a', 't-b', 't-c', 't-d'].map((id) => ({ id }) as AgentTask)
  const parse = (value: unknown) => parseSuggestions(JSON.stringify(value), known)
  assert.deepEqual(parse([{ ids: ['t-a', 't-b'], keep: 't-b', reason: ' Same\n thing ', confidence: 80 }]), [{ ids: ['t-b', 't-a'], keep: 't-b', reason: 'Same thing', confidence: 0.8 }], 'a bare list, a percentage')
  assert.equal(parse({ groups: [{ ids: ['t-a', 't-b'], keep: 't-zzz' }] })[0].keep, 't-a', 'a keeper not in the group: the first')
  assert.equal(parse({ groups: [{ ids: ['t-a', 't-a'] }] }).length, 0, 'one task is no group')
  const overlap = parse({ groups: [{ ids: ['t-a', 't-b'], confidence: 0.6 }, { ids: ['t-b', 't-c'], confidence: 0.9 }, { ids: ['t-d', 't-a'], confidence: 0.55 }] })
  assert.deepEqual(overlap.map((s) => s.ids), [['t-b', 't-c'], ['t-d', 't-a']], 'each task in one group, the surer first')
  assert.throws(() => parseSuggestions('{"answer": 1}', known), /without a "groups" list/)
  assert.throws(() => parseSuggestions('', known), /it printed nothing/)
})

test('dismissed pairs do not come back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-dismiss-'))
  try {
    assert.deepEqual(pairKeys(['t-c', 't-a', 't-b']), ['t-a|t-b', 't-a|t-c', 't-b|t-c'])
    assert.equal((await readDismissed(home)).size, 0)
    await dismissSuggestion(home, ['t-b', 't-a'])
    const dismissed = await readDismissed(home)
    const s = (ids: string[]) => ({ ids, keep: ids[0], reason: '', confidence: 0.9 })
    const { shown, hidden } = withoutDismissed([s(['t-a', 't-b']), s(['t-b', 't-a']), s(['t-a', 't-b', 't-c']), s(['t-c', 't-d'])], dismissed)
    assert.deepEqual([shown.map((x) => x.ids), hidden], [[['t-a', 't-b', 't-c'], ['t-c', 't-d']], 2], 'a group with a task more is new')
    await dismissSuggestion(home, ['t-a', 't-b', 't-c'])
    assert.deepEqual([...(await readDismissed(home))].sort(), ['t-a|t-b', 't-a|t-c', 't-b|t-c'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('orca-tasks suggest-merges prints the groups and merges nothing; bad JSON and a missing agent fail with a reason', async () => {
  const { run } = await import('../cli.ts')
  const t = await setup()
  const cli = async (mode: string, ...args: string[]) => {
    let stdout = ''
    let stderr = ''
    const code = await run(['suggest-merges', ...args], { stdout: (x) => (stdout += x), stderr: (x) => (stderr += x), env: { ORCA_TASKS_HOME: t.home, ORCA_TASKS_SUGGEST_AGENT: t.agent, PATH: process.env.PATH, STUB_MODE: mode, STUB_SEEN: t.seen } })
    return { code, stdout, stderr }
  }
  try {
    const before = JSON.stringify((await t.store.read()).tasks)
    const text = await cli('good')
    assert.equal(text.code, 0, text.stderr)
    assert.match(text.stdout, /^1 likely duplicate group among 3 open tasks \(Claude Code\)\. Nothing is merged until you run merge:\n1\. Keep t-\S+ "[^"]+" \(92%\): Both ask for the Q4 memo\n {3}merge t-\S+ "[^"]+"\n {3}orca-tasks merge t-\S+ t-\S+\n$/)
    const json = JSON.parse((await cli('good', '--json')).stdout)
    assert.deepEqual([json.considered, json.suggestions.length, json.suggestions[0].confidence], [3, 1, 0.92])
    assert.equal(JSON.stringify((await t.store.read()).tasks), before, 'nothing merged')
    // Dismissed in the panel: not printed again.
    await dismissSuggestion(t.home, json.suggestions[0].ids)
    assert.match((await cli('good')).stdout, /^No likely duplicates among 3 open tasks \(Claude Code\)\.\n1 dismissed before, not shown\.\n$/)
    const bad = await cli('bad', '--json')
    assert.deepEqual([bad.code, JSON.parse(bad.stdout).error.code], [1, 'bad_json'])
    const slow = await cli('slow', '--timeout', '0.3')
    assert.equal(slow.code, 1)
    assert.match(slow.stderr, /^orca-tasks: Claude Code did not answer within 0 s/)
    assert.equal((await cli('good', '--timeout', 'soon')).code, 2)
    let said = ''
    const missing = await run(['suggest-merges'], { stdout: () => undefined, stderr: (x) => (said += x), env: { ORCA_TASKS_HOME: t.home, ORCA_TASKS_SUGGEST_AGENT: join(t.home, 'nope') } })
    assert.equal(missing, 1)
    assert.match(said, /was not found\. Install Claude Code/)
  } finally {
    await t.stop()
  }
})
