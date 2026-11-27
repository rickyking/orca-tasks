// Pure operations on tasks: making, changing, filtering and ordering them. No I/O, so the store,
// the CLI, the worker and the panel all share them.

import { isDay, isTime, localDay } from './dates.ts'
import { canonicalProject, type OrcaProject } from './projects.ts'
import { DEFAULT_STATUSES, firstOfKind, isClosedKind, resolveStatus } from './statuses.ts'
import { PRIORITIES, PROJECT_AGENTS, SCHEMA, SEND_TYPES, type Handoff, type ProjectAgent, type ProjectSend, type NewTask, type TaskStatus, type Priority, type SendType, type StatusDef, type Task, type TaskFile, type TaskFilter, type TaskPatch, type View } from './types.ts'

export class TaskInputError extends Error {
  readonly code = 'invalid_params'
}

export function emptyFile(now: Date): TaskFile {
  return { format: 'orca-tasks', version: 1, schema: SCHEMA, revision: 0, updated_at: now.toISOString(), statuses: DEFAULT_STATUSES.map((s) => ({ ...s })), tasks: [] }
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** A new id, unique among `taken`: `t-` + 8 random characters. */
export function newId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    let id = 't-'
    for (let i = 0; i < 8; i += 1) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)]
    if (!taken.has(id)) return id
  }
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new TaskInputError(`${field} must be a string`)
  if (value.length > max) throw new TaskInputError(`${field} is longer than ${max} characters`)
  return value
}

function cleanTitle(value: unknown): string {
  const title = cleanText(value, 'title', 2000).replace(/\s+/g, ' ').trim()
  if (title === '') throw new TaskInputError('title is empty')
  return title
}

function cleanDue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !isDay(value)) throw new TaskInputError(`due must be YYYY-MM-DD or null, not ${JSON.stringify(value)}`)
  return value
}

function cleanTime(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !isTime(value)) throw new TaskInputError(`due_time must be HH:MM or null, not ${JSON.stringify(value)}`)
  return value
}

function cleanPriority(value: unknown): Priority {
  if (value === undefined || value === null || value === '') return 'none'
  if (typeof value !== 'string' || !(PRIORITIES as readonly string[]).includes(value)) {
    throw new TaskInputError(`priority must be one of ${PRIORITIES.join(', ')}`)
  }
  return value as Priority
}

function cleanOptional(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  const text = cleanText(value, field, 2000).trim()
  return text === '' ? null : text
}

function cleanTags(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TaskInputError('tags must be a list of strings')
  const tags: string[] = []
  for (const tag of value) {
    const clean = cleanText(tag, 'tag', 200).trim().replace(/^#/, '')
    if (clean !== '' && !tags.includes(clean)) tags.push(clean)
  }
  return tags
}

function cleanInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new TaskInputError(`${field} must be an ISO 8601 time or null`)
  }
  return new Date(value).toISOString()
}

/** done when it is closed (done or cancelled), else hold when held_at is set, else open. */
export function statusOf(task: Pick<Task, 'done_at' | 'held_at'> & { closed_at?: string | null }): TaskStatus {
  return task.done_at || task.closed_at ? 'done' : task.held_at ? 'hold' : 'open'
}

/** The fields that follow from a task's status: `state`, `state_name`, `status`, `done_at`,
 *  `closed_at`, `held_at` and `waiting_on`, consistent with each other and with the status's kind. */
type StateFields = Pick<Task, 'state' | 'state_name' | 'status' | 'done_at' | 'closed_at' | 'held_at' | 'waiting_on'>

