// Plain node:test, so CI runs it with nothing but Node: `node --test src/core/*.test.ts`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addDays, DateInputError, isDay, parseDay, parseInstant, startOfDay } from './dates.ts'
import { formatLine, parseLine, parseLines } from './line.ts'
import { compareTasks, filterTasks, findTask, inView, makeTask, normalizeTask, patchTask, TaskInputError, TaskNotFoundError, viewCounts } from './tasks.ts'
import type { Task } from './types.ts'

const TODAY = '2026-11-23' // a Monday
const NOW = new Date(2026, 10, 23, 15, 0, 0)

function task(fields: Partial<Task> & { id: string }): Task {
  return { ...makeTask({ title: fields.title ?? fields.id }, fields.id, NOW), ...fields }
}

test('days: real days only, and relative words', () => {
  assert.ok(isDay('2026-02-28'))
  assert.ok(!isDay('2026-02-30'))
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(parseDay('today', TODAY), TODAY)
  assert.equal(parseDay('Tomorrow', TODAY), '2026-11-24')
  assert.equal(parseDay('+3d', TODAY), '2026-11-26')
  assert.equal(parseDay('+3', TODAY), '2026-11-26')
  assert.equal(parseDay('-1d', TODAY), '2026-11-22')
  assert.equal(parseDay('+2w', TODAY), '2026-12-07')
  assert.equal(parseDay('fri', TODAY), '2026-11-27')
  assert.equal(parseDay('monday', TODAY), '2026-11-30', 'the next Monday, not today')
  assert.equal(parseDay('none', TODAY), null)
  assert.equal(parseDay('', TODAY), null)
  assert.equal(parseDay('2026-12-01', TODAY), '2026-12-01')
  assert.throws(() => parseDay('2026-13-01', TODAY), DateInputError)
  assert.throws(() => parseDay('soon', TODAY), DateInputError)
  assert.throws(() => parseDay('3', TODAY), DateInputError)
})

test('instants: ISO, days at local midnight, spans back from now', () => {
  assert.equal(parseInstant('now', NOW), NOW.toISOString())
  assert.equal(parseInstant('today', NOW), startOfDay(TODAY).toISOString())
  assert.equal(parseInstant('yesterday', NOW), startOfDay('2026-11-22').toISOString())
  assert.equal(parseInstant('2026-11-20', NOW), startOfDay('2026-11-20').toISOString())
  assert.equal(parseInstant('-2h', NOW), new Date(NOW.getTime() - 7_200_000).toISOString())
  assert.equal(parseInstant('2026-11-23T09:00:00+09:00', NOW), '2026-11-23T00:00:00.000Z')
  assert.throws(() => parseInstant('last week', NOW), DateInputError)
})

test('Simple Todo lines: markers anywhere, checkbox optional', () => {
  assert.deepEqual(parseLine('- [ ] Review the PR !high @orca-tasks #review due:2026-11-30', TODAY), {
    title: 'Review the PR',
    done: false,
    tags: ['review'],
    priority: 'high',
    project: 'orca-tasks',
    due: '2026-11-30'
  })
  assert.deepEqual(parseLine('* [x] Sent the report #ops', TODAY), { title: 'Sent the report', done: true, tags: ['ops'] })
  assert.deepEqual(parseLine('Plain line due:tomorrow !urgent', TODAY), {
    title: 'Plain line',
    done: false,
    tags: [],
    priority: 'urgent',
    due: '2026-11-24'
  })
  assert.deepEqual(parseLine('- Call Alice source:chat:msg_1 #a #a', TODAY), {
    title: 'Call Alice',
    done: false,
    tags: ['a'],
    source: 'chat:msg_1'
  })
  // An unreadable due: stays in the title rather than being dropped.
  assert.equal(parseLine('- [ ] Fix due:someday', TODAY)?.title, 'Fix due:someday')
  assert.equal(parseLine('处理 飞书 任务 @运营 #紧急', TODAY)?.project, '运营')
  assert.equal(parseLine('', TODAY), null)
  assert.equal(parseLine('# Heading', TODAY), null)
  assert.equal(parseLine('- [ ] #only-a-tag', TODAY), null)
  assert.equal(parseLines('- [ ] a\n\n- [ ] b\r\n', TODAY).length, 2)
})

test('lines round-trip through formatLine', () => {
  const t = task({ id: 't-1', title: 'Ship it', priority: 'high', project: 'orca', tags: ['release'], due: '2026-11-30', source: 'chat:1' })
  const line = formatLine(t)
  assert.equal(line, '- [ ] Ship it !high @orca #release due:2026-11-30 source:chat:1')
  const back = parseLine(line, TODAY)
  assert.equal(back?.title, 'Ship it')
  assert.equal(back?.source, 'chat:1')
})

