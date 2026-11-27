// The Agent Tasks board and sidebar. The same page is both:
// - the board, Orca's center tab (a custom editor, board.html): a list or columns, with a details
//   pane on the right; the file the tab opens is only a handle;
// - the sidebar panel (an HTML panel, sidebar.html, `data-mode="sidebar"`): the list in a narrow
//   column, the details in place of the list, and the "For agents" notes.
// Tasks live in ~/.orca-tasks/tasks.json and come from the plugin's worker. Since 0.4.1 the
// sidebar is this page rather than an Orca components panel, because components cannot be dragged.
//
// Dragging (src/board/drag.ts) uses pointer events: a row or a card goes to another status, or to
// another place in its own, and statuses are put in order in Statuses. Each row also has a status
// menu (its coloured dot) for moving it without dragging.
//
// Ideas for the layout (list and board views, details pane, chips, quick add, the overdue toggle)
// come from uttam-gelot/orca-todos (MIT); the code is this plugin's own.

import type { BotStatus } from '../core/bots.ts'
import { earliestDue, highestPriority, mergeDefaults, type CreatedChoice, type DueChoice, type PriorityChoice } from '../core/merge.ts'
import { workspaceStatusWords, type WorkspaceStatus } from '../core/project-send.ts'
import { botSendInput, initialChat, initialThen, projectSendInput, readableError, settleBotForm, withoutUndefined } from '../core/send-input.ts'
import { checklist, checklistLabel, setChecklistItem } from '../core/checklist.ts'
import { localDay, localTime } from '../core/dates.ts'
import type { OrcaProject } from '../core/projects.ts'
import { groupByProject } from '../core/projects.ts'
import { botReplied, bySection as groupByStatus, dropOrder, DUE_FILTERS, dayLabel, dueLabel, matchesDue, orderSection, visibleStatuses, type DueFilter } from '../core/sections.ts'
import { DEFAULT_STATUSES, defaultSendStatus, firstOfKind, KIND_LABELS, type StatusOp } from '../core/statuses.ts'
import { activeHandoff, compareTasks, currentStatus, doneDay, isClosed, isOverdue, lastChat, lastWorkspace, viewCounts } from '../core/tasks.ts'
import { PRIORITIES, STATUS_COLORS, STATUS_KINDS, type Priority, type ProjectAgent, type SendType, type StatusColor, type StatusDef, type StatusKind, type Task, type TaskPatch } from '../core/types.ts'
import type { BotOffer, ProjectOffer, TaskPaths } from '../protocol.ts'
import { cx, h, icon, mountInto } from './dom.ts'
import { autoScroll, ghostOf, insertionIndex, moveIndex, pointerDrag } from './drag.ts'
import type { MergeSuggestion, SuggestResult } from '../core/suggest.ts'
import { backAction, forwardAction, mouseNav, ViewHistory, type View } from './history.ts'
import { keyTarget as statusKeyTarget, QUICK_ROOM, quickIcon, quickStatuses } from './quick.ts'
import { keyAction, moveCursor, shortcutList, type FieldPlace, type KeyAction, type KeyScreen, type KeyTarget } from './keys.ts'

/** The sidebar panel, or the board tab. */
const SIDEBAR = document.documentElement.dataset.mode === 'sidebar'

/** Every request to the worker goes through here: Orca's `plugin.request` takes only JSON, and a
 *  field set to `undefined` is refused as "input: Invalid input" (what broke Send in 0.4.2). */
const request: typeof orca.plugin.request = ((name: string, input?: unknown, options?: unknown) =>
  (orca.plugin.request as (n: string, i?: unknown, o?: unknown) => Promise<unknown>)(name, input === undefined ? undefined : withoutUndefined(input), options)) as typeof orca.plugin.request

type ViewMode = 'list' | 'board'

interface SendForm {
  taskId: string
  offer: BotOffer | null
  bot: string
  type: SendType
  chat: 'new' | 'home' | 'last'
  /** An instruction above the task ("check progress"). */
  note: string
  /** Whether the task's notes go with it. */
  notes: boolean
  /** The status to move the task to after sending, or '' to leave it. */
  state: string
  busy: boolean
  error: string | null
}

/** The send-to-its-project form. */
interface ProjectSendForm {
  taskId: string
  offer: ProjectOffer | null
  agent: ProjectAgent
  note: string
  notes: boolean
  state: string
  open: boolean
  busy: boolean
  error: string | null
}

/** The merge confirm step: the tasks to merge, the one to keep, and the choices it starts from. */
interface MergeForm {
  ids: string[]
  keep: string
  /** `earliest`, `keep`, `none`, or `day:<YYYY-MM-DD>@<HH:MM or ->`. */
  due: string
  priority: PriorityChoice
  created: CreatedChoice
  busy: boolean
  error: string | null
}

interface Saved {
  view: ViewMode
  filter: DueFilter
  project: string
  /** Which statuses' groups are closed, by id; one not listed is closed when its status is. */
  closed: Record<string, boolean>
  /** Each status's tasks grouped by project. */
  byProject: boolean
}

const SURFACE = SIDEBAR ? 'sidebar' : 'board'
/** How long the panel waits for Suggest merges: the agent's 3 minutes, and a little. */
const SUGGEST_WAIT_MS = 200_000
const STORE_KEY = `agent-tasks-${SURFACE}`
const FIRST = SIDEBAR ? 10 : 30
const MORE = SIDEBAR ? 20 : 50

const saved: Saved = readSaved()
const state = {
  tasks: [] as Task[],
  loaded: false,
  today: localDay(new Date()),
  bots: {} as Record<string, BotStatus>,
  statuses: DEFAULT_STATUSES.map((s) => ({ ...s })) as StatusDef[],
  /** The Statuses settings show in place of the list or board. */
  settings: false,
  newStatus: { name: '', kind: 'open' as StatusKind, color: 'blue' as StatusColor },
  orca: [] as OrcaProject[],
  view: saved.view,
  filter: saved.filter,
  project: saved.project,
  closed: saved.closed,
  limits: {} as Record<string, number>,
  search: '',
  selected: null as string | null,
  /** The task the keys act on (J/K move it, Enter opens it, X ticks it); the open one, or the one
   *  last moved to with the details closed. */
  cursor: null as string | null,
  /** The shortcuts list (?) is shown. */
  help: false,
  /** Esc was pressed once on a send form with a typed instruction; the next one discards it. */
  escArmed: false,
  send: null as SendForm | null,
  toProject: null as ProjectSendForm | null,
  /** What the agent in each task's project workspace is doing, by task id. */
  workspaces: {} as Record<string, WorkspaceStatus>,
  /** Tasks picked with Cmd/Ctrl- or Shift-click, to merge. */
  picked: [] as string[],
  merge: null as MergeForm | null,
  /** Suggest merges: asking the agent (busy), what it answered, or why not. */
  suggest: null as { busy: boolean; error: string | null; result: SuggestResult | null } | null,
  canUndoMerge: false,
  notice: null as { text: string; error: boolean; undoMerge?: boolean; draft?: boolean } | null,
  /** What the details pane shows now, so typing there is not redrawn under the cursor. */
  detailsKey: '',
  byProject: saved.byProject,
  /** Where the CLI and the data are, for the sidebar's "For agents". */
  paths: null as TaskPaths | null
}

function readSaved(): Saved {
  try {
    return savedFrom(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'))
  } catch {
    return savedFrom(null)
  }
}

function savedFrom(value: unknown): Saved {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Saved>
  return {
    view: raw.view === 'board' && !SIDEBAR ? 'board' : 'list',
    filter: DUE_FILTERS.some((f) => f.id === raw.filter) ? (raw.filter as DueFilter) : 'all',
    project: typeof raw.project === 'string' ? raw.project : '',
    closed: raw.closed && typeof raw.closed === 'object' ? { ...raw.closed } : {},
    byProject: raw.byProject === true
  }
}

function snapshot(): Saved {
  return { view: state.view, filter: state.filter, project: state.project, closed: state.closed, byProject: state.byProject }
}

/** Remembers what is shown: in the frame's storage when it has one, and with the worker (an
 *  isolated frame may lose its storage). */
function persist(): void {
  const value = snapshot()
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value))
  } catch {
    // No storage in this frame; the worker keeps it.
  }
  void request('tasks.uiState', { surface: SURFACE, set: value as unknown as Record<string, unknown> }).catch(() => undefined)
}

/** What the worker remembers, when the frame's own storage had nothing. */
async function restore(): Promise<void> {
  try {
    if (localStorage.getItem(STORE_KEY)) return
  } catch {
    // No storage: ask the worker.
  }
  try {
    const { state: kept } = await request('tasks.uiState', { surface: SURFACE })
    if (!kept) return
    Object.assign(state, savedFrom(kept))
    // What the worker kept is where the history starts, not a step back from the defaults.
    viewHistory.reset(shownView())
    render()
  } catch {
    // An older worker: start from the defaults.
  }
}

/** An error as the person should read it: Orca's "input: Invalid input" names the field. */
function message(error: unknown): string {
  return readableError(error)
}



function nowTime(): string {
  return localTime(new Date())
}

// ---- Talking to the worker ----

async function load(): Promise<void> {
  try {
    const answer = await request('tasks.list')
    state.tasks = answer.tasks
    state.today = answer.today
    state.bots = answer.bots ?? {}
    state.workspaces = answer.workspaces ?? {}
    state.canUndoMerge = answer.canUndoMerge === true
    state.picked = state.picked.filter((id) => answer.tasks.some((t) => t.id === id && !t.merged_into))
    if (answer.statuses) state.statuses = answer.statuses
    state.loaded = true
    if (state.selected && !state.tasks.some((t) => t.id === state.selected)) state.selected = null
  } catch (error) {
    state.notice = { text: `Could not read the task list: ${message(error)}`, error: true }
  }
  render()
}

function loadProjects(): void {
  request('tasks.projects').then(
    (answer) => {
      state.orca = answer.orca
      render()
    },
    () => undefined
  )
}

async function act(work: () => Promise<unknown>, done?: string): Promise<void> {
  try {
    await work()
    if (done) state.notice = { text: done, error: false }
  } catch (error) {
    state.notice = { text: message(error), error: true }
  }
  await load()
}

function patch(task: Task, fields: TaskPatch): Promise<void> {
  return act(() => request('tasks.update', { id: task.id, patch: fields }))
}

function setDone(task: Task, done: boolean): Promise<void> {
  return act(() => request('tasks.setDone', { id: task.id, done }))
}

/** Moves a task to another status (the status menu or the Status field). It shows there at once,
 *  first in its section; the worker's answer and the reload confirm it. */
async function moveTo(task: Task, target: string): Promise<void> {
  const def = statusOf(target)
  if (!def || currentStatus(task, state.statuses).id === target) return
  state.tasks = state.tasks.map((t) => {
    if (t.id !== task.id) return t
    const next = { ...t, state: def.id, state_name: def.name }
    delete next.rank
    return next
  })
  render(true)
  await patch(task, { state: target })
}

/** A dragged task dropped into status `target`, before the task `before` (null: at the end). */
async function dropTask(task: Task, target: string, before: string | null): Promise<void> {
  const def = statusOf(target)
  if (!def) return
  // The whole section, also what a filter hides, in the order shown.
  const section = orderSection(state.tasks.filter((t) => currentStatus(t, state.statuses).id === target)).map((t) => t.id)
  const order = dropOrder(section, task.id, before)
  const moving = currentStatus(task, state.statuses).id !== target
  if (!moving && order.join() === section.join()) return
  const rank = new Map(order.map((id, i) => [id, i + 1]))
  state.tasks = state.tasks.map((t) => {
    if (t.id === task.id) return { ...t, state: def.id, state_name: def.name, rank: rank.get(t.id) }
    return rank.has(t.id) ? { ...t, rank: rank.get(t.id) } : t
  })
  if (isGroupClosed(def)) {
    state.closed = { ...state.closed, [def.id]: false }
    persist()
  }
  render(true)
  await act(() => request('tasks.move', { id: task.id, state: moving ? target : null, order }))
}