function stateFields(def: StatusDef, given: { doneAt: string | null; closedAt: string | null; heldAt: string | null; waitingOn: string | null }, at: string): StateFields {
  const base = { state: def.id, state_name: def.name }
  switch (def.kind) {
    case 'done': {
      const done = given.doneAt ?? at
      return { ...base, status: 'done', done_at: done, closed_at: done, held_at: null, waiting_on: null }
    }
    case 'cancelled':
      return { ...base, status: 'done', done_at: null, closed_at: given.closedAt ?? at, held_at: null, waiting_on: null }
    case 'hold':
      return { ...base, status: 'hold', done_at: null, closed_at: null, held_at: given.heldAt ?? at, waiting_on: given.waitingOn }
    default:
      return { ...base, status: 'open', done_at: null, closed_at: null, held_at: null, waiting_on: null }
  }
}

function cleanWaiting(value: unknown): string | null {
  const text = cleanText(value, 'waiting_on', 2000).trim()
  return text === '' ? null : text
}

/** The status a task is in: its `state` when that is one of `statuses`, else worked out from the
 *  fields older versions write. */
export function currentStatus(task: Pick<Task, 'state' | 'done_at' | 'held_at'> & { closed_at?: string | null }, statuses: readonly StatusDef[]): StatusDef {
  const def = statuses.find((s) => s.id === task.state)
  if (def) return def
  if (task.done_at) return firstOfKind(statuses, 'done')
  if (task.closed_at) return firstOfKind(statuses, 'cancelled')
  return firstOfKind(statuses, task.held_at ? 'hold' : 'open')
}

/** A whole new task from what a caller gave, checked. `state` names its status; else done_at
 *  makes it done, waiting_on puts it on hold, and otherwise it is in the first open status. */
export function makeTask(input: NewTask, id: string, now: Date, statuses: readonly StatusDef[] = DEFAULT_STATUSES): Task {
  const at = now.toISOString()
  const doneAt = cleanInstant(input.done_at, 'done_at')
  const hold = input.waiting_on !== undefined && input.waiting_on !== null
  const def = input.state ? resolveStatus(statuses, input.state) : firstOfKind(statuses, doneAt ? 'done' : hold ? 'hold' : 'open')
  return {
    id,
    title: cleanTitle(input.title),
    notes: input.notes === undefined ? '' : cleanText(input.notes, 'notes', 100_000),
    created_at: at,
    updated_at: at,
    due: cleanDue(input.due),
    priority: cleanPriority(input.priority),
    project: cleanOptional(input.project, 'project'),
    tags: cleanTags(input.tags),
    source: cleanOptional(input.source, 'source'),
    ...stateFields(def, { doneAt, closedAt: null, heldAt: null, waitingOn: hold ? cleanWaiting(input.waiting_on) : null }, at),
    due_time: input.due === undefined || input.due === null || input.due === '' ? null : cleanTime(input.due_time),
    handoffs: []
  }
}

/**
 * Which status a patch puts the task in. `state` names it. Otherwise, as before 0.4.0: a done_at
 * completes it (a done task keeps its done status), done_at null reopens a closed one (on hold
 * when the patch also gives waiting_on), a waiting_on string puts an open task on hold (a held
 * one keeps its hold status) and null takes it off; a closed task stays closed.
 */
function patchedStatus(cur: StatusDef, patch: TaskPatch, statuses: readonly StatusDef[]): StatusDef {
  if (patch.state !== undefined && patch.state !== null) return resolveStatus(statuses, patch.state)
  const waiting = 'waiting_on' in patch && patch.waiting_on !== undefined && patch.waiting_on !== null
  if ('done_at' in patch && patch.done_at) return cur.kind === 'done' ? cur : firstOfKind(statuses, 'done')
  if ('done_at' in patch && isClosedKind(cur.kind)) return firstOfKind(statuses, waiting ? 'hold' : 'open')
  if (isClosedKind(cur.kind)) return cur
  if ('waiting_on' in patch) {
    if (waiting) return cur.kind === 'hold' ? cur : firstOfKind(statuses, 'hold')
    return cur.kind === 'hold' ? firstOfKind(statuses, 'open') : cur
  }
  return cur
}

