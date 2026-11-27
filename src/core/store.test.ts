// The file store: atomic, locked writes; plain node:test so CI runs it with Node alone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreError, TaskStore } from './store.ts'

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orca-tasks-test-'))
}

test('an empty folder reads as an empty list, and the first write creates the file', async () => {
  const home = await tempHome()
  const store = new TaskStore({ home })
  assert.deepEqual((await store.read()).tasks, [])
  const { task, created } = await store.add({ title: 'First', due: '2026-11-30', tags: ['a'] })
  assert.ok(created)
  assert.match(task.id, /^t-[a-z0-9]{8}$/)
  const file = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  assert.equal(file.format, 'orca-tasks')
  assert.equal(file.version, 1)
  assert.equal(file.revision, 1)
  assert.equal(file.tasks[0].title, 'First')
  // No lock or temporary file is left behind.
  assert.deepEqual((await readdir(home)).sort(), ['tasks.json'])
  await rm(home, { recursive: true, force: true })
})

test('complete, reopen, edit and delete keep ids stable', async () => {
  const home = await tempHome()
  let clock = new Date('2026-11-23T06:00:00.000Z')
  const store = new TaskStore({ home, now: () => clock })
  const { task } = await store.add({ title: 'Call Alice' })
  clock = new Date('2026-11-23T07:00:00.000Z')
  const done = await store.setDone(task.id, true)
  assert.equal(done.id, task.id)
  assert.equal(done.done_at, '2026-11-23T07:00:00.000Z')
  // Completing again keeps the first time.
  clock = new Date('2026-11-23T08:00:00.000Z')
  assert.equal((await store.setDone(task.id, true)).done_at, '2026-11-23T07:00:00.000Z')
  assert.equal((await store.read()).revision, 2, 'a no-op does not write')
  assert.equal((await store.setDone(task.id, false)).done_at, null)
  const edited = await store.update(task.id, { title: 'Call Alice back', priority: 'high' })
  assert.equal(edited.title, 'Call Alice back')
  assert.equal(edited.created_at, '2026-11-23T06:00:00.000Z')
  await store.remove(task.id)
  assert.deepEqual(await store.list(), [])
  await rm(home, { recursive: true, force: true })
})

test('dedupe on source answers the existing task', async () => {
  const home = await tempHome()
  const store = new TaskStore({ home })
  const first = await store.add({ title: 'From the tracker', source: 'https://tracker.example.com/tasks/1' }, { dedupe: true })
  const again = await store.add({ title: 'From the tracker (again)', source: 'https://tracker.example.com/tasks/1' }, { dedupe: true })
  assert.equal(again.created, false)
  assert.equal(again.task.id, first.task.id)
  assert.equal((await store.list()).length, 1)
  await rm(home, { recursive: true, force: true })
})

test('many writers at once lose nothing (one process, separate stores)', async () => {
  const home = await tempHome()
  const writers = Array.from({ length: 8 }, () => new TaskStore({ home }))
  await Promise.all(
    writers.flatMap((store, w) => Array.from({ length: 10 }, (_, i) => store.add({ title: `w${w} #${i}` })))
  )
  const file = await new TaskStore({ home }).read()
  assert.equal(file.tasks.length, 80)
  assert.equal(file.revision, 80)
  assert.equal(new Set(file.tasks.map((t) => t.id)).size, 80)
  await rm(home, { recursive: true, force: true })
})

test('many writers at once lose nothing (separate processes)', async () => {
  const home = await tempHome()
  const storeUrl = new URL('./store.ts', import.meta.url).href
  const writer = `
    const { TaskStore } = await import(${JSON.stringify(storeUrl)})
    const store = new TaskStore({ home: process.env.ORCA_TASKS_HOME })
    for (let i = 0; i < 10; i++) await store.add({ title: 'pid ' + process.pid + ' #' + i })
  `
  const runs = Array.from(
    { length: 6 },
    () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', writer], {
          env: { ...process.env, ORCA_TASKS_HOME: home }
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => (stderr += String(chunk)))
        child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`writer exited ${code}: ${stderr}`))))
      })
  )
  await Promise.all(runs)
  const file = await new TaskStore({ home }).read()
  assert.equal(file.tasks.length, 60)
  assert.equal(file.revision, 60)
  assert.equal(new Set(file.tasks.map((t) => t.id)).size, 60)
  await rm(home, { recursive: true, force: true })
})

