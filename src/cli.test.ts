// The CLI as agents use it. Plain node:test, so CI runs it with Node alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './cli.ts'
import type { OrcaRun } from './core/bots.ts'

interface Ran {
  code: number
  stdout: string
  stderr: string
  json: any
}

const ORCA = ['online-store', 'data-pipeline', 'HomeLab'].map((name) => ({ name, id: `id-${name}`, kind: 'git' as const, path: `/p/${name}`, hostId: 'local', hidden: false }))

/** A stand-in for Orca's CLI: answers `bot list`, `orchestration send`, `bot chats` and
 *  `agent read` the way Orca does, and records every call. */
function fakeOrca() {
  const calls: string[][] = []
  const bots = [
    { id: 'b-orca', name: 'Orca', agent: 'claude', paused: false, linked: ['GitHub'], specialty: 'I take pull requests to merge-ready for my owner.', chats: { count: 2, home: true } },
    { id: 'b-web', name: 'web-bot', agent: 'claude', paused: false, linked: [], specialty: 'I keep the online-store checkout in order.', chats: { count: 1, home: true } }
  ]
  const ok = (result: unknown): OrcaRun => ({ code: 0, stdout: JSON.stringify({ id: 'r', ok: true, result }), stderr: '' })
  const runOrca = async (args: readonly string[]): Promise<OrcaRun> => {
    calls.push([...args])
    const command = args.slice(0, 2).join(' ')
    if (command === 'bot list') return ok({ bots, unreachable: [{ name: 'OC Osaka' }] })
    if (command === 'orchestration send') return ok({ message: { id: 'msg_42', type: 'handoff', to: 'bot:Orca' } })
    if (command === 'bot chats') {
      const subject = calls.find((c) => c[1] === 'send')?.[calls.find((c) => c[1] === 'send')!.indexOf('--subject') + 1] ?? ''
      return ok({ bot: args[3], chats: [{ id: 'home-chat', title: 'Home', home: true, lastActivityAt: 1 }, { id: '3540ecf3-47c3-4876-b825-81bf5d6b3595', title: `your owner's agent: ${subject}`, home: false, lastActivityAt: Date.now() }] })
    }
    if (command === 'agent read') return ok({ orcaSessionId: args[2].slice('orca_session_id:'.length), kind: 'chat', state: 'done', entries: [{ kind: 'message', role: 'user', text: 'task' }, { kind: 'message', role: 'assistant', text: 'Drafted it; see the PR.' }, { kind: 'message', role: 'assistant', text: 'NO_REPLY' }] })
    return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'unknown', message: `no fake for ${args.join(' ')}` } }), stderr: '' }
  }
  return { calls, runOrca }
}

async function setup(now = new Date(2026, 10, 23, 15)) {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-cli-'))
  const orca = fakeOrca()
  let clock = now
  async function cli(...args: string[]): Promise<Ran> {
    let stdout = ''
    let stderr = ''
    const code = await run(args, {
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      env: { ORCA_TASKS_HOME: home },
      now: () => clock,
      stdin: async () => '- [ ] From stdin !low\n',
      readFile: (path) => readFile(path, 'utf8'),
      orcaProjects: async () => ({ projects: ORCA, from: 'host-api', updated_at: '2026-11-23T00:00:00.000Z' }),
      runOrca: orca.runOrca
    })
    let json: any
    try {
      json = JSON.parse(stdout)
    } catch {
      json = undefined
    }
    return { code, stdout, stderr, json }
  }
  return {
    home,
    cli,
    orcaCalls: orca.calls,
    setNow: (date: Date) => (clock = date),
    done: () => rm(home, { recursive: true, force: true })
  }
}

test('add, list, complete: the loop an agent runs', async () => {
  const t = await setup()
  const added = await t.cli('add', 'Reply', 'to', 'Alice', '--due', 'tomorrow', '--priority', 'high', '--project', 'ops', '--tag', 'chat', '--source', 'chat:msg_1', '--notes', 'about the budget', '--json')
  assert.equal(added.code, 0, added.stderr)
  assert.equal(added.json.created, true)
  const task = added.json.task
  assert.deepEqual(
    { title: task.title, due: task.due, priority: task.priority, project: task.project, tags: task.tags, source: task.source, notes: task.notes, done_at: task.done_at },
    { title: 'Reply to Alice', due: '2026-11-24', priority: 'high', project: 'ops', tags: ['chat'], source: 'chat:msg_1', notes: 'about the budget', done_at: null }
  )
  // Every documented field is there (0.3.0 added due_time and handoffs, 0.4.0 state, state_name
  // and closed_at; the 0.2.0 ones are unchanged).
  assert.deepEqual(Object.keys(task).sort(), ['closed_at', 'created_at', 'done_at', 'due', 'due_time', 'handoffs', 'held_at', 'id', 'notes', 'priority', 'project', 'source', 'state', 'state_name', 'status', 'tags', 'title', 'updated_at', 'waiting_on'])
  assert.deepEqual({ status: task.status, state: task.state, state_name: task.state_name, closed_at: task.closed_at }, { status: 'open', state: 'todo', state_name: 'To Do', closed_at: null })

  const listed = await t.cli('list', '--json')
  assert.equal(listed.json.today, '2026-11-23')
  assert.deepEqual(listed.json.tasks.map((x: { id: string }) => x.id), [task.id])

  t.setNow(new Date(2026, 10, 23, 17))
  const done = await t.cli('done', task.id, '--json')
  assert.equal(done.code, 0)
  assert.equal(done.json.tasks[0].done_at, new Date(2026, 10, 23, 17).toISOString())
  assert.equal(done.json.tasks[0].status, 'done')
  assert.deepEqual((await t.cli('list', '--json')).json.tasks, [], 'done tasks leave the default list')
  const since = await t.cli('list', '--done-since', 'today', '--json')
  assert.deepEqual(since.json.tasks.map((x: { id: string }) => x.id), [task.id])
  assert.deepEqual((await t.cli('list', '--done-since', '-1h', '--json')).json.tasks.length, 1)
  assert.deepEqual((await t.cli('list', '--done-since', '2026-11-24', '--json')).json.tasks.length, 0)

  const reopened = await t.cli('undone', task.id.slice(0, 5), '--json')
  assert.equal(reopened.json.tasks[0].done_at, null, 'a unique id prefix works')
  await t.done()
})

