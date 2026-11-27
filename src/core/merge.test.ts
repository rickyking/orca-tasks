// Merging duplicate tasks: the rules, the store's merge and undo, and add --dedupe after a merge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keeperOf, mergeDefaults, mergeTasks } from './merge.ts'
import { DEFAULT_STATUSES } from './statuses.ts'
import { TaskStore } from './store.ts'
import { makeTask, patchTask } from './tasks.ts'
import type { Handoff, Task } from './types.ts'

const NOW = new Date('2026-11-25T06:00:00.000Z')
const statuses = DEFAULT_STATUSES

function task(id: string, title: string, fields: Record<string, unknown>, created: string): Task {
  return { ...makeTask({ title, ...fields }, id, new Date(created), statuses) }
}

const handoff = (bot: string, at: string): Handoff => ({ bot, bot_id: null, type: 'handoff', chat: 'new', chat_id: null, message_id: null, subject: 'x', sent_at: at, by: 'panel', returned_at: null })

test('merge rules: the keeper keeps title and status; notes, sources, tags, history, earliest dates and highest priority come in', () => {
  const keeper = patchTask(task('t-keep', 'Reply to Alice about the budget', { notes: 'Draft in docs.', source: 'chat:msg_1', tags: ['chat'], priority: 'medium', due: '2026-11-28' }, '2026-11-22T09:00:00.000Z'), { state: 'in-progress' }, NOW, [], statuses)
  keeper.handoffs = [handoff('Orca', '2026-11-23T10:00:00.000Z')]
  const dup = task('t-dup', 'Budget reply for Alice', { notes: '- [ ] numbers', source: 'issue:42', tags: ['meeting', 'chat'], priority: 'high', due: '2026-11-26', due_time: '15:30' }, '2026-11-20T09:00:00.000Z')
  dup.handoffs = [handoff('web-bot', '2026-11-21T10:00:00.000Z')]
  dup.workspaces = [{ project: 'web', project_id: 'p', workspace_id: 'w1', workspace_name: 'budget-dup', terminal_id: null, agent: 'codex', sent_at: '2026-11-21T11:00:00.000Z', by: 'board' }]
  const third = task('t-3rd', 'Alice budget', { source: 'chat:msg_9', priority: 'low' }, '2026-11-24T09:00:00.000Z')

  const defaults = mergeDefaults(keeper, [dup, third])
  assert.deepEqual(defaults, { due: { due: '2026-11-26', due_time: '15:30' }, priority: 'high', created_at: '2026-11-20T09:00:00.000Z' })

  const { keeper: kept, merged } = mergeTasks(keeper, [dup, third], {}, NOW, statuses)
  assert.equal(kept.title, 'Reply to Alice about the budget')
  assert.equal(kept.state, 'in-progress', 'the keeper keeps its status')
  assert.equal(kept.notes, 'Draft in docs.\n\n## Merged from Budget reply for Alice (t-dup)\nSource: issue:42\n- [ ] numbers\n\n## Merged from Alice budget (t-3rd)\nSource: chat:msg_9')
  assert.equal(kept.source, 'chat:msg_1', 'its own source stays first')
  assert.deepEqual(kept.sources, ['chat:msg_1', 'issue:42', 'chat:msg_9'])
  assert.deepEqual(kept.tags, ['chat', 'meeting'])
  assert.deepEqual(kept.handoffs.map((h) => h.bot), ['web-bot', 'Orca'], 'bot history in time order')
  assert.deepEqual(kept.workspaces?.map((w) => w.workspace_id), ['w1'])
  assert.deepEqual([kept.due, kept.due_time, kept.priority, kept.created_at], ['2026-11-26', '15:30', 'high', '2026-11-20T09:00:00.000Z'])
  assert.deepEqual(kept.merged_from, ['t-dup', 't-3rd'])
  for (const m of merged) {
    assert.deepEqual([m.state, m.status, m.merged_into, m.merged_at, m.done_at], ['cancelled', 'done', 't-keep', NOW.toISOString(), null])
  }
  assert.equal(merged[0].source, 'issue:42', 'a merged task keeps its own fields')

  const chosen = mergeTasks(keeper, [dup], { due: 'keep', priority: 'keep', created: 'keep' }, NOW, statuses).keeper
  assert.deepEqual([chosen.due, chosen.due_time, chosen.priority, chosen.created_at], ['2026-11-28', null, 'medium', '2026-11-22T09:00:00.000Z'], 'the confirm step can override each')
  const none = mergeTasks(keeper, [dup], { due: 'none', priority: 'urgent' }, NOW, statuses).keeper
  assert.deepEqual([none.due, none.priority], [null, 'urgent'])
  const day = mergeTasks(keeper, [dup], { due: { due: '2026-12-01', due_time: '09:00' } }, NOW, statuses).keeper
  assert.deepEqual([day.due, day.due_time], ['2026-12-01', '09:00'])
})

