// The worker as Orca runs it, over Orca's mock host: `orca plugin test .`.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaRun } from './core/bots.ts'
import { TaskStore } from './core/store.ts'
import { botSendInput } from './core/send-input.ts'
import { stubAgent } from './core/test/stub-agent.ts'
import { BOARD_FILE, VERSION, createWorker } from './worker.ts'

const NOW = new Date(2026, 10, 23, 15)

/** Orca's CLI as the worker sees it: bots, a send, and a chat that answered. */
function fakeOrca(chatState = 'working') {
  const calls: string[][] = []
  const ok = (result: unknown): OrcaRun => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
  const runOrca = async (args: readonly string[]): Promise<OrcaRun> => {
    calls.push([...args])
    const command = args.slice(0, 2).join(' ')
    if (command === 'bot list') {
      return ok({
        bots: [
          { id: 'b1', name: 'Orca', agent: 'claude', specialty: 'Pull requests.', paused: false },
          { id: 'b2', name: 'online-store', agent: 'codex', specialty: 'Releases.', paused: false }
        ],
        unreachable: []
      })
    }
    if (command === 'orchestration send') return ok({ message: { id: 'msg_7' }, chatId: '0bb66c0f-54fa-442a-bc6a-7bba13627dc0' })
    if (command === 'bot chats') return ok({ bot: 'Orca', chats: [{ id: '9a72617b-1ce3-4f05-b5c3-65f7a1e75f6f', title: "your owner's agent: Late chat", home: false, lastActivityAt: NOW.getTime() + 1000 }] })
    if (command === 'agent read') return ok({ state: chatState, entries: [{ kind: 'message', role: 'assistant', text: 'On it.' }] })
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  return { calls, runOrca, setState: (state: string) => (chatState = state) }
}

const PROJECTS = {
  projects: [
    { id: 'p-web', name: 'online-store', kind: 'git', hostId: 'local', path: '/Users/me/online-store' },
    { id: 'p-df', name: 'data-pipeline', kind: 'git', hostId: 'local', path: '/Users/me/data-pipeline' }
  ],
  truncated: false
}
const WORKSPACES = {
  workspaces: [
    { id: 'w-feature', kind: 'worktree', name: 'feature-x', projectId: 'p-web', path: '/Users/me/web-wt/feature-x', branch: 'feature-x', hostId: 'local' },
    { id: 'w-main', kind: 'worktree', name: 'main', projectId: 'p-web', path: '/Users/me/online-store', branch: 'main', hostId: 'local' }
  ],
  truncated: false
}

async function start(options: { settings?: Record<string, boolean | string>; installCli?: boolean; home?: string; now?: () => Date; results?: Record<string, unknown>; capabilities?: string[]; suggestAgent?: { command?: string; timeoutMs?: number; env?: Record<string, string | undefined> } } = {}) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'orca-tasks-worker-')))
  const simpleTodoInbox = join(home, 'simple-todo-inbox.md')
  const orcaCli = fakeOrca()
  const handle = createWorker({ home, now: options.now ?? (() => NOW), timers: false, installCli: options.installCli ?? false, simpleTodoInbox, runOrca: orcaCli.runOrca, ...(options.suggestAgent ? { suggestAgent: options.suggestAgent } : {}) })
  const host = mockHost({
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    settings: options.settings ?? {},
    results: { 'project.list': PROJECTS, 'workspace.list': WORKSPACES, 'workspace.open': { opened: true }, ...options.results }
  })
  const worker = await mountWorker({ default: handle.activate, deactivate: handle.deactivate }, { host })
  return {
    home,
    simpleTodoInbox,
    worker,
    host,
    handle,
    orcaCli,
    async stop() {
      assert.deepEqual(worker.refusals, [])
      await worker.deactivate()
      await rm(home, { recursive: true, force: true })
    }
  }
}

test('the panel adds, completes, edits and deletes through the worker', async () => {
  const t = await start()
  const { task } = await t.worker.request('tasks.add', { text: 'Call Alice !high @ops #chat', view: 'today' })
  assert.equal(task.title, 'Call Alice')
  assert.equal(task.due, '2026-11-23', 'added from Today, it is due today')
  assert.equal(task.priority, 'high')
  const upcoming = await t.worker.request('tasks.add', { text: 'Later', view: 'upcoming' })
  assert.equal(upcoming.task.due, '2026-11-24')
  const inbox = await t.worker.request('tasks.add', { text: 'Whenever due:fri', view: 'inbox' })
  assert.equal(inbox.task.due, '2026-11-27', 'a due: marker wins over the view')

  const done = await t.worker.request('tasks.setDone', { id: task.id, done: true })
  assert.equal(done.task.done_at, NOW.toISOString())
  const edited = await t.worker.request('tasks.update', { id: task.id, patch: { title: 'Call Alice back', tags: ['chat', 'call'] } })
  assert.deepEqual(edited.task.tags, ['chat', 'call'])
  await t.worker.request('tasks.delete', { id: upcoming.task.id })

  const listed = await t.worker.request('tasks.list')
  assert.deepEqual(listed.tasks.map((x) => x.title).sort(), ['Call Alice back', 'Whenever'])
  assert.equal(listed.today, '2026-11-23')
  // The CLI sees exactly what the panel wrote.
  const fromDisk = await new TaskStore({ home: t.home }).read()
  assert.equal(fromDisk.revision, listed.revision)
  assert.ok(t.worker.posts.some((post) => post.event === 'tasks.changed'))
  await t.stop()
})