test('list filters: due ranges, overdue, views, project, tag, source, search, limit', async () => {
  const t = await setup()
  await t.cli('add', 'Overdue thing', '--due', '2026-11-20')
  await t.cli('add', 'Today thing', '--due', 'today', '--project', 'Ops', '--tag', 'a', '--tag', 'b')
  await t.cli('add', 'Next week', '--due', '+7d', '--source', 'issue:42')
  await t.cli('add', 'Someday', '--notes', 'needle here')
  const titles = async (...args: string[]) => (await t.cli('list', ...args, '--json')).json.tasks.map((x: { title: string }) => x.title)
  assert.deepEqual(await titles('--due-to', 'today'), ['Overdue thing', 'Today thing'])
  assert.deepEqual(await titles('--overdue'), ['Overdue thing'])
  assert.deepEqual(await titles('--due', 'today'), ['Today thing'])
  assert.deepEqual(await titles('--due-from', 'tomorrow', '--due-to', '+14d'), ['Next week'])
  assert.deepEqual(await titles('--no-due'), ['Someday'])
  assert.deepEqual(await titles('--has-due', '--limit', '1'), ['Overdue thing'])
  assert.deepEqual(await titles('--view', 'today'), ['Overdue thing', 'Today thing'])
  assert.deepEqual(await titles('--view', 'upcoming'), ['Next week'])
  assert.deepEqual(await titles('--view', 'inbox'), ['Someday'])
  assert.deepEqual(await titles('--project', 'ops'), ['Today thing'])
  assert.deepEqual(await titles('--tag', 'a', '--tag', 'b'), ['Today thing'])
  assert.deepEqual(await titles('--source', 'issue:42'), ['Next week'])
  assert.deepEqual(await titles('--search', 'NEEDLE'), ['Someday'])
  const lines = await t.cli('list', '--format', 'line', '--project', 'ops')
  assert.equal(lines.stdout, '- [ ] Today thing @Ops #a #b due:2026-11-23\n')
  await t.done()
})

test('edit changes only what it names; tags can be added and removed', async () => {
  const t = await setup()
  const { task } = (await t.cli('add', 'Draft', '--tag', 'x', '--tag', 'y', '--project', 'p', '--json')).json
  const edited = await t.cli('edit', task.id, '--title', 'Final', '--due', 'fri', '--add-tag', 'z', '--remove-tag', '#x', '--json')
  assert.equal(edited.code, 0, edited.stdout)
  assert.equal(edited.json.task.title, 'Final')
  assert.equal(edited.json.task.due, '2026-11-27')
  assert.deepEqual(edited.json.task.tags, ['y', 'z'])
  assert.equal(edited.json.task.project, 'p')
  const cleared = await t.cli('edit', task.id, '--due', 'none', '--project', 'none', '--json')
  assert.equal(cleared.json.task.due, null)
  assert.equal(cleared.json.task.project, null)
  assert.equal((await t.cli('edit', task.id)).code, 2, 'nothing to change is a usage error')
  await t.done()
})

test('add --dedupe on --source returns the task that is already there', async () => {
  const t = await setup()
  const url = 'https://tracker.example.com/tasks/abc'
  const first = await t.cli('add', 'Tracker task', '--source', url, '--dedupe', '--json')
  const second = await t.cli('add', 'Tracker task', '--source', url, '--dedupe', '--json')
  assert.equal(second.json.created, false)
  assert.equal(second.json.task.id, first.json.task.id)
  const third = await t.cli('add', 'Tracker task', '--source', url, '--json')
  assert.equal(third.json.created, true, 'without --dedupe a second task is added')
  await t.done()
})