test('makeTask and patchTask check every field', () => {
  const t = makeTask({ title: '  Write   notes ', tags: ['#a', 'b', 'a'], due: '2026-11-30', priority: 'low' }, 't-1', NOW)
  assert.equal(t.title, 'Write notes')
  assert.deepEqual(t.tags, ['a', 'b'])
  assert.equal(t.created_at, NOW.toISOString())
  assert.equal(t.done_at, null)
  assert.throws(() => makeTask({ title: '' }, 't-2', NOW), TaskInputError)
  assert.throws(() => makeTask({ title: 'x', due: 'tomorrow' }, 't-2', NOW), TaskInputError)
  assert.throws(() => makeTask({ title: 'x', priority: 'big' as never }, 't-2', NOW), TaskInputError)
  const later = new Date(NOW.getTime() + 1000)
  const p = patchTask({ ...t, extra: 'kept' }, { due: null, project: ' ops ' }, later)
  assert.equal(p.due, null)
  assert.equal(p.project, 'ops')
  assert.equal(p.title, 'Write notes')
  assert.equal(p.extra, 'kept', 'fields a newer version wrote survive a change')
  assert.equal(p.updated_at, later.toISOString())
})

test('normalizeTask repairs what another program wrote', () => {
  assert.equal(normalizeTask({ title: 'no id' }), null)
  const t = normalizeTask({ id: 't-x', title: 'x', due: 'bad', priority: 'huge', tags: ['a', 3] })
  assert.equal(t?.due, null)
  assert.equal(t?.priority, 'none')
  assert.deepEqual(t?.tags, ['a'])
})

test('views: Today is due today or overdue plus done today', () => {
  const doneToday = new Date(2026, 10, 23, 9).toISOString()
  const doneBefore = new Date(2026, 10, 20, 9).toISOString()
  const all = [
    task({ id: 't-over', due: '2026-11-20' }),
    task({ id: 't-today', due: TODAY }),
    task({ id: 't-later', due: '2026-11-25' }),
    task({ id: 't-inbox' }),
    task({ id: 't-done-today', due: '2026-11-01', done_at: doneToday }),
    task({ id: 't-done-before', done_at: doneBefore })
  ]
  const ids = (view: 'today' | 'upcoming' | 'inbox' | 'done') => all.filter((t) => inView(t, view, TODAY)).map((t) => t.id)
  assert.deepEqual(ids('today'), ['t-over', 't-today', 't-done-today'])
  assert.deepEqual(ids('upcoming'), ['t-later'])
  assert.deepEqual(ids('inbox'), ['t-inbox'])
  assert.deepEqual(ids('done'), ['t-done-today', 't-done-before'])
  const counts = viewCounts(all, TODAY)
  assert.equal(counts.overdue, 1)
  assert.equal(counts.dueToday, 1)
  assert.equal(counts.today, 3)
})

test('filters: status, done since, due range, project, tags, source, text', () => {
  const all = [
    task({ id: 't-a', due: '2026-11-22', project: 'Ops', tags: ['chat'], source: 'tracker:1', notes: 'ask about budget' }),
    task({ id: 't-b', due: '2026-11-26', tags: ['chat', 'issues'] }),
    task({ id: 't-c', done_at: '2026-11-23T01:00:00.000Z' }),
    task({ id: 't-d', done_at: '2026-11-21T01:00:00.000Z' })
  ]
  const ids = (filter: Parameters<typeof filterTasks>[1]) => filterTasks(all, filter, TODAY).map((t) => t.id)
  assert.deepEqual(ids({ statuses: ['open'] }), ['t-a', 't-b'])
  assert.deepEqual(ids({ statuses: ['done'] }), ['t-c', 't-d'])
  assert.deepEqual(ids({ doneSince: '2026-11-22T00:00:00.000Z' }), ['t-c'])
  assert.deepEqual(ids({ dueFrom: '2026-11-23', dueTo: '2026-11-30' }), ['t-b'])
  assert.deepEqual(ids({ dueTo: TODAY, statuses: ['open'] }), ['t-a'])
  assert.deepEqual(ids({ noDue: true }), ['t-c', 't-d'])
  assert.deepEqual(ids({ project: 'ops' }), ['t-a'])
  assert.deepEqual(ids({ tags: ['chat', 'issues'] }), ['t-b'])
  assert.deepEqual(ids({ source: 'tracker:1' }), ['t-a'])
  assert.deepEqual(ids({ text: 'BUDGET' }), ['t-a'])
})

test('order: open by due day then priority then age; done newest first', () => {
  const list = [
    task({ id: 't-none', created_at: '2026-11-01T00:00:00.000Z' }),
    task({ id: 't-late-low', due: '2026-11-30', priority: 'low' }),
    task({ id: 't-late-high', due: '2026-11-30', priority: 'high' }),
    task({ id: 't-soon', due: '2026-11-24' }),
    task({ id: 't-done-old', done_at: '2026-11-01T00:00:00.000Z' }),
    task({ id: 't-done-new', done_at: '2026-11-22T00:00:00.000Z' })
  ].sort(compareTasks)
  assert.deepEqual(
    list.map((t) => t.id),
    ['t-soon', 't-late-high', 't-late-low', 't-none', 't-done-new', 't-done-old']
  )
})