test('a lock left by a dead process is cleared; a live one is waited for', async () => {
  const home = await tempHome()
  const store = new TaskStore({ home, lockTimeoutMs: 300 })
  await writeFile(join(home, 'tasks.json.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }), 'utf8')
  await store.add({ title: 'after a crash' })
  assert.equal((await store.list()).length, 1)
  // A lock held by this (live) process and fresh: the writer gives up with `locked`.
  await writeFile(join(home, 'tasks.json.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
  await assert.rejects(store.add({ title: 'blocked' }), (error: unknown) => error instanceof StoreError && error.code === 'locked')
  // Old enough, it is taken to be stale whoever holds it.
  const stale = new TaskStore({ home, staleLockMs: 0 })
  await stale.add({ title: 'after a stale lock' })
  assert.equal((await stale.list()).length, 2)
  await rm(home, { recursive: true, force: true })
})

test('a broken file is reported and never overwritten', async () => {
  const home = await tempHome()
  await writeFile(join(home, 'tasks.json'), '{"tasks": [', 'utf8')
  const store = new TaskStore({ home })
  await assert.rejects(store.add({ title: 'x' }), (error: unknown) => error instanceof StoreError && error.code === 'corrupt')
  assert.equal(await readFile(join(home, 'tasks.json'), 'utf8'), '{"tasks": [')
  await writeFile(join(home, 'tasks.json'), JSON.stringify({ format: 'orca-tasks', version: 9, tasks: [] }), 'utf8')
  await assert.rejects(store.read(), (error: unknown) => error instanceof StoreError && error.code === 'too_new')
  await rm(home, { recursive: true, force: true })
})

test('unknown fields in the file and on tasks survive a write', async () => {
  const home = await tempHome()
  await writeFile(
    join(home, 'tasks.json'),
    JSON.stringify({ format: 'orca-tasks', version: 1, revision: 4, updated_at: '2026-11-01T00:00:00.000Z', lists: ['x'], tasks: [{ id: 't-old', title: 'Old', estimate: 3 }] }),
    'utf8'
  )
  const store = new TaskStore({ home })
  await store.update('t-old', { priority: 'low' })
  const file = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  assert.deepEqual(file.lists, ['x'])
  assert.equal(file.revision, 5)
  assert.equal(file.tasks[0].estimate, 3)
  assert.equal(file.tasks[0].priority, 'low')
  await rm(home, { recursive: true, force: true })
})

test('the inbox is taken in and emptied', async () => {
  const home = await tempHome()
  const store = new TaskStore({ home, now: () => new Date(2026, 10, 23, 12) })
  assert.deepEqual(await store.takeInbox(), [])
  await writeFile(join(home, 'inbox.md'), '- [ ] Review the PR !high @orca #review due:tomorrow\n- [x] Already done\n\nnot-a-task-line-is-still-a-task\n', 'utf8')
  const added = await store.takeInbox(undefined, 0)
  assert.deepEqual(
    added.map((t) => [t.title, t.priority, t.project, t.tags, t.due, t.done_at !== null]),
    [
      ['Review the PR', 'high', 'orca', ['review'], '2026-11-24', false],
      ['Already done', 'none', null, [], null, true],
      ['not-a-task-line-is-still-a-task', 'none', null, [], null, false]
    ]
  )
  await assert.rejects(stat(join(home, 'inbox.md')))
  assert.deepEqual((await readdir(home)).sort(), ['tasks.json'])
  await rm(home, { recursive: true, force: true })
})

test('a project that names an Orca project is stored as its exact name', async () => {
  const home = await tempHome()
  const orca = [{ name: 'online-store', id: 'p1', kind: 'git' as const, path: '/p', hostId: 'local', hidden: false }]
  const store = new TaskStore({ home, orcaProjects: async () => orca })
  const { task } = await store.add({ title: 'Pack', project: 'Online Store' })
  assert.equal(task.project, 'online-store')
  assert.equal((await store.update(task.id, { project: 'online_store' })).project, 'online-store')
  assert.equal((await store.update(task.id, { project: 'Personal' })).project, 'Personal')
  const [imported] = await store.importLines('- [ ] From a line @Online-Store')
  assert.equal(imported.project, 'online-store')
  await rm(home, { recursive: true, force: true })
})

test('a 0.2.0 file is migrated to the current schema, keeps everything, and 0.2.0 can still read it', async () => {
  const home = await tempHome()
  const old = {
    format: 'orca-tasks',
    version: 1,
    revision: 41,
    updated_at: '2026-11-22T00:00:00.000Z',
    mine: 'kept',
    tasks: [
      { id: 't-old00001', title: 'From 0.2.0', notes: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', due: '2026-11-25', priority: 'high', project: 'ops', tags: ['a'], source: null, done_at: null, status: 'hold', waiting_on: 'Bob', held_at: '2026-11-21T00:00:00.000Z', custom: 1 },
      { id: 't-old00002', title: 'From 0.1.0', notes: 'n', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', due: null, priority: 'none', project: null, tags: [], source: 'chat:1', done_at: '2026-11-21T00:00:00.000Z' }
    ]
  }
  await writeFile(join(home, 'tasks.json'), JSON.stringify(old), 'utf8')
  const store = new TaskStore({ home, now: () => new Date('2026-11-23T00:00:00.000Z') })
  assert.equal(await store.schemaOnDisk(), 1)
  // Reading migrates in memory without writing.
  const read = await store.read()
  assert.deepEqual(read.tasks.map((t) => [t.due_time, t.handoffs]), [[null, []], [null, []]])
  assert.equal(JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8')).schema, undefined)

  assert.equal(await store.migrate(), true)
  assert.equal(await store.migrate(), false, 'only once')
  const file = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  assert.equal(file.version, 1, 'still a format 0.2.0 reads')
  assert.equal(file.schema, 3)
  assert.equal(file.revision, 42)
  assert.equal(file.mine, 'kept')
  const [a, b] = file.tasks
  assert.deepEqual(
    [a.status, a.waiting_on, a.held_at, a.priority, a.custom, a.due_time, a.handoffs],
    ['hold', 'Bob', '2026-11-21T00:00:00.000Z', 'high', 1, null, []]
  )
  assert.deepEqual([b.status, b.done_at, b.source, b.due_time, b.handoffs], ['done', '2026-11-21T00:00:00.000Z', 'chat:1', null, []])
  assert.deepEqual([a.state, b.state], ['pending', 'done'])

  // What 0.2.0 does with this file: its reader refuses only `version > 1`, and its normalizeTask
  // keeps fields it does not know (`...t`), so a 0.2.0 write keeps due_time and handoffs.
  const { normalizeTask: oldNormalize } = await import('./tasks.ts')
  assert.equal(file.version > 1, false)
  assert.equal(oldNormalize(a)?.due_time, null)

  // A file with no tasks file at all needs no migration.
  const empty = new TaskStore({ home: await tempHome() })
  assert.equal(await empty.migrate(), false)
  await rm(home, { recursive: true, force: true })
})

test('handoffs are recorded and taken back under the lock', async () => {
  const home = await tempHome()
  let clock = new Date('2026-11-23T06:00:00.000Z')
  const store = new TaskStore({ home, now: () => clock })
  const { task } = await store.add({ title: 'Send me' })
  const handoff = { bot: 'Orca', bot_id: 'b1', type: 'handoff' as const, chat: 'new' as const, chat_id: 'c1', message_id: 'm1', subject: 'Send me', sent_at: clock.toISOString(), by: 'cli' as const, returned_at: null }
  const sent = await store.recordHandoff(task.id, handoff)
  assert.deepEqual(sent.handoffs, [handoff])
  clock = new Date('2026-11-23T07:00:00.000Z')
  const back = await store.returnHandoff(task.id)
  assert.equal(back.handoffs[0].returned_at, '2026-11-23T07:00:00.000Z')
  const again = await store.returnHandoff(task.id)
  assert.equal(again.handoffs[0].returned_at, '2026-11-23T07:00:00.000Z', 'taking back twice keeps the first time')
  const file = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  assert.equal(file.schema, 3)
  assert.equal(file.tasks[0].handoffs[0].chat_id, 'c1')
  await rm(home, { recursive: true, force: true })
})

test('a 0.3.0 file is migrated to statuses: open to To Do, held or waiting to Pending, done to Done', async () => {
  const home = await tempHome()
  const at = '2026-11-20T00:00:00.000Z'
  const base = { notes: '', created_at: at, updated_at: at, due: null, due_time: null, priority: 'none', project: null, tags: [], source: null, done_at: null, status: 'open', waiting_on: null, held_at: null, handoffs: [] }
  const sent = { bot: 'Orca', bot_id: 'b1', chat: 'new', chat_id: 'c1', message_id: 'm1', subject: 'With a bot', sent_at: at, by: 'panel', returned_at: null }
  const old = {
    format: 'orca-tasks',
    version: 1,
    schema: 2,
    revision: 7,
    updated_at: at,
    tasks: [
      { ...base, id: 't-open0001', title: 'Open' },
      { ...base, id: 't-held0001', title: 'Held', status: 'hold', waiting_on: 'Bob', held_at: '2026-11-21T00:00:00.000Z' },
      { ...base, id: 't-wait0001', title: 'Waiting on, no held_at', waiting_on: 'Pablo' },
      { ...base, id: 't-done0001', title: 'Done', status: 'done', done_at: '2026-11-22T00:00:00.000Z' },
      { ...base, id: 't-bot00001', title: 'With a bot', handoffs: [sent], custom: 'kept' }
    ]
  }
  await writeFile(join(home, 'tasks.json'), JSON.stringify(old), 'utf8')
  const store = new TaskStore({ home, now: () => new Date('2026-11-24T00:00:00.000Z') })
  assert.equal(await store.schemaOnDisk(), 2)
  assert.equal(await store.migrate(), true)
  assert.equal(await store.migrate(), false, 'only once')
  const file = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  assert.equal(file.schema, 3)
  assert.equal(file.version, 1, 'older versions still read it')
  assert.deepEqual(
    file.statuses.map((s: { id: string; name: string; kind: string; closed: boolean }) => [s.id, s.name, s.kind, s.closed]),
    [
      ['todo', 'To Do', 'open', false],
      ['in-progress', 'In Progress', 'open', false],
      ['pending', 'Pending', 'hold', false],
      ['done', 'Done', 'done', true],
      ['cancelled', 'Cancelled', 'cancelled', true]
    ]
  )
  const by = Object.fromEntries(file.tasks.map((t: Record<string, unknown>) => [t.id, t]))
  // The new fields.
  assert.deepEqual(
    file.tasks.map((t: Record<string, unknown>) => [t.id, t.state, t.state_name]),
    [
      ['t-open0001', 'todo', 'To Do'],
      ['t-held0001', 'pending', 'Pending'],
      ['t-wait0001', 'pending', 'Pending'],
      ['t-done0001', 'done', 'Done'],
      ['t-bot00001', 'todo', 'To Do']
    ]
  )
  // The 0.3.0 fields keep their meaning: what scripts using the CLI read.
  assert.deepEqual([by['t-open0001'].status, by['t-open0001'].done_at, by['t-open0001'].held_at, by['t-open0001'].closed_at], ['open', null, null, null])
  assert.deepEqual([by['t-held0001'].status, by['t-held0001'].waiting_on, by['t-held0001'].held_at], ['hold', 'Bob', '2026-11-21T00:00:00.000Z'])
  assert.deepEqual([by['t-wait0001'].status, by['t-wait0001'].waiting_on, by['t-wait0001'].held_at], ['hold', 'Pablo', at], 'held since its last change')
  assert.deepEqual([by['t-done0001'].status, by['t-done0001'].done_at, by['t-done0001'].closed_at], ['done', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'])
  assert.deepEqual([by['t-bot00001'].handoffs[0].type, by['t-bot00001'].custom], ['handoff', 'kept'])
  assert.equal(file.revision, 8)

  // 0.3.0 writes after the migration (as its CLI would): its fields win over a state that no
  // longer agrees with them.
  const after = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'))
  after.tasks[0].done_at = '2026-11-24T01:00:00.000Z' // 0.3.0 `done`
  after.tasks[0].status = 'done'
  after.tasks[1].held_at = null // 0.3.0 `unhold`
  after.tasks[1].waiting_on = null
  after.tasks[1].status = 'open'
  after.tasks[3].done_at = null // 0.3.0 `undone`
  after.tasks[3].status = 'open'
  await writeFile(join(home, 'tasks.json'), JSON.stringify(after), 'utf8')
  const reread = await store.read()
  assert.deepEqual(reread.tasks.slice(0, 4).map((t) => [t.state, t.status]), [['done', 'done'], ['todo', 'open'], ['pending', 'hold'], ['todo', 'open']])
  await rm(home, { recursive: true, force: true })
})

test('statuses: add, rename, recolour, move, change kind and delete; tasks follow', async () => {
  const home = await tempHome()
  let clock = new Date('2026-11-24T06:00:00.000Z')
  const store = new TaskStore({ home, now: () => clock })
  const { task: a } = await store.add({ title: 'A' })
  const { task: b } = await store.add({ title: 'B', state: 'In Progress' })
  assert.deepEqual([a.state, b.state, b.status], ['todo', 'in-progress', 'open'])

  let list = await store.editStatuses({ op: 'add', name: 'Review', kind: 'hold', color: 'purple', index: 2 })
  assert.deepEqual(list.map((s) => s.id), ['todo', 'in-progress', 'review', 'pending', 'done', 'cancelled'])
  const held = await store.update(b.id, { state: 'review', waiting_on: 'Bob' })
  assert.deepEqual([held.state, held.state_name, held.status, held.waiting_on, held.held_at], ['review', 'Review', 'hold', 'Bob', clock.toISOString()])

  list = await store.editStatuses({ op: 'update', id: 'review', name: 'In review', color: 'teal' })
  assert.equal((await store.get(b.id)).state_name, 'In review', 'a rename reaches the tasks')
  await assert.rejects(store.editStatuses({ op: 'update', id: 'review', name: 'to do' }), /already a status called/)
  await assert.rejects(store.editStatuses({ op: 'update', id: 'done', kind: 'open' }), /no closed · done status/)

  list = await store.editStatuses({ op: 'move', id: 'done', index: 0 })
  assert.equal(list[0].id, 'done')

  // Changing a status's kind changes what its tasks report to older readers.
  clock = new Date('2026-11-24T07:00:00.000Z')
  await store.editStatuses({ op: 'update', id: 'review', kind: 'done' })
  const closed = await store.get(b.id)
  assert.deepEqual([closed.status, closed.done_at, closed.held_at, closed.waiting_on], ['done', clock.toISOString(), null, null])

  // Deleting moves its tasks to the first other status of its kind, or where it is told.
  await store.editStatuses({ op: 'remove', id: 'review' })
  assert.equal((await store.get(b.id)).state, 'done')
  const { task: c } = await store.add({ title: 'C', state: 'pending', waiting_on: 'Alice' })
  await store.editStatuses({ op: 'add', name: 'Blocked', kind: 'hold' })
  await store.editStatuses({ op: 'remove', id: 'pending', moveTo: 'blocked' })
  const moved = await store.get(c.id)
  assert.deepEqual([moved.state, moved.status, moved.waiting_on], ['blocked', 'hold', 'Alice'])

  // Cancelled: closed but not completed, so it has closed_at and no done_at.
  const cancelled = await store.update(a.id, { state: 'Cancelled' })
  assert.deepEqual([cancelled.status, cancelled.done_at, cancelled.closed_at], ['done', null, clock.toISOString()])
  const reopened = await store.setDone(a.id, false)
  assert.deepEqual([reopened.state, reopened.status, reopened.closed_at], ['todo', 'open', null])
  await rm(home, { recursive: true, force: true })
})

test('dragging: move to a status and a place in its section in one write; the CLI order is unchanged', async () => {
  const home = await tempHome()
  const store = new TaskStore({ home, now: () => new Date('2026-11-24T06:00:00.000Z') })
  const a = (await store.add({ title: 'A', due: '2026-11-25' })).task
  const b = (await store.add({ title: 'B', due: '2026-11-26' })).task
  const c = (await store.add({ title: 'C', due: '2026-11-27', state: 'In Progress' })).task
  // Reorder To Do: B above A.
  await store.move(b.id, null, [b.id, a.id])
  let tasks = await store.list({})
  assert.deepEqual(tasks.map((t) => [t.title, t.rank ?? null]), [['A', 2], ['B', 1], ['C', null]], 'list keeps its due order; ranks are for the panel')
  // C goes from In Progress to To Do, between B and A.
  const moved = await store.move(c.id, 'todo', [b.id, c.id, a.id])
  assert.deepEqual([moved.state, moved.status, moved.rank], ['todo', 'open', 2])
  tasks = await store.list({})
  assert.deepEqual(Object.fromEntries(tasks.map((t) => [t.title, t.rank])), { A: 3, B: 1, C: 2 })
  // Dropped on Done: completed like any other way of finishing it.
  const done = await store.move(a.id, 'done', [a.id])
  assert.deepEqual([done.status, done.done_at, done.rank], ['done', '2026-11-24T06:00:00.000Z', 1])
  // Changing the status another way drops the old place.
  const back = await store.update(a.id, { state: 'todo' })
  assert.equal('rank' in back, false)
  await rm(home, { recursive: true, force: true })
})