function editStatuses(op: StatusOp): Promise<void> {
  return act(async () => {
    const answer = await request('tasks.statuses', op)
    state.statuses = answer.statuses
  })
}

function statusOf(id: string): StatusDef | undefined {
  return state.statuses.find((s) => s.id === id)
}

function isGroupClosed(def: StatusDef): boolean {
  return state.closed[def.id] ?? def.closed
}

async function openSend(task: Task): Promise<void> {
  state.toProject = null
  state.send = { taskId: task.id, offer: null, bot: '', type: 'handoff', chat: 'home', note: '', notes: true, state: initialThen(null, state.statuses), busy: false, error: null }
  render(true)
  try {
    const offer = await request('tasks.bots', { id: task.id })
    if (state.send?.taskId !== task.id) return
    // The project's bot (else Orca) unless the last send for this project chose another; the
    // other choices as they were that time. Then: In Progress unless this project chose otherwise.
    const last = offer.last
    state.send = {
      ...state.send,
      offer,
      bot: last?.bot ?? offer.default ?? offer.bots[0]?.name ?? '',
      type: last?.type ?? 'handoff',
      chat: initialChat(last, Boolean(offer.lastChat)),
      notes: last?.notes ?? true,
      state: initialThen(last, state.statuses),
      error: offer.error
    }
  } catch (error) {
    if (state.send?.taskId === task.id) state.send = { ...state.send, error: message(error) }
  }
  render(true)
}

async function send(): Promise<void> {
  const form = state.send
  if (!form || !form.bot || form.busy) return
  form.busy = true
  form.error = null
  render(true)
  try {
    const { task, handoff } = await request('tasks.send', botSendInput(form.taskId, form, SIDEBAR ? 'panel' : 'board'))
    state.escArmed = false
    state.send = null
    state.notice = { text: `Sent to ${handoff.bot}${handoff.chat === 'new' ? ' in a new chat' : handoff.chat === 'home' ? ' in its Home Chat' : ''}. The task is ${task.state_name}.`, error: false }
  } catch (error) {
    form.busy = false
    form.error = message(error)
  }
  await load()
  render(true)
}

async function openToProject(task: Task): Promise<void> {
  state.send = null
  state.toProject = { taskId: task.id, offer: null, agent: 'claude', note: '', notes: true, state: initialThen(null, state.statuses), open: false, busy: false, error: null }
  render(true)
  try {
    const offer = await request('tasks.projectOffer', { id: task.id })
    if (state.toProject?.taskId !== task.id) return
    const last = offer.last
    state.toProject = { ...state.toProject, offer, agent: last?.agent ?? 'claude', notes: last?.notes ?? true, state: initialThen(last, state.statuses), open: last?.open ?? false, error: offer.error ?? offer.access }
  } catch (error) {
    if (state.toProject?.taskId === task.id) state.toProject = { ...state.toProject, error: message(error) }
  }
  render(true)
}

async function sendToProject(): Promise<void> {
  const form = state.toProject
  if (!form || form.busy || !form.offer?.project) return
  form.busy = true
  form.error = null
  render(true)
  try {
    const { task, workspace } = await request('tasks.sendToProject', projectSendInput(form.taskId, form, SIDEBAR ? 'panel' : 'board'))
    state.escArmed = false
    state.toProject = null
    state.notice = { text: `Started ${workspace.agent} in a new workspace of ${workspace.project}, ${workspace.workspace_name}. The task is ${task.state_name}.`, error: false }
  } catch (error) {
    form.busy = false
    form.error = message(error)
  }
  await load()
  render(true)
}

// ---- Picking and merging ----

/** Cmd/Ctrl- or Shift-click picks a task (or puts it back), to merge several. */
function togglePick(task: Task): void {
  if (task.merged_into) return
  state.picked = state.picked.includes(task.id) ? state.picked.filter((id) => id !== task.id) : [...state.picked, task.id]
  render()
}

function dueKey(due: { due: string; due_time: string | null } | null): string {
  return due ? `day:${due.due}@${due.due_time ?? '-'}` : 'none'
}

/** Opens the merge confirm step for `ids`, keeping `keep` (default: the oldest). */
function openMerge(ids: string[], keep?: string): void {
  const tasks = ids.map((id) => state.tasks.find((t) => t.id === id)).filter((t): t is Task => t !== undefined)
  const keeper = tasks.find((t) => t.id === keep) ?? [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
  if (!keeper) return
  state.send = null
  state.toProject = null
  state.merge = { ids: tasks.map((t) => t.id), keep: keeper.id, due: 'earliest', priority: 'highest', created: 'earliest', busy: false, error: null }
  render(true)
}

function mergeChoice(form: MergeForm): DueChoice {
  if (form.due === 'earliest' || form.due === 'keep' || form.due === 'none') return form.due
  const [, day, time] = /^day:([^@]+)@(.+)$/.exec(form.due) ?? []
  return day ? { due: day, due_time: time === '-' ? null : time } : 'earliest'
}

async function merge(): Promise<void> {
  const form = state.merge
  if (!form || form.busy) return
  const ids = form.ids.filter((id) => id !== form.keep)
  if (ids.length === 0) return
  form.busy = true
  form.error = null
  render(true)
  try {
    const { keeper, merged } = await request('tasks.merge', { keep: form.keep, ids, due: mergeChoice(form), priority: form.priority, created: form.created })
    state.merge = null
    state.picked = []
    state.selected = keeper.id
    state.notice = { text: `Merged ${merged.length} task${merged.length === 1 ? '' : 's'} into "${keeper.title}". The others are cancelled and point to it.`, error: false, undoMerge: true }
  } catch (error) {
    form.busy = false
    form.error = message(error)
  }
  await load()
  render(true)
}

async function undoMerge(): Promise<void> {
  try {
    const { keeper, restored } = await request('tasks.undoMerge')
    state.notice = { text: `Undid the merge: "${keeper.title}" and ${restored.length} other${restored.length === 1 ? '' : 's'} are as they were.`, error: false }
  } catch (error) {
    state.notice = { text: message(error), error: true }
  }
  await load()
}

// ---- What is shown ----

function scoped(): Task[] {
  const needle = state.search.trim().toLowerCase()
  const time = nowTime()
  return [...state.tasks].sort(compareTasks).filter((task) => {
    if (state.project && (task.project ?? '') !== (state.project === '__none__' ? '' : state.project)) return false
    if (!matchesDue(task, state.filter, state.today, time, doneDay(task))) return false
    if (needle && !`${task.title}\n${task.notes}\n${task.tags.join(' ')}\n${task.project ?? ''}`.toLowerCase().includes(needle)) return false
    return true
  })
}

function bySection(list: Task[]): Record<string, Task[]> {
  const groups = groupByStatus(list, state.statuses)
  for (const id of Object.keys(groups)) groups[id] = orderSection(groups[id])
  return groups
}

function visibleSections(): StatusDef[] {
  return visibleStatuses(state.statuses, state.filter)
}

/** The tasks in the order they are shown, for J/K. */
function shownOrder(): Task[] {
  if (state.settings) return []
  const groups = bySection(scoped())
  return visibleSections().flatMap((def) => (state.view === 'list' && isGroupClosed(def) ? [] : (groups[def.id] ?? []).slice(0, state.limits[def.id] ?? FIRST)))
}

function selectedTask(): Task | null {
  return state.tasks.find((t) => t.id === state.selected) ?? null
}

function select(id: string | null): void {
  if (state.selected !== id) {
    state.send = null
    state.toProject = null
  }
  state.selected = id
  if (id) state.cursor = id
  render(true)
}

function isOrca(name: string | null): boolean {
  return name !== null && state.orca.some((p) => p.name === name)
}

// ---- Drawing ----

const root = document.getElementById('root') ?? document.body.appendChild(h('div', { id: 'root' }))
const els = buildFrame()

function buildFrame() {
  const stats = h('span', { class: 'stats' })
  const overdue = h('button', { class: 'btn sm overdue-toggle', title: 'Show only overdue tasks', onclick: () => setFilter(state.filter === 'overdue' ? 'all' : 'overdue') })
  const viewList = h('button', { onclick: () => setView('list'), title: 'List (V)' }, icon('list'), 'List')
  const viewBoard = h('button', { onclick: () => setView('board'), title: 'Board (V)' }, icon('board'), 'Board')
  const settings = h(
    'button',
    {
      class: cx('btn sm', SIDEBAR && 'icon-only'),
      title: 'Statuses: add, rename, recolour, reorder and delete them',
      'aria-label': 'Statuses',
      onclick: () => {
        state.settings = !state.settings
        render()
      }
    },
    icon('settings', 13),
    SIDEBAR ? null : 'Statuses'
  )
  const suggest = h(
    'button',
    {
      class: cx('btn sm', SIDEBAR && 'icon-only'),
      title: 'Suggest merges: ask Claude Code which open tasks look like duplicates (nothing merges until you confirm)',
      'aria-label': 'Suggest merges',
      onclick: () => void suggestMerges()
    },
    icon('sparkles', 13),
    SIDEBAR ? null : 'Suggest merges'
  )
  const help = h('button', { class: 'btn sm icon-only', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', 'aria-expanded': 'false', onclick: () => toggleHelp() }, '?')
  const boardButton = h('button', { class: 'btn sm', title: 'Open the board in a tab', onclick: () => void openBoard() }, icon('board', 13), 'Board')
  const byProjectBox = h('input', {
    type: 'checkbox',
    onchange: (e: Event) => {
      state.byProject = (e.target as HTMLInputElement).checked
      persist()
      render()
    }
  })
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search  /',
    'aria-label': 'Search tasks',
    oninput: (e: Event) => {
      state.search = (e.target as HTMLInputElement).value
      render()
    }
  })
  const filter = h(
    'select',
    { class: 'select', 'aria-label': 'Show', onchange: (e: Event) => setFilter((e.target as HTMLSelectElement).value as DueFilter) },
    DUE_FILTERS.map((f) => h('option', { value: f.id }, f.title))
  )
  const project = h('select', {
    class: 'select',
    'aria-label': 'Project',
    onchange: (e: Event) => {
      state.project = (e.target as HTMLSelectElement).value
      persist()
      render()
    }
  })
  const quick = h('input', {
    class: 'input',
    placeholder: SIDEBAR ? 'Add a task: Call Alice !high @ops #chat @fri' : 'Add a task: Call Alice !high @ops #chat @fri  (due:fri@15:30 for a time)',
    'aria-label': 'New task',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const input = e.target as HTMLInputElement
        void addTask(input.value).then((ok) => {
          if (ok) input.value = ''
        })
      }
    }
  })
  const notice = h('div')
  const main = h('div', { class: 'main' })
  const details = h('div', { class: 'details' })
  const body = h('div', { class: 'body' }, main, details)
  const header = SIDEBAR
    ? h(
        'div',
        { class: 'header' },
        h('div', { class: 'quick-add' }, quick),
        h('div', { class: 'header-row' }, filter, h('span', { class: 'spacer' }), boardButton, suggest, settings, help),
        h('div', { class: 'header-row' }, stats, overdue, h('span', { class: 'spacer' }), h('label', { class: 'check-line' }, byProjectBox, 'Group by project')),
        notice
      )
    : h(
    'div',
    { class: 'header' },
    h(
      'div',
      { class: 'header-row' },
      h('span', { class: 'title' }, 'Agent Tasks'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, viewList, viewBoard),
      h('label', { class: 'search' }, icon('search'), search),
      filter,
      project,
      h('span', { class: 'spacer' }),
      stats,
      overdue,
      suggest,
      settings,
      help
    ),
    h('div', { class: 'quick-add' }, quick),
    notice
  )
  if (SIDEBAR) document.body.classList.add('sidebar')
  mountInto(root, h('div', { class: 'app' }, header, body))
  return { stats, overdue, viewList, viewBoard, settings, suggest, help, search, filter, project, quick, notice, main, details, body, byProjectBox }
}