/** The task with `patch` applied, checked; fields the patch leaves out (and unknown ones) stay. */
export function patchTask(task: Task, patch: TaskPatch, now: Date, orca: readonly OrcaProject[] = [], statuses: readonly StatusDef[] = DEFAULT_STATUSES): Task {
  const next: Task = { ...task }
  if ('title' in patch) next.title = cleanTitle(patch.title)
  if ('notes' in patch) next.notes = cleanText(patch.notes ?? '', 'notes', 100_000)
  if ('due' in patch) next.due = cleanDue(patch.due)
  if ('due_time' in patch) next.due_time = cleanTime(patch.due_time)
  if (next.due === null) {
    if ('due_time' in patch && next.due_time !== null) throw new TaskInputError('due_time needs a due day')
    next.due_time = null
  }
  if ('priority' in patch) next.priority = cleanPriority(patch.priority)
  if ('project' in patch) next.project = canonicalProject(cleanOptional(patch.project, 'project'), orca) ?? null
  if ('tags' in patch) next.tags = cleanTags(patch.tags)
  if ('source' in patch) next.source = cleanOptional(patch.source, 'source')
  const cur = currentStatus(task, statuses)
  const def = patchedStatus(cur, patch, statuses)
  const givenDone = 'done_at' in patch ? cleanInstant(patch.done_at, 'done_at') : null
  const givenWaiting = 'waiting_on' in patch && patch.waiting_on !== undefined && patch.waiting_on !== null ? cleanWaiting(patch.waiting_on) : undefined
  Object.assign(
    next,
    stateFields(
      def,
      {
        doneAt: givenDone ?? (cur.kind === 'done' ? task.done_at : null),
        closedAt: cur.kind === def.kind ? task.closed_at : null,
        heldAt: cur.kind === 'hold' ? task.held_at : null,
        waitingOn: givenWaiting !== undefined ? givenWaiting : cur.kind === 'hold' ? task.waiting_on : null
      },
      now.toISOString()
    )
  )
  // Its place in the old status means nothing in the new one: it shows first there, until dragged.
  if (next.state !== task.state && 'rank' in next) delete next.rank
  next.updated_at = now.toISOString()
  return next
}

/** The task after its status list changed: the same status (moved to another one when `moves`
 *  says so, or the first of its kind when its status is gone), with the fields that follow from
 *  it worked out again, and its name as it is now. Unchanged tasks come back as they were. */
export function restateTask(task: Task, statuses: readonly StatusDef[], moves: Readonly<Record<string, string>>, now: Date): Task {
  const target = moves[task.state] ?? task.state
  let def = statuses.find((s) => s.id === target)
  if (!def) {
    const before = currentStatus({ ...task, state: '' }, statuses)
    def = before
  }
  const fields = stateFields(
    def,
    { doneAt: task.done_at, closedAt: task.closed_at ?? task.done_at, heldAt: task.held_at, waitingOn: task.waiting_on },
    now.toISOString()
  )
  const changed = (Object.keys(fields) as (keyof StateFields)[]).some((key) => fields[key] !== task[key])
  return changed ? { ...task, ...fields, updated_at: now.toISOString() } : task
}

/** A task read from disk, repaired enough to work with (another program may have written it).
 *  Its status is its `state` when that is one of `statuses` and agrees with the fields older
 *  versions write (done_at, held_at, waiting_on): when an older version completed, reopened, held
 *  or unheld the task, those fields win. A task from before 0.4.0 gets To Do, Pending (held, or
 *  waiting on someone) or Done. */
