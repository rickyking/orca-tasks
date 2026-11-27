// A stand-in for the plugin's worker inside a plain browser page, for board.browser.test.ts: it
// defines `window.orca` with demo tasks and answers the board's requests with the same core code
// the worker uses (no files, no Orca). Every request is recorded in `window.__calls`.

import { mergeTasks } from '../../core/merge.ts'
import { dropOrder } from '../../core/sections.ts'
import { jsonProblem } from '../../core/send-input.ts'
import { applyStatusOp, DEFAULT_STATUSES, type StatusOp } from '../../core/statuses.ts'
import { makeTask, patchTask, restateTask } from '../../core/tasks.ts'
import type { StatusDef, Task, TaskPatch } from '../../core/types.ts'
import { DEMO_NOW, DEMO_PROJECTS, DEMO_TODAY, demoData } from './demo-data.ts'

// `?demo`: the made-up task list of demo-data.ts, for screenshots, with the clock stopped at
// DEMO_NOW so due chips and overdue times read the same on every run.
const DEMO = new URLSearchParams(location.search).has('demo')
if (DEMO) {
  const RealDate = Date
  const fixed = DEMO_NOW.getTime()
  class DemoDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed)
      else super(...(args as [string]))
    }
    static now(): number {
      return fixed
    }
  }
  ;(globalThis as unknown as { Date: DateConstructor }).Date = DemoDate as unknown as DateConstructor
}

// Each page load starts from the defaults.
try {
  localStorage.clear()
} catch {
  // No storage: nothing to clear.
}

const now = new Date(2026, 10, 24, 10)
let statuses: StatusDef[] = DEFAULT_STATUSES.map((s) => ({ ...s }))
const make = (id: string, title: string, fields: Record<string, unknown> = {}, patch: TaskPatch = {}): Task =>
  patchTask(makeTask({ title, ...fields }, id, now, statuses), patch, now, [], statuses)
const demo = DEMO ? demoData(statuses) : null
const tasks: Task[] = demo ? demo.tasks : [
  make('t-alice', 'Reply to Alice', { due: '2026-11-24' }),
  make('t-memo', 'Send the board memo', { due: '2026-11-25', priority: 'high' }),
  make('t-plan', 'Review the Q4 plan', { due: '2026-11-26', project: 'planning' }),
  make('t-layers', 'Load the sample data', {}, { state: 'in-progress' }),
  make('t-pack', 'Finalize the release notes', {}, { waiting_on: 'Bob' }),
  make('t-notes', 'Standup notes', {}, { done_at: now.toISOString() })
]
/** The Orca projects outside the demo: two Git projects and a folder one (no workspaces there). */
const PROJECTS = [
  { name: 'planning', id: 'p-planning', kind: 'git', path: '/h/planning', hostId: 'local', hidden: false },
  { name: 'website', id: 'p-website', kind: 'git', path: '/h/website', hostId: 'local', hidden: false },
  { name: 'notes', id: 'p-notes', kind: 'folder', path: '/h/notes', hostId: 'local', hidden: false }
]
const calls: { name: string; input: unknown }[] = []
const listeners = new Map<string, ((payload: unknown) => void)[]>()
const uiState: Record<string, Record<string, unknown>> = {}

function find(id: string): number {
  const at = tasks.findIndex((t) => t.id === id)
  if (at === -1) throw new Error(`no task ${id}`)
  return at
}

function changed(): void {
  setTimeout(() => (listeners.get('tasks.changed') ?? []).forEach((fn) => fn({ revision: 1, today: '2026-11-24' })), 0)
}