async function openBoard(): Promise<void> {
  try {
    const answer = await request('tasks.openBoard')
    state.notice = answer.opened ? null : { text: answer.reason ?? 'Could not open the board.', error: false }
  } catch (error) {
    state.notice = { text: message(error), error: true }
  }
  render()
}

function setView(view: ViewMode): void {
  state.view = view
  persist()
  render()
}

function setFilter(filter: DueFilter): void {
  state.filter = filter
  persist()
  render()
}

async function addTask(text: string): Promise<boolean> {
  if (text.trim() === '') return false
  const project = state.project && state.project !== '__none__' ? state.project : undefined
  try {
    const { task } = await request('tasks.add', { text, project, ...(state.filter === 'today' ? { view: 'today' as const } : {}) })
    state.selected = task.id
    state.notice = null
  } catch (error) {
    state.notice = { text: message(error), error: true }
    render()
    return false
  }
  await load()
  return true
}

/** The task being dragged to another status or place, by id. */
let dragging: string | null = null
/** Something is being dragged (a task or a status): redraws wait until it is dropped. */
let dragActive = false
/** A redraw asked for while dragging, done when the drag ends. */
let renderLater = false

function render(forceDetails = false): void {
  // Redrawing would take the dragged row or card, and the drop targets, out from under the pointer.
  if (dragActive) {
    renderLater = true
    return
  }
  renderLater = false
  const counts = viewCounts(state.tasks, state.today, nowTime())
  els.stats.textContent = `${counts.open} open${counts.high || !SIDEBAR ? ` · ${counts.high} high` : ''}${counts.withBot ? ` · ${counts.withBot} with a bot` : ''}`
  els.byProjectBox.checked = state.byProject
  els.overdue.textContent = `${counts.overdue} overdue`
  els.overdue.className = cx('btn sm overdue-toggle', state.filter === 'overdue' && 'on')
  els.overdue.style.display = counts.overdue > 0 || state.filter === 'overdue' ? '' : 'none'
  els.viewList.className = cx(state.view === 'list' && 'on')
  els.viewBoard.className = cx(state.view === 'board' && 'on')
  els.settings.className = cx('btn sm', state.settings && 'on')
  els.help.className = cx('btn sm icon-only', state.help && 'on')
  els.suggest.className = cx('btn sm', SIDEBAR && 'icon-only', state.suggest && 'on')
  els.help.setAttribute('aria-expanded', String(state.help))
  els.filter.value = state.filter
  renderProjectSelect()
  mountInto(
    els.notice,
    state.notice
      ? h(
          'div',
          { class: cx('notice', state.notice.error && 'error') },
          h('span', { style: { flex: '1' } }, state.notice.text),
          state.notice.undoMerge && state.canUndoMerge ? h('button', { class: 'btn sm', onclick: () => void undoMerge() }, 'Undo') : null,
          h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Dismiss', onclick: () => ((state.notice = null), render()) }, icon('close'))
        )
      : null,
    state.picked.length > 0
      ? h(
          'div',
          { class: 'notice picked-bar' },
          h('span', { style: { flex: '1' } }, `${state.picked.length} picked${state.picked.length === 1 ? ': Cmd- or Shift-click another to merge them' : ''}`),
          h('button', { class: 'btn sm', disabled: state.picked.length < 2, title: 'Fold the picked tasks into one', onclick: () => openMerge(state.picked) }, icon('merge', 12), 'Merge…'),
          h('button', { class: 'btn ghost sm', onclick: () => ((state.picked = []), render()) }, 'Clear')
        )
      : null,
    state.help ? shortcutsBox() : null,
    state.suggest ? suggestionsBox(state.suggest) : null
  )
  if (state.settings) {
    // Leave the settings alone while the person types a name there.
    const typing = els.main.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT'
    if (!typing || !els.main.querySelector('.statuses')) mountInto(els.main, renderStatuses())
  } else if (!state.loaded) {
    mountInto(els.main, h('div', { class: 'blank' }, 'Loading tasks…'))
  } else if (state.tasks.length === 0) {
    mountInto(els.main, h('div', { class: 'blank' }, h('strong', null, 'No tasks yet'), 'Type one above. Agents add them with orca-tasks.'))
  } else {
    mountInto(els.main, state.view === 'list' || SIDEBAR ? renderList() : renderBoard())
  }
  if (SIDEBAR && !state.settings) els.main.appendChild(forAgents())
  renderDetails(forceDetails)
  viewHistory.note(shownView())
}

function renderProjectSelect(): void {
  const names = new Set<string>()
  for (const t of state.tasks) if (t.project) names.add(t.project)
  for (const p of state.orca) if (!p.hidden) names.add(p.name)
  const sorted = [...names].sort((a, b) => Number(isOrca(b)) - Number(isOrca(a)) || a.localeCompare(b))
  const key = JSON.stringify([sorted, state.project, state.orca.length])
  if (els.project.dataset.key === key) return
  els.project.dataset.key = key
  mountInto(
    els.project,
    h('option', { value: '' }, 'All projects'),
    sorted.map((name) => h('option', { value: name }, isOrca(name) ? `◆ ${name}` : `@${name}`)),
    h('option', { value: '__none__' }, 'No project')
  )
  els.project.value = state.project
}

function dueChip(task: Task): HTMLElement | null {
  if (!task.due) return null
  const overdue = isOverdue(task, state.today, nowTime())
  const today = !task.done_at && !overdue && task.due === state.today
  return h('span', { class: cx('chip', !task.done_at && overdue && 'overdue', today && 'today'), title: `Due ${task.due}${task.due_time ? ` ${task.due_time}` : ''}` }, icon('calendar', 12), dueLabel(task, state.today))
}

function chips(task: Task, compact = false): HTMLElement {
  const bot = state.bots[task.id]
  const handoff = activeHandoff(task)
  const list = checklistLabel(task.notes)
  const parts: (HTMLElement | null)[] = []
  if (task.priority !== 'none' && task.priority !== 'low' && !isClosed(task)) parts.push(h('span', { class: cx('chip plain', `prio-${task.priority}`) }, task.priority === 'urgent' ? '!! urgent' : task.priority === 'high' ? '! high' : 'medium'))
  if (task.held_at && !isClosed(task)) parts.push(h('span', { class: 'chip hold', title: task.waiting_on ?? 'On hold' }, icon('pause', 12), task.waiting_on ? `Waiting on ${task.waiting_on}` : 'On hold'))
  if (handoff) {
    const replied = botReplied(task, bot)
    parts.push(h('span', { class: cx('chip bot', replied && 'answered'), title: bot?.reply ?? '' }, icon('bot', 12), replied ? `${handoff.bot} answered` : `${handoff.bot}${bot && bot.state !== 'unknown' ? ` · ${bot.state}` : ''}`))
  }
  const workspace = lastWorkspace(task)
  if (workspace && !isClosed(task)) {
    const ws = state.workspaces[task.id]
    parts.push(h('span', { class: cx('chip bot', ws?.state === 'done' && 'answered'), title: `${workspace.agent} in workspace ${workspace.workspace_name}` }, icon('branch', 12), `${workspace.agent}${ws ? ` · ${workspaceStatusWords(ws)}` : ''}`))
  }
  parts.push(dueChip(task))
  if (list) {
    const all = checklist(task.notes)
    parts.push(h('span', { class: cx('chip plain', all.done === all.total && 'done-list'), title: 'Checklist' }, icon('checklist', 12), list))
  } else if (task.notes.trim() && !compact) {
    parts.push(h('span', { class: 'chip plain', title: 'Has notes' }, icon('note', 12)))
  }
  if (task.project) {
    parts.push(
      h(
        'span',
        {
          class: cx('chip', isOrca(task.project) && 'project'),
          title: isOrca(task.project) ? `Open ${task.project} in Orca` : task.project,
          onclick: isOrca(task.project)
            ? (e: Event) => {
                e.stopPropagation()
                void act(() => request('tasks.openProject', { name: task.project ?? '' }))
              }
            : undefined
        },
        icon('folder', 12),
        task.project
      )
    )
  }
  if (!compact) for (const tag of task.tags) parts.push(h('span', { class: 'chip plain' }, `#${tag}`))
  return h('span', { class: 'chips' }, parts)
}

function tick(task: Task): HTMLElement {
  const closed = isClosed(task)
  return h(
    'button',
    {
      class: cx('tick', closed && 'on', closed && !task.done_at && 'cancelled'),
      'aria-label': closed ? `Reopen ${task.title}` : `Complete ${task.title}`,
      title: closed ? 'Reopen (X)' : 'Done (X)',
      onclick: (e: Event) => {
        e.stopPropagation()
        void setDone(task, !closed)
      }
    },
    task.done_at ? icon('check', 11) : closed ? icon('close', 11) : null
  )
}

function renderList(): HTMLElement {
  const groups = bySection(scoped())
  return h(
    'div',
    { class: 'list' },
    visibleSections().map((def) => {
      const id = def.id
      const list = groups[id] ?? []
      const closed = isGroupClosed(def)
      const limit = state.limits[id] ?? (def.closed ? Math.min(FIRST, 5) : FIRST)
      const head = h(
        'button',
        {
          class: 'group-head',
          'aria-expanded': String(!closed),
          onclick: () => {
            state.closed = { ...state.closed, [id]: !closed }
            persist()
            render()
          }
        },
        icon('chevron', 14),
        h('span', { class: cx('dot', `c-${def.color}`) }),
        def.name,
        h('span', { class: 'count' }, String(list.length))
      )
      // The whole group takes a dragged task; a closed one by its header, and opens after the drop.
      if (closed) return h('div', { class: 'group closed', 'data-drop-status': id }, head)
      const shown = list.slice(0, limit)
      const rest = list.length - shown.length
      const rows = state.byProject
        ? groupByProject(shown, state.orca).map((g) =>
            h(
              'div',
              { class: 'project-group' },
              h('div', { class: 'project-head' }, g.project === null ? 'No project' : g.orca ? `◆ ${g.project}` : `@${g.project}`, h('span', { class: 'count' }, String(g.total))),
              g.tasks.map((task) => row(task))
            )
          )
        : shown.map((task) => row(task))
      return h(
        'div',
        { class: 'group', 'data-drop-status': id },
        head,
        list.length === 0 ? h('div', { class: 'empty' }, emptyText(def)) : rows,
        rest > 0 ? h('button', { class: 'btn ghost sm more', onclick: () => ((state.limits[id] = limit + MORE), render()) }, `Show ${Math.min(rest, MORE)} more`) : null
      )
    })
  )
}

function emptyText(def: StatusDef): string {
  return { open: 'Nothing here.', hold: 'Nothing is waiting on someone else.', done: 'Nothing done here yet.', cancelled: 'Nothing cancelled.' }[def.kind]
}