export function normalizeTask(raw: unknown, statuses: readonly StatusDef[] = DEFAULT_STATUSES): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.title !== 'string') return null
  const at = typeof t.created_at === 'string' ? t.created_at : new Date(0).toISOString()
  return {
    ...t,
    id: t.id,
    title: t.title,
    notes: typeof t.notes === 'string' ? t.notes : '',
    created_at: at,
    updated_at: typeof t.updated_at === 'string' ? t.updated_at : at,
    due: typeof t.due === 'string' && isDay(t.due) ? t.due : null,
    priority: (PRIORITIES as readonly unknown[]).includes(t.priority) ? (t.priority as Priority) : 'none',
    project: typeof t.project === 'string' && t.project !== '' ? t.project : null,
    tags: Array.isArray(t.tags) ? t.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    source: typeof t.source === 'string' && t.source !== '' ? t.source : null,
    ...readState(t, statuses, typeof t.updated_at === 'string' ? t.updated_at : at),
    due_time: typeof t.due === 'string' && isDay(t.due) && typeof t.due_time === 'string' && isTime(t.due_time) ? t.due_time : null,
    handoffs: Array.isArray(t.handoffs) ? t.handoffs.map(normalizeHandoff).filter((h): h is Handoff => h !== null) : [],
    ...optionalFields(t)
  }
}

/** The 0.5.0 fields a task has only where they apply (sent to a project, merged), repaired; a
 *  task without them gets none, so files without them read and write as before. */
function optionalFields(t: Record<string, unknown>): Partial<Task> {
  const out: Partial<Task> = {}
  if ('workspaces' in t) out.workspaces = Array.isArray(t.workspaces) ? t.workspaces.map(normalizeProjectSend).filter((w): w is ProjectSend => w !== null) : []
  if ('sources' in t) out.sources = Array.isArray(t.sources) ? [...new Set(t.sources.filter((s): s is string => typeof s === 'string' && s !== ''))] : []
  if ('merged_into' in t) out.merged_into = stringOrNull(t.merged_into)
  if ('merged_at' in t) out.merged_at = stringOrNull(t.merged_at)
  if ('merged_from' in t) out.merged_from = Array.isArray(t.merged_from) ? t.merged_from.filter((s): s is string => typeof s === 'string' && s !== '') : []
  return out
}

/** A project send read from disk, or null when it is not one. Unknown fields are kept. */
export function normalizeProjectSend(raw: unknown): ProjectSend | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  if (typeof w.workspace_id !== 'string' || w.workspace_id === '' || typeof w.sent_at !== 'string') return null
  return {
    ...w,
    project: typeof w.project === 'string' ? w.project : '',
    project_id: stringOrNull(w.project_id),
    workspace_id: w.workspace_id,
    workspace_name: typeof w.workspace_name === 'string' ? w.workspace_name : w.workspace_id,
    terminal_id: stringOrNull(w.terminal_id),
    agent: (PROJECT_AGENTS as readonly unknown[]).includes(w.agent) ? (w.agent as ProjectAgent) : 'claude',
    sent_at: w.sent_at,
    by: w.by === 'cli' || w.by === 'board' ? w.by : 'panel'
  }
}

/** Every source a task holds: its own, then those merged into it. */
export function sourcesOf(task: Task): string[] {
  return [...new Set([...(task.source ? [task.source] : []), ...(task.sources ?? [])])]
}

/** The workspace the task was last sent to in its project, or null. */
export function lastWorkspace(task: Task): ProjectSend | null {
  return task.workspaces?.at(-1) ?? null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A handoff record read from disk, or null when it is not one. Unknown fields are kept. */
export function normalizeHandoff(raw: unknown): Handoff | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Record<string, unknown>
  if (typeof h.bot !== 'string' || h.bot === '' || typeof h.sent_at !== 'string') return null
  return {
    ...h,
    bot: h.bot,
    bot_id: stringOrNull(h.bot_id),
    type: (SEND_TYPES as readonly unknown[]).includes(h.type) ? (h.type as SendType) : 'handoff',
    chat: h.chat === 'home' || h.chat === 'existing' ? h.chat : 'new',
    chat_id: stringOrNull(h.chat_id),
    message_id: stringOrNull(h.message_id),
    subject: typeof h.subject === 'string' ? h.subject : '',
    sent_at: h.sent_at,
    by: h.by === 'cli' || h.by === 'board' ? h.by : 'panel',
    returned_at: stringOrNull(h.returned_at)
  }
}

/** The handoff the task is with now: its latest handoff or question (a status message asks for
 *  nothing), unless it was taken back or the task is closed. */