test('bad input from the panel is refused with invalid_params', async () => {
  const t = await start()
  await assert.rejects(t.worker.request('tasks.add', { text: '   ' }))
  const { task } = await t.worker.request('tasks.add', { text: 'x' })
  await assert.rejects(t.worker.request('tasks.update', { id: task.id, patch: { due: 'tomorrow' } }))
  await assert.rejects(t.worker.request('tasks.setDone', { id: 't-missing', done: true }))
  await t.stop()
})

test('the status bar counts open tasks due today or overdue; the command lists them', async () => {
  const t = await start()
  await t.worker.request('tasks.add', { text: 'Late due:2026-11-20 !urgent' })
  await t.worker.request('tasks.add', { text: 'Now', view: 'today' })
  await t.worker.request('tasks.add', { text: 'Not yet due:+3' })
  const updates = t.host.callsOf('statusBar.update')
  const last = updates[updates.length - 1] as { text: string; tone: string; tooltip: string }
  assert.equal(last.text, '3 open · 1 high · 1 overdue')
  assert.equal(last.tone, 'warning')
  assert.match(last.tooltip, /2 due today or overdue/)
  const summary = await t.worker.command('agent-tasks.summary')
  assert.equal(summary, '2 due today:\noverdue 2026-11-20: Late !urgent\nNow')
  await t.stop()
})

test('takes in the inbox on start, and Simple Todo\'s only when the setting is on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  await writeFile(join(home, 'inbox.md'), '- [ ] From an agent !low\n', 'utf8')
  const simpleTodoInbox = join(home, 'simple-todo-inbox.md')
  await writeFile(simpleTodoInbox, '- [ ] Written for Simple Todo #old\n', 'utf8')

  const off = createWorker({ home, now: () => NOW, timers: false, installCli: false, simpleTodoInbox })
  const first = await mountWorker({ default: off.activate }, { host: mockHost({ settings: {}, results: { 'project.list': PROJECTS } }) })
  let titles = (await first.request('tasks.list')).tasks.map((x) => x.title)
  assert.deepEqual(titles, ['From an agent'])
  assert.equal(await readFile(simpleTodoInbox, 'utf8'), '- [ ] Written for Simple Todo #old\n', 'left alone while the setting is off')
  await first.deactivate()

  const on = createWorker({ home, now: () => NOW, timers: false, installCli: false, simpleTodoInbox })
  const second = await mountWorker({ default: on.activate }, { host: mockHost({ settings: { takeSimpleTodoInbox: true }, results: { 'project.list': PROJECTS } }) })
  titles = (await second.request('tasks.list')).tasks.map((x) => x.title)
  assert.deepEqual(titles.sort(), ['From an agent', 'Written for Simple Todo'])
  await assert.rejects(stat(simpleTodoInbox))
  assert.deepEqual(second.refusals, [])
  await second.deactivate()
  await rm(home, { recursive: true, force: true })
})

test('installs a working CLI for agents beside the data', async () => {
  const t = await start({ installCli: true })
  const paths = await t.worker.request('tasks.paths')
  assert.equal(paths.cli, join(t.home, 'bin', 'orca-tasks'))
  const script = await readFile(paths.cli ?? '', 'utf8')
  assert.ok(script.startsWith('#!/bin/sh'))
  for (const file of ['store.ts', 'bots.ts', 'checklist.ts', 'statuses.ts']) assert.ok((await stat(join(t.home, 'cli', VERSION, 'core', file))).isFile())
  await t.stop()
})

test('Orca projects: exact names, the CLI cache, and opening a project in Orca', async () => {
  const t = await start()
  const { task } = await t.worker.request('tasks.add', { text: 'Pack the release @Online-Store' })
  assert.equal(task.project, 'online-store')
  const projects = await t.worker.request('tasks.projects')
  assert.deepEqual(projects.orca.map((p) => p.name), ['online-store', 'data-pipeline'])
  assert.deepEqual(projects.summary.map((p) => [p.name, p.open]), [['online-store', 1], ['data-pipeline', 0]])
  const cache = JSON.parse(await readFile(join(t.home, 'orca-projects.json'), 'utf8'))
  assert.equal(cache.from, 'host-api')
  assert.equal(cache.projects[0].name, 'online-store')
  const opened = await t.worker.request('tasks.openProject', { name: 'online-store' })
  assert.deepEqual(opened, { opened: true, workspace: 'main' }, "the project's own checkout is preferred")
  assert.deepEqual(t.host.callsOf('workspace.open').at(-1), { workspaceId: 'w-main' })
  await assert.rejects(t.worker.request('tasks.openProject', { name: 'Personal' }))
  // data-pipeline has no workspace in Orca.
  await assert.rejects(t.worker.request('tasks.openProject', { name: 'data-pipeline' }))
  await t.stop()
})