function row(task: Task): HTMLElement {
  const el = h(
    'div',
    {
      class: cx('row', isClosed(task) && 'done', state.selected === task.id && 'selected', state.cursor === task.id && 'cursor', state.picked.includes(task.id) && 'picked'),
      tabindex: '0',
      role: 'button',
      'data-id': task.id,
      'aria-pressed': state.picked.length ? String(state.picked.includes(task.id)) : undefined,
      onclick: (e: MouseEvent) => (e.metaKey || e.ctrlKey || e.shiftKey ? togglePick(task) : select(task.id))
    },
    tick(task),
    statusButton(task),
    h('span', { class: 'row-title', title: `${task.title}\nDrag to another status, or to another place in this one` }, task.title),
    chips(task),
    quickActions(task, SIDEBAR ? QUICK_ROOM.sidebar : QUICK_ROOM.list)
  )
  dragTask(el, task)
  return el
}

/** The coloured dot on a row or a card: a menu of the statuses, to move the task without dragging.
 *  It pulses softly while the task is In Progress (the status of that name, or the one that
 *  started as In Progress), unless the person asks for less motion. */
function statusButton(task: Task): HTMLElement {
  const def = currentStatus(task, state.statuses)
  const working = !isClosed(task) && def.id === defaultSendStatus(state.statuses)?.id
  return h(
    'button',
    {
      class: 'status-button',
      title: `${def.name}: change the status`,
      'aria-label': `Status of ${task.title}: ${def.name}. Change it`,
      'aria-haspopup': 'menu',
      onclick: (e: Event) => {
        e.stopPropagation()
        openStatusMenu(task, e.currentTarget as HTMLElement)
      }
    },
    h('span', { class: cx('dot', `c-${def.color}`, working && 'pulse') })
  )
}

let closeMenu: (() => void) | null = null

function openStatusMenu(task: Task, anchor: HTMLElement): void {
  const current = currentStatus(task, state.statuses).id
  const items = state.statuses.map((def) =>
    h(
      'button',
      {
        class: cx('menu-item', def.id === current && 'current'),
        role: 'menuitemradio',
        'aria-checked': String(def.id === current),
        onclick: (e: Event) => {
          e.stopPropagation()
          closeMenu?.()
          void moveTo(task, def.id)
        }
      },
      h('span', { class: cx('dot', `c-${def.color}`) }),
      def.name,
      def.id === current ? icon('check', 12) : null
    )
  )
  openMenu(anchor, `Move ${task.title} to`, items)
}

/** A menu under (or above) `anchor`: arrows move, Esc or a click elsewhere closes it. */
function openMenu(anchor: HTMLElement, label: string, items: HTMLElement[]): void {
  closeMenu?.()
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label }, items)
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const m = menu.getBoundingClientRect()
  const left = Math.max(4, Math.min(r.left, window.innerWidth - m.width - 4))
  const top = r.bottom + m.height + 4 > window.innerHeight ? Math.max(4, r.top - m.height - 4) : r.bottom + 4
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` })
  ;((menu.querySelector('.menu-item.current') ?? menu.querySelector('.menu-item')) as HTMLElement | null)?.focus()
  const away = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeMenu?.()
  }
  const key = (e: KeyboardEvent) => {
    const list = Array.from(menu.querySelectorAll<HTMLElement>('.menu-item'))
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeMenu?.()
      anchor.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus()
    }
  }
  setTimeout(() => window.addEventListener('pointerdown', away, true), 0)
  window.addEventListener('keydown', key, true)
  anchor.closest('.row, .card')?.classList.add('menu-open')
  closeMenu = () => {
    menu.remove()
    anchor.closest('.row, .card')?.classList.remove('menu-open')
    window.removeEventListener('pointerdown', away, true)
    window.removeEventListener('keydown', key, true)
    closeMenu = null
  }
}

/**
 * The quick actions at the right edge of a row or a card, shown on hover and on keyboard focus
 * (laid over it, so nothing moves): an icon for each status the task can move to, the most useful
 * first when they do not all fit (quick.ts), and "…" for the rest and the other actions. A click
 * there never opens the task.
 */
function quickActions(task: Task, room: number): HTMLElement {
  const current = currentStatus(task, state.statuses).id
  const { shown, more } = quickStatuses(state.statuses, current, room)
  const inProgress = defaultSendStatus(state.statuses)?.id ?? null
  const stop = (e: Event) => e.stopPropagation()
  return h(
    'div',
    { class: 'quick', onclick: stop, ondblclick: stop },
    shown.map((def) =>
      h(
        'button',
        {
          class: cx('quick-button', `c-${def.color}`),
          title: def.name,
          'aria-label': `Move ${task.title} to ${def.name}`,
          'data-status': def.id,
          onclick: (e: Event) => {
            e.stopPropagation()
            void moveTo(task, def.id)
          }
        },
        icon(quickIcon(def, inProgress), 14)
      )
    ),
    h(
      'button',
      {
        class: 'quick-button more',
        title: 'More',
        'aria-label': `More for ${task.title}`,
        'aria-haspopup': 'menu',
        onclick: (e: Event) => {
          e.stopPropagation()
          openMoreMenu(task, e.currentTarget as HTMLElement, more)
        }
      },
      icon('more', 14)
    )
  )
}

/** "…" on a row or a card: the statuses its icons leave out, then open, send, merge. */
function openMoreMenu(task: Task, anchor: HTMLElement, more: readonly StatusDef[]): void {
  const item = (label: string, action: () => void, lead: Node | null = null) =>
    h(
      'button',
      {
        class: 'menu-item',
        role: 'menuitem',
        onclick: (e: Event) => {
          e.stopPropagation()
          closeMenu?.()
          action()
        }
      },
      lead,
      label
    )
  const open = !isClosed(task)
  const items = [
    item('Open', () => select(task.id)),
    ...more.map((def) => item(`Move to ${def.name}`, () => void moveTo(task, def.id), h('span', { class: cx('dot', `c-${def.color}`) }))),
    open
      ? item('Send to a bot…', () => {
          select(task.id)
          void openSend(task)
        })
      : null,
    open && task.project
      ? item('Send to the project…', () => {
          select(task.id)
          void openToProject(task)
        })
      : null,
    task.merged_into ? null : item('Merge…', () => openMerge([...new Set([task.id, ...state.picked])], task.id)),
    item(state.picked.includes(task.id) ? 'Unpick' : 'Pick for a merge', () => togglePick(task))
  ].filter((x): x is HTMLButtonElement => x !== null)
  openMenu(anchor, `More for ${task.title}`, items)
}

/** Lets a row or a card be dragged to a status (a list group or a board column) and to a place in
 *  it: before the row or card under the pointer, or at the end. */
function dragTask(el: HTMLElement, task: Task): void {
  let ghost: ReturnType<typeof ghostOf> | null = null
  let target: { status: string; before: string | null } | null = null
  const scroll = autoScroll(() => [els.main, ...Array.from(els.main.querySelectorAll<HTMLElement>('.column-body, .board'))])
  const clear = () => {
    els.main.querySelectorAll('.drop, .insert-before, .insert-after').forEach((x) => x.classList.remove('drop', 'insert-before', 'insert-after'))
  }
  const end = () => {
    scroll.stop()
    ghost?.remove()
    ghost = null
    clear()
    el.classList.remove('dragging')
    document.body.classList.remove('dragging-task')
    dragging = null
    dragActive = false
  }
  pointerDrag(el, {
    onStart: (x, y) => {
      closeMenu?.()
      dragging = task.id
      dragActive = true
      el.classList.add('dragging')
      document.body.classList.add('dragging-task')
      ghost = ghostOf(el, x, y)
    },
    onMove: (x, y) => {
      ghost?.move(x, y)
      scroll.at(x, y)
      clear()
      target = null
      const zone = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop-status]')
      if (!zone) return
      const status = zone.dataset.dropStatus as string
      const items = Array.from(zone.querySelectorAll<HTMLElement>('[data-id]')).filter((x2) => x2.dataset.id !== task.id)
      const at = insertionIndex(
        y,
        items.map((x2) => x2.getBoundingClientRect())
      )
      const before = items[at]?.dataset.id ?? null
      // Into a closed group, by its header: at the top.
      const closedGroup = zone.classList.contains('closed')
      const first = closedGroup ? (orderSection(state.tasks.filter((t) => currentStatus(t, state.statuses).id === status))[0]?.id ?? null) : null
      target = { status, before: closedGroup ? (first === task.id ? null : first) : before }
      zone.classList.add('drop')
      if (!closedGroup) {
        if (items[at]) items[at].classList.add('insert-before')
        else items.at(-1)?.classList.add('insert-after')
      }
    },
    onDrop: () => {
      const where = target
      end()
      if (where) void dropTask(task, where.status, where.before)
      else if (renderLater) render(true)
    },
    onCancel: () => {
      end()
      if (renderLater) render(true)
    }
  })
}

function renderBoard(): HTMLElement {
  const groups = bySection(scoped())
  return h(
    'div',
    { class: 'board' },
    visibleSections().map((def) => {
      const id = def.id
      const list = groups[id] ?? []
      const limit = state.limits[id] ?? FIRST
      return h(
        'div',
        { class: 'column', 'data-section': id, 'data-drop-status': id },
        h('div', { class: 'column-head' }, h('span', { class: cx('dot', `c-${def.color}`) }), def.name, h('span', { class: 'count' }, String(list.length))),
        h(
          'div',
          { class: 'column-body' },
          list.length === 0 ? h('div', { class: 'hint', style: { padding: '4px 2px' } }, emptyText(def)) : list.slice(0, limit).map((task) => card(task)),
          list.length > limit ? h('button', { class: 'btn ghost sm', onclick: () => ((state.limits[id] = limit + MORE), render()) }, `Show ${Math.min(list.length - limit, MORE)} more`) : null
        )
      )
    })
  )
}

function card(task: Task): HTMLElement {
  const el = h(
    'div',
    {
      class: cx('card', isClosed(task) && 'done', state.selected === task.id && 'selected', state.cursor === task.id && 'cursor', state.picked.includes(task.id) && 'picked'),
      tabindex: '0',
      'data-id': task.id,
      title: 'Drag to another column, or to another place in this one. Cmd- or Shift-click to pick it for a merge',
      onclick: (e: MouseEvent) => (e.metaKey || e.ctrlKey || e.shiftKey ? togglePick(task) : select(task.id))
    },
    h('div', { class: 'card-top' }, tick(task), h('span', { class: 'card-title' }, task.title), statusButton(task)),
    chips(task, true),
    quickActions(task, QUICK_ROOM.card)
  )
  dragTask(el, task)
  return el
}

/** The sidebar's notes for agents: the CLI, a few commands, and where the data is. */
function forAgents(): HTMLElement {
  const where = state.paths
  const cli = where?.cli ?? 'orca-tasks'
  return h(
    'details',
    { class: 'agents' },
    h('summary', null, 'For agents'),
    h('div', { class: 'hint' }, 'Agents read and write this list from the shell. Command:'),
    h('code', null, cli),
    h(
      'pre',
      null,
      [
        'orca-tasks list --view today --json',
        'orca-tasks add "Reply to Alice" --due fri@15:30 \\',
        '  --source chat:msg_1 --dedupe --json',
        'orca-tasks done <id> --json',
        'orca-tasks hold <id> --on "Bob\'s review"',
        'orca-tasks edit <id> --state "In Progress"',
        'orca-tasks statuses --json',
        'orca-tasks send <id> --to Orca --type question \\',
        '  --note "Check progress" --chat last'
      ].join('\n')
    ),
    where ? h('div', { class: 'hint' }, 'Data') : null,
    where ? h('code', null, where.data) : null,
    where ? h('div', { class: 'hint' }, 'Inbox (append one line per task: - [ ] text !high @project #tag due:YYYY-MM-DD)') : null,
    where ? h('code', null, where.inbox) : null
  )
}

// ---- Details ----

function renderDetails(force: boolean): void {
  if (state.merge) {
    els.body.className = 'body with-details'
    const key = `merge|${JSON.stringify(state.merge)}|${state.tasks.length}`
    if (!force && key === state.detailsKey) return
    state.detailsKey = key
    mountInto(els.details, mergeBox(state.merge))
    return
  }
  const task = selectedTask()
  els.body.className = cx('body', task && 'with-details')
  if (!task) {
    state.detailsKey = ''
    mountInto(els.details)
    return
  }
  const key = `${task.id}|${task.updated_at}|${JSON.stringify(state.bots[task.id] ?? null)}|${JSON.stringify(state.workspaces[task.id] ?? null)}|${JSON.stringify(state.send)}|${JSON.stringify(state.toProject)}|${JSON.stringify(state.merge)}|${state.tasks.length}`
  // Leave the pane alone while the person types in it, unless the task itself changed.
  const typing = els.details.contains(document.activeElement) && document.activeElement !== els.details
  if (!force && (key === state.detailsKey || (typing && state.detailsKey.startsWith(`${task.id}|${task.updated_at}|`)))) return
  state.detailsKey = key
  mountInto(els.details, details(task))
}

function details(task: Task): HTMLElement {
  const def = currentStatus(task, state.statuses)
  const title = h('textarea', {
    class: 'pane-title',
    rows: '1',
    'aria-label': 'Title',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        ;(e.target as HTMLTextAreaElement).blur()
      }
    },
    onblur: (e: Event) => {
      const value = (e.target as HTMLTextAreaElement).value.replace(/\s+/g, ' ').trim()
      if (value && value !== task.title) void patch(task, { title: value })
    }
  })
  title.value = task.title
  requestAnimationFrame(() => {
    title.style.height = 'auto'
    title.style.height = `${title.scrollHeight}px`
  })
  return h(
    'div',
    { class: 'pane' },
    h(
      'div',
      { class: 'pane-head' },
      tick(task),
      title,
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Close details', title: 'Close (Esc)', onclick: () => select(null) }, icon('close'))
    ),
    h('div', { class: 'meta-line' }, h('span', { class: cx('dot', `c-${def.color}`) }), def.name, task.waiting_on ? `· waiting on ${task.waiting_on}` : null),
    fields(task),
    task.merged_into ? mergedNote(task) : null,
    notesBlock(task),
    botBlock(task),
    projectBlock(task),
    footer(task)
  )
}

function fields(task: Task): HTMLElement {
  const date = h('input', {
    class: 'input',
    type: 'date',
    'aria-label': 'Due day',
    value: task.due ?? '',
    onchange: (e: Event) => {
      const day = (e.target as HTMLInputElement).value || null
      void patch(task, { due: day, due_time: day ? task.due_time : null })
    }
  })
  const time = h('input', {
    class: 'input',
    type: 'time',
    'aria-label': 'Due time',
    value: task.due_time ?? '',
    disabled: !task.due,
    onchange: (e: Event) => void patch(task, { due_time: (e.target as HTMLInputElement).value || null })
  })
  const status = h(
    'select',
    { class: 'select', 'aria-label': 'Status', onchange: (e: Event) => void moveTo(task, (e.target as HTMLSelectElement).value) },
    state.statuses.map((s) => h('option', { value: s.id }, `${s.name}${s.closed ? ' (closed)' : ''}`))
  )
  status.value = currentStatus(task, state.statuses).id
  const priority = h(
    'select',
    { class: 'select', 'aria-label': 'Priority', onchange: (e: Event) => void patch(task, { priority: (e.target as HTMLSelectElement).value as Priority }) },
    PRIORITIES.map((p) => h('option', { value: p }, p === 'none' ? 'No priority' : p[0].toUpperCase() + p.slice(1)))
  )
  priority.value = task.priority
  const names = new Set<string>(state.orca.filter((p) => !p.hidden).map((p) => p.name))
  for (const t of state.tasks) if (t.project) names.add(t.project)
  const project = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Project',
      onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value
        void patch(task, { project: value === '' ? null : value })
      }
    },
    h('option', { value: '' }, 'No project'),
    [...names].sort((a, b) => Number(isOrca(b)) - Number(isOrca(a)) || a.localeCompare(b)).map((name) => h('option', { value: name }, isOrca(name) ? `◆ ${name}` : `@${name}`))
  )
  project.value = task.project ?? ''
  const tags = h('input', {
    class: 'input wide',
    'aria-label': 'Tags',
    placeholder: 'space separated',
    value: task.tags.map((t) => `#${t}`).join(' '),
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    },
    onblur: (e: Event) => {
      const next = (e.target as HTMLInputElement).value
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, ''))
        .filter((t) => t !== '')
      if (next.join(' ') !== task.tags.join(' ')) void patch(task, { tags: next })
    }
  })
  const hold = isClosed(task)
    ? null
    : task.held_at
      ? h('input', {
          class: 'input wide',
          'aria-label': 'Waiting on',
          placeholder: 'Who or what it waits on',
          value: task.waiting_on ?? '',
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          },
          onblur: (e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim()
            if (value !== (task.waiting_on ?? '')) void patch(task, { waiting_on: value })
          }
        })
      : null
  return h(
    'div',
    { class: 'fields' },
    h('span', { class: 'label' }, 'Status'),
    h('div', { class: 'field' }, status),
    h('span', { class: 'label' }, 'Due'),
    h(
      'div',
      { class: 'field' },
      date,
      time,
      task.due ? h('button', { class: 'btn ghost sm', onclick: () => void patch(task, { due: null, due_time: null }) }, 'Clear') : null,
      isOverdue(task, state.today, nowTime()) ? h('span', { class: 'chip overdue' }, 'overdue') : null
    ),
    h('span', { class: 'label' }, 'Priority'),
    h('div', { class: 'field' }, priority),
    h('span', { class: 'label' }, 'Project'),
    h(
      'div',
      { class: 'field' },
      project,
      task.project && isOrca(task.project)
        ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `Open ${task.project} in Orca`, title: 'Open in Orca', onclick: () => void act(() => request('tasks.openProject', { name: task.project ?? '' })) }, icon('external'))
        : null
    ),
    h('span', { class: 'label' }, 'Tags'),
    h('div', { class: 'field' }, tags),
    hold ? h('span', { class: 'label' }, 'Waiting on') : null,
    hold ? h('div', { class: 'field' }, hold) : null
  )
}