export function activeHandoff(task: Task): Handoff | null {
  const last = [...task.handoffs].reverse().find((h) => h.type !== 'status')
  return last && last.returned_at === null && !isClosed(task) ? last : null
}

/** The chat the task was last sent to, when Orca named it: where "its earlier chat" sends. */
export function lastChat(task: Task): string | null {
  return [...task.handoffs].reverse().find((h) => h.chat_id !== null)?.chat_id ?? null
}

/** Open, not on hold, and past due on `today` at `time` (`HH:MM`; without it only earlier days
 *  count): due before today, or due today at a time already past. */
export function isOverdue(task: Task, today: string, time?: string): boolean {
  if (isClosed(task) || task.held_at !== null || task.due === null) return false
  if (task.due < today) return true
  return task.due === today && task.due_time !== null && time !== undefined && task.due_time < time
}

function readState(t: Record<string, unknown>, statuses: readonly StatusDef[], updatedAt: string): StateFields {
  const done_at = stringOrNull(t.done_at)
  const held_at = stringOrNull(t.held_at)
  const waiting_on = typeof t.waiting_on === 'string' && t.waiting_on.trim() !== '' ? t.waiting_on : null
  const closed_at = stringOrNull(t.closed_at)
  const held = held_at !== null || waiting_on !== null
  let def = statuses.find((s) => s.id === t.state)
  if (!def) {
    const cancelled = !done_at && t.status === 'done' && closed_at !== null
    def = firstOfKind(statuses, done_at ? 'done' : cancelled ? 'cancelled' : held ? 'hold' : 'open')
  } else if (done_at && def.kind !== 'done') def = firstOfKind(statuses, 'done')
  else if (!done_at && def.kind === 'done') def = firstOfKind(statuses, held ? 'hold' : 'open')
  else if (!done_at && held && def.kind !== 'hold') def = firstOfKind(statuses, 'hold')
  else if (!held && def.kind === 'hold') def = firstOfKind(statuses, 'open')
  return stateFields(def, { doneAt: done_at, closedAt: closed_at ?? updatedAt, heldAt: held_at ?? updatedAt, waitingOn: waiting_on }, updatedAt)
}

/** Done or cancelled. */
export function isClosed(task: Pick<Task, 'done_at'> & { closed_at?: string | null }): boolean {
  return task.done_at !== null || (task.closed_at ?? null) !== null
}

/** Not closed: open or on hold. */
export function isOpen(task: Task): boolean {
  return !isClosed(task)
}

export function isHeld(task: Task): boolean {
  return !isClosed(task) && task.held_at !== null
}

/** The local day a task was closed (completed or cancelled), or null. */
export function doneDay(task: Task): string | null {
  const at = task.closed_at ?? task.done_at
  return at ? localDay(new Date(at)) : null
}

/** Whether a task belongs in one of the panel's views on `today`. */
export function inView(task: Task, view: View, today: string): boolean {
  switch (view) {
    case 'today':
      return isOpen(task) ? task.due !== null && task.due <= today : doneDay(task) === today
    case 'upcoming':
      return isOpen(task) && task.due !== null && task.due > today
    case 'inbox':
      return isOpen(task) && task.due === null
    case 'done':
      return !isOpen(task)
  }
}