test('findTask takes a unique prefix', () => {
  const all = [task({ id: 't-abc111' }), task({ id: 't-abc222' }), task({ id: 't-xyz' })]
  assert.equal(findTask(all, 't-xyz').id, 't-xyz')
  assert.equal(findTask(all, 't-abc1').id, 't-abc111')
  assert.throws(() => findTask(all, 't-abc'), TaskInputError)
  assert.throws(() => findTask(all, 't-nope'), TaskNotFoundError)
})

// ---- Orca projects and grouping ----
import { canonicalProject, groupByProject, matchOrcaProject, suggestProjects, summarizeProjects, type OrcaProject } from './projects.ts'
import { statusOf } from './tasks.ts'

const ORCA: OrcaProject[] = ['online-store', 'data-pipeline', 'HomeLab', 'worker-jobs'].map((name) => ({
  name,
  id: `id-${name}`,
  kind: 'git',
  path: `/p/${name}`,
  hostId: 'local',
  hidden: false
}))

test('a loosely typed project becomes the Orca project name; others stay as typed', () => {
  assert.equal(canonicalProject('online-store', ORCA), 'online-store')
  assert.equal(canonicalProject('Online Store', ORCA), 'online-store')
  assert.equal(canonicalProject('homelab', ORCA), 'HomeLab')
  assert.equal(canonicalProject('data_pipeline', ORCA), 'data-pipeline')
  assert.equal(canonicalProject('Personal', ORCA), 'Personal')
  assert.equal(canonicalProject('  ', ORCA), null)
  assert.equal(canonicalProject(undefined, ORCA), undefined)
  assert.equal(matchOrcaProject('work', ORCA), null, 'a prefix is a suggestion, not a match')
})

test('project suggestions: Orca projects first, prefix matches before others', () => {
  assert.deepEqual(suggestProjects('da', ORCA, ['dad-stuff', 'online-store']), [
    { name: 'data-pipeline', orca: true },
    { name: 'dad-stuff', orca: false }
  ])
  assert.equal(suggestProjects('', ORCA, ['zz']).length, 5)
})

test('groups by project: most open first, No project last, Orca projects marked', () => {
  const all = [
    task({ id: 't-1', project: 'HomeLab' }),
    task({ id: 't-2', project: 'data-pipeline' }),
    task({ id: 't-3', project: 'data-pipeline' }),
    task({ id: 't-4' }),
    task({ id: 't-5', project: 'Personal', done_at: '2026-11-23T01:00:00.000Z' }),
    task({ id: 't-6', project: 'Personal' }),
    task({ id: 't-7', project: 'Personal' })
  ]
  const groups = groupByProject(all, ORCA)
  assert.deepEqual(
    groups.map((g) => [g.project, g.orca, g.open, g.total]),
    [
      ['Personal', false, 2, 3],
      ['data-pipeline', true, 2, 2],
      ['HomeLab', true, 1, 1],
      [null, false, 1, 1]
    ]
  )
  const summary = summarizeProjects(all, ORCA)
  assert.deepEqual(summary.slice(0, 3).map((p) => [p.name, p.orca, p.open, p.done]), [
    ['data-pipeline', true, 2, 0],
    ['HomeLab', true, 1, 0],
    ['online-store', true, 0, 0]
  ])
  assert.deepEqual(summary.at(-1), { name: 'Personal', orca: false, id: null, kind: null, path: null, hidden: false, open: 2, hold: 0, done: 1, total: 3 })
  const withHold = groupByProject([...all, { ...task({ id: 't-8', project: 'HomeLab' }), status: 'hold' as const, held_at: '2026-11-22T00:00:00.000Z', waiting_on: 'Alice' }], ORCA)
  const homelab = withHold.find((g) => g.project === 'HomeLab')
  assert.deepEqual([homelab?.open, homelab?.hold, homelab?.total], [1, 1, 2], 'held tasks are not counted as open')
})

// ---- On hold ----