test('on hold: kept out of the status bar count and the summary', async () => {
  const t = await start()
  const late = await t.worker.request('tasks.add', { text: 'Late due:2026-11-20' })
  await t.worker.request('tasks.add', { text: 'Now', view: 'today' })
  const held = await t.worker.request('tasks.update', { id: late.task.id, patch: { waiting_on: "Bob's review" } })
  assert.deepEqual([held.task.status, held.task.waiting_on, held.task.held_at], ['hold', "Bob's review", NOW.toISOString()])
  const updates = t.host.callsOf('statusBar.update')
  const last = updates[updates.length - 1] as { text: string; tone: string }
  assert.deepEqual([last.text, last.tone], ['1 open', 'neutral'])
  assert.equal(await t.worker.command('agent-tasks.summary'), '1 due today:\nNow\n1 on hold.')
  await t.stop()
})

/** Orca's terminals as Send uses them: the command it starts is `orca-tasks send ...`; here a
 *  stand-in runs it against the same home (or prints an error). */
function sendTerminals(home: string, outcome: 'ok' | 'fail') {
  const created: { workspaceId: string; title?: string; command?: string }[] = []
  const closed: string[] = []
  return {
    created,
    closed,
    results: {
      'workspace.readContext': { workspaceId: 'w-main', branch: 'main', displayName: 'main', terminals: [] },
      'terminal.create': (params: { workspaceId: string; title?: string; command?: string }) => {
        created.push(params)
        if (outcome === 'ok') {
          const id = /'send' '([^']+)'/.exec(params.command ?? '')?.[1] ?? ''
          setTimeout(() => {
            const store = new TaskStore({ home })
            const state = /'--state' '([^']+)'/.exec(params.command ?? '')?.[1]
            void store.recordHandoff(id, { bot: 'Orca', bot_id: 'b1', type: 'handoff', chat: 'new', chat_id: '0bb66c0f-54fa-442a-bc6a-7bba13627dc0', message_id: 'msg_7', subject: 'x', sent_at: NOW.toISOString(), by: 'panel', returned_at: null }).then(() => (state ? store.update(id, { state, waiting_on: 'Orca' }) : undefined))
          }, 50)
        }
        return { terminalId: `term-${created.length}` }
      },
      'terminal.read': () => ({ lines: outcome === 'ok' ? ['$ orca-tasks send …'] : ['$ orca-tasks send …', 'orca-tasks: Sending to Orca failed: no_active_sender_terminal'], truncated: false }),
      'terminal.close': (params: { terminalId: string }) => {
        closed.push(params.terminalId)
        return { closed: true }
      }
    }
  }
}