const handlers: Record<string, (input: never) => unknown> = {
  'tasks.list': () => ({ tasks: tasks.map((t) => ({ ...t })), revision: 1, today: DEMO ? DEMO_TODAY : '2026-11-24', bots: demo?.bots ?? {}, workspaces: demo?.workspaces ?? {}, statuses }),
  'tasks.projects': () => ({ orca: DEMO ? DEMO_PROJECTS : PROJECTS, summary: [] }),
  'tasks.paths': () => ({ home: '/h', data: '/h/tasks.json', inbox: '/h/inbox.md', cli: '/h/bin/orca-tasks' }),
  'tasks.uiState': (input: { surface: string; set?: Record<string, unknown> }) => {
    if (input.set) uiState[input.surface] = input.set
    return { state: uiState[input.surface] ?? null }
  },
  'tasks.update': (input: { id: string; patch: TaskPatch }) => {
    const at = find(input.id)
    tasks[at] = patchTask(tasks[at], input.patch, now, [], statuses)
    changed()
    return { task: tasks[at] }
  },
  'tasks.setDone': (input: { id: string; done: boolean }) => {
    const at = find(input.id)
    tasks[at] = patchTask(tasks[at], { done_at: input.done ? now.toISOString() : null }, now, [], statuses)
    changed()
    return { task: tasks[at] }
  },
  // What TaskStore.move does, without the file.
  'tasks.move': (input: { id: string; state: string | null; order: string[] }) => {
    const at = find(input.id)
    if (input.state && input.state !== tasks[at].state) tasks[at] = patchTask(tasks[at], { state: input.state }, now, [], statuses)
    const target = tasks[at].state
    input.order.forEach((id, i) => {
      const k = tasks.findIndex((t) => t.id === id)
      if (k !== -1 && tasks[k].state === target) tasks[k] = { ...tasks[k], rank: i + 1 }
    })
    changed()
    return { task: tasks[at] }
  },
  'tasks.statuses': (op: StatusOp) => {
    const change = applyStatusOp(statuses, op)
    statuses = change.statuses
    tasks.forEach((t, i) => (tasks[i] = restateTask(t, statuses, change.moves, now)))
    changed()
    return { statuses }
  },
  'tasks.bots': (input: { id: string }) => {
    const task = tasks[find(input.id)]
    const earlier = [...task.handoffs].reverse().find((x) => x.chat_id)?.chat_id ?? null
    if (DEMO) {
      const bot = (name: string, specialty: string) => ({ name, id: `b-${name}`, agent: 'claude', specialty, paused: false })
      const project = task.project === 'online-store' || task.project === 'docs-site' ? task.project : null
      const all = [bot('online-store', 'Keeps the online store running.'), bot('Orca', ''), bot('docs-site', 'Writes and checks the docs.')]
      return { bots: all, project, main: 'Orca', default: project ?? 'Orca', unreachable: [], error: null, lastChat: earlier, last: null }
    }
    return { bots: [{ name: 'Orca', id: 'b1', agent: 'claude', specialty: '', paused: false }], project: null, main: 'Orca', default: 'Orca', unreachable: [], error: null, lastChat: earlier, last: null }
  },
  // Records the send on the task, as the worker does once orca-tasks send has run.
  'tasks.send': (input: { id: string; bot: string; type: 'handoff' | 'question' | 'status'; chat: 'new' | 'home' | 'last'; state: string | null }) => {
    const at = find(input.id)
    const handoff = { bot: input.bot, bot_id: 'b1', type: input.type, chat: input.chat === 'last' ? ('existing' as const) : input.chat, chat_id: '0bb66c0f-54fa-442a-bc6a-7bba13627dc0', message_id: 'm', subject: tasks[at].title, sent_at: now.toISOString(), by: 'panel' as const, returned_at: null }
    tasks[at] = { ...tasks[at], handoffs: [...tasks[at].handoffs, handoff] }
    if (input.state) tasks[at] = patchTask(tasks[at], { state: input.state }, now, [], statuses)
    changed()
    return { task: tasks[at], handoff }
  },
  'tasks.projectOffer': (input: { id: string; project?: string }) => ({ project: input.project ?? 'planning', error: null, access: null, agents: ['claude', 'codex'], last: null }),
  // Records the workspace on the task, as the worker does once Orca has started it.
  'tasks.sendToProject': (input: { id: string; agent: 'claude' | 'codex'; state: string | null; project?: string }) => {
    const at = find(input.id)
    const project = input.project ?? tasks[at].project ?? 'planning'
    const workspace = { project, project_id: `p-${project}`, workspace_id: `w-${input.id}`, workspace_name: `${input.id}-ws`, terminal_id: null, agent: input.agent, sent_at: now.toISOString(), by: 'board' as const }
    tasks[at] = { ...tasks[at], workspaces: [...(tasks[at].workspaces ?? []), workspace] }
    if (input.state) tasks[at] = patchTask(tasks[at], { state: input.state }, now, [], statuses)
    changed()
    return { task: tasks[at], workspace }
  },
  'tasks.merge': (input: { keep: string; ids: string[]; priority?: string }) => {
    const plan = mergeTasks(tasks[find(input.keep)], input.ids.map((id) => tasks[find(id)]), { priority: input.priority as never }, now, statuses)
    for (const t of [plan.keeper, ...plan.merged]) tasks[find(t.id)] = t
    changed()
    return plan
  },
  // As the worker answers once Claude Code has read the open tasks; `window.__suggestMode =
  // 'missing'` answers as when Claude Code is not installed.
  'tasks.suggestMerges': async () => {
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (w.__suggestMode === 'missing') throw Object.assign(new Error('Claude Code (the claude command) was not found. Install Claude Code (npm install -g @anthropic-ai/claude-code), sign in once with `claude`, and try again.'), { code: 'unavailable' })
    return {
      suggestions: [
        { ids: ['t-memo', 't-plan'], keep: 't-memo', reason: 'Both are about sending the board the Q4 memo', confidence: 0.88 },
        { ids: ['t-alice', 't-pack'], keep: 't-alice', reason: 'Both wait on the same reply', confidence: 0.6 }
      ],
      considered: 5,
      leftOut: 0,
      hidden: 0,
      agent: 'Claude Code'
    }
  },
  'tasks.dismissMerge': () => ({ dismissed: true }),
  'tasks.openBoard': () => ({ opened: false, reason: 'test' }),
  'tasks.navLog': () => ({ logged: true })
}

const w = window as unknown as Record<string, unknown>
w.__calls = calls
w.__tasks = tasks
w.__dropOrder = dropOrder
w.orca = {
  plugin: {
    request: async (name: string, input?: unknown) => {
      // As Orca does: `plugin.request` takes only JSON (z.json()), and says so as "input: Invalid input".
      if (input !== undefined && jsonProblem(input)) throw Object.assign(new Error('input: Invalid input'), { code: 'invalid_params' })
      calls.push({ name, input })
      const handler = handlers[name]
      if (!handler) throw new Error(`no stub for ${name}`)
      return handler(input as never)
    },
    on: (event: string, fn: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return { dispose: () => undefined }
    }
  },
  storage: undefined,
  shell: { openExternal: async () => ({ opened: true }) }
}