test('on hold: put on, keep held_at, take off; done takes it off hold', () => {
  const open = makeTask({ title: 'Pack' }, 't-h', NOW)
  assert.deepEqual([open.status, open.waiting_on, open.held_at], ['open', null, null])
  const t1 = new Date(NOW.getTime() + 60_000)
  const held = patchTask(open, { waiting_on: " Bob's review " }, t1)
  assert.deepEqual([held.status, held.waiting_on, held.held_at], ['hold', "Bob's review", t1.toISOString()])
  const t2 = new Date(NOW.getTime() + 120_000)
  const renamed = patchTask(held, { waiting_on: "Pablo's data" }, t2)
  assert.equal(renamed.held_at, t1.toISOString(), 'changing what it waits on keeps when it went on hold')
  const edited = patchTask(renamed, { title: 'Pack v2' }, t2)
  assert.equal(edited.status, 'hold', 'other edits keep it on hold')
  const done = patchTask(edited, { done_at: t2.toISOString() }, t2)
  assert.deepEqual([done.status, done.waiting_on, done.held_at], ['done', null, null])
  const back = patchTask(held, { waiting_on: null }, t2)
  assert.deepEqual([back.status, back.waiting_on, back.held_at], ['open', null, null])
  assert.equal(makeTask({ title: 'x', waiting_on: 'Alice' }, 't-x', NOW).status, 'hold')
})

test('on hold: older tasks read as open; status always matches done_at and held_at', () => {
  assert.equal(normalizeTask({ id: 't-old', title: 'old' })?.status, 'open')
  assert.equal(normalizeTask({ id: 't-old', title: 'old', done_at: '2026-11-01T00:00:00Z', status: 'open' })?.status, 'done')
  const held = normalizeTask({ id: 't-h', title: 'h', held_at: '2026-11-20T00:00:00Z', waiting_on: 'Bob' })
  assert.deepEqual([held?.status, held?.waiting_on], ['hold', 'Bob'])
  assert.equal(statusOf({ done_at: null, held_at: null }), 'open')
})

test('on hold: filters by status, never overdue, kept in their view', () => {
  const all = [
    task({ id: 't-open', due: '2026-11-20' }),
    { ...task({ id: 't-held', due: '2026-11-20' }), status: 'hold' as const, held_at: '2026-11-21T00:00:00.000Z', waiting_on: 'Bob' },
    task({ id: 't-done', done_at: '2026-11-23T01:00:00.000Z' })
  ]
  const ids = (statuses: ('open' | 'hold' | 'done')[]) => filterTasks(all, { statuses }, TODAY).map((t) => t.id)
  assert.deepEqual(ids(['open']), ['t-open'])
  assert.deepEqual(ids(['hold']), ['t-held'])
  assert.deepEqual(ids(['open', 'hold']), ['t-open', 't-held'])
  assert.ok(inView(all[1], 'today', TODAY), 'a held task stays in Today, in its own section')
  const counts = viewCounts(all, TODAY)
  assert.equal(counts.overdue, 1)
  assert.equal(counts.hold, 1)
})

// ---- 0.3.0: times, checklists, sections, bots ----
import { dueInstant, isTime, parseDue, parseTime, remindInstant } from './dates.ts'
import { checklist, checklistLabel, setChecklistItem } from './checklist.ts'
import { botReplied, bySection, dueLabel, matchesDue, sectionOf, visibleStatuses } from './sections.ts'
import { activeHandoff, isClosed, isOverdue, lastChat, normalizeHandoff } from './tasks.ts'
import { botChoices, findHandoffChat, findSendIds, handoffBody, handoffSubject, parseBotList, projectBot, type Bot } from './bots.ts'
import { applyStatusOp, DEFAULT_STATUSES, findStatus, normalizeStatuses } from './statuses.ts'

test('times of day: 24-hour, am/pm, and a due with a time', () => {
  assert.equal(parseTime('15:30'), '15:30')
  assert.equal(parseTime('9:05'), '09:05')
  assert.equal(parseTime('9'), '09:00')
  assert.equal(parseTime('9am'), '09:00')
  assert.equal(parseTime('12am'), '00:00')
  assert.equal(parseTime('12pm'), '12:00')
  assert.equal(parseTime('9:30 PM'), '21:30')
  assert.equal(parseTime('noon'), '12:00')
  assert.equal(parseTime('none'), null)
  assert.throws(() => parseTime('25:00'), DateInputError)
  assert.throws(() => parseTime('13pm'), DateInputError)
  assert.throws(() => parseTime('later'), DateInputError)
  assert.ok(isTime('00:00') && !isTime('9:00') && !isTime('24:00'))
  assert.deepEqual(parseDue('fri@15:30', TODAY), { day: '2026-11-27', time: '15:30' })
  assert.deepEqual(parseDue('tomorrow 9am', TODAY), { day: '2026-11-24', time: '09:00' })
  assert.deepEqual(parseDue('2026-11-25T08:15', TODAY), { day: '2026-11-25', time: '08:15' })
  assert.deepEqual(parseDue('5pm', TODAY), { day: TODAY, time: '17:00' })
  assert.deepEqual(parseDue('fri', TODAY), { day: '2026-11-27', time: null })
  assert.deepEqual(parseDue('', TODAY), { day: null, time: null })
  assert.throws(() => parseDue('none@10:00', TODAY), DateInputError)
  assert.equal(dueInstant('2026-11-23', '15:30').getTime(), new Date(2026, 10, 23, 15, 30).getTime())
  assert.equal(dueInstant('2026-11-23', null).getTime(), new Date(2026, 10, 23, 23, 59, 59, 999).getTime())
  assert.equal(remindInstant('2026-11-23', null, '08:00').getTime(), new Date(2026, 10, 23, 8).getTime())
  assert.equal(remindInstant('2026-11-23', '15:30', '08:00').getTime(), new Date(2026, 10, 23, 15, 30).getTime())
})