test('send to a bot: offers the project bot, runs orca-tasks send in a terminal only on request, follows the chat', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const terminals = sendTerminals(home, 'ok')
  const t = await start({ home, installCli: true, results: terminals.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Check the invoices @online-store' })
  const offer = await t.worker.request('tasks.bots', { id: task.id })
  assert.deepEqual([offer.bots.map((b) => b.name), offer.project, offer.main, offer.default, offer.error], [['online-store', 'Orca'], 'online-store', 'Orca', 'online-store', null])
  assert.equal(terminals.created.length, 0, 'nothing is sent by adding, listing or offering')

  const { handoff, task: sent } = await t.worker.request('tasks.send', { id: task.id, bot: 'Orca', chat: 'new', note: "Bob's numbers", by: 'panel' })
  assert.equal(terminals.created.length, 1)
  const [made] = terminals.created
  assert.equal(made.workspaceId, 'w-main', 'in the focused workspace')
  assert.equal(made.title, 'Agent Tasks: send to Orca')
  assert.equal(made.command, `'${join(home, 'bin', 'orca-tasks')}' 'send' '${task.id}' '--to' 'Orca' '--type' 'handoff' '--chat' 'new' '--by' 'panel' '--note' 'Bob'\\''s numbers' '--keep-state'`)
  assert.deepEqual(terminals.closed, ['term-1'], 'the terminal is closed again')
  assert.deepEqual([handoff.bot, handoff.chat_id, handoff.message_id], ['Orca', '0bb66c0f-54fa-442a-bc6a-7bba13627dc0', 'msg_7'])
  assert.equal(sent.handoffs.length, 1)
  const listed = await t.worker.request('tasks.list')
  assert.deepEqual(listed.bots[task.id], { state: 'working', reply: 'On it.' })
  t.orcaCli.setState('done')
  const status = await t.worker.request('tasks.botStatus', { id: task.id })
  assert.equal(status.status?.state, 'done')
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Nobody', chat: 'new', by: 'panel' }))
  assert.equal(terminals.created.length, 1, 'an unknown bot opens no terminal')
  const back = await t.worker.request('tasks.takeBack', { id: task.id })
  assert.ok(back.task.handoffs[0].returned_at)
  assert.deepEqual((await t.worker.request('tasks.list')).bots, {})
  await t.stop()
})

test('send options reach orca-tasks send, the terminal waits for the new status, and the choices are remembered per project', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const terminals = sendTerminals(home, 'ok')
  const t = await start({ home, installCli: true, results: terminals.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Check the invoices @online-store' })
  const { task: other } = await t.worker.request('tasks.add', { text: 'Elsewhere' })
  const first = await t.worker.request('tasks.bots', { id: task.id })
  assert.deepEqual([first.last, first.lastChat], [null, null])
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Orca', chat: 'last', by: 'panel' }), /not been in a bot chat/)
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Orca', type: 'status', chat: 'new', by: 'panel' }), /cannot start a new chat/)
  assert.equal(terminals.created.length, 0)

  const { task: sent } = await t.worker.request('tasks.send', { id: task.id, bot: 'Orca', type: 'question', chat: 'home', note: 'Check progress', notes: false, state: 'pending', by: 'board' })
  assert.match(terminals.created[0].command ?? '', /'--type' 'question' '--chat' 'home' '--by' 'board' '--note' 'Check progress' '--no-notes' '--state' 'pending'$/)
  assert.deepEqual([sent.state, sent.status, sent.waiting_on], ['pending', 'hold', 'Orca'], 'the answer has the new status')
  assert.deepEqual(terminals.closed, ['term-1'])

  const again = await t.worker.request('tasks.bots', { id: task.id })
  assert.deepEqual(again.last, { bot: 'Orca', type: 'question', chat: 'home', notes: false, state: 'pending', keepState: false, chatChosen: true })
  assert.equal(again.lastChat, '0bb66c0f-54fa-442a-bc6a-7bba13627dc0')
  assert.equal((await t.worker.request('tasks.bots', { id: other.id })).last, null, 'another project has its own choices')

  // Deleting the remembered status drops it from the remembered choices.
  const { statuses } = await t.worker.request('tasks.statuses', { op: 'add', name: 'Blocked', kind: 'hold' })
  assert.ok(statuses.some((st) => st.id === 'blocked'))
  await t.worker.request('tasks.statuses', { op: 'remove', id: 'pending' })
  assert.equal((await t.worker.request('tasks.list')).tasks.find((x) => x.id === task.id)?.state, 'blocked')
  assert.equal((await t.worker.request('tasks.bots', { id: task.id })).last?.state, null)
  assert.equal((await t.worker.request('tasks.bots', { id: task.id })).last?.keepState, false, 'a deleted status is not a choice to leave it: the form starts at In Progress')

  // "Leave the status as it is" is remembered as a choice, and goes to the CLI as --keep-state.
  await t.worker.request('tasks.send', { id: task.id, bot: 'Orca', type: 'handoff', chat: 'home', notes: true, state: null, by: 'panel' })
  assert.match(terminals.created.at(-1)?.command ?? '', /'--keep-state'$/)
  assert.deepEqual((await t.worker.request('tasks.bots', { id: task.id })).last, { bot: 'Orca', type: 'handoff', chat: 'home', notes: true, state: null, keepState: true, chatChosen: true })

  // A new chat chosen now is kept; one kept by 0.5.1 or earlier starts at the Home Chat once.
  await t.worker.request('tasks.send', { id: task.id, bot: 'Orca', type: 'handoff', chat: 'new', notes: true, state: null, by: 'panel' })
  assert.equal((await t.worker.request('tasks.bots', { id: task.id })).last?.chat, 'new')
  const prefsFile = join(t.home, 'send-prefs.json')
  const prefs = JSON.parse(await readFile(prefsFile, 'utf8'))
  prefs.projects['online-store'] = { bot: 'Orca', type: 'handoff', chat: 'new', notes: true, state: null, keepState: true }
  await writeFile(prefsFile, JSON.stringify(prefs), 'utf8')
  assert.equal((await t.worker.request('tasks.bots', { id: task.id })).last?.chat, 'home', 'a new chat from before 0.6.0 starts at Home')
  await t.worker.request('tasks.send', { id: task.id, bot: 'Orca', type: 'handoff', chat: 'new', notes: true, state: null, by: 'panel' })
  assert.equal((await t.worker.request('tasks.bots', { id: task.id })).last?.chat, 'new', 'chosen again after that: kept')
  await t.stop()
})

test('send to a bot: what orca-tasks send printed as an error reaches the panel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const terminals = sendTerminals(home, 'fail')
  const t = await start({ home, installCli: true, results: terminals.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Check the invoices' })
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Orca', chat: 'home', by: 'board' }), /no_active_sender_terminal/)
  assert.deepEqual(terminals.closed, ['term-1'])
  assert.equal((await t.worker.request('tasks.list')).tasks[0].handoffs.length, 0)
  await t.stop()
})

test('reminders: none for what was already due, one when a task comes due, never twice', async () => {
  let clock = new Date(2026, 10, 23, 9, 0)
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const store = new TaskStore({ home, now: () => clock })
  await store.add({ title: 'Already late', due: '2026-11-20' })
  const t = await start({ home, now: () => clock, settings: { reminderTime: '08:00' } })
  assert.equal(t.host.callsOf('notifications.show').length, 0, 'the first look sends nothing')
  await t.worker.request('tasks.add', { text: 'Call Alice due:today@10:30' })
  await t.worker.request('tasks.add', { text: 'Tomorrow thing due:tomorrow' })
  await t.handle.tick()
  assert.equal(t.host.callsOf('notifications.show').length, 0, 'not due yet')
  clock = new Date(2026, 10, 23, 10, 31)
  await t.handle.tick()
  assert.deepEqual(t.host.callsOf('notifications.show'), [{ title: 'Due: Call Alice', body: 'Today 10:30' }])
  await t.handle.tick()
  assert.equal(t.host.callsOf('notifications.show').length, 1, 'never twice')
  clock = new Date(2026, 10, 24, 8, 1)
  await t.handle.tick()
  assert.deepEqual(t.host.callsOf('notifications.show').at(-1), { title: 'Due: Tomorrow thing', body: 'Today' }, 'a task without a time at the reminder time')
  await t.stop()
})

test('reminders can be turned off', async () => {
  let clock = new Date(2026, 10, 23, 9, 0)
  const t = await start({ now: () => clock, settings: { dueReminders: false } })
  await t.worker.request('tasks.add', { text: 'Call Alice due:today@10:30' })
  clock = new Date(2026, 10, 23, 11, 0)
  await t.handle.tick()
  assert.equal(t.host.callsOf('notifications.show').length, 0)
  await t.stop()
})

test('a 0.2.0 file is brought to the current schema when the worker starts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  await writeFile(join(home, 'tasks.json'), JSON.stringify({ format: 'orca-tasks', version: 1, revision: 3, updated_at: '2026-11-22T00:00:00.000Z', tasks: [{ id: 't-old00001', title: 'Old', notes: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', due: null, priority: 'none', project: null, tags: [], source: null, done_at: null }] }), 'utf8')
  const t = await start({ home })
  const file = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  assert.deepEqual([file.schema, file.version, file.tasks[0].due_time, file.tasks[0].handoffs, file.tasks[0].state, file.tasks[0].status], [3, 1, null, [], 'todo', 'open'])
  assert.deepEqual((await t.worker.request('tasks.list')).statuses.map((s) => s.name), ['To Do', 'In Progress', 'Pending', 'Done', 'Cancelled'])
  await t.stop()
})