export function matches(task: Task, filter: TaskFilter, today: string, time?: string): boolean {
  const statuses = filter.doneSince ? ['done'] : filter.statuses
  if (statuses && !statuses.includes(statusOf(task))) return false
  if (filter.states && !filter.states.includes(task.state)) return false
  if (filter.doneSince && (!task.done_at || Date.parse(task.done_at) < Date.parse(filter.doneSince))) return false
  if (filter.noDue === true && task.due !== null) return false
  if (filter.noDue === false && task.due === null) return false
  if (filter.dueFrom && (task.due === null || task.due < filter.dueFrom)) return false
  if (filter.dueTo && (task.due === null || task.due > filter.dueTo)) return false
  if (filter.project !== undefined && (task.project ?? '').toLowerCase() !== filter.project.toLowerCase()) return false
  if (filter.tags && !filter.tags.every((tag) => task.tags.includes(tag.replace(/^#/, '')))) return false
  if (filter.source !== undefined && !sourcesOf(task).includes(filter.source)) return false
  if (filter.text) {
    const needle = filter.text.toLowerCase()
    if (!task.title.toLowerCase().includes(needle) && !task.notes.toLowerCase().includes(needle)) return false
  }
  if (filter.view && !inView(task, filter.view, today)) return false
  if (filter.overdue !== undefined && isOverdue(task, today, time) !== filter.overdue) return false
  if (filter.withBot !== undefined && (activeHandoff(task) !== null) !== filter.withBot) return false
  return true
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

/**
 * The order lists are shown in: open before done; open by due day (none last), then priority,
 * then oldest first; done newest first.
 */
export function compareTasks(a: Task, b: Task): number {
  const STATUS_RANK = { open: 0, hold: 1, done: 2 }
  const rankA = STATUS_RANK[statusOf(a)]
  const rankB = STATUS_RANK[statusOf(b)]
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 2) return (b.closed_at ?? b.done_at ?? '').localeCompare(a.closed_at ?? a.done_at ?? '')
  if (a.due !== b.due) {
    if (a.due === null) return 1
    if (b.due === null) return -1
    return a.due < b.due ? -1 : 1
  }
  if (a.due_time !== b.due_time) {
    if (a.due_time === null) return 1
    if (b.due_time === null) return -1
    return a.due_time < b.due_time ? -1 : 1
  }
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (rank !== 0) return rank
  return a.created_at.localeCompare(b.created_at)
}

export function filterTasks(tasks: readonly Task[], filter: TaskFilter, today: string, time?: string): Task[] {
  return tasks.filter((task) => matches(task, filter, today, time)).sort(compareTasks)
}

/** How many tasks each view holds (on-hold ones included); open ones overdue or due today (on-hold
 *  ones never count there); how many are on hold; and open ones in all, of high or urgent
 *  priority, and with a bot. With `time`, a task due today at an earlier time is overdue. */
export function viewCounts(
  tasks: readonly Task[],
  today: string,
  time?: string
): Record<View, number> & { overdue: number; dueToday: number; hold: number; open: number; high: number; withBot: number } {
  const counts = { today: 0, upcoming: 0, inbox: 0, done: 0, overdue: 0, dueToday: 0, hold: 0, open: 0, high: 0, withBot: 0 }
  for (const task of tasks) {
    if (inView(task, 'today', today)) counts.today += 1
    if (inView(task, 'upcoming', today)) counts.upcoming += 1
    if (inView(task, 'inbox', today)) counts.inbox += 1
    if (inView(task, 'done', today)) counts.done += 1
    if (isHeld(task)) counts.hold += 1
    else if (isOpen(task)) {
      counts.open += 1
      if (task.priority === 'urgent' || task.priority === 'high') counts.high += 1
      if (activeHandoff(task)) counts.withBot += 1
      if (isOverdue(task, today, time)) counts.overdue += 1
      else if (task.due === today) counts.dueToday += 1
    }
  }
  return counts
}

/** Finds a task by its id, or by a prefix of it that only one task has. */
export function findTask(tasks: readonly Task[], idOrPrefix: string): Task {
  const exact = tasks.find((task) => task.id === idOrPrefix)
  if (exact) return exact
  const found = idOrPrefix.length >= 3 ? tasks.filter((task) => task.id.startsWith(idOrPrefix)) : []
  if (found.length === 1) return found[0]
  if (found.length > 1) throw new TaskInputError(`"${idOrPrefix}" matches ${found.length} tasks; give more of the id`)
  throw new TaskNotFoundError(`no task with id ${idOrPrefix}`)
}

export class TaskNotFoundError extends Error {
  readonly code = 'not_found'
}