test('quick add reads @today, @fri and @fri@15:30 as the due day; the inbox keeps @ for projects', () => {
  const quick = parseLine('Call Alice !h #chat @fri@15:30', TODAY, { dueWords: true })
  assert.deepEqual([quick?.title, quick?.priority, quick?.tags, quick?.due, quick?.due_time, quick?.project], ['Call Alice', 'high', ['chat'], '2026-11-27', '15:30', undefined])
  assert.equal(parseLine('x @today', TODAY, { dueWords: true })?.due, TODAY)
  assert.equal(parseLine('x @ops', TODAY, { dueWords: true })?.project, 'ops')
  const inbox = parseLine('x @fri', TODAY)
  assert.deepEqual([inbox?.project, inbox?.due], ['fri', undefined])
  assert.equal(parseLine('x due:tomorrow@9am', TODAY)?.due_time, '09:00')
})

test('overdue counts a time already past today; on-hold and done never are', () => {
  const at = task({ id: 't-a', due: TODAY, due_time: '14:00' })
  assert.ok(isOverdue(at, TODAY, '15:00'))
  assert.ok(!isOverdue(at, TODAY, '13:59'))
  assert.ok(!isOverdue(at, TODAY), 'without a time only earlier days count')
  assert.ok(!isOverdue(task({ id: 't-b', due: TODAY }), TODAY, '23:00'))
  assert.ok(isOverdue(task({ id: 't-c', due: '2026-11-22' }), TODAY, '00:00'))
  assert.ok(!isOverdue(task({ id: 't-d', due: '2026-11-22', held_at: NOW.toISOString(), status: 'hold' }), TODAY))
  const counts = viewCounts([at, task({ id: 't-e', due: TODAY, priority: 'urgent' }), task({ id: 't-f', priority: 'high' })], TODAY, '15:00')
  assert.deepEqual([counts.open, counts.high, counts.overdue, counts.dueToday], [3, 2, 1, 1])
  assert.deepEqual(filterTasks([at, task({ id: 't-g', due: TODAY })], { overdue: true }, TODAY, '15:00').map((t) => t.id), ['t-a'])
})

test('due_time is checked, follows the due day, and is repaired when read', () => {
  const t = makeTask({ title: 'x', due: TODAY, due_time: '09:30' }, 't-1', NOW)
  assert.equal(t.due_time, '09:30')
  assert.deepEqual(t.handoffs, [])
  assert.equal(makeTask({ title: 'x', due_time: '09:30' }, 't-2', NOW).due_time, null, 'no day, no time')
  assert.throws(() => makeTask({ title: 'x', due: TODAY, due_time: '9:30' }, 't-3', NOW), TaskInputError)
  assert.equal(patchTask(t, { due: null }, NOW).due_time, null)
  assert.throws(() => patchTask({ ...t, due: null, due_time: null }, { due_time: '10:00' }, NOW), TaskInputError)
  assert.equal(normalizeTask({ id: 't-x', title: 'x', due: TODAY, due_time: 'soon' })?.due_time, null)
  assert.equal(normalizeTask({ id: 't-x', title: 'x', due_time: '10:00' })?.due_time, null)
  assert.deepEqual(normalizeTask({ id: 't-x', title: 'x', handoffs: [{ bot: 'Orca', sent_at: 'x' }, { nope: 1 }] })?.handoffs.map((h) => [h.bot, h.chat, h.returned_at]), [['Orca', 'new', null]])
  assert.deepEqual([...[task({ id: 'b', due: TODAY }), task({ id: 'a', due: TODAY, due_time: '10:00' })].sort(compareTasks)].map((x) => x.id), ['a', 'b'])
})

test('checklists in notes: progress and ticking in place', () => {
  const notes = 'Plan\n- [x] Read the draft\n- [ ] Check numbers\n  * [X] nested done\n- [ ]   \nnot - [ ] an item'
  const list = checklist(notes)
  assert.deepEqual([list.done, list.total], [2, 3])
  assert.deepEqual(list.items.map((i) => [i.line, i.text, i.done]), [[1, 'Read the draft', true], [2, 'Check numbers', false], [3, 'nested done', true]])
  assert.equal(checklistLabel(notes), '2/3')
  assert.equal(checklistLabel('no list'), '')
  const ticked = setChecklistItem(notes, 2, true)
  assert.equal(ticked.split('\n')[2], '- [x] Check numbers')
  assert.equal(setChecklistItem(ticked, 1, false).split('\n')[1], '- [ ] Read the draft')
  assert.equal(setChecklistItem(notes, 0, true), notes, 'a line that is no item is left alone')
})