test('the Board button opens a board file in the focused workspace, and never writes one', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-tasks-ws-'))
  const context = { workspaceId: 'w-main', branch: 'main', displayName: 'main', terminals: [] }
  const list = { workspaces: [{ id: 'w-main', kind: 'folder', name: 'main', projectId: 'p-web', path: folder, branch: null, hostId: 'local' }], truncated: false }
  const t = await start({ results: { 'workspace.readContext': context, 'workspace.list': list, 'editor.open': { opened: true } } })
  const without = await t.worker.request('tasks.openBoard')
  assert.equal(without.opened, false)
  assert.match(without.reason ?? '', /Open Agent Tasks board/)
  assert.deepEqual(await readdir(folder), [], 'nothing is written into the workspace')
  await writeFile(join(folder, BOARD_FILE), '', 'utf8')
  assert.deepEqual(await t.worker.request('tasks.openBoard'), { opened: true })
  assert.deepEqual(t.host.callsOf('editor.open').at(-1), { workspaceId: 'w-main', path: BOARD_FILE })
  await t.stop()
  await rm(folder, { recursive: true, force: true })
})

test('a handoff whose chat was not known yet gets it on the next look', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const store = new TaskStore({ home, now: () => NOW })
  const { task } = await store.add({ title: 'Late chat' })
  await store.recordHandoff(task.id, { bot: 'Orca', bot_id: 'b1', type: 'handoff', chat: 'new', chat_id: null, message_id: 'msg_1', subject: 'Late chat', sent_at: NOW.toISOString(), by: 'cli', returned_at: null })
  const t = await start({ home })
  const listed = await t.worker.request('tasks.list')
  assert.equal(listed.tasks[0].handoffs[0].chat_id, '9a72617b-1ce3-4f05-b5c3-65f7a1e75f6f')
  assert.deepEqual(listed.bots[task.id], { state: 'working', reply: 'On it.' })
  await t.stop()
})