test('add --parse reads Simple Todo markers; import reads files, stdin and the inbox', async () => {
  const t = await setup()
  const parsed = await t.cli('add', 'Ship v1 !urgent @orca #release due:today', '--parse', '--json')
  assert.deepEqual(
    [parsed.json.task.title, parsed.json.task.priority, parsed.json.task.project, parsed.json.task.tags, parsed.json.task.due],
    ['Ship v1', 'urgent', 'orca', ['release'], '2026-11-23']
  )
  const plain = await t.cli('add', 'Fix #12 for @ana', '--json')
  assert.equal(plain.json.task.title, 'Fix #12 for @ana', 'without --parse the title is kept as typed')

  const file = join(t.home, 'old-inbox.md')
  await writeFile(file, '- [ ] One !high\n- [x] Two #done\n', 'utf8')
  const imported = await t.cli('import', file, '--source', 'simple-todo', '--json')
  assert.deepEqual(imported.json.tasks.map((x: { title: string; source: string }) => [x.title, x.source]), [['One', 'simple-todo'], ['Two', 'simple-todo']])
  assert.ok(imported.json.tasks[1].done_at)
  const fromStdin = await t.cli('import', '-', '--json')
  assert.equal(fromStdin.json.tasks[0].title, 'From stdin')

  await writeFile(join(t.home, 'inbox.md'), '- [ ] Appended by an agent due:tomorrow\n', 'utf8')
  const listed = await t.cli('list', '--search', 'appended', '--json')
  assert.equal(listed.json.tasks[0].due, '2026-11-24', 'every command takes the inbox in first')
  await t.done()
})

test('errors: exit codes and JSON errors', async () => {
  const t = await setup()
  const missing = await t.cli('done', 't-nothing', '--json')
  assert.equal(missing.code, 3)
  assert.equal(missing.json.error.code, 'not_found')
  const usage = await t.cli('list', '--bogus')
  assert.equal(usage.code, 2)
  assert.match(usage.stderr, /unknown option --bogus/)
  assert.equal((await t.cli('add', 'x', '--due', 'someday')).code, 2)
  assert.equal((await t.cli('add', 'x', '--priority', 'huge')).code, 2)
  assert.equal((await t.cli('frobnicate')).code, 2)
  assert.equal((await t.cli('add')).code, 2)
  const help = await t.cli('help')
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--done-since <time>/)
  const where = await t.cli('path', '--json')
  assert.equal(where.json.data, join(t.home, 'tasks.json'))
  await t.done()
})

test('bin/orca-tasks runs the CLI as a program', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-bin-'))
  const bin = fileURLToPath(new URL('../bin/orca-tasks', import.meta.url).href)
  const env = { ...process.env, ORCA_TASKS_HOME: home }
  const added = spawnSync(bin, ['add', 'From the shell', '--json'], { encoding: 'utf8', env })
  assert.equal(added.status, 0, added.stderr)
  assert.equal(JSON.parse(added.stdout).task.title, 'From the shell')
  const piped = spawnSync(bin, ['import', '-', '--json'], { encoding: 'utf8', env, input: '- [ ] Piped in #x\n' })
  assert.equal(piped.status, 0, piped.stderr)
  const listed = spawnSync(bin, ['list'], { encoding: 'utf8', env })
  assert.match(listed.stdout, /From the shell/)
  assert.match(listed.stdout, /Piped in/)
  assert.equal(listed.stderr, '', 'no warnings on stderr')
  await rm(home, { recursive: true, force: true })
})