test('sections are the statuses: a task is in the section of its state; closed ones hide under some filters', () => {
  const S = DEFAULT_STATUSES
  const handoff = normalizeHandoff({ bot: 'Orca', sent_at: NOW.toISOString(), chat_id: 'c1' })!
  const withBot = task({ id: 't-bot', handoffs: [handoff] })
  assert.equal(sectionOf(task({ id: 't-a' }), S), 'todo')
  assert.equal(sectionOf(withBot, S), 'todo', 'sending does not move a task by itself')
  assert.ok(!botReplied(withBot, { state: 'working' }))
  assert.ok(botReplied(withBot, { state: 'done' }), 'the bot finished: it answered')
  assert.ok(botReplied(withBot, { state: 'waiting' }))
  assert.equal(activeHandoff(task({ id: 't-done', handoffs: [handoff], done_at: NOW.toISOString() })), null)
  assert.equal(sectionOf(patchTask(task({ id: 't-h' }), { waiting_on: 'Bob' }, NOW), S), 'pending')
  assert.equal(sectionOf(patchTask(task({ id: 't-d' }), { done_at: NOW.toISOString() }, NOW), S), 'done')
  const groups = bySection([task({ id: 't-1' }), patchTask(task({ id: 't-2' }), { state: 'cancelled' }, NOW)], S)
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((t) => t.id)])), { todo: ['t-1'], 'in-progress': [], pending: [], done: [], cancelled: ['t-2'] })
  assert.deepEqual(visibleStatuses(S, 'upcoming').map((s) => s.id), ['todo', 'in-progress', 'pending'])
  assert.deepEqual(visibleStatuses(S, 'today').length, 5)
  // A status message asks for nothing, so it does not count as the bot having the task.
  const fyi = normalizeHandoff({ bot: 'Orca', sent_at: NOW.toISOString(), type: 'status', chat: 'home', chat_id: 'c2' })!
  assert.equal(activeHandoff(task({ id: 't-fyi', handoffs: [fyi] })), null)
  assert.equal(activeHandoff(task({ id: 't-both', handoffs: [handoff, fyi] }))?.chat_id, 'c1')
  assert.equal(lastChat(task({ id: 't-both', handoffs: [handoff, fyi] })), 'c2')
  const over = task({ id: 't-o', due: '2026-11-20' })
  assert.ok(matchesDue(over, 'today', TODAY, '15:00', null))
  assert.ok(matchesDue(over, 'overdue', TODAY, '15:00', null))
  assert.ok(!matchesDue(over, 'upcoming', TODAY, '15:00', null))
  assert.ok(matchesDue(task({ id: 't-n' }), 'nodue', TODAY, '15:00', null))
  assert.ok(matchesDue(task({ id: 't-dd', done_at: NOW.toISOString() }), 'today', TODAY, '15:00', TODAY))
  assert.equal(dueLabel({ due: TODAY, due_time: '15:30' }, TODAY), 'Today 15:30')
  assert.equal(dueLabel({ due: '2026-11-24', due_time: null }, TODAY), 'Tomorrow')
  assert.equal(dueLabel({ due: '2026-11-27', due_time: null }, TODAY), 'Fri')
  assert.equal(dueLabel({ due: '2026-12-25', due_time: null }, TODAY), 'Dec 25')
})