test('dragging reaches the file through tasks.move, and the sidebar and the board keep what they show', async () => {
  const t = await start()
  const { task: a } = await t.worker.request('tasks.add', { text: 'First' })
  const { task: b } = await t.worker.request('tasks.add', { text: 'Second' })
  const { task: moved } = await t.worker.request('tasks.move', { id: b.id, state: 'pending', order: [b.id] })
  assert.deepEqual([moved.state, moved.status, moved.rank], ['pending', 'hold', 1])
  await t.worker.request('tasks.move', { id: a.id, state: 'pending', order: [a.id, b.id] })
  const listed = (await t.worker.request('tasks.list')).tasks
  assert.deepEqual(listed.map((x) => [x.title, x.state, x.rank]), [['First', 'pending', 1], ['Second', 'pending', 2]])

  assert.deepEqual(await t.worker.request('tasks.uiState', { surface: 'sidebar' }), { state: null })
  await t.worker.request('tasks.uiState', { surface: 'sidebar', set: { closed: { done: false }, filter: 'today' } })
  assert.deepEqual((await t.worker.request('tasks.uiState', { surface: 'sidebar' })).state, { closed: { done: false }, filter: 'today' })
  assert.equal((await t.worker.request('tasks.uiState', { surface: 'board' })).state, null, 'each surface has its own')
  await t.stop()
})