function notesBlock(task: Task): HTMLElement {
  const list = checklist(task.notes)
  const notes = h('textarea', {
    class: 'textarea',
    'aria-label': 'Notes',
    placeholder: 'Notes. A line like "- [ ] a step" becomes a checklist item. Saved when you leave the field (Cmd/Ctrl+Enter, Esc).',
    onblur: (e: Event) => {
      const value = (e.target as HTMLTextAreaElement).value
      if (value !== task.notes) void patch(task, { notes: value })
    }
  })
  notes.value = task.notes
  return h(
    'div',
    { class: 'block' },
    list.total > 0
      ? h(
          'div',
          { class: 'block' },
          h('div', { class: 'section-label' }, icon('checklist', 12), `Checklist ${list.done}/${list.total}`),
          h('div', { class: 'progress' }, h('div', { style: { width: `${Math.round((list.done / list.total) * 100)}%` } })),
          list.items.map((item) =>
            h(
              'label',
              { class: cx('check-item', item.done && 'on') },
              h('input', { type: 'checkbox', checked: item.done, onchange: (e: Event) => void patch(task, { notes: setChecklistItem(task.notes, item.line, (e.target as HTMLInputElement).checked) }) }),
              h('span', null, item.text)
            )
          )
        )
      : null,
    h('div', { class: 'section-label' }, 'Notes'),
    notes
  )
}

function botBlock(task: Task): HTMLElement | null {
  const handoff = task.handoffs.at(-1) ?? null
  const active = activeHandoff(task)
  const status = state.bots[task.id]
  const form = state.send?.taskId === task.id ? state.send : null
  const when = (iso: string) => `${dayLabel(localDay(new Date(iso)), state.today)} ${localTime(new Date(iso))}`
  if (!handoff && isClosed(task)) return null
  const history = handoff
    ? h(
        'div',
        { class: 'block' },
        h('div', { class: 'meta-line' }, icon('bot', 12), `${handoff.bot} · ${handoff.type === 'handoff' ? '' : `${handoff.type} · `}${handoff.chat === 'new' ? 'new chat' : handoff.chat === 'home' ? 'Home Chat' : 'earlier chat'} · sent ${when(handoff.sent_at)}${handoff.returned_at ? ` · taken back ${when(handoff.returned_at)}` : ''}`),
        active && status ? h('div', { class: 'meta-line' }, `Chat: ${status.state}`, status.error ? h('span', { title: status.error }, '(could not read it)') : null) : null,
        active && status?.reply ? h('div', { class: 'reply' }, status.reply) : null,
        handoff.chat_id ? h('div', { class: 'meta-line' }, 'chat', h('code', null, handoff.chat_id)) : null,
        task.handoffs.length > 1 ? h('div', { class: 'meta-line' }, `Sent ${task.handoffs.length} times: ${task.handoffs.map((x) => x.bot).join(', ')}`) : null,
        active
          ? h(
              'div',
              { class: 'field' },
              handoff.chat_id ? h('button', { class: 'btn sm', onclick: () => void act(() => request('tasks.botStatus', { id: task.id })) }, icon('refresh', 12), 'Check the bot') : null,
              h('button', { class: 'btn ghost sm', onclick: () => void act(() => request('tasks.takeBack', { id: task.id }), 'Taken back from the bot.') }, 'Take back')
            )
          : null
      )
    : null
  const sendForm = form ? sendBox(task, form) : null
  return h(
    'div',
    { class: 'block' },
    h('div', { class: 'section-label' }, icon('bot', 12), 'Bot'),
    history,
    sendForm,
    !form && !isClosed(task) ? h('div', null, h('button', { class: 'btn sm', onclick: () => void openSend(task) }, icon('bot', 12), active ? 'Send again…' : 'Send to a bot…')) : null
  )
}

/** A merged task: where it went. */
function mergedNote(task: Task): HTMLElement {
  const keeper = state.tasks.find((t) => t.id === task.merged_into)
  return h(
    'div',
    { class: 'notice', style: { margin: '0' } },
    icon('merge', 12),
    h('span', { style: { flex: '1' } }, keeper ? `Merged into "${keeper.title}".` : `Merged into ${task.merged_into}.`),
    keeper ? h('button', { class: 'btn sm', onclick: () => select(keeper.id) }, 'Show it') : null
  )
}

/** Sending the task to its project: a new workspace with a coding agent, and what it is doing. */
function projectBlock(task: Task): HTMLElement | null {
  const sent = lastWorkspace(task)
  const form = state.toProject?.taskId === task.id ? state.toProject : null
  if (!sent && (isClosed(task) || !task.project)) return null
  const when = (iso: string) => `${dayLabel(localDay(new Date(iso)), state.today)} ${localTime(new Date(iso))}`
  const status = state.workspaces[task.id]
  const history = sent
    ? h(
        'div',
        { class: 'block' },
        h('div', { class: 'meta-line' }, icon('branch', 12), `${sent.workspace_name} · ${sent.agent} · sent ${when(sent.sent_at)}`),
        !isClosed(task) ? h('div', { class: 'meta-line' }, `Agent: ${workspaceStatusWords(status)}`, status?.error ? h('span', { title: status.error }, '(could not read it)') : null) : null,
        (task.workspaces?.length ?? 0) > 1 ? h('div', { class: 'meta-line' }, `Sent to the project ${task.workspaces?.length} times`) : null,
        h(
          'div',
          { class: 'field' },
          status?.state !== 'gone' ? h('button', { class: 'btn sm', onclick: () => void act(() => request('tasks.openWorkspace', { id: task.id })) }, icon('external', 12), 'Open the workspace') : null,
          !isClosed(task) ? h('button', { class: 'btn ghost sm', onclick: () => void act(() => request('tasks.workspaceStatus', { id: task.id })) }, icon('refresh', 12), 'Check') : null
        )
      )
    : null
  return h(
    'div',
    { class: 'block' },
    h('div', { class: 'section-label' }, icon('branch', 12), 'Project workspace'),
    history,
    form ? projectBox(task, form) : null,
    !form && !isClosed(task) && task.project
      ? h('div', null, h('button', { class: 'btn sm', title: `Start a new workspace in ${task.project} with a coding agent working on this task`, onclick: () => void openToProject(task) }, icon('branch', 12), sent ? 'Send to the project again…' : 'Send to the project…'))
      : null
  )
}