test('merge rules: what cannot be merged', () => {
  const a = task('t-a', 'A', {}, '2026-11-20T09:00:00.000Z')
  const b = task('t-b', 'B', {}, '2026-11-20T09:00:00.000Z')
  assert.throws(() => mergeTasks(a, [], {}, NOW, statuses), /at least one other task/)
  assert.throws(() => mergeTasks(a, [a], {}, NOW, statuses), /cannot be merged into itself/)
  assert.throws(() => mergeTasks(a, [b, b], {}, NOW, statuses), /listed twice/)
  assert.throws(() => mergeTasks(a, [{ ...b, merged_into: 't-z' }], {}, NOW, statuses), /already merged into t-z/)
  assert.throws(() => mergeTasks({ ...a, merged_into: 't-z' }, [b], {}, NOW, statuses), /merge into that one instead/)
  const keeperWithoutSource = mergeTasks(a, [{ ...b, source: 'chat:1' }], {}, NOW, statuses).keeper
  assert.equal(keeperWithoutSource.source, 'chat:1', 'a keeper without a source takes the first merged one')
  assert.equal(keeperWithoutSource.sources, undefined, 'one source needs no list')
})

test('keeperOf follows merges, also a keeper merged later', () => {
  const a = { ...task('t-a', 'A', {}, NOW.toISOString()), merged_into: 't-b' }
  const b = { ...task('t-b', 'B', {}, NOW.toISOString()), merged_into: 't-c' }
  const c = task('t-c', 'C', {}, NOW.toISOString())
  assert.equal(keeperOf([a, b, c], a).id, 't-c')
  assert.equal(keeperOf([a, c], a).id, 't-a', 'a keeper that is gone leaves the task itself')
})

test('store: merge in one write, add --dedupe answers the keeper for a merged source, undo puts it back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-merge-'))
  try {
    let clock = new Date('2026-11-25T06:00:00.000Z')
    const store = new TaskStore({ home, now: () => clock })
    const keep = (await store.add({ title: 'Reply to Alice', source: 'chat:msg_1', notes: 'mine' })).task
    clock = new Date('2026-11-25T06:01:00.000Z')
    const dup = (await store.add({ title: 'Alice reply', source: 'issue:42', priority: 'high' })).task
    const before = JSON.parse(await readFile(store.path, 'utf8'))

    const dry = await store.merge(keep.id, [dup.id], {}, { dryRun: true })
    assert.equal(dry.keeper.priority, 'high')
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), before, 'a dry run writes nothing')

    clock = new Date('2026-11-25T06:05:00.000Z')
    const { keeper, merged } = await store.merge(keep.id, [dup.id])
    assert.deepEqual([keeper.priority, keeper.sources, merged[0].merged_into, merged[0].state], ['high', ['chat:msg_1', 'issue:42'], keep.id, 'cancelled'])
    const file = JSON.parse(await readFile(store.path, 'utf8'))
    assert.equal(file.revision, before.revision + 1, 'one write')
    assert.equal(file.last_merge.keeper, keep.id)

    // Scripts using the CLI add with --dedupe on the source: a merged duplicate is never added again.
    const again = await store.add({ title: 'Alice reply (from the tracker again)', source: 'issue:42' }, { dedupe: true })
    assert.deepEqual([again.created, again.task.id], [false, keep.id], 'the keeper, not the cancelled duplicate')
    const own = await store.add({ title: 'Reply to Alice', source: 'chat:msg_1' }, { dedupe: true })
    assert.deepEqual([own.created, own.task.id], [false, keep.id])
    assert.equal((await store.add({ title: 'New', source: 'chat:msg_2' }, { dedupe: true })).created, true)
    assert.deepEqual((await store.list({ source: 'issue:42', statuses: ['open'] })).map((t) => t.id), [keep.id], 'list --source finds the keeper (the duplicate is closed)')

    const undone = await store.undoMerge()
    assert.deepEqual([undone.keeper.id, undone.restored.map((t) => t.id)], [keep.id, [dup.id]])
    const back = await store.get(dup.id)
    assert.deepEqual([back.state, back.merged_into, back.priority], ['todo', undefined, 'high'])
    assert.deepEqual([(await store.get(keep.id)).notes, (await store.get(keep.id)).sources], ['mine', undefined])
    await assert.rejects(store.undoMerge(), /no merge to undo/)

    await store.merge(keep.id, [dup.id])
    clock = new Date('2026-11-25T07:00:00.000Z')
    await store.update(keep.id, { title: 'Reply to Alice today' })
    await assert.rejects(store.undoMerge(), /changed after the merge/, 'a task changed since is not overwritten')
    await assert.rejects(store.merge(keep.id, [dup.id]), /already merged/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