test('send to a bot: every chat and Then choice with an empty instruction, as the 0.4.3 panel sends it, goes out', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const terminals = sendTerminals(home, 'ok')
  const t = await start({ home, installCli: true, results: terminals.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Check the invoices' })
  const cli = `'${join(home, 'bin', 'orca-tasks')}'`
  let sends = 0
  for (const chat of ['new', 'home', 'last'] as const) {
    for (const state of ['', 'in-progress', 'pending', 'todo']) {
      for (const note of ['', 'Check progress']) {
        const input = botSendInput(task.id, { bot: 'Orca', type: 'handoff', chat, note, notes: note === '', state }, 'panel')
        await t.worker.request('tasks.send', input)
        sends += 1
        const command = terminals.created.at(-1)?.command ?? ''
        const expected = `${cli} 'send' '${task.id}' '--to' 'Orca' '--type' 'handoff' '--chat' '${chat}' '--by' 'panel'${note ? ` '--note' '${note}'` : ''}${note === '' ? '' : ` '--no-notes'`}${state ? ` '--state' '${state}'` : ` '--keep-state'`}`
        assert.equal(command, expected)
      }
    }
  }
  assert.equal(terminals.created.length, sends)
  assert.equal(terminals.closed.length, sends, 'every send terminal is closed again')
  await t.stop()
})

test('send to a bot: a bad request names the field', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const terminals = sendTerminals(home, 'ok')
  const t = await start({ home, installCli: true, results: terminals.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Check the invoices' })
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Orca', chat: 'elsewhere' as never }), /^Error: Chat: must be a new chat/)
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Orca', chat: 'home', state: 'reviewing' }), /^Error: Then: there is no status reviewing/)
  await assert.rejects(t.worker.request('tasks.send', { id: task.id, bot: 'Nobody', chat: 'home' }), /^Error: Send to: Orca has no bot named Nobody/)
  assert.equal(terminals.created.length, 0)
  await t.stop()
})

/** Orca's workspace.create and workspace.list as a project send uses them. */
function projectHost() {
  const created: Record<string, unknown>[] = []
  const opened: string[] = []
  let state = 'working'
  return {
    created,
    opened,
    setState: (s: string) => (state = s),
    results: {
      'workspace.create': (params: Record<string, unknown>) => {
        created.push(params)
        return { workspaceId: 'w-new', terminalId: 'term-agent' }
      },
      'workspace.list': (params?: { includeStatus?: boolean }) => ({
        workspaces: [
          ...WORKSPACES.workspaces,
          { id: 'w-new', kind: 'worktree', name: 'fix-the-login-bug', projectId: 'p-web', path: '/Users/me/web-wt/fix', branch: 'fix', hostId: 'local', ...(params?.includeStatus ? { status: { state, unread: state === 'done', terminalCount: 1, lastActivityAt: 7 } } : {}) }
        ],
        truncated: false
      }),
      'workspace.open': (params: { workspaceId: string }) => {
        opened.push(params.workspaceId)
        return { opened: true }
      }
    }
  }
}

test('send to the project: a new workspace with the agent and the task as its prompt, recorded, with its status and a way to open it', async () => {
  const orcaHost = projectHost()
  const t = await start({ installCli: true, results: orcaHost.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Fix the login bug @online-store' })
  const { task: loose } = await t.worker.request('tasks.add', { text: 'Somewhere else @not-orca' })
  assert.equal(orcaHost.created.length, 0, 'nothing starts until the button is pressed')

  const offer = await t.worker.request('tasks.projectOffer', { id: task.id })
  assert.deepEqual([offer.project, offer.error, offer.access, offer.agents, offer.last], ['online-store', null, null, ['claude', 'codex'], null])
  assert.match((await t.worker.request('tasks.projectOffer', { id: loose.id })).error ?? '', /not one of your Orca projects/)

  const { task: sent, workspace } = await t.worker.request('tasks.sendToProject', { id: task.id, agent: 'codex', note: 'Write a test first', notes: true, state: 'in-progress', open: false, by: 'board' })
  assert.equal(orcaHost.created.length, 1)
  const [params] = orcaHost.created
  assert.deepEqual([params.projectId, params.hostId, params.name, params.agent, params.open], ['p-web', 'local', `fix-the-login-bug-${task.id.slice(2, 6)}`, 'codex', false])
  assert.match(String(params.prompt), /Write a test first\n\nTask: Fix the login bug\n/)
  assert.deepEqual([workspace.workspace_id, workspace.terminal_id, workspace.agent, workspace.by, workspace.project], ['w-new', 'term-agent', 'codex', 'board', 'online-store'])
  assert.deepEqual([sent.state, sent.workspaces?.length], ['in-progress', 1])

  const listed = await t.worker.request('tasks.list')
  assert.deepEqual(listed.workspaces?.[task.id], { state: 'working', unread: false, lastActivityAt: 7 })
  orcaHost.setState('done')
  assert.deepEqual((await t.worker.request('tasks.workspaceStatus', { id: task.id })).status, { state: 'done', unread: true, lastActivityAt: 7 })
  assert.deepEqual(await t.worker.request('tasks.openWorkspace', { id: task.id }), { opened: true, workspace: `fix-the-login-bug-${task.id.slice(2, 6)}` })
  assert.deepEqual(orcaHost.opened, ['w-new'])
  assert.deepEqual((await t.worker.request('tasks.projectOffer', { id: task.id })).last, { agent: 'codex', notes: true, state: 'in-progress', keepState: false, open: false }, 'the choices are remembered per project')

  await assert.rejects(t.worker.request('tasks.sendToProject', { id: loose.id }), /^Error: Project: /)
  await assert.rejects(t.worker.request('tasks.sendToProject', { id: task.id, agent: 'gemini' as never }), /^Error: Agent: must be claude or codex/)
  assert.equal(orcaHost.created.length, 1)
  await t.stop()
})

test('send to another project (the send menu): the workspace starts there, the choices are kept for that project', async () => {
  const orcaHost = projectHost()
  const t = await start({ installCli: true, results: orcaHost.results })
  const { task } = await t.worker.request('tasks.add', { text: 'Load the sample data @online-store' })
  const { task: none } = await t.worker.request('tasks.add', { text: 'Write the import script' })

  const offer = await t.worker.request('tasks.projectOffer', { id: none.id, project: 'data-pipeline' })
  assert.deepEqual([offer.project, offer.error], ['data-pipeline', null], 'a task without a project can go to any Orca project')
  assert.match((await t.worker.request('tasks.projectOffer', { id: task.id, project: 'gone' })).error ?? '', /^gone is not one of your Orca projects/)

  const { task: sent, workspace } = await t.worker.request('tasks.sendToProject', { id: task.id, agent: 'claude', notes: true, state: 'in-progress', open: false, by: 'panel', project: 'data-pipeline' })
  const [params] = orcaHost.created
  assert.equal(params.projectId, 'p-df')
  assert.match(String(params.prompt), /a new branch of data-pipeline\./)
  assert.deepEqual([workspace.project, sent.project, sent.state], ['data-pipeline', 'online-store', 'in-progress'], 'the task keeps its own project')
  assert.deepEqual((await t.worker.request('tasks.projectOffer', { id: none.id, project: 'data-pipeline' })).last?.agent, 'claude', 'kept for data-pipeline')
  assert.equal((await t.worker.request('tasks.projectOffer', { id: task.id })).last, null, 'not for the task\'s own project')
  await assert.rejects(t.worker.request('tasks.sendToProject', { id: task.id, project: 'gone' }), /^Error: Project: gone is not one of your Orca projects/)
  assert.equal(orcaHost.created.length, 1)
  await t.stop()
})

test('the page\'s back/forward diagnostics land in the plugin log, at most 60 lines a minute', async () => {
  let clock = new Date('2026-11-24T10:00:00.000Z')
  const t = await start({ now: () => clock })
  const before = t.worker.logs.length
  await t.worker.request('tasks.navLog', { start: { surface: 'sidebar', views: ['list', 'details', 'statuses', 'menus'], events: ['pointerdown', 'keydown'], top: true, focus: true, hostApi: '1.9', platform: 'MacIntel' } })
  await t.worker.request('tasks.navLog', {
    entries: [
      { surface: 'sidebar', view: 'list', type: 'pointerdown', button: 3, buttons: 8, pointerType: 'mouse', mods: '', target: 'row', focus: true, taken: 'stopped' },
      { surface: 'sidebar', view: 'list', type: 'keydown', key: '[', code: 'BracketLeft', mods: 'meta', target: 'page', focus: true, taken: 'back' }
    ]
  })
  assert.deepEqual(t.worker.logs.slice(before), [
    'nav listeners attached: sidebar (views list, details, statuses, menus; top frame; focus=yes; host API 1.9; MacIntel): pointerdown, keydown',
    'nav sidebar/list pointerdown button=3 buttons=8 pointer=mouse mods=none on=row focus=yes -> stopped',
    'nav sidebar/list keydown key=[ code=BracketLeft mods=meta on=page focus=yes -> back'
  ])
  const many = Array.from({ length: 50 }, () => ({ surface: 'board', view: 'board', type: 'auxclick', button: 3, buttons: 0, mods: '', target: 'card', focus: false, taken: 'back' }))
  await t.worker.request('tasks.navLog', { entries: many })
  await t.worker.request('tasks.navLog', { entries: many, dropped: 3 })
  assert.equal(t.worker.logs.filter((l) => l.startsWith('nav board/')).length, 58, '60 a minute, with the two before')
  clock = new Date('2026-11-24T10:01:00.000Z')
  await t.worker.request('tasks.navLog', { entries: many.slice(0, 1) })
  assert.ok(t.worker.logs.includes('nav: 43 more line(s) left out in the minute before'))
  assert.equal(t.worker.logs.at(-1), 'nav board/board auxclick button=3 buttons=0 mods=none on=card focus=no -> back')
  await t.stop()
})

test('send to the project: without the new capabilities it says what to approve', async () => {
  const orcaHost = projectHost()
  const capabilities = ['settings:own', 'workspace:read', 'workspace:write', 'notifications:show', 'terminal:send', 'terminal:read']
  const t = await start({ results: orcaHost.results, capabilities })
  const { task } = await t.worker.request('tasks.add', { text: 'Fix the login bug @online-store' })
  const offer = await t.worker.request('tasks.projectOffer', { id: task.id })
  assert.match(offer.access ?? '', /workspace:create and agent:launch/)
  await assert.rejects(t.worker.request('tasks.sendToProject', { id: task.id }), /needs your OK to start workspaces and agents \(workspace:create and agent:launch\)/)
  assert.equal(orcaHost.created.length, 0)
  await t.worker.deactivate()
})

test('merge through the worker, and undo it', async () => {
  const t = await start()
  const { task: keep } = await t.worker.request('tasks.add', { text: 'Reply to Alice' })
  const { task: dup } = await t.worker.request('tasks.add', { text: 'Alice reply !high' })
  const dry = await t.worker.request('tasks.merge', { keep: keep.id, ids: [dup.id], dryRun: true })
  assert.equal(dry.keeper.priority, 'high')
  assert.equal((await t.worker.request('tasks.list')).canUndoMerge, false)
  const { keeper, merged } = await t.worker.request('tasks.merge', { keep: keep.id, ids: [dup.id], priority: 'keep', due: 'none', created: 'keep' })
  assert.deepEqual([keeper.priority, merged[0].merged_into, merged[0].state_name], ['none', keep.id, 'Cancelled'])
  assert.equal((await t.worker.request('tasks.list')).canUndoMerge, true)
  await assert.rejects(t.worker.request('tasks.merge', { keep: keep.id, ids: [] }), /^Error: Merge: choose at least one/)
  const undone = await t.worker.request('tasks.undoMerge')
  assert.equal(undone.restored[0].state, 'todo')
  assert.equal((await t.worker.request('tasks.list')).canUndoMerge, false)
  await t.stop()
})

test('suggest merges: the groups the agent finds come back, nothing merges, a dismissed one does not come back; bad JSON and a timeout are errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-worker-'))
  const command = await stubAgent(home)
  const env: Record<string, string | undefined> = { ...process.env, STUB_MODE: 'good' }
  const t = await start({ home, suggestAgent: { command, env, timeoutMs: 400 } })
  await t.worker.request('tasks.add', { text: 'Send the board memo' })
  await t.worker.request('tasks.add', { text: 'Board memo to Bob' })
  await t.worker.request('tasks.add', { text: 'Reply to Alice' })
  const before = JSON.stringify((await t.worker.request('tasks.list')).tasks)
  const [first, second] = await Promise.all([t.worker.request('tasks.suggestMerges'), t.worker.request('tasks.suggestMerges')])
  assert.deepEqual(first, second, 'two presses, one run')
  assert.equal(first.considered, 3)
  assert.equal(first.suggestions.length, 1)
  assert.equal(first.suggestions[0].reason, 'Both ask for the Q4 memo')
  assert.equal(JSON.stringify((await t.worker.request('tasks.list')).tasks), before, 'nothing merged')
  await t.worker.request('tasks.dismissMerge', { ids: first.suggestions[0].ids })
  const again = await t.worker.request('tasks.suggestMerges')
  assert.deepEqual([again.suggestions.length, again.hidden], [0, 1])
  await assert.rejects(t.worker.request('tasks.dismissMerge', { ids: ['t-1'] }), /two or more tasks/)
  env.STUB_MODE = 'bad'
  await assert.rejects(t.worker.request('tasks.suggestMerges'), /did not answer with the JSON it was asked for/)
  env.STUB_MODE = 'slow'
  await assert.rejects(t.worker.request('tasks.suggestMerges'), /did not answer within 0 s/)
  await t.stop()
})