function projectBox(task: Task, form: ProjectSendForm): HTMLElement {
  const offer = form.offer
  const change = (fields: Partial<ProjectSendForm>) => {
    Object.assign(form, fields)
    render(true)
  }
  const agent = h(
    'select',
    { class: 'select', 'aria-label': 'Agent', onchange: (e: Event) => change({ agent: (e.target as HTMLSelectElement).value as ProjectAgent }) },
    (offer?.agents ?? ['claude', 'codex']).map((a) => h('option', { value: a }, a === 'claude' ? 'Claude Code' : a === 'codex' ? 'Codex' : a))
  )
  agent.value = form.agent
  const then = h(
    'select',
    { class: 'select', 'aria-label': 'Then', onchange: (e: Event) => change({ state: (e.target as HTMLSelectElement).value }) },
    [['', 'Leave the status as it is'], ...state.statuses.filter((s) => !s.closed).map((s): [string, string] => [s.id, s.kind === 'hold' ? `Move to ${s.name}, waiting on the agent` : `Move to ${s.name}`])].map(([v, text]) => h('option', { value: v }, text))
  )
  then.value = form.state
  const note = h('input', {
    class: 'input wide',
    'aria-label': 'Instruction for the agent',
    placeholder: 'Instruction above the task (optional): write a test first…',
    value: form.note,
    oninput: (e: Event) => {
      form.note = (e.target as HTMLInputElement).value
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') void sendToProject()
    }
  })
  const ready = offer && offer.project && !offer.error && !offer.access
  return h(
    'div',
    { class: 'bot-box' },
    !offer && !form.error ? h('div', { class: 'hint' }, 'Looking up the project…') : null,
    ready
      ? h(
          'div',
          { class: 'fields' },
          h('span', { class: 'label' }, 'Project'),
          h('div', { class: 'field' }, h('span', null, `◆ ${offer.project}`)),
          h('span', { class: 'label' }, 'Agent'),
          h('div', { class: 'field' }, agent),
          h('span', { class: 'label' }, 'Then'),
          h('div', { class: 'field' }, then)
        )
      : null,
    ready ? note : null,
    ready ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: form.notes, onchange: (e: Event) => change({ notes: (e.target as HTMLInputElement).checked }) }), 'Include the notes') : null,
    ready ? h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: form.open, onchange: (e: Event) => change({ open: (e.target as HTMLInputElement).checked }) }), 'Show the workspace in Orca') : null,
    ready ? h('div', { class: 'hint' }, `A new workspace (a branch of ${offer.project}) starts with ${form.agent === 'codex' ? 'Codex' : 'Claude Code'}, whose first prompt is the task: the title, due, priority, tags, source${form.notes ? ', notes' : ''} and your instruction.`) : null,
    form.error ? h('div', { class: 'notice error', style: { margin: '0' } }, form.error) : null,
    h(
      'div',
      { class: 'field' },
      h('button', { class: 'btn primary sm', disabled: form.busy || !ready, onclick: () => void sendToProject() }, icon('branch', 12), form.busy ? 'Starting…' : `Send to ${offer?.project ?? 'the project'}`),
      h('button', { class: 'btn ghost sm', onclick: () => ((state.toProject = null), render(true)) }, 'Cancel')
    )
  )
}

/** The merge confirm step: which task to keep, and the due day, priority and created date it gets. */
function mergeBox(form: MergeForm): HTMLElement {
  const tasks = form.ids.map((id) => state.tasks.find((t) => t.id === id)).filter((t): t is Task => t !== undefined)
  const keeper = tasks.find((t) => t.id === form.keep) ?? tasks[0]
  const others = tasks.filter((t) => t.id !== keeper?.id)
  const change = (fields: Partial<MergeForm>) => {
    Object.assign(form, fields)
    render(true)
  }
  const select = (aria: string, value: string, options: [string, string][], onchange: (value: string) => void) => {
    const el = h('select', { class: 'select', 'aria-label': aria, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) }, options.map(([v, text]) => h('option', { value: v }, text)))
    el.value = value
    return el
  }
  const dueText = (due: { due: string; due_time: string | null } | null) => (due ? `${dayLabel(due.due, state.today)}${due.due_time ? ` ${due.due_time}` : ''}` : 'No due day')
  const defaults = keeper ? mergeDefaults(keeper, others) : null
  const dues = new Map<string, string>()
  for (const t of tasks) if (t.due) dues.set(dueKey({ due: t.due, due_time: t.due_time }), dueText({ due: t.due, due_time: t.due_time }))
  const addable = state.tasks
    .filter((t) => !form.ids.includes(t.id) && !t.merged_into)
    .sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || Number((b.project ?? '') === (keeper?.project ?? '')) - Number((a.project ?? '') === (keeper?.project ?? '')) || a.title.localeCompare(b.title))
  const add = h(
    'select',
    { class: 'select', 'aria-label': 'Add a task to merge', onchange: (e: Event) => {
        const id = (e.target as HTMLSelectElement).value
        if (id) change({ ids: [...form.ids, id] })
      } },
    h('option', { value: '' }, 'Add a task to merge…'),
    addable.slice(0, 200).map((t) => h('option', { value: t.id }, `${t.title}${t.project ? ` @${t.project}` : ''}${isClosed(t) ? ` (${t.state_name})` : ''}`))
  )
  add.value = ''
  return h(
    'div',
    { class: 'pane merge' },
    h('div', { class: 'pane-head' }, icon('merge', 14), h('strong', { style: { flex: '1' } }, `Merge ${tasks.length} tasks`), h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Close', onclick: () => ((state.merge = null), render(true)) }, icon('close'))),
    h('div', { class: 'hint' }, 'The kept task keeps its title and status, and gets the others\' notes (each under "Merged from …"), sources, tags and bot and workspace history. The others move to Cancelled and point to it.'),
    h(
      'div',
      { class: 'merge-list' },
      tasks.map((t) =>
        h(
          'label',
          { class: cx('check-line', t.id === keeper?.id && 'on') },
          h('input', { type: 'radio', name: 'merge-keep', checked: t.id === keeper?.id, onchange: () => change({ keep: t.id }) }),
          h('span', { style: { flex: '1' } }, t.title, h('span', { class: 'hint' }, ` ${t.id}${t.source ? ` · ${t.source}` : ''} · ${t.state_name}`)),
          tasks.length > 2 ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `Leave out ${t.title}`, onclick: (e: Event) => {
                e.preventDefault()
                const ids = form.ids.filter((id) => id !== t.id)
                change({ ids, keep: form.keep === t.id ? ids[0] : form.keep })
              } }, icon('close', 12)) : null
        )
      )
    ),
    add,
    h(
      'div',
      { class: 'fields' },
      h('span', { class: 'label' }, 'Due'),
      h('div', { class: 'field' }, select('Due', form.due, [['earliest', `Earliest: ${dueText(defaults?.due ?? earliestDue(tasks))}`], ['keep', `The kept task's: ${dueText(keeper?.due ? { due: keeper.due, due_time: keeper.due_time } : null)}`], ...[...dues.entries()], ['none', 'No due day']], (due) => change({ due }))),
      h('span', { class: 'label' }, 'Priority'),
      h('div', { class: 'field' }, select('Priority', form.priority, [['highest', `Highest: ${defaults?.priority ?? highestPriority(tasks)}`], ['keep', `The kept task's: ${keeper?.priority ?? 'none'}`], ...PRIORITIES.map((p): [string, string] => [p, p === 'none' ? 'No priority' : p[0].toUpperCase() + p.slice(1)])], (priority) => change({ priority: priority as PriorityChoice }))),
      h('span', { class: 'label' }, 'Created'),
      h('div', { class: 'field' }, select('Created', form.created, [['earliest', `Earliest: ${defaults ? dayLabel(localDay(new Date(defaults.created_at)), state.today) : ''}`], ['keep', "The kept task's"]], (created) => change({ created: created as CreatedChoice })))
    ),
    form.error ? h('div', { class: 'notice error', style: { margin: '0' } }, form.error) : null,
    h(
      'div',
      { class: 'field' },
      h('button', { class: 'btn primary sm', disabled: form.busy || others.length === 0, onclick: () => void merge() }, icon('merge', 12), form.busy ? 'Merging…' : `Merge into "${keeper?.title ?? ''}"`),
      h('button', { class: 'btn ghost sm', onclick: () => ((state.merge = null), render(true)) }, 'Cancel')
    )
  )
}