test('hold, unhold, list --status, and done on a held task', async () => {
  const t = await setup()
  const { task } = (await t.cli('add', 'Finalize pack', '--due', 'yesterday', '--json')).json
  assert.equal((await t.cli('hold', task.id)).code, 2, 'hold needs --on')
  t.setNow(new Date(2026, 10, 23, 16))
  const held = await t.cli('hold', task.id, '--on', "Bob's review", '--json')
  assert.equal(held.code, 0, held.stdout)
  assert.deepEqual(
    [held.json.tasks[0].status, held.json.tasks[0].waiting_on, held.json.tasks[0].held_at],
    ['hold', "Bob's review", new Date(2026, 10, 23, 16).toISOString()]
  )
  const ids = async (...args: string[]) => (await t.cli('list', ...args, '--json')).json.tasks.map((x: { id: string }) => x.id)
  await t.cli('add', 'Other', '--json')
  assert.equal((await ids()).length, 1, 'held tasks leave the default (open) list')
  assert.deepEqual(await ids('--status', 'hold'), [task.id])
  assert.deepEqual(await ids('--hold'), [task.id])
  assert.equal((await ids('--status', 'open,hold')).length, 2)
  assert.deepEqual(await ids('--overdue'), [], 'a held task is never overdue')
  assert.equal((await ids('--view', 'today')).length, 1)
  assert.match((await t.cli('list', '--hold')).stdout, /\[~\] .*on hold: waiting on Bob's review/)
  const back = await t.cli('unhold', task.id, '--json')
  assert.deepEqual([back.json.tasks[0].status, back.json.tasks[0].waiting_on, back.json.tasks[0].held_at], ['open', null, null])
  await t.cli('hold', task.id, '--on', "Pablo's data")
  const done = await t.cli('done', task.id, '--json')
  assert.deepEqual([done.json.tasks[0].status, done.json.tasks[0].waiting_on], ['done', null])
  assert.equal((await t.cli('hold', task.id, '--on', 'x')).code, 2, 'a done task cannot go on hold')
  assert.equal((await t.cli('list', '--status', 'later')).code, 2)
  await t.done()
})

test('Orca projects: exact names, list --group project, projects', async () => {
  const t = await setup()
  const a = await t.cli('add', 'Pack', '--project', 'Online Store', '--json')
  assert.equal(a.json.task.project, 'online-store')
  await t.cli('add', 'Load layers', '--project', 'data-pipeline')
  await t.cli('add', 'More layers', '--project', 'data-pipeline')
  await t.cli('add', 'Groceries', '--project', 'Personal')
  await t.cli('add', 'Loose end')
  assert.equal((await t.cli('list', '--project', 'online store', '--json')).json.tasks.length, 1)
  const grouped = await t.cli('list', '--group', 'project', '--json')
  assert.deepEqual(
    grouped.json.groups.map((g: { project: string | null; orca: boolean; open: number; tasks: unknown[] }) => [g.project, g.orca, g.open, g.tasks.length]),
    [
      ['data-pipeline', true, 2, 2],
      ['online-store', true, 1, 1],
      ['Personal', false, 1, 1],
      [null, false, 1, 1]
    ]
  )
  assert.equal(grouped.json.today, '2026-11-23')
  assert.match((await t.cli('list', '--group', 'project')).stdout, /^data-pipeline \(Orca\): 2 open, 2 total/)
  assert.equal((await t.cli('list', '--group', 'tag')).code, 2)
  const projects = await t.cli('projects', '--json')
  assert.equal(projects.json.from, 'host-api')
  assert.deepEqual(
    projects.json.projects.map((p: { name: string; orca: boolean; open: number }) => [p.name, p.orca, p.open]),
    [
      ['data-pipeline', true, 2],
      ['online-store', true, 1],
      ['HomeLab', true, 0],
      ['Personal', false, 1]
    ]
  )
  await t.done()
})

test('due times: --due day@time, --time, overdue later today, line format', async () => {
  const t = await setup(new Date(2026, 10, 23, 15))
  const a = await t.cli('add', 'Call Alice', '--due', 'today@14:00', '--json')
  assert.deepEqual([a.json.task.due, a.json.task.due_time], ['2026-11-23', '14:00'])
  const b = await t.cli('add', 'Standup', '--due', 'tomorrow', '--time', '9:30am', '--json')
  assert.deepEqual([b.json.task.due, b.json.task.due_time], ['2026-11-24', '09:30'])
  const c = await t.cli('add', 'Review', '--due', '2026-11-23T18:00', '--json')
  assert.equal(c.json.task.due_time, '18:00')
  await t.cli('add', 'All day today', '--due', 'today')
  assert.equal((await t.cli('add', 'x', '--time', '10:00')).code, 2, 'a time needs a day')
  assert.equal((await t.cli('add', 'x', '--due', 'fri@25:00')).code, 2)
  const titles = async (...args: string[]) => (await t.cli('list', ...args, '--json')).json.tasks.map((x: { title: string }) => x.title)
  assert.deepEqual(await titles('--overdue'), ['Call Alice'], '14:00 has passed at 15:00; an all-day task is not overdue yet')
  assert.deepEqual(await titles('--due', 'today'), ['Call Alice', 'Review', 'All day today'], 'timed tasks first, by time')
  const edited = await t.cli('edit', a.json.task.id, '--time', 'none', '--json')
  assert.equal(edited.json.task.due_time, null)
  const moved = await t.cli('edit', b.json.task.id, '--due', 'fri', '--json')
  assert.deepEqual([moved.json.task.due, moved.json.task.due_time], ['2026-11-27', null], 'a new day without a time clears the time')
  const parsed = await t.cli('add', 'Ship !h #release due:fri@16:00', '--parse', '--json')
  assert.deepEqual([parsed.json.task.title, parsed.json.task.priority, parsed.json.task.due, parsed.json.task.due_time], ['Ship', 'high', '2026-11-27', '16:00'])
  assert.match((await t.cli('list', '--search', 'ship', '--format', 'line')).stdout, /due:2026-11-27@16:00/)
  assert.match((await t.cli('list', '--search', 'ship')).stdout, /due 2026-11-27 16:00/)
  await t.done()
})

test('output for tasks without 0.3.0 fields is what 0.2.0 printed', async () => {
  const t = await setup()
  const { task } = (await t.cli('add', 'Reply to Alice', '--due', 'tomorrow', '--priority', 'high', '--project', 'ops', '--tag', 'chat', '--json')).json
  assert.equal((await t.cli('list')).stdout, `[ ] ${task.id}  Reply to Alice  (due 2026-11-24, !high, @ops, #chat)\n`)
  assert.equal((await t.cli('list', '--format', 'line')).stdout, '- [ ] Reply to Alice !high @ops #chat due:2026-11-24\n')
  assert.equal((await t.cli('get', task.id)).stdout.split('\n')[0], `[ ] ${task.id}  Reply to Alice  (due 2026-11-24, !high, @ops, #chat)`)
  await t.done()
})

test('send: picks the project bot or Orca, records the handoff, reads the chat, takes it back', async () => {
  const t = await setup()
  const web = (await t.cli('add', 'Check the invoices', '--project', 'online-store', '--notes', '- [x] one\n- [ ] two', '--json')).json.task
  const plain = (await t.cli('add', 'Draft the plan', '--due', 'fri@10:00', '--json')).json.task

  const bots = await t.cli('bots', web.id, '--json')
  assert.equal(bots.code, 0, bots.stdout)
  assert.equal(bots.json.default, 'web-bot', "the project's bot comes first")
  assert.deepEqual(bots.json.bots.map((b: { name: string; role: string | null }) => [b.name, b.role]), [['Orca', 'main'], ['web-bot', 'project']])
  assert.deepEqual(bots.json.unreachable, ['OC Osaka'])
  assert.equal((await t.cli('bots', plain.id, '--json')).json.default, 'Orca', 'without a project bot, Orca')

  const before = t.orcaCalls.length
  const dry = await t.cli('send', plain.id, '--dry-run', '--json')
  assert.equal(dry.json.bot, 'Orca')
  assert.match(dry.json.body, /Task: Draft the plan\nDue: 2026-11-27 10:00/)
  assert.ok(!t.orcaCalls.slice(before).some((c) => c[1] === 'send'), 'a dry run sends nothing')

  const sent = await t.cli('send', plain.id, '--note', 'Use last quarter as the template', '--json')
  assert.equal(sent.code, 0, sent.stdout)
  const call = t.orcaCalls.find((c) => c[0] === 'orchestration' && c[1] === 'send')!
  assert.deepEqual(call.slice(0, 8), ['orchestration', 'send', '--to', 'bot:Orca', '--type', 'handoff', '--subject', 'Draft the plan'])
  assert.ok(!call.includes('--chat'), "the bot's Home Chat by default (Orca's own default: no --chat)")
  assert.match(call[call.indexOf('--body') + 1], /^Your owner sent you this task[\s\S]*Use last quarter as the template[\s\S]*Task id: t-/)
  assert.deepEqual(
    { bot: sent.json.handoff.bot, chat: sent.json.handoff.chat, chat_id: sent.json.handoff.chat_id, message_id: sent.json.handoff.message_id, by: sent.json.handoff.by },
    { bot: 'Orca', chat: 'home', chat_id: 'home-chat', message_id: 'msg_42', by: 'cli' }
  )
  assert.equal(sent.json.task.handoffs.length, 1)

  assert.deepEqual((await t.cli('list', '--with-bot', '--json')).json.tasks.map((x: { id: string }) => x.id), [plain.id])
  assert.deepEqual((await t.cli('list', '--no-bot', '--json')).json.tasks.map((x: { id: string }) => x.id), [web.id])
  assert.match((await t.cli('list', '--with-bot')).stdout, /with bot Orca since/)

  const status = await t.cli('bot-status', plain.id, '--json')
  assert.deepEqual(status.json.status, { state: 'done', reply: 'Drafted it; see the PR.' })
  assert.match((await t.cli('get', web.id)).stdout, /checklist 1\/2/)

  const home = await t.cli('send', web.id, '--to', 'web-bot', '--chat', 'home', '--by', 'board', '--json')
  assert.equal(home.json.handoff.chat_id, 'home-chat', 'a Home Chat send finds the Home Chat')
  assert.equal(home.json.handoff.by, 'board', 'the panel and the board run send with --by')
  assert.equal((await t.cli('send', web.id, '--by', 'robot')).code, 2)
  assert.equal((await t.cli('send', web.id, '--to', 'nobody')).code, 2)
  assert.equal((await t.cli('send', web.id, '--chat', 'elsewhere')).code, 2)

  const back = await t.cli('take-back', plain.id, '--json')
  assert.ok(back.json.task.handoffs[0].returned_at)
  assert.deepEqual((await t.cli('list', '--with-bot', '--json')).json.tasks.map((x: { id: string }) => x.id), [web.id])
  await t.cli('done', web.id)
  assert.equal((await t.cli('send', web.id)).code, 2, 'a done task is not sent')
  await t.done()
})

test('send options: question or status, an earlier chat, no notes, and a status after sending', async () => {
  const t = await setup()
  const task = (await t.cli('add', 'Check the invoices', '--project', 'online-store', '--notes', 'private notes', '--json')).json.task
  const sendCalls = () => t.orcaCalls.filter((c) => c[0] === 'orchestration' && c[1] === 'send')
  const arg = (call: string[], name: string) => (call.includes(name) ? call[call.indexOf(name) + 1] : undefined)

  assert.equal((await t.cli('send', task.id, '--chat', 'last')).code, 2, 'no earlier chat yet')
  assert.equal((await t.cli('send', task.id, '--type', 'status', '--chat', 'new')).code, 2, 'a status message cannot start a chat')
  assert.equal((await t.cli('send', task.id, '--type', 'nudge')).code, 2)
  assert.equal((await t.cli('send', task.id, '--state', 'Nope')).code, 2)

  const dry = await t.cli('send', task.id, '--type', 'question', '--no-notes', '--note', 'Check progress', '--state', 'Pending', '--dry-run', '--json')
  assert.deepEqual([dry.json.type, dry.json.chat, dry.json.notes, dry.json.state, dry.json.subject], ['question', 'home', false, 'pending', 'Question: Check the invoices'])
  assert.doesNotMatch(dry.json.body, /private notes/)
  assert.equal(sendCalls().length, 0)

  // A handoff in a chat of its own, then the task waits on the bot under Pending.
  const sent = await t.cli('send', task.id, '--chat', 'new', '--state', 'pending', '--json')
  assert.equal(sent.code, 0, sent.stdout)
  assert.deepEqual([arg(sendCalls()[0], '--type'), arg(sendCalls()[0], '--chat'), arg(sendCalls()[0], '--to')], ['handoff', 'new', 'bot:web-bot'])
  assert.match(arg(sendCalls()[0], '--body')!, /private notes/)
  assert.deepEqual([sent.json.task.state, sent.json.task.status, sent.json.task.waiting_on], ['pending', 'hold', 'web-bot'])
  assert.deepEqual([sent.json.handoff.type, sent.json.handoff.chat], ['handoff', 'new'])

  // "Check progress" in the same chat, as a question, and the task moves to In Progress.
  const asked = await t.cli('send', task.id, '--type', 'question', '--chat', 'last', '--note', 'Check progress', '--no-notes', '--state', 'In Progress', '--json')
  assert.equal(asked.code, 0, asked.stdout)
  const call = sendCalls()[1]
  assert.deepEqual([arg(call, '--type'), arg(call, '--chat'), arg(call, '--subject')], ['question', '3540ecf3-47c3-4876-b825-81bf5d6b3595', 'Question: Check the invoices'])
  assert.match(arg(call, '--body')!, /Check progress/)
  assert.doesNotMatch(arg(call, '--body')!, /private notes/)
  assert.deepEqual([asked.json.handoff.type, asked.json.handoff.chat, asked.json.handoff.chat_id], ['question', 'existing', '3540ecf3-47c3-4876-b825-81bf5d6b3595'])
  assert.deepEqual([asked.json.task.state, asked.json.task.status, asked.json.task.waiting_on], ['in-progress', 'open', null])

  // A status message goes to the Home Chat by default, with no --chat new.
  const fyi = await t.cli('send', task.id, '--type', 'status', '--json')
  assert.equal(fyi.code, 0, fyi.stdout)
  assert.equal(arg(sendCalls()[2], '--chat'), undefined)
  assert.equal(fyi.json.handoff.chat, 'home')
  assert.match((await t.cli('get', task.id)).stdout, /told web-bot \(Home Chat/)
  await t.done()
})

test('statuses from the CLI: list, add, edit, rm; --state on add, edit and list; 0.3.0 fields unchanged', async () => {
  const t = await setup()
  const listed = await t.cli('statuses', '--json')
  assert.deepEqual(listed.json.statuses.map((s: { name: string; kind: string; tasks: number }) => [s.name, s.kind, s.tasks]), [
    ['To Do', 'open', 0],
    ['In Progress', 'open', 0],
    ['Pending', 'hold', 0],
    ['Done', 'done', 0],
    ['Cancelled', 'cancelled', 0]
  ])
  assert.match((await t.cli('statuses')).stdout, /^ 1\. To Do  \[todo\] open, gray, 0 tasks\n/)

  const a = (await t.cli('add', 'Write the memo', '--state', 'in progress', '--json')).json.task
  assert.deepEqual([a.state, a.state_name, a.status], ['in-progress', 'In Progress', 'open'])
  assert.match((await t.cli('list')).stdout, /Write the memo  \(status In Progress\)/)
  const b = (await t.cli('add', 'Ask Bob', '--json')).json.task
  assert.equal((await t.cli('list')).stdout.split('\n').find((l) => l.includes('Ask Bob')), `[ ] ${b.id}  Ask Bob`, 'To Do prints as before')

  // What scripts using the CLI run: hold / unhold / done answer the same status, waiting_on, held_at, done_at.
  const held = (await t.cli('hold', b.id, '--on', 'Bob: review', '--json')).json.tasks[0]
  assert.deepEqual([held.status, held.waiting_on, held.state], ['hold', 'Bob: review', 'pending'])
  assert.deepEqual((await t.cli('list', '--status', 'open,hold', '--json')).json.tasks.map((x: { status: string }) => x.status).sort(), ['hold', 'open'])
  const unheld = (await t.cli('unhold', b.id, '--json')).json.tasks[0]
  assert.deepEqual([unheld.status, unheld.held_at, unheld.state], ['open', null, 'todo'])

  const edited = (await t.cli('edit', b.id, '--state', 'Cancelled', '--json')).json.task
  assert.deepEqual([edited.status, edited.done_at, edited.state], ['done', null, 'cancelled'])
  assert.ok((await t.cli('list', '--all')).stdout.includes(`[-] ${b.id}  Ask Bob  (cancelled ${new Date(2026, 10, 23, 15).toISOString()})`))
  assert.deepEqual((await t.cli('list', '--done-since', '-1d', '--json')).json.tasks, [], 'a cancelled task was not completed')
  assert.deepEqual((await t.cli('list', '--json')).json.tasks.map((x: { id: string }) => x.id), [a.id])
  assert.deepEqual((await t.cli('list', '--state', 'cancelled,in-progress', '--json')).json.tasks.map((x: { id: string }) => x.id).sort(), [a.id, b.id].sort())
  assert.equal((await t.cli('hold', b.id, '--on', 'x')).code, 2, 'a cancelled task cannot be held')
  assert.equal((await t.cli('edit', a.id, '--on', 'Alice', '--json')).json.task.state, 'pending', 'edit --on puts it on hold')

  const added = await t.cli('statuses', 'add', 'In', 'review', '--kind', 'waiting', '--color', 'purple', '--position', '3', '--json')
  assert.equal(added.code, 0, added.stdout)
  assert.deepEqual(added.json.statuses.map((s: { id: string }) => s.id), ['todo', 'in-progress', 'in-review', 'pending', 'done', 'cancelled'])
  assert.equal((await t.cli('statuses', 'edit', 'in review', '--name', 'Review', '--color', 'teal', '--position', '1', '--json')).json.statuses[0].name, 'Review')
  assert.equal((await t.cli('statuses', 'edit', 'Review', '--color', 'magenta')).code, 2)
  assert.equal((await t.cli('statuses', 'rm', 'Pending', '--move-to', 'Review', '--json')).code, 0)
  assert.equal((await t.cli('get', a.id, '--json')).json.task.state, 'in-review')
  const refused = await t.cli('statuses', 'rm', 'Review', '--json')
  assert.equal(refused.code, 2, 'the last hold status stays')
  assert.match(refused.json.error.message, /no open · on hold/)
  assert.equal((await t.cli('statuses', 'frob', 'x')).code, 2)
  await t.done()
})

test('merge from the CLI: dry run, merge, get points to the keeper, add --dedupe, undo; 0.3.0 fields unchanged', async () => {
  const t = await setup()
  const keep = (await t.cli('add', 'Reply to Alice', '--source', 'chat:msg_1', '--priority', 'medium', '--json')).json.task
  const dup = (await t.cli('add', 'Alice: budget reply', '--source', 'issue:42', '--priority', 'high', '--due', '2026-11-26', '--notes', 'numbers', '--json')).json.task
  const before = await readFile(join(t.home, 'tasks.json'), 'utf8')

  const usage = await t.cli('merge', keep.id)
  assert.equal(usage.code, 2)
  assert.match(usage.stderr, /merge takes the id to keep, then one or more ids/)

  const dry = await t.cli('merge', keep.id, dup.id, '--dry-run', '--json')
  assert.equal(dry.code, 0, dry.stdout)
  assert.deepEqual([dry.json.dryRun, dry.json.keeper.priority, dry.json.keeper.due, dry.json.merged[0].state], [true, 'high', '2026-11-26', 'cancelled'])
  assert.equal(await readFile(join(t.home, 'tasks.json'), 'utf8'), before, 'a dry run changes nothing')

  const merged = await t.cli('merge', keep.id, dup.id, '--priority', 'keep')
  assert.equal(merged.code, 0, merged.stderr)
  assert.match(merged.stdout, new RegExp(`^Merged ${dup.id} into ${keep.id}:`))
  assert.match(merged.stdout, /Undo with: orca-tasks merge --undo/)

  const kept = (await t.cli('get', keep.id, '--json')).json.task
  assert.deepEqual([kept.title, kept.priority, kept.due, kept.sources, kept.merged_from], ['Reply to Alice', 'medium', '2026-11-26', ['chat:msg_1', 'issue:42'], [dup.id]])
  assert.match(kept.notes, /## Merged from Alice: budget reply \(t-/)
  // The fields scripts using the CLI read keep their meaning on both.
  assert.deepEqual([kept.status, kept.source, kept.done_at], ['open', 'chat:msg_1', null])

  const old = await t.cli('get', dup.id, '--json')
  assert.deepEqual([old.json.task.merged_into, old.json.task.status, old.json.merged_into.id], [keep.id, 'done', keep.id], 'get <old id> points to the keeper')
  const oldText = await t.cli('get', dup.id)
  assert.match(oldText.stdout, new RegExp(`merged into ${keep.id}`))
  assert.match(oldText.stdout, new RegExp(`\\nMerged into ${keep.id}: Reply to Alice\\n`))

  const again = await t.cli('add', 'Alice: budget reply', '--source', 'issue:42', '--dedupe', '--json')
  assert.deepEqual([again.json.created, again.json.task.id], [false, keep.id], 'add --dedupe on a merged source answers the keeper')
  const open = await t.cli('list', '--json')
  assert.deepEqual(open.json.tasks.map((x: { id: string }) => x.id), [keep.id], 'the merged task is closed (cancelled), not open')

  assert.equal((await t.cli('merge', keep.id, dup.id)).code, 2, 'a task merged already cannot be merged again')
  const undo = await t.cli('merge', '--undo', '--json')
  assert.equal(undo.code, 0, undo.stdout)
  const restored = (await t.cli('get', dup.id, '--json')).json
  assert.deepEqual([restored.task.state, restored.task.merged_into, restored.merged_into], ['todo', undefined, undefined])
  await t.done()
})

test('send moves the task to In Progress unless told otherwise; --keep-state leaves it; without In Progress it stays', async () => {
  const t = await setup()
  const task = (await t.cli('add', 'Check the invoices', '--project', 'online-store', '--json')).json.task
  assert.equal(task.state, 'todo')

  // Bot sends: In Progress by default, also in a dry run, for a question or a status message too.
  assert.equal((await t.cli('send', task.id, '--dry-run', '--json')).json.state, 'in-progress')
  assert.equal((await t.cli('send', task.id, '--keep-state', '--dry-run', '--json')).json.state, null)
  assert.match((await t.cli('send', task.id, '--dry-run')).stdout, /then move the task to In Progress/)
  const kept = await t.cli('send', task.id, '--keep-state', '--json')
  assert.equal(kept.code, 0, kept.stdout)
  assert.equal(kept.json.task.state, 'todo', '--keep-state: the status is left as it is')
  const sent = await t.cli('send', task.id, '--type', 'question', '--json')
  assert.equal(sent.code, 0, sent.stdout)
  assert.deepEqual([sent.json.task.state, sent.json.task.status], ['in-progress', 'open'])
  assert.match((await t.cli('send', task.id, '--type', 'status')).stdout, /now In Progress/)
  assert.equal((await t.cli('send', task.id, '--state', 'Pending', '--keep-state')).code, 2, '--state and --keep-state do not go together')
  // --state still wins.
  assert.equal((await t.cli('send', task.id, '--state', 'To Do', '--dry-run', '--json')).json.state, 'todo')

  // Project sends: the same default.
  assert.equal((await t.cli('send', task.id, '--to-project', '--dry-run', '--json')).json.state, 'in-progress')
  assert.equal((await t.cli('send', task.id, '--to-project', '--keep-state', '--dry-run', '--json')).json.state, null)
  assert.equal((await t.cli('send', task.id, '--to-project', '--keep-state', '--state', 'todo')).code, 2)

  // Renamed, it is still the one: the status that started as In Progress.
  assert.equal((await t.cli('statuses', 'edit', 'In Progress', '--name', 'Doing')).code, 0)
  assert.equal((await t.cli('send', task.id, '--dry-run', '--json')).json.state, 'in-progress')
  // Deleted: the status is left as it is (its tasks went to To Do).
  assert.equal((await t.cli('statuses', 'rm', 'Doing')).code, 0)
  assert.equal((await t.cli('send', task.id, '--dry-run', '--json')).json.state, null)
  assert.equal((await t.cli('send', task.id, '--to-project', '--dry-run', '--json')).json.state, null)
  const after = await t.cli('send', task.id, '--json')
  assert.equal(after.code, 0, after.stdout)
  assert.equal(after.json.task.state, 'todo', 'In Progress was deleted: nothing to move to')
  await t.done()
})

test('send --to-project: dry run shows the workspace and the prompt; a send runs orca worktree create and is recorded', async () => {
  const t = await setup()
  const task = (await t.cli('add', 'Fix the login bug', '--project', 'online store', '--notes', 'repro steps', '--json')).json.task
  const plain = (await t.cli('add', 'No project here', '--json')).json.task

  const dry = await t.cli('send', task.id, '--to-project', '--agent', 'codex', '--note', 'Write a test first', '--dry-run', '--json')
  assert.equal(dry.code, 0, dry.stdout)
  assert.deepEqual([dry.json.project, dry.json.agent, dry.json.workspace_name], ['online-store', 'codex', `fix-the-login-bug-${task.id.slice(2, 6)}`])
  assert.match(dry.json.prompt, /Write a test first\n\nTask: Fix the login bug\n/)
  assert.match(dry.json.prompt, /Notes:\nrepro steps/)
  assert.ok(!t.orcaCalls.some((c) => c[0] === 'worktree'), 'a dry run creates nothing')

  const none = await t.cli('send', plain.id, '--to-project')
  assert.equal(none.code, 2)
  assert.match(none.stderr, /has no project/)
  assert.equal((await t.cli('send', task.id, '--to-project', '--to', 'Orca')).code, 2, '--to is for bots')
  assert.equal((await t.cli('send', task.id, '--agent', 'codex')).code, 2, '--agent goes with --to-project')

  // Orca's CLI as it answers a create.
  const fake = await t.cli('send', task.id, '--to-project', '--state', 'In Progress', '--json')
  assert.equal(fake.code, 1, 'the fake Orca has no worktree create')
  assert.match(fake.json.error.message, /orca worktree create failed/)
  const created = t.orcaCalls.find((c) => c[0] === 'worktree' && c[1] === 'create')
  assert.ok(created)
  assert.deepEqual(created.slice(2, 8), ['--project', 'online-store', '--name', `fix-the-login-bug-${task.id.slice(2, 6)}`, '--agent', 'claude'])
  assert.equal((await t.cli('get', task.id, '--json')).json.task.workspaces, undefined, 'nothing recorded when the create failed')
  await t.done()
})