test('statuses: what each kind means for status, done_at, held_at and closed_at', () => {
  const later = new Date(NOW.getTime() + 3_600_000)
  const open = task({ id: 't-1' })
  assert.deepEqual([open.state, open.state_name, open.status, open.closed_at], ['todo', 'To Do', 'open', null])
  const progress = patchTask(open, { state: 'in progress' }, NOW)
  assert.deepEqual([progress.state, progress.status], ['in-progress', 'open'], 'names match loosely')
  const held = patchTask(progress, { waiting_on: 'Bob' }, NOW)
  assert.deepEqual([held.state, held.status, held.waiting_on, held.held_at], ['pending', 'hold', 'Bob', NOW.toISOString()])
  const reheld = patchTask(held, { waiting_on: 'Alice' }, later)
  assert.deepEqual([reheld.waiting_on, reheld.held_at], ['Alice', NOW.toISOString()], 'holding again keeps held_at')
  const unheld = patchTask(held, { waiting_on: null }, later)
  assert.deepEqual([unheld.state, unheld.status, unheld.held_at], ['todo', 'open', null], 'unhold goes to the first open status')
  const done = patchTask(held, { done_at: later.toISOString() }, later)
  assert.deepEqual([done.state, done.status, done.done_at, done.closed_at, done.held_at, done.waiting_on], ['done', 'done', later.toISOString(), later.toISOString(), null, null])
  const cancelled = patchTask(open, { state: 'Cancelled' }, later)
  assert.deepEqual([cancelled.status, cancelled.done_at, cancelled.closed_at], ['done', null, later.toISOString()], 'cancelled is closed, not completed')
  assert.ok(isClosed(cancelled))
  assert.deepEqual(patchTask(cancelled, { waiting_on: 'x' }, later).state, 'cancelled', 'a closed task stays closed')
  assert.equal(patchTask(cancelled, { done_at: null }, later).state, 'todo', 'reopening a cancelled task')
  assert.throws(() => patchTask(open, { state: 'Nope' }, NOW), /no status "Nope"/)
  // Filters: --status done is every closed task; --done-since only completed ones.
  const all = [open, held, done, cancelled]
  assert.deepEqual(filterTasks(all, { statuses: ['done'] }, TODAY).map((t) => t.id).length, 2)
  assert.deepEqual(filterTasks(all, { doneSince: NOW.toISOString() }, TODAY).length, 1)
  assert.deepEqual(filterTasks(all, { states: ['pending'] }, TODAY).map((t) => t.state), ['pending'])
  assert.equal(viewCounts(all, TODAY).open, 1, 'cancelled is not open')
  // A task in a state that names no status (deleted elsewhere) reads from its old fields.
  assert.equal(normalizeTask({ ...open, state: 'gone', held_at: NOW.toISOString() })?.state, 'pending')
})

test('status lists: repaired when read, checked when changed', () => {
  assert.deepEqual(normalizeStatuses(undefined).map((s) => s.id), ['todo', 'in-progress', 'pending', 'done', 'cancelled'])
  const repaired = normalizeStatuses([{ id: 'doing', name: 'Doing', kind: 'open', color: 'nope' }, { id: 'doing', name: 'Dup' }, { id: 'BAD id', name: 'x' }])
  assert.deepEqual(repaired.map((s) => [s.id, s.kind, s.color]), [['doing', 'open', 'gray'], ['pending', 'hold', 'amber'], ['done', 'done', 'green']], 'required kinds come back')
  assert.equal(findStatus(DEFAULT_STATUSES, 'IN-PROGRESS')?.id, 'in-progress')
  assert.equal(findStatus(DEFAULT_STATUSES, 'todo')?.name, 'To Do')
  assert.throws(() => applyStatusOp(DEFAULT_STATUSES, { op: 'add', name: 'to-do!' }), /already a status called/)
  const added = applyStatusOp(DEFAULT_STATUSES, { op: 'add', name: 'Waiting for QA', index: 1 })
  assert.deepEqual([added.statuses[1].id, added.statuses[1].kind, added.statuses[1].closed], ['waiting-for-qa', 'open', false])
  assert.throws(() => applyStatusOp(DEFAULT_STATUSES, { op: 'remove', id: 'pending' }), /no open · on hold/)
  assert.throws(() => applyStatusOp(DEFAULT_STATUSES, { op: 'update', id: 'done', kind: 'cancelled' }), /no closed · done/)
  assert.deepEqual(applyStatusOp(DEFAULT_STATUSES, { op: 'remove', id: 'in-progress' }).moves, { 'in-progress': 'todo' })
  assert.deepEqual(applyStatusOp(DEFAULT_STATUSES, { op: 'remove', id: 'cancelled' }).moves, { cancelled: 'todo' }, 'no other cancelled one: the first open')
  assert.deepEqual(applyStatusOp(DEFAULT_STATUSES, { op: 'move', id: 'cancelled', index: 0 }).statuses[0].id, 'cancelled')
})