function sendBox(task: Task, form: SendForm): HTMLElement {
  const offer = form.offer
  const earlier = offer?.lastChat ?? lastChat(task)
  const label = (name: string) => (offer && name === offer.project ? `${name} (this project's bot)` : offer && name === offer.main ? `${name} (main bot)` : name)
  const select = (aria: string, value: string, options: [string, string, boolean?][], onchange: (value: string) => void) => {
    const el = h(
      'select',
      { class: 'select', 'aria-label': aria, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
      options.map(([v, text, disabled]) => h('option', { value: v, disabled: disabled === true }, text))
    )
    el.value = value
    return el
  }
  const change = (fields: Partial<SendForm>) => {
    Object.assign(form, fields)
    // A status message cannot start a new chat; "the chat it had before" needs one.
    form.chat = settleBotForm(form, Boolean(earlier)).chat
    render(true)
  }
  const botSelect = offer ? select('Bot', form.bot, offer.bots.map((b) => [b.name, label(b.name), b.paused]), (bot) => change({ bot })) : null
  const type = select(
    'Kind',
    form.type,
    [
      ['handoff', 'Handoff: the bot owns the job'],
      ['question', 'Question: just answer'],
      ['status', 'Status: for its information']
    ],
    (value) => change({ type: value as SendType })
  )
  const chats: [string, string][] = [
    ['home', "The bot's Home Chat"],
    ...(form.type === 'status' ? [] : [['new', 'A new chat of its own'] as [string, string]]),
    ...(earlier ? [['last', 'The chat it had before'] as [string, string]] : [])
  ]
  const chat = select('Chat', form.chat, chats, (value) => change({ chat: value === 'home' || value === 'last' ? value : 'new' }))
  const then = select(
    'Then',
    form.state,
    [['', 'Leave the status as it is'], ...state.statuses.filter((s) => !s.closed).map((s): [string, string] => [s.id, s.kind === 'hold' ? `Move to ${s.name}, waiting on ${form.bot || 'the bot'}` : `Move to ${s.name}`])],
    (value) => change({ state: value })
  )
  const note = h('input', {
    class: 'input wide',
    'aria-label': 'Instruction for the bot',
    placeholder: 'Instruction above the task (optional): check progress…',
    value: form.note,
    oninput: (e: Event) => {
      form.note = (e.target as HTMLInputElement).value
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') void send()
    }
  })
  const notes = h(
    'label',
    { class: 'check-line' },
    h('input', { type: 'checkbox', checked: form.notes, onchange: (e: Event) => change({ notes: (e.target as HTMLInputElement).checked }) }),
    'Include the notes'
  )
  const where = form.chat === 'new' ? 'in a new chat' : form.chat === 'home' ? 'in its Home Chat' : 'in the chat it had before'
  const what = form.type === 'question' ? 'is asked' : form.type === 'status' ? 'is told (no reply expected)' : 'gets the task'
  const after = form.state ? ` Then the task moves to ${statusOf(form.state)?.name ?? form.state}.` : ''
  const ready = offer && offer.bots.length > 0
  return h(
    'div',
    { class: 'bot-box' },
    !offer && !form.error ? h('div', { class: 'hint' }, 'Asking Orca for its bots…') : null,
    offer && offer.bots.length === 0 && !form.error ? h('div', { class: 'hint' }, 'No bots on this computer. Make one in Orca first.') : null,
    ready
      ? h(
          'div',
          { class: 'fields' },
          h('span', { class: 'label' }, 'Send to'),
          h('div', { class: 'field' }, botSelect),
          h('span', { class: 'label' }, 'As'),
          h('div', { class: 'field' }, type),
          h('span', { class: 'label' }, 'Chat'),
          h('div', { class: 'field' }, chat),
          h('span', { class: 'label' }, 'Then'),
          h('div', { class: 'field' }, then)
        )
      : null,
    ready ? note : null,
    ready ? notes : null,
    ready ? h('div', { class: 'hint' }, `${form.bot || 'The bot'} ${what} ${where}: the title, due, project, tags, source${form.notes ? ' and notes' : ''}.${after}`) : null,
    form.error ? h('div', { class: 'notice error', style: { margin: '0' } }, form.error) : null,
    h(
      'div',
      { class: 'field' },
      h('button', { class: 'btn primary sm', disabled: form.busy || !form.bot, onclick: () => void send() }, icon('bot', 12), form.busy ? 'Sending…' : form.bot ? `Send to ${form.bot}` : 'Send'),
      h(
        'button',
        {
          class: 'btn ghost sm',
          onclick: () => {
            state.send = null
            render(true)
          }
        },
        'Cancel'
      )
    )
  )
}

// ---- Statuses (settings) ----

/** Lets a status be dragged by its grip to another place in the order. */
function dragStatus(rowEl: HTMLElement, grip: HTMLElement, def: StatusDef, index: number): void {
  let ghost: ReturnType<typeof ghostOf> | null = null
  let to = index
  const clear = () => els.main.querySelectorAll('.insert-before, .insert-after').forEach((x) => x.classList.remove('insert-before', 'insert-after'))
  const end = () => {
    ghost?.remove()
    ghost = null
    clear()
    rowEl.classList.remove('dragging')
    document.body.classList.remove('dragging-task')
    dragActive = false
  }
  pointerDrag(grip, {
    canStart: () => true,
    onStart: (x, y) => {
      dragActive = true
      rowEl.classList.add('dragging')
      document.body.classList.add('dragging-task')
      ghost = ghostOf(rowEl, x, y)
    },
    onMove: (x, y) => {
      ghost?.move(x, y)
      clear()
      const rows = Array.from(els.main.querySelectorAll<HTMLElement>('.status-row'))
      const before = insertionIndex(
        y,
        rows.map((r) => r.getBoundingClientRect())
      )
      to = moveIndex(index, before)
      if (to === index) return
      if (rows[before]) rows[before].classList.add('insert-before')
      else rows.at(-1)?.classList.add('insert-after')
    },
    onDrop: () => {
      end()
      if (to !== index) {
        // Shown in the new order at once; the worker's answer confirms it.
        const list = state.statuses.filter((s) => s.id !== def.id)
        list.splice(to, 0, def)
        state.statuses = list
        render()
        void editStatuses({ op: 'move', id: def.id, index: to })
      } else if (renderLater) render()
    },
    onCancel: () => {
      end()
      if (renderLater) render()
    }
  })
}

function renderStatuses(): HTMLElement {
  const counts = bySection(state.tasks)
  const kindSelect = (value: StatusKind, aria: string, onchange: (kind: StatusKind) => void) => {
    const el = h(
      'select',
      { class: 'select', 'aria-label': aria, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value as StatusKind) },
      STATUS_KINDS.map((k) => h('option', { value: k }, KIND_LABELS[k]))
    )
    el.value = value
    return el
  }
  const colorSelect = (value: StatusColor, aria: string, onchange: (color: StatusColor) => void) => {
    const el = h(
      'select',
      { class: 'select', 'aria-label': aria, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value as StatusColor) },
      STATUS_COLORS.map((c) => h('option', { value: c }, c[0].toUpperCase() + c.slice(1)))
    )
    el.value = value
    return el
  }
  const rows = state.statuses.map((def, index) => {
    const name = h('input', {
      class: 'input',
      'aria-label': `Name of ${def.name}`,
      value: def.name,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          ;(e.target as HTMLInputElement).value = def.name
          ;(e.target as HTMLInputElement).blur()
        }
      },
      onblur: (e: Event) => {
        const value = (e.target as HTMLInputElement).value.trim()
        if (value && value !== def.name) void editStatuses({ op: 'update', id: def.id, name: value })
      }
    })
    const n = (counts[def.id] ?? []).length
    const others = state.statuses.filter((s) => s.id !== def.id)
    const moveTo = others.find((s) => s.kind === def.kind) ?? firstOfKind(others, 'open')
    const grip = h('span', { class: 'grip', title: 'Drag to put this status somewhere else in the order' }, icon('grip', 14))
    const rowEl = h(
      'div',
      { class: 'status-row', 'data-status-row': def.id },
      grip,
      h('span', { class: cx('dot', `c-${def.color}`) }),
      name,
      colorSelect(def.color, `Colour of ${def.name}`, (color) => void editStatuses({ op: 'update', id: def.id, color })),
      kindSelect(def.kind, `Kind of ${def.name}`, (kind) => void editStatuses({ op: 'update', id: def.id, kind })),
      h(
        'span',
        { class: 'actions' },
        h('span', { class: 'count', title: 'Tasks in it' }, String(n)),
        h('button', { class: 'btn ghost sm icon-only', 'aria-label': `Move ${def.name} up`, title: 'Move up', disabled: index === 0, onclick: () => void editStatuses({ op: 'move', id: def.id, index: index - 1 }) }, icon('chevronUp')),
        h('button', { class: 'btn ghost sm icon-only', 'aria-label': `Move ${def.name} down`, title: 'Move down', disabled: index === state.statuses.length - 1, onclick: () => void editStatuses({ op: 'move', id: def.id, index: index + 1 }) }, icon('chevron')),
        h(
          'button',
          {
            class: 'btn ghost sm icon-only danger',
            'aria-label': `Delete ${def.name}`,
            title: n ? `Delete; its ${n} task${n === 1 ? '' : 's'} move to ${moveTo?.name ?? 'another status'}` : 'Delete',
            onclick: () => void editStatuses({ op: 'remove', id: def.id })
          },
          icon('trash', 13)
        )
      )
    )
    dragStatus(rowEl, grip, def, index)
    return rowEl
  })
  const form = state.newStatus
  const add = () => {
    const name = form.name.trim()
    if (!name) return
    const firstClosed = state.statuses.findIndex((s) => s.closed)
    const index = form.kind === 'done' || form.kind === 'cancelled' || firstClosed === -1 ? state.statuses.length : firstClosed
    state.newStatus = { ...form, name: '' }
    void editStatuses({ op: 'add', name, kind: form.kind, color: form.color, index })
  }
  const newName = h('input', {
    class: 'input',
    'aria-label': 'New status',
    placeholder: 'New status: Review, Blocked…',
    value: form.name,
    oninput: (e: Event) => {
      form.name = (e.target as HTMLInputElement).value
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') add()
    }
  })
  return h(
    'div',
    { class: 'statuses' },
    h('h2', null, 'Statuses'),
    h('div', { class: 'hint' }, 'The sidebar sections and the board columns, in this order. Open statuses are work to do (an on-hold one waits on someone else and is never overdue); closed ones are done or cancelled. Agents see the same list: orca-tasks statuses.'),
    h('div', null, rows),
    h(
      'div',
      { class: 'status-add' },
      newName,
      colorSelect(form.color, 'Colour of the new status', (color) => (form.color = color)),
      kindSelect(form.kind, 'Kind of the new status', (kind) => (form.kind = kind)),
      h('button', { class: 'btn sm', onclick: add }, icon('plus', 12), 'Add')
    ),
    h('div', { class: 'hint' }, 'Deleting a status moves its tasks to the first other status of the same kind (else the first open one). At least one open, one on-hold and one done status stay.'),
    h(
      'div',
      null,
      h(
        'button',
        {
          class: 'btn sm',
          onclick: () => {
            state.settings = false
            render()
          }
        },
        'Back to the tasks'
      )
    )
  )
}

function footer(task: Task): HTMLElement {
  const source = task.source
  const sourceEl = source
    ? /^https?:\/\//.test(source)
      ? h(
          'a',
          {
            class: 'link',
            href: source,
            onclick: (e: Event) => {
              e.preventDefault()
              void orca.shell?.openExternal(source)
            }
          },
          source.length > 80 ? `${source.slice(0, 79)}…` : source
        )
      : h('code', null, source)
    : null
  return h(
    'div',
    { class: 'block' },
    sourceEl ? h('div', { class: 'meta-line' }, icon('link', 12), 'Source', sourceEl) : null,
    h('div', { class: 'meta-line' }, 'id', h('code', null, task.id), `added ${dayLabel(localDay(new Date(task.created_at)), state.today)}`, doneDay(task) ? `· ${task.done_at ? 'done' : 'closed'} ${dayLabel(doneDay(task) as string, state.today)}` : null),
    h(
      'div',
      { class: 'field' },
      isClosed(task)
        ? null
        : task.held_at
          ? h('button', { class: 'btn sm', onclick: () => void patch(task, { waiting_on: null }) }, icon('play', 12), 'Take off hold')
          : h('button', { class: 'btn sm', onclick: () => void patch(task, { waiting_on: '' }) }, icon('pause', 12), 'Put on hold'),
      task.merged_into ? null : h('button', { class: 'btn sm', title: 'Fold another task into this one, or this one into another', onclick: () => openMerge([...new Set([task.id, ...state.picked])], task.id) }, icon('merge', 12), 'Merge…'),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn ghost sm danger',
          onclick: () => {
            state.selected = null
            void act(() => request('tasks.delete', { id: task.id }), `Deleted "${task.title}".`)
          }
        },
        icon('trash', 12),
        'Delete'
      )
    )
  )
}

// ---- Keyboard ----
// The rules are in keys.ts; this applies them. Keys typed in a field are the field's, except Esc
// (leave it; a details field saves as it is left) and Cmd/Ctrl+Enter (save, or send a form).

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

function keyTarget(el: HTMLElement | null): KeyTarget {
  if (!el || el === document.body || el === document.documentElement) return 'page'
  if (typingIn(el)) return 'field'
  if (el.dataset.id && els.main.contains(el)) return 'task'
  if (el.closest('button, a, summary, label')) return 'button'
  return 'page'
}

function fieldPlace(el: HTMLElement): FieldPlace {
  if (el === els.quick || el === els.search) return 'box'
  if (el.closest('.bot-box')) return 'form'
  if (els.details.contains(el)) return 'details'
  return 'other'
}

// ---- Suggest merges ----

/** Asks the worker to run the agent over the open tasks (core/suggest.ts); it can take a minute. */
async function suggestMerges(): Promise<void> {
  if (state.suggest?.busy) return
  state.help = false
  state.suggest = { busy: true, error: null, result: null }
  render()
  try {
    const result = await request('tasks.suggestMerges', undefined, { timeoutMs: SUGGEST_WAIT_MS })
    // Closed while it ran: the answer is not shown.
    if (state.suggest) state.suggest = { busy: false, error: null, result }
  } catch (error) {
    if (state.suggest) state.suggest = { busy: false, error: message(error), result: null }
  }
  render()
}

/** The suggestions still to show: their tasks are still there and open (one merged since drops
 *  out), two or more to a group. */
function liveSuggestions(result: SuggestResult): MergeSuggestion[] {
  const open = new Set(state.tasks.filter((t) => !isClosed(t) && !t.merged_into).map((t) => t.id))
  return result.suggestions.map((s) => ({ ...s, ids: s.ids.filter((id) => open.has(id)) })).filter((s) => s.ids.length >= 2 && s.ids.includes(s.keep))
}

async function dismissMerge(suggestion: MergeSuggestion): Promise<void> {
  const current = state.suggest?.result
  if (!current) return
  try {
    await request('tasks.dismissMerge', { ids: suggestion.ids })
    // A task is in one group at most, so its keeper names it.
    current.suggestions = current.suggestions.filter((s) => s.keep !== suggestion.keep)
  } catch (error) {
    if (state.suggest) state.suggest.error = message(error)
  }
  render()
}

function suggestionsBox(suggest: NonNullable<typeof state.suggest>): HTMLElement {
  const title = (id: string) => state.tasks.find((t) => t.id === id)?.title ?? id
  const live = suggest.result ? liveSuggestions(suggest.result) : []
  const head = suggest.busy
    ? 'Asking Claude Code which open tasks look like duplicates… (up to 3 minutes)'
    : suggest.error
      ? 'No suggestions'
      : live.length === 0
        ? `No likely duplicates among ${suggest.result?.considered ?? 0} open tasks.`
        : `${live.length} likely duplicate${live.length === 1 ? '' : 's'}: review each before it merges.`
  return h(
    'div',
    { class: cx('notice suggestions', suggest.error && 'error'), role: 'region', 'aria-label': 'Merge suggestions' },
    h(
      'div',
      { style: { flex: '1', minWidth: '0' } },
      h('div', { class: 'section-label' }, icon('sparkles', 12), 'Merge suggestions'),
      h('div', null, head),
      suggest.error ? h('div', null, suggest.error) : null,
      live.length > 0
        ? h(
            'ol',
            { class: 'suggestion-list' },
            live.map((s) =>
              h(
                'li',
                { class: 'suggestion', 'data-keep': s.keep },
                h('div', { class: 'suggestion-title' }, h('strong', null, `Keep "${title(s.keep)}"`), h('span', { class: 'confidence', title: 'How sure the agent is' }, `${Math.round(s.confidence * 100)}%`)),
                s.ids.filter((id) => id !== s.keep).map((id) => h('div', { class: 'hint' }, `+ "${title(id)}"`)),
                h('div', { class: 'suggestion-reason' }, s.reason),
                h(
                  'div',
                  { class: 'suggestion-actions' },
                  h('button', { class: 'btn sm', title: 'Open the merge step with this filled in; nothing merges until you press Merge', onclick: () => openMerge(s.ids, s.keep) }, icon('merge', 12), 'Review merge…'),
                  h('button', { class: 'btn ghost sm', title: 'Do not suggest these again', onclick: () => void dismissMerge(s) }, 'Dismiss')
                )
              )
            )
          )
        : null,
      suggest.result && suggest.result.hidden > 0 ? h('div', { class: 'hint' }, `${suggest.result.hidden} dismissed before, not shown.`) : null,
      h('div', { class: 'hint' }, "Only the open tasks' title, notes, sources, tags, project, due day and status go to Claude Code (run on this computer, with no tools).")
    ),
    h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Close the suggestions', onclick: () => ((state.suggest = null), render()) }, icon('close'))
  )
}

function toggleHelp(): void {
  state.help = !state.help
  render()
}

function shortcutsBox(): HTMLElement {
  return h(
    'div',
    { class: 'notice shortcuts', role: 'region', 'aria-label': 'Keyboard shortcuts' },
    h(
      'div',
      { style: { flex: '1' } },
      h('div', { class: 'section-label' }, 'Keyboard shortcuts'),
      h('dl', null, shortcutList(SIDEBAR).flatMap(([keys, what]) => [h('dt', null, keys), h('dd', null, what)])),
      h('div', { class: 'hint' }, 'They work while the focus is in this panel, and not while you type in a field (except Esc and Cmd/Ctrl+Enter).')
    ),
    h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Close the shortcuts', onclick: () => toggleHelp() }, icon('close'))
  )
}

/** Focuses the row or card of the cursor's task and brings it into view. */
function showCursor(): void {
  const el = state.cursor ? els.main.querySelector<HTMLElement>(`[data-id="${CSS.escape(state.cursor)}"]`) : null
  if (!el) return
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest' })
}

function closeForms(): void {
  state.send = null
  state.toProject = null
  state.merge = null
  state.escArmed = false
  if (state.notice?.draft) state.notice = null
  render(true)
}

function hasDraft(): boolean {
  return Boolean(state.send?.note.trim() || state.toProject?.note.trim())
}

/** What is open, for the keys and the mouse's back button. */
function keyScreen(): KeyScreen {
  return {
    sidebar: SIDEBAR,
    menu: closeMenu !== null,
    help: state.help,
    form: state.merge ? 'merge' : state.send ? 'send' : state.toProject ? 'project' : null,
    suggestions: state.suggest !== null,
    draft: hasDraft(),
    armed: state.escArmed,
    details: selectedTask() !== null,
    settings: state.settings,
    picked: state.picked.length > 0
  }
}

// ---- Back and forward (the mouse's thumb buttons, Browser Back / Forward) ----

/** The views shown before and after this one, kept by the page (not the frame's history). */
const viewHistory = new ViewHistory()

function shownView(): View {
  return { view: state.view, filter: state.filter, project: state.project, selected: selectedTask()?.id ?? null }
}

/** Shows a view from the history: its list or board, filter and project, and its open task when
 *  that is still there. */
function showView(view: View): void {
  state.view = view.view === 'board' && !SIDEBAR ? 'board' : 'list'
  state.filter = DUE_FILTERS.some((f) => f.id === view.filter) ? (view.filter as DueFilter) : 'all'
  state.project = view.project
  state.settings = false
  persist()
  select(view.selected && state.tasks.some((t) => t.id === view.selected) ? view.selected : null)
}

/** Back: what Esc would close (the menu, the shortcuts, a form, the details, Statuses, the picked
 *  tasks), else the view before. */
function goBack(): void {
  const action = backAction(keyScreen(), viewHistory.canGoBack())
  if (action === 'close-details') viewHistory.closedTask()
  if (action === 'view-back') {
    const view = viewHistory.back()
    if (view) showView(view)
    return
  }
  if (action !== 'back') run(action)
}

/** Forward: the view (or the task) Back left. */
function goForward(): void {
  if (forwardAction(keyScreen(), viewHistory.canGoForward()) !== 'view-forward') return
  const view = viewHistory.forward()
  if (view) showView(view)
}

function run(action: KeyAction): void {
  switch (action) {
    case 'close-menu':
      closeMenu?.()
      break
    case 'close-help':
      toggleHelp()
      break
    case 'warn-draft':
      state.escArmed = true
      state.notice = { text: 'The instruction you typed has not been sent. Press Esc (or the mouse back button) again to discard it and close the form, or Send.', error: false, draft: true }
      render()
      break
    case 'close-form':
      closeForms()
      break
    case 'close-suggestions':
      state.suggest = null
      render()
      break
    case 'close-details': {
      const id = state.selected
      select(null)
      state.cursor = id
      render()
      showCursor()
      break
    }
    case 'close-settings':
      state.settings = false
      render()
      break
    case 'clear-picked':
      state.picked = []
      render()
      break
    case 'next':
    case 'previous': {
      const order = shownOrder().map((t) => t.id)
      const to = moveCursor(order, state.cursor ?? state.selected, action === 'next' ? 1 : -1)
      if (!to) break
      // The open details follow, unless a form is open there (it would be lost).
      if (state.selected && !state.send && !state.toProject && !state.merge) select(to)
      else {
        state.cursor = to
        render()
      }
      showCursor()
      break
    }
    case 'open':
      if (state.cursor && state.tasks.some((t) => t.id === state.cursor)) select(state.cursor)
      break
    case 'toggle-done': {
      const task = state.tasks.find((t) => t.id === state.cursor) ?? selectedTask()
      if (task) void setDone(task, !isClosed(task))
      break
    }
    case 'pending':
    case 'cancel': {
      const task = state.tasks.find((t) => t.id === state.cursor) ?? selectedTask()
      if (!task) break
      const to = statusKeyTarget(state.statuses, currentStatus(task, state.statuses).id, action === 'pending' ? 'hold' : 'cancelled')
      if (to) void moveTo(task, to.id)
      else {
        state.notice = { text: action === 'pending' ? 'You have no on-hold status to move it to.' : 'You have no cancelled status to move it to. Add one in Statuses.', error: false }
        render()
      }
      break
    }
    case 'quick-add':
      els.quick.focus()
      break
    case 'search':
      els.search.focus()
      break
    case 'toggle-view':
      setView(state.view === 'list' ? 'board' : 'list')
      break
    case 'help':
      toggleHelp()
      break
    case 'submit':
      if (state.send) void send()
      else if (state.toProject) void sendToProject()
      break
    case 'back':
      goBack()
      break
    case 'forward':
      goForward()
      break
    case 'view-back':
    case 'view-forward':
    case 'save':
    case 'none':
      break
  }
}

// The mouse's back and forward buttons (button 3 and 4: an MX Master's thumb buttons). Every event
// of those buttons is stopped, so the browser never takes them as "go back" in this frame (or in
// Orca's window); the step is taken when the button is released.
for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) {
  window.addEventListener(
    type,
    (e: MouseEvent) => {
      const { prevent, step } = mouseNav(type, e.button)
      if (!prevent) return
      e.preventDefault()
      e.stopPropagation()
      if (!step) return
      // Leave a field first, as Esc does: a details field saves as it is left.
      const el = document.activeElement as HTMLElement | null
      if (keyTarget(el) === 'field') el?.blur()
      if (step === 'back') goBack()
      else goForward()
    },
    true
  )
}

document.addEventListener('keydown', (e) => {
  if (e.isComposing) return
  const el = document.activeElement as HTMLElement | null
  const target = keyTarget(el)
  // A focused row or card is where the keys act.
  if (target === 'task' && el?.dataset.id) state.cursor = el.dataset.id
  else if (target === 'button') {
    const holder = el?.closest<HTMLElement>('[data-id]')
    if (holder?.dataset.id && els.main.contains(holder)) state.cursor = holder.dataset.id
  }
  if (e.key !== 'Escape') state.escArmed = false
  const { leave, action } = keyAction(
    { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, target, field: target === 'field' && el ? fieldPlace(el) : undefined },
    keyScreen()
  )
  if (!leave && action === 'none') return
  e.preventDefault()
  // Leaving a details field saves it (its blur handler), before anything closes.
  if (leave) el?.blur()
  run(action)
})

// ---- Start ----

orca.plugin.on('tasks.changed', () => void load())
void restore()
if (SIDEBAR) {
  request('tasks.paths').then(
    (paths) => {
      state.paths = paths
      render()
    },
    () => undefined
  )
}
// Orca waits for an editor to ask for its document; the board does not use it.
void orca.document?.get().catch(() => undefined)
// Overdue and "due today" depend on the clock, not only on the list.
setInterval(() => render(), 60_000)
render()
void load()
loadProjects()