test('bots: the project bot by name or by what it is for, else Orca; send ids', () => {
  const { bots, unreachable } = parseBotList({
    bots: [
      { id: '1', name: 'Orca', agent: 'claude', specialty: 'Pull requests for my owner.', paused: false },
      { id: '2', name: 'Data Pipeline', specialty: 'Terraform.' },
      { id: '3', name: 'checkout', specialty: 'I run the Online-Store checkout.' },
      { name: '' }
    ],
    unreachable: [{ name: 'OC Osaka' }]
  })
  assert.deepEqual(bots.map((b) => b.name), ['Orca', 'Data Pipeline', 'checkout'])
  assert.deepEqual(unreachable, ['OC Osaka'])
  assert.equal(projectBot(bots, 'data-pipeline')?.name, 'Data Pipeline')
  assert.equal(projectBot(bots, 'online-store')?.name, 'checkout')
  assert.equal(projectBot(bots, 'HomeLab'), null)
  const choices = botChoices(bots, 'HomeLab')
  assert.deepEqual([choices.project, choices.main?.name, choices.others.map((b: Bot) => b.name)], [null, 'Orca', ['checkout', 'Data Pipeline']])
  assert.deepEqual(findSendIds({ message: { id: 'msg_1', to: 'orca_session_id:3540ecf3-47c3-4876-b825-81bf5d6b3595' } }), { messageId: 'msg_1', chatId: '3540ecf3-47c3-4876-b825-81bf5d6b3595' })
  assert.deepEqual(findSendIds({ messageId: 'm2', delivery: { chatId: '0bb66c0f-54fa-442a-bc6a-7bba13627dc0' } }), { messageId: 'm2', chatId: '0bb66c0f-54fa-442a-bc6a-7bba13627dc0' })
  assert.deepEqual(findSendIds({ message: { id: 'm3' } }), { messageId: 'm3', chatId: null })
  const body = handoffBody(task({ id: 't-x', title: 'Ship', due: TODAY, due_time: '10:00', tags: ['a'], notes: '- [ ] one' }), { note: 'Quick one', cli: '/h/bin/orca-tasks' })
  assert.match(body, /^Your owner sent you this task .* It is yours to do\.\n\nQuick one\n\nTask: Ship\nDue: 2026-11-23 10:00\nTags: #a\nStatus: To Do\nTask id: t-x\n\nNotes:\n- \[ \] one/)
  assert.match(body, /When you have finished, say what you did/)
  assert.match(body, /\/h\/bin\/orca-tasks get t-x --json/)
  // A question asks for an answer, not the work; a status message asks for nothing. Notes can stay out.
  const ship = task({ id: 't-x', title: 'Ship', notes: 'secret plan' })
  const question = handoffBody(ship, { type: 'question', note: 'Is it on track?', notes: false })
  assert.match(question, /^Your owner has a question about this task .* do not take the task on/)
  assert.match(question, /Is it on track\?/)
  assert.match(question, /\nAnswer in your reply here, in this chat/)
  assert.doesNotMatch(question, /secret plan|When you have finished/)
  const fyi = handoffBody(ship, { type: 'status' })
  assert.match(fyi, /^For your information, .* no reply needed\./)
  assert.match(fyi, /secret plan/)
  assert.doesNotMatch(fyi, /When you have finished|Answer in your reply/)
  assert.deepEqual([handoffSubject(ship), handoffSubject(ship, 'question'), handoffSubject(ship, 'status')], ['Ship', 'Question: Ship', 'FYI: Ship'])
})

test('the chat a handoff landed in: Orca titles a new chat from the subject', () => {
  const sent = '2026-11-24T21:31:43.997Z'
  const chats = [
    { id: 'home', title: 'Home', home: true, lastActivityAt: Date.parse(sent) + 5000, lastSaid: null },
    { id: 'old', title: "your owner's agent: Ship it", home: false, lastActivityAt: Date.parse(sent) - 3_600_000, lastSaid: null },
    { id: 'new', title: "your owner's agent: Ship it", home: false, lastActivityAt: Date.parse(sent) + 2000, lastSaid: null },
    { id: 'other', title: 'Something else', home: false, lastActivityAt: Date.parse(sent) + 9000, lastSaid: null }
  ]
  assert.equal(findHandoffChat(chats, { chat: 'new', subject: 'Ship it', sent_at: sent }), 'new', 'the one active since the send, not an older chat of the same name')
  assert.equal(findHandoffChat(chats, { chat: 'home', subject: 'Ship it', sent_at: sent }), 'home')
  assert.equal(findHandoffChat(chats, { chat: 'new', subject: 'Nothing like it', sent_at: sent }), null)
})

test('section order: tasks never dragged first, in the usual order, then the ones dragged into place', async () => {
  const { orderSection, dropOrder } = await import('./sections.ts')
  const a = task({ id: 't-a', due: '2026-11-25' })
  const b = task({ id: 't-b', due: '2026-11-24' })
  const c = { ...task({ id: 't-c' }), rank: 2 }
  const d = { ...task({ id: 't-d', due: '2026-11-20' }), rank: 1 }
  assert.deepEqual(orderSection([a, b, c, d]).map((t) => t.id), ['t-b', 't-a', 't-d', 't-c'])
  assert.deepEqual(dropOrder(['t-1', 't-2', 't-3'], 't-3', 't-1'), ['t-3', 't-1', 't-2'], 'moved up')
  assert.deepEqual(dropOrder(['t-1', 't-2', 't-3'], 't-1', 't-3'), ['t-2', 't-1', 't-3'], 'moved down, before t-3')
  assert.deepEqual(dropOrder(['t-1', 't-2'], 't-1', null), ['t-2', 't-1'], 'to the end')
  assert.deepEqual(dropOrder(['t-1', 't-2'], 't-9', 't-2'), ['t-1', 't-9', 't-2'], 'from another section')
  assert.deepEqual(dropOrder([], 't-9', null), ['t-9'], 'into an empty section')
})
