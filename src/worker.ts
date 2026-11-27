// The plugin's worker. Orca runs it in Node for as long as the plugin is enabled (it has a status
// bar item). It is the panel's only way to the task file, and it:
// - answers the panel's requests by reading and writing ~/.orca-tasks/tasks.json through the
//   same locked store the CLI uses;
// - watches that file, so a change an agent makes shows in open panels within a second or two;
// - takes in lines appended to ~/.orca-tasks/inbox.md (and, when the setting is on, Simple
//   Todo's ~/.simple-todo/inbox.md);
// - keeps the status bar count (open · high · overdue);
// - sends due reminders as Orca notifications;
// - sends a task to an Orca bot when the person presses Send, and keeps up with that bot's chat;
// - sends a task to its project (a new Orca workspace with a coding agent) when the person presses
//   Send to project, and keeps up with that workspace's agent status;
// - merges duplicate tasks when the person confirms a merge, and undoes the latest one;
// - installs the `orca-tasks` CLI for agents at ~/.orca-tasks/bin/orca-tasks.
import type { OrcaWorkerApi } from 'orca/worker'
import { watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLine } from './core/line.ts'
import { addDays, localDay, localTime, remindInstant } from './core/dates.ts'
import { defaultHome, TaskStore } from './core/store.ts'
import { activeHandoff, filterTasks, isClosed, isOverdue, lastChat, lastWorkspace, viewCounts } from './core/tasks.ts'
import { PROJECT_AGENTS, SEND_TYPES, type Handoff, type NewTask, type ProjectSend, type Task } from './core/types.ts'
import { botSendArgs, checkBotSend, checkProjectSend, initialChat, rememberedChat, SendFieldError } from './core/send-input.ts'
import { projectPrompt, projectTarget, workspaceName, workspaceStatus, type WorkspaceStatus } from './core/project-send.ts'
import type { MergeChoices } from './core/merge.ts'
import { agentFromEnv, dismissSuggestion, SuggestError, suggestMerges, type SuggestResult } from './core/suggest.ts'
import { botChatStatus, botChoices, defaultBot, defaultRunOrca, findHandoffChat, listBotChats, listBots, type BotChat, type BotStatus, type RunOrca } from './core/bots.ts'
import { fromHostApi, matchOrcaProject, summarizeProjects, type OrcaProject } from './core/projects.ts'
import { writeProjectsCache } from './core/orca-projects.ts'
import { checkNavLog, NAV_LOG_PER_MINUTE, navLine, navStartLine } from './core/nav-log.ts'
import type { BotOffer, ProjectOffer, ProjectPrefs, SendPrefs, TaskPaths } from './protocol.ts'

export const VERSION = '0.6.5'
const TICK_MS = 2_000
const STATUS_ITEM = 'today'
const SIMPLE_TODO_SETTING = 'takeSimpleTodoInbox'
/** How often Orca's project list is asked for again (it also is when the panel asks). */
const PROJECTS_MS = 60_000
/** How often the chats of tasks with a bot are read again. */
const BOTS_MS = 60_000
/** At most this many chats are read per round. */
const BOTS_PER_ROUND = 12
const REMINDERS_SETTING = 'dueReminders'
const REMINDER_TIME_SETTING = 'reminderTime'
/** Where the worker keeps which reminders it sent, so a restart does not send them again. */
const REMINDERS_FILE = 'reminders.json'
/** Where the worker keeps the send form's last choices, per project. */
const SEND_PREFS_FILE = 'send-prefs.json'
/** Where the worker keeps what the sidebar and the board were showing. */
const UI_STATE_FILE = 'ui-state.json'
/** A reminder more than this late (the computer slept, Orca was closed) is dropped, not sent. */
const REMINDER_LATE_MS = 12 * 3_600_000
/** How long Send waits for `orca-tasks send` in its terminal, and how often it looks. */
const SEND_TIMEOUT_MS = 60_000
const SEND_POLL_MS = 400
/** The board file the Board button looks for at the top of a workspace; its content is unused. */
export const BOARD_FILE = 'Agent Tasks.agenttasks'

/** The CLI's own files, copied beside the data so the installed command keeps working when the
 *  plugin's folder moves on an update. Paths are relative to this file's folder. */
const CLI_FILES = ['cli-bin.ts', 'cli.ts', 'core/bots.ts', 'core/checklist.ts', 'core/dates.ts', 'core/line.ts', 'core/merge.ts', 'core/orca-projects.ts', 'core/project-send.ts', 'core/projects.ts', 'core/statuses.ts', 'core/store.ts', 'core/suggest.ts', 'core/tasks.ts', 'core/types.ts', 'core/workspace-cli.ts']

/** The capabilities sending a task to its project needs, as the manifest names them. */
export const PROJECT_SEND_CAPABILITIES = ['workspace:create', 'agent:launch'] as const

export interface WorkerOptions {
  /** Where tasks.json lives; default ~/.orca-tasks. */
  home?: string
  now?: () => Date
  /** Poll and watch the file (off in tests, which call the handlers directly). */
  timers?: boolean
  /** Copy the CLI into `<home>/bin` when the worker starts. */
  installCli?: boolean
  /** Simple Todo's inbox; default ~/.simple-todo/inbox.md. */
  simpleTodoInbox?: string
  /** Runs Orca's CLI (`orca bot list`, `orca orchestration send`...); default the real one. */
  runOrca?: RunOrca
  /** The agent Suggest merges runs (tests: a stand-in); default Claude Code. */
  suggestAgent?: { command?: string; timeoutMs?: number; env?: Record<string, string | undefined> }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Copies the CLI next to the data and writes `<home>/bin/orca-tasks`; answers its path. */
export async function installCli(home: string, sourceDir: string): Promise<string> {
  const libDir = join(home, 'cli', VERSION)
  for (const file of CLI_FILES) {
    const target = join(libDir, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(join(sourceDir, file), 'utf8'), 'utf8')
  }
  await writeFile(join(libDir, 'package.json'), `${JSON.stringify({ type: 'module', private: true, version: VERSION }, null, 2)}\n`, 'utf8')
  const binDir = join(home, 'bin')
  await mkdir(binDir, { recursive: true })
  const bin = join(binDir, 'orca-tasks')
  const script = [
    '#!/bin/sh',
    `# Installed by the Agent Tasks plugin ${VERSION}; rewritten each time the plugin starts.`,
    '# Needs Node 22.18 or newer on PATH. Run `orca-tasks help` for usage.',
    `exec node --disable-warning=ExperimentalWarning ${shellQuote(join(libDir, 'cli-bin.ts'))} "$@"`,
    ''
  ].join('\n')
  await writeFile(bin, script, { encoding: 'utf8', mode: 0o755 })
  await chmod(bin, 0o755)
  return bin
}

function summary(tasks: readonly Task[], today: string, time: string): string {
  const open = filterTasks(tasks, { statuses: ['open'], dueTo: today }, today, time)
  const held = filterTasks(tasks, { statuses: ['hold'] }, today).length
  const onHold = held ? `\n${held} on hold.` : ''
  if (open.length === 0) return `Nothing due today.${onHold}`
  const lines = open.map((task) => `${isOverdue(task, today, time) ? `overdue ${task.due}${task.due_time ? ` ${task.due_time}` : ''}: ` : task.due_time ? `${task.due_time} ` : ''}${task.title}${task.priority !== 'none' ? ` !${task.priority}` : ''}`)
  return `${open.length} due today:\n${lines.join('\n')}${onHold}`
}

/** The status bar text: `5 open · 2 high · 1 overdue`, leaving out what is zero. */
export function statusText(counts: { open: number; high: number; overdue: number }): string {
  const parts = [`${counts.open} open`]
  if (counts.high) parts.push(`${counts.high} high`)
  if (counts.overdue) parts.push(`${counts.overdue} overdue`)
  return parts.join(' · ')
}

interface ReminderState {
  /** Task id -> the due (`day` or `day@HH:MM`) it was reminded for, so a new due reminds again. */
  sent: Record<string, string>
}

function reminderKey(task: Task): string {
  return `${task.due}${task.due_time ? `@${task.due_time}` : ''}`
}

/** The due line of a reminder: "Today 15:30", "Overdue since 2026-11-20". */
function dueWords(task: Task, today: string): string {
  if (!task.due) return ''
  const day = task.due === today ? 'Today' : task.due < today ? `Since ${task.due}` : task.due
  return `${day}${task.due_time ? ` ${task.due_time}` : ''}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The key a project's send choices are kept under: its name, or "" for tasks without one. */
function prefsKey(project: string | null): string {
  return project ?? ''
}

/** The send choices kept for each project, or none when the file is missing or unreadable. */
async function readSendPrefs(home: string): Promise<Record<string, SendPrefs>> {
  try {
    const raw = JSON.parse(await readFile(join(home, SEND_PREFS_FILE), 'utf8')) as { projects?: unknown }
    const projects = raw && typeof raw.projects === 'object' && raw.projects !== null ? (raw.projects as Record<string, unknown>) : {}
    const out: Record<string, SendPrefs> = {}
    for (const [key, value] of Object.entries(projects)) {
      const p = value as Partial<SendPrefs> | null
      if (!p || typeof p.bot !== 'string') continue
      out[key] = {
        bot: p.bot,
        type: (SEND_TYPES as readonly unknown[]).includes(p.type) ? (p.type as SendPrefs['type']) : 'handoff',
        chat: rememberedChat(p),
        notes: p.notes !== false,
        state: typeof p.state === 'string' && p.state !== '' ? p.state : null,
        keepState: p.keepState === true,
        chatChosen: p.chatChosen === true
      }
    }
    return out
  } catch {
    return {}
  }
}

async function readPrefsFile(home: string): Promise<{ projects?: Record<string, unknown>; toProject?: Record<string, unknown> }> {
  try {
    const raw = JSON.parse(await readFile(join(home, SEND_PREFS_FILE), 'utf8')) as Record<string, unknown>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

async function writeSendPrefs(home: string, key: string, prefs: SendPrefs): Promise<void> {
  const all = await readSendPrefs(home)
  all[key] = prefs
  const file = await readPrefsFile(home)
  await writeFile(join(home, SEND_PREFS_FILE), `${JSON.stringify({ ...file, projects: all }, null, 2)}\n`, 'utf8')
}

/** What the send-to-project form chose last time, per project. */
async function readProjectPrefs(home: string): Promise<Record<string, ProjectPrefs>> {
  const raw = (await readPrefsFile(home)).toProject
  const out: Record<string, ProjectPrefs> = {}
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const p = value as Partial<ProjectPrefs> | null
    if (!p || typeof p !== 'object') continue
    out[key] = {
      agent: (PROJECT_AGENTS as readonly unknown[]).includes(p.agent) ? (p.agent as ProjectPrefs['agent']) : 'claude',
      notes: p.notes !== false,
      state: typeof p.state === 'string' && p.state !== '' ? p.state : null,
      keepState: p.keepState === true,
      open: p.open === true
    }
  }
  return out
}

async function writeProjectPrefs(home: string, key: string, prefs: ProjectPrefs): Promise<void> {
  const file = await readPrefsFile(home)
  const all = await readProjectPrefs(home)
  all[key] = prefs
  await writeFile(join(home, SEND_PREFS_FILE), `${JSON.stringify({ ...file, toProject: all }, null, 2)}\n`, 'utf8')
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

/** The error code a host call rejected with, or ''. */
function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
}

export function createWorker(options: WorkerOptions = {}) {
  let stop: (() => void) | undefined
  let runTick: (() => Promise<void>) | undefined

  async function activate(orca: OrcaWorkerApi): Promise<void> {
    const home = options.home ?? defaultHome()
    const now = options.now ?? (() => new Date())
    let orcaProjects: OrcaProject[] = []
    let projectsAt = 0
    const store = new TaskStore({ home, now, orcaProjects: () => orcaProjects })

    /** Asks Orca for the person's projects, and keeps them where the CLI reads them. */
    async function refreshProjects(force = false): Promise<void> {
      if (!force && Date.now() - projectsAt < PROJECTS_MS) return
      if (!orca.host.has('project.list')) return
      projectsAt = Date.now()
      const answer = await orca.host.call('project.list', {})
      orcaProjects = fromHostApi(answer.projects)
      await writeProjectsCache(home, { updated_at: now().toISOString(), from: 'host-api', projects: orcaProjects })
    }
    const simpleTodoInbox = options.simpleTodoInbox ?? join(homedir(), '.simple-todo', 'inbox.md')
    const runOrca = options.runOrca ?? defaultRunOrca(process.env)
    let cliPath: string | null = null
    let lastKey = ''
    /** What each task's bot last said, by task id. */
    const botStatuses = new Map<string, BotStatus>()
    /** What the agent in each task's project workspace is doing, by task id. */
    const workspaceStatuses = new Map<string, WorkspaceStatus>()
    let botsAt = 0
    let botsKey = ''

    /** Reads the chats of tasks that are with a bot; answers whether anything changed. */
    async function refreshBots(force = false, only?: string): Promise<boolean> {
      if (!force && Date.now() - botsAt < BOTS_MS) return false
      botsAt = Date.now()
      let tasks = (await store.read()).tasks.filter((t) => (only ? t.id === only : true))
      // A handoff whose chat Orca had not made yet when it was sent: look for it again.
      const chatsByBot = new Map<string, BotChat[]>()
      for (const task of tasks) {
        const handoff = activeHandoff(task)
        if (!handoff || handoff.chat_id) continue
        if (!chatsByBot.has(handoff.bot)) chatsByBot.set(handoff.bot, await listBotChats(runOrca, handoff.bot).catch(() => []))
        const chat = findHandoffChat(chatsByBot.get(handoff.bot) ?? [], handoff)
        if (chat) await store.setHandoffChat(task.id, chat)
      }
      if (chatsByBot.size > 0) tasks = (await store.read()).tasks.filter((t) => (only ? t.id === only : true))
      const withBot = tasks.filter((t) => activeHandoff(t)?.chat_id).slice(0, BOTS_PER_ROUND)
      for (const task of withBot) {
        const chat = activeHandoff(task)?.chat_id
        if (chat) botStatuses.set(task.id, await botChatStatus(runOrca, chat))
      }
      if (!only) for (const id of [...botStatuses.keys()]) if (!withBot.some((t) => t.id === id)) botStatuses.delete(id)
      await refreshWorkspaces(tasks, only).catch((error: unknown) => orca.log(`workspace status: ${errorText(error)}`))
      const key = statusKey()
      if (key === botsKey) return false
      botsKey = key
      return true
    }

    /** What the bots and the workspaces last said, to tell whether it changed. */
    function statusKey(): string {
      return JSON.stringify([[...botStatuses.entries()], [...workspaceStatuses.entries()]])
    }

    /** Reads the agent status of the workspaces open tasks were sent to (one `workspace.list`). */
    async function refreshWorkspaces(tasks: readonly Task[], only?: string): Promise<void> {
      const sent = tasks.filter((t) => !isClosed(t) && lastWorkspace(t))
      if (!only) for (const id of [...workspaceStatuses.keys()]) if (!sent.some((t) => t.id === id)) workspaceStatuses.delete(id)
      if (sent.length === 0 || !orca.host.has('workspace.list')) return
      let listed: Awaited<ReturnType<typeof listWorkspaces>>
      try {
        listed = await listWorkspaces()
      } catch (error) {
        for (const task of sent) workspaceStatuses.set(task.id, { state: 'unknown', unread: false, lastActivityAt: null, error: errorText(error) })
        return
      }
      for (const task of sent) workspaceStatuses.set(task.id, workspaceStatus(listed.workspaces, (lastWorkspace(task) as ProjectSend).workspace_id, listed.truncated))
    }

    function listWorkspaces() {
      return orca.host.call('workspace.list', { includeStatus: true })
    }

    /** Sends a notification for each open task that came due since the last look. */
    async function remind(): Promise<void> {
      const enabled = await orca.settings.get(REMINDERS_SETTING).catch(() => true)
      if (enabled === false || !orca.host.has('notifications.show')) return
      const morningSetting = await orca.settings.get(REMINDER_TIME_SETTING).catch(() => '09:00')
      const morning = typeof morningSetting === 'string' ? morningSetting : '09:00'
      const path = join(home, REMINDERS_FILE)
      let state: ReminderState | null = null
      try {
        const raw = JSON.parse(await readFile(path, 'utf8')) as ReminderState
        if (raw && typeof raw.sent === 'object' && raw.sent !== null) state = raw
      } catch {
        state = null
      }
      // The first look sends nothing: what is already due was due before reminders existed.
      const firstLook = state === null
      const sent: Record<string, string> = { ...(state?.sent ?? {}) }
      const file = await store.read()
      const at = now()
      const today = localDay(at)
      const due: Task[] = []
      const ids = new Set<string>()
      for (const task of file.tasks) {
        ids.add(task.id)
        if (isClosed(task) || task.held_at || !task.due) continue
        const key = reminderKey(task)
        if (sent[task.id] === key) continue
        const when = remindInstant(task.due, task.due_time, morning).getTime()
        if (when > at.getTime()) continue
        sent[task.id] = key
        if (!firstLook && at.getTime() - when <= REMINDER_LATE_MS) due.push(task)
      }
      for (const id of Object.keys(sent)) if (!ids.has(id)) delete sent[id]
      if (firstLook || due.length > 0 || JSON.stringify(sent) !== JSON.stringify(state?.sent ?? {})) {
        await writeFile(path, `${JSON.stringify({ sent }, null, 2)}\n`, 'utf8')
      }
      if (due.length === 1) {
        const task = due[0]
        const where = task.project ? ` · ${task.project}` : ''
        await orca.host.call('notifications.show', { title: `Due: ${task.title}`, body: `${dueWords(task, today)}${where}` }).catch(() => undefined)
      } else if (due.length > 1) {
        const lines = due.slice(0, 4).map((t) => `${t.due_time ? `${t.due_time} ` : ''}${t.title}`)
        if (due.length > 4) lines.push(`and ${due.length - 4} more`)
        await orca.host.call('notifications.show', { title: `${due.length} tasks are due`, body: lines.join('\n') }).catch(() => undefined)
      }
    }

    /** Tells open panels and the status bar when the file or the day changed. */
    async function refresh(force = false): Promise<void> {
      const file = await store.read()
      const at = now()
      const today = localDay(at)
      const time = localTime(at)
      const counts = viewCounts(file.tasks, today, time)
      const key = `${file.revision}|${file.updated_at}|${today}|${counts.overdue}|${botsKey}`
      if (!force && key === lastKey) return
      lastKey = key
      orca.panels.post('tasks.changed', { revision: file.revision, today })
      const todayCount = counts.dueToday + counts.overdue
      const tooltip = [
        `Agent Tasks: ${counts.open} open, ${counts.high} high priority, ${counts.overdue} overdue`,
        `${todayCount} due today or overdue${counts.hold ? `, ${counts.hold} on hold` : ''}${counts.withBot ? `, ${counts.withBot} with a bot` : ''}`
      ].join('\n')
      await orca.host
        .call('statusBar.update', {
          id: STATUS_ITEM,
          text: statusText(counts),
          tone: counts.overdue > 0 ? 'warning' : 'neutral',
          tooltip
        })
        .catch(() => undefined)
    }

    async function takeInboxes(): Promise<void> {
      const added = await store.takeInbox()
      if (added.length) orca.log(`took ${added.length} task(s) from ${store.inboxPath}`)
      const fromSimpleTodo = await orca.settings.get(SIMPLE_TODO_SETTING).catch(() => false)
      if (fromSimpleTodo === true) {
        const more = await store.takeInbox(simpleTodoInbox)
        if (more.length) orca.log(`took ${more.length} task(s) from ${simpleTodoInbox}`)
      }
    }

    // Each tick and file event runs one at a time, so two never read and write over each other
    // (the store's lock makes that safe anyway; this keeps the log quiet).
    let running: Promise<void> = Promise.resolve()
    function guarded(label: string, work: () => Promise<void>): () => Promise<void> {
      return () => {
        running = running.then(work).catch((error: unknown) => orca.log(`${label}: ${error instanceof Error ? error.message : String(error)}`))
        return running
      }
    }
    const tick = guarded('tick', async () => {
      await refreshProjects().catch((error: unknown) => orca.log(`project list: ${errorText(error)}`))
      await takeInboxes()
      const botsChanged = await refreshBots().catch((error: unknown) => {
        orca.log(`bot chats: ${errorText(error)}`)
        return false
      })
      await refresh(botsChanged)
      await remind().catch((error: unknown) => orca.log(`reminders: ${errorText(error)}`))
    })
    const onFileEvent = guarded('watch', () => refresh())
    runTick = tick

    orca.panels.handle('tasks.list', async () => {
      const file = await store.read()
      return { tasks: file.tasks, revision: file.revision, today: localDay(now()), bots: Object.fromEntries(botStatuses), workspaces: Object.fromEntries(workspaceStatuses), statuses: file.statuses ?? (await store.statuses()), canUndoMerge: Boolean(file.last_merge) }
    })

    orca.panels.handle('tasks.statuses', async (op) => {
      const statuses = await store.editStatuses(op)
      await refresh(true)
      return { statuses }
    })

    orca.panels.handle('tasks.add', async ({ text, view, project, hold, state }) => {
      const today = localDay(now())
      const parsed = parseLine(text, today, { dueWords: true })
      if (!parsed) throw Object.assign(new Error('The task has no title.'), { code: 'invalid_params' })
      const { done, ...fields } = parsed
      const input: NewTask = { ...fields }
      if (input.project === undefined && project) input.project = project
      if (hold) input.waiting_on = ''
      if (state) input.state = state
      if (input.due === undefined) {
        if (view === 'today') input.due = today
        else if (view === 'upcoming') input.due = addDays(today, 1)
      }
      if (done || view === 'done') input.done_at = now().toISOString()
      const { task } = await store.add(input)
      await refresh()
      return { task }
    })

    orca.panels.handle('tasks.update', async ({ id, patch }) => {
      const task = await store.update(id, patch)
      await refresh()
      return { task }
    })

    orca.panels.handle('tasks.move', async ({ id, state, order }) => {
      const task = await store.move(id, state, order)
      await refresh()
      return { task }
    })

    orca.panels.handle('tasks.uiState', async ({ surface, set }) => {
      const path = join(home, UI_STATE_FILE)
      let all: Record<string, Record<string, unknown>> = {}
      try {
        const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
        if (raw && typeof raw === 'object') all = raw as Record<string, Record<string, unknown>>
      } catch {
        all = {}
      }
      if (set) {
        all[surface] = set
        await writeFile(path, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
      }
      const state = all[surface]
      return { state: state && typeof state === 'object' ? state : null }
    })

    orca.panels.handle('tasks.setDone', async ({ id, done }) => {
      const task = await store.setDone(id, done)
      await refresh()
      return { task }
    })

    orca.panels.handle('tasks.delete', async ({ id }) => {
      const task = await store.remove(id)
      await refresh()
      return { task }
    })

    orca.panels.handle('tasks.projects', async () => {
      await refreshProjects(true).catch(() => undefined)
      return { orca: orcaProjects, summary: summarizeProjects((await store.read()).tasks, orcaProjects) }
    })

    orca.panels.handle('tasks.openProject', async ({ name }) => {
      const project = matchOrcaProject(name, orcaProjects)
      if (!project || !project.id) throw Object.assign(new Error(`${name} is not an Orca project.`), { code: 'invalid_params' })
      const { workspaces } = await orca.host.call('workspace.list', {})
      const mine = workspaces.filter((w) => w.projectId === project.id)
      // The project's own checkout or folder first, else its first worktree.
      const workspace = mine.find((w) => w.path === project.path) ?? mine[0]
      if (!workspace) throw Object.assign(new Error(`Orca has no workspace open for ${project.name}.`), { code: 'conflict' })
      await orca.host.call('workspace.open', { workspaceId: workspace.id })
      return { opened: true, workspace: workspace.name }
    })

    orca.panels.handle('tasks.paths', (): TaskPaths => ({ home: store.home, data: store.path, inbox: store.inboxPath, cli: cliPath }))

    // What the sidebar and the board saw of events that could be a mouse's back or forward
    // gesture (core/nav-log.ts), one line each in `orca plugin logs`, at most NAV_LOG_PER_MINUTE a
    // minute so they never push the other lines out.
    let navMinute = 0
    let navLines = 0
    let navDropped = 0
    orca.panels.handle('tasks.navLog', (raw) => {
      const { start, entries, dropped } = checkNavLog(raw)
      const minute = Math.floor(now().getTime() / 60_000)
      if (minute !== navMinute) {
        if (navDropped > 0) orca.log(`nav: ${navDropped} more line(s) left out in the minute before`)
        navMinute = minute
        navLines = 0
        navDropped = 0
      }
      if (start) orca.log(navStartLine(start))
      const lines = entries.map(navLine)
      if (dropped > 0) lines.push(`nav: the page left out ${dropped} more event(s), too many at once`)
      for (const line of lines) {
        if (navLines >= NAV_LOG_PER_MINUTE) navDropped += 1
        else {
          navLines += 1
          orca.log(line)
        }
      }
      return { logged: lines.length > 0 || start !== null }
    })

    orca.panels.handle('tasks.bots', async ({ id }): Promise<BotOffer> => {
      const task = id ? await store.get(id) : null
      const remembered = (await readSendPrefs(home))[prefsKey(task?.project ?? null)] ?? null
      const earlier = task ? lastChat(task) : null
      try {
        const { bots, unreachable } = await listBots(runOrca)
        const choices = botChoices(bots, task?.project ?? null)
        const statuses = await store.statuses()
        // A remembered choice counts only while it still makes sense: the bot still exists, the
        // status too, and "its earlier chat" only for a task that has one.
        const last: SendPrefs | null = remembered && bots.some((b) => b.name === remembered.bot)
          ? { ...remembered, chat: initialChat(remembered, Boolean(earlier)), state: remembered.state && statuses.some((s) => s.id === remembered.state) ? remembered.state : null }
          : null
        return {
          bots: [choices.project, choices.main, ...choices.others].filter((b): b is NonNullable<typeof b> => b !== null),
          project: choices.project?.name ?? null,
          main: choices.main?.name ?? (choices.project?.name.toLowerCase() === 'orca' ? choices.project.name : null),
          default: defaultBot(bots, task?.project ?? null)?.name ?? null,
          unreachable,
          error: null,
          lastChat: earlier,
          last
        }
      } catch (error) {
        return { bots: [], project: null, main: null, default: null, unreachable: [], error: errorText(error), lastChat: earlier, last: null }
      }
    })

    /** The workspace to open the send terminal in: the focused one, else one of the task's
     *  project, else the first on this computer. */
    async function sendWorkspace(task: Task): Promise<string> {
      const context = orca.host.has('workspace.readContext') ? await orca.host.call('workspace.readContext', {}).catch(() => null) : null
      if (context?.workspaceId) return context.workspaceId
      const { workspaces } = await orca.host.call('workspace.list', {})
      const project = task.project ? matchOrcaProject(task.project, orcaProjects) : null
      const local = workspaces.filter((w) => w.hostId === null || w.hostId === 'local')
      const pick = (project && local.find((w) => w.projectId === project.id)) ?? local[0]
      if (!pick) throw Object.assign(new Error('Open a workspace in Orca first: sending runs orca-tasks send in a terminal there.'), { code: 'conflict' })
      return pick.id
    }

    orca.panels.handle('tasks.send', async (raw) => {
      // Checked here, field by field, so a bad request names the form's field ("Chat: …").
      const { id, bot, type, chat, note, notes, state, by } = checkBotSend(raw)
      const task = await store.get(id)
      if (isClosed(task)) throw invalid(`Task: ${task.title} is closed; reopen it before sending it to a bot.`)
      if (chat === 'last' && !lastChat(task)) throw invalid('Chat: this task has not been in a bot chat yet; send it to a new chat or the Home Chat.')
      if (state && !(await store.statuses()).some((s) => s.id === state)) throw invalid(`Then: there is no status ${state} any more; choose another.`)
      const { bots } = await listBots(runOrca).catch((error: unknown) => {
        throw Object.assign(new Error(errorText(error)), { code: 'unavailable' })
      })
      const target = bots.find((b) => b.name === bot)
      if (!target) throw invalid(`Send to: Orca has no bot named ${bot}.`)
      if (!cliPath) throw Object.assign(new Error('The orca-tasks command is not installed, so the task cannot be sent from here. Run: orca-tasks send ' + task.id), { code: 'unavailable' })
      // `orca orchestration send` needs a sender, which only an Orca terminal has: run the CLI's
      // own `send` in a terminal of a workspace, wait for the handoff to land on the task, close it.
      const before = task.handoffs.length
      const args = botSendArgs({ id, bot, type, chat, ...(note ? { note } : {}), notes, state, by }, task.id, target.name)
      const command = [cliPath, ...args].map(shellQuote).join(' ')
      const workspaceId = await sendWorkspace(task)
      const { terminalId } = await orca.host.call('terminal.create', { workspaceId, title: `Agent Tasks: send to ${target.name}`, command })
      let handoff: Handoff | undefined
      try {
        const deadline = Date.now() + SEND_TIMEOUT_MS
        for (;;) {
          await sleep(SEND_POLL_MS)
          const now = await store.get(task.id)
          // Done once the handoff is on the task and, when a status was asked for, the task is
          // in it: the CLI writes them one after the other, and closing the terminal stops it.
          if (now.handoffs.length > before && (!state || now.state === state)) {
            handoff = now.handoffs[now.handoffs.length - 1]
            break
          }
          const output = orca.host.has('terminal.read') ? await orca.host.call('terminal.read', { terminalId, maxLines: 80 }).catch(() => null) : null
          const failed = output?.lines.map((line) => line.trim()).find((line) => line.startsWith('orca-tasks: '))
          if (failed) throw Object.assign(new Error(failed.slice('orca-tasks: '.length)), { code: 'action_failed' })
          if (Date.now() > deadline) {
            throw Object.assign(new Error(`No answer from orca-tasks send after ${SEND_TIMEOUT_MS / 1000} s. Run it in a terminal to see why: orca-tasks send ${task.id} --to ${target.name}`), { code: 'timeout' })
          }
        }
      } finally {
        await orca.host.call('terminal.close', { terminalId }).catch(() => undefined)
      }
      const saved = await store.get(task.id)
      await writeSendPrefs(home, prefsKey(task.project), { bot: target.name, type, chat, notes, state: state ?? null, keepState: !state, chatChosen: true }).catch((error: unknown) => orca.log(`send choices: ${errorText(error)}`))
      orca.log(`sent ${task.id} to bot ${target.name} as a ${type}${handoff.chat_id ? ` (chat ${handoff.chat_id})` : ''}`)
      if (handoff.chat_id) botStatuses.set(task.id, await botChatStatus(runOrca, handoff.chat_id))
      await refresh(true)
      return { task: saved, handoff }
    })

    orca.panels.handle('tasks.botStatus', async ({ id }) => {
      if (activeHandoff(await store.get(id)) && !activeHandoff(await store.get(id))?.chat_id) await refreshBots(true, id)
      const task = await store.get(id)
      const chat = (activeHandoff(task) ?? task.handoffs.at(-1))?.chat_id
      if (!chat) return { status: null }
      const status = await botChatStatus(runOrca, chat)
      if (activeHandoff(task)) {
        const before = JSON.stringify(botStatuses.get(task.id) ?? null)
        botStatuses.set(task.id, status)
        if (before !== JSON.stringify(status)) {
          botsKey = statusKey()
          await refresh(true)
        }
      }
      return { status }
    })

    orca.panels.handle('tasks.takeBack', async ({ id }) => {
      const task = await store.returnHandoff(id)
      botStatuses.delete(task.id)
      await refresh(true)
      return { task }
    })

    // ---- Sending a task to its project ----

    /** Whether the task can be sent to its project, and what the form chose last time. */
    orca.panels.handle('tasks.projectOffer', async ({ id, project: chosen }): Promise<ProjectOffer> => {
      const task = await store.get(id)
      await refreshProjects(true).catch(() => undefined)
      const named = typeof chosen === 'string' && chosen.trim() !== '' ? chosen.trim() : undefined
      const target = projectTarget(task, orcaProjects, matchOrcaProject, named)
      // The choices are kept per project the workspace goes to.
      const key = named ? ('project' in target ? target.project.name : named) : task.project
      const remembered = (await readProjectPrefs(home))[prefsKey(key)] ?? null
      const statuses = await store.statuses()
      const last = remembered ? { ...remembered, state: remembered.state && statuses.some((s) => s.id === remembered.state) ? remembered.state : null } : null
      const access = hasProjectAccess()
      return {
        project: 'project' in target ? target.project.name : null,
        error: 'error' in target ? target.error : null,
        access: access ? null : needAccessText(),
        agents: [...PROJECT_AGENTS],
        last
      }
    })

    /** Whether Orca gave Agent Tasks what a project send needs (the host checks each call again). */
    function hasProjectAccess(): boolean {
      if (!orca.host.has('workspace.create')) return false
      const granted = orca.grantedCapabilities as readonly string[] | undefined
      return !Array.isArray(granted) || PROJECT_SEND_CAPABILITIES.every((c) => granted.includes(c))
    }

    function needAccessText(): string {
      return `Agent Tasks needs your OK to start workspaces and agents (${PROJECT_SEND_CAPABILITIES.join(' and ')}). Approve it in Orca's plugin settings (Plugins, Agent Tasks), then try again.`
    }

    orca.panels.handle('tasks.sendToProject', async (raw) => {
      const { id, agent, note, notes, state, open, by, project: chosen } = checkProjectSend(raw)
      const task = await store.get(id)
      if (isClosed(task)) throw invalid(`Task: ${task.title} is closed; reopen it before sending it to its project.`)
      await refreshProjects(true).catch(() => undefined)
      const target = projectTarget(task, orcaProjects, matchOrcaProject, chosen)
      if ('error' in target) throw invalid(`Project: ${target.error}`)
      const statuses = await store.statuses()
      const after = state ? statuses.find((s) => s.id === state) : null
      if (state && !after) throw new SendFieldError('Then', `there is no status ${state} any more; choose another`)
      if (!hasProjectAccess()) throw Object.assign(new Error(needAccessText()), { code: 'capability_denied' })
      const { project } = target
      const name = workspaceName(task)
      const prompt = projectPrompt(task, { note, notes, cli: cliPath ?? undefined, ...(chosen ? { project: project.name } : {}) })
      const sentAt = now()
      let created: { workspaceId: string; terminalId?: string }
      try {
        created = await orca.host.call('workspace.create', { projectId: project.id as string, ...(project.hostId ? { hostId: project.hostId } : {}), name, agent, prompt, open })
      } catch (error) {
        const code = codeOf(error)
        if (code === 'capability_denied' || code === 'consent_required' || code === 'not_permitted') throw Object.assign(new Error(needAccessText()), { code })
        throw Object.assign(new Error(`Starting a workspace in ${project.name} failed: ${errorText(error)}`), { code: code || 'action_failed' })
      }
      const send: ProjectSend = {
        project: project.name,
        project_id: project.id,
        workspace_id: created.workspaceId,
        workspace_name: name,
        terminal_id: created.terminalId ?? null,
        agent,
        sent_at: sentAt.toISOString(),
        by: by === 'cli' ? 'panel' : by
      }
      let saved = await store.recordWorkspace(task.id, send)
      if (after) saved = await store.update(task.id, { state: after.id, ...(after.kind === 'hold' ? { waiting_on: `${agent} in ${name}` } : {}) })
      await writeProjectPrefs(home, prefsKey(chosen ? project.name : task.project), { agent, notes, state: state ?? null, keepState: !state, open }).catch((error: unknown) => orca.log(`send choices: ${errorText(error)}`))
      orca.log(`sent ${task.id} to project ${project.name}: workspace ${name} (${created.workspaceId}) with ${agent}`)
      await refreshWorkspaces([saved], saved.id).catch(() => undefined)
      await refresh(true)
      return { task: saved, workspace: send }
    })

    orca.panels.handle('tasks.workspaceStatus', async ({ id }) => {
      const task = await store.get(id)
      const send = lastWorkspace(task)
      if (!send) return { status: null }
      if (!orca.host.has('workspace.list')) return { status: { state: 'unknown' as const, unread: false, lastActivityAt: null } }
      const listed = await listWorkspaces()
      const status = workspaceStatus(listed.workspaces, send.workspace_id, listed.truncated)
      const before = JSON.stringify(workspaceStatuses.get(task.id) ?? null)
      if (!isClosed(task)) workspaceStatuses.set(task.id, status)
      if (before !== JSON.stringify(status)) {
        botsKey = statusKey()
        await refresh(true)
      }
      return { status }
    })

    orca.panels.handle('tasks.openWorkspace', async ({ id }) => {
      const send = lastWorkspace(await store.get(id))
      if (!send) throw invalid('This task has not been sent to its project.')
      try {
        await orca.host.call('workspace.open', { workspaceId: send.workspace_id })
      } catch (error) {
        throw Object.assign(new Error(`Orca could not show ${send.workspace_name}: ${errorText(error)}. It may have been removed.`), { code: codeOf(error) || 'action_failed' })
      }
      return { opened: true, workspace: send.workspace_name }
    })

    // ---- Merging ----

    orca.panels.handle('tasks.merge', async ({ keep, ids, due, priority, created, dryRun }) => {
      if (typeof keep !== 'string' || keep === '') throw invalid('Keep: choose the task to keep.')
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) throw invalid('Merge: choose at least one other task to merge into it.')
      const choices: MergeChoices = {}
      if (due !== undefined && due !== null) choices.due = due
      if (priority !== undefined && priority !== null) choices.priority = priority
      if (created !== undefined && created !== null) choices.created = created
      const plan = await store.merge(keep, ids, choices, { dryRun: dryRun === true })
      if (!dryRun) {
        orca.log(`merged ${ids.join(', ')} into ${plan.keeper.id}`)
        await refresh(true)
      }
      return plan
    })

    // Suggest merges: Claude Code reads the open tasks once (core/suggest.ts) and answers groups of
    // likely duplicates. One run at a time: a second press (the sidebar and the board) waits for
    // the same answer. Nothing is merged here.
    let suggesting: Promise<SuggestResult> | null = null
    orca.panels.handle('tasks.suggestMerges', async () => {
      if (!suggesting) {
        const agent = options.suggestAgent ?? { command: agentFromEnv(process.env) }
        suggesting = store
          .read()
          .then(({ tasks }) => suggestMerges(tasks, home, agent))
          .then(
            (result) => {
              orca.log(`suggested ${result.suggestions.length} merge${result.suggestions.length === 1 ? '' : 's'} among ${result.considered} open tasks`)
              return result
            },
            (error: unknown) => {
              orca.log(`suggest merges: ${errorText(error)}`)
              throw error instanceof SuggestError ? Object.assign(new Error(error.message), { code: error.code === 'timeout' ? 'timeout' : error.code === 'agent_missing' ? 'unavailable' : 'action_failed' }) : error
            }
          )
          .finally(() => {
            suggesting = null
          })
      }
      return suggesting
    })

    orca.panels.handle('tasks.dismissMerge', async ({ ids }) => {
      if (!Array.isArray(ids) || ids.length < 2 || ids.some((x) => typeof x !== 'string')) throw invalid('Dismiss: a suggestion names two or more tasks.')
      await dismissSuggestion(home, ids)
      return { dismissed: true }
    })

    orca.panels.handle('tasks.undoMerge', async () => {
      const result = await store.undoMerge()
      orca.log(`undid the merge into ${result.keeper.id}`)
      await refresh(true)
      return result
    })

    /** Opens the board in an editor tab: a `.agenttasks` file at the top of the focused workspace.
     *  Orca opens editor tabs only for files inside a workspace, and the worker never writes into
     *  one, so without such a file it says how to make one. */
    async function openBoard(): Promise<{ opened: boolean; reason?: string }> {
      const howTo = `Press + in the tab bar and choose "Open Agent Tasks board". Save that tab as "${BOARD_FILE}" in a workspace and the Board button opens it there.`
      if (!orca.host.has('editor.open') || !orca.host.has('workspace.readContext') || !orca.host.has('workspace.list')) return { opened: false, reason: howTo }
      const context = await orca.host.call('workspace.readContext', {})
      if (!context?.workspaceId) return { opened: false, reason: `No workspace is open. ${howTo}` }
      const { workspaces } = await orca.host.call('workspace.list', {})
      const workspace = workspaces.find((w) => w.id === context.workspaceId)
      if (!workspace || (workspace.hostId !== null && workspace.hostId !== 'local')) return { opened: false, reason: howTo }
      const names = await readdir(workspace.path).catch(() => [] as string[])
      const file = names.includes(BOARD_FILE) ? BOARD_FILE : names.find((name) => name.toLowerCase().endsWith('.agenttasks'))
      if (!file) return { opened: false, reason: howTo }
      try {
        await orca.host.call('editor.open', { workspaceId: workspace.id, path: file })
        return { opened: true }
      } catch (error) {
        return { opened: false, reason: `Orca would not open ${file} (${errorText(error)}). ${howTo}` }
      }
    }

    orca.panels.handle('tasks.openBoard', () => openBoard())

    orca.commands.register('agent-tasks.summary', async () => {
      const at = now()
      return summary((await store.read()).tasks, localDay(at), localTime(at))
    })

    orca.commands.register('agent-tasks.openBoard', async () => {
      const result = await openBoard()
      return result.opened ? 'Opened the Agent Tasks board.' : (result.reason ?? 'Could not open the board.')
    })

    await mkdir(home, { recursive: true })
    if (await store.migrate().catch((error: unknown) => {
      orca.log(`could not bring ${store.path} to the current schema: ${errorText(error)}`)
      return false
    })) {
      orca.log(`brought ${store.path} to schema 3 (statuses)`)
    }

    if (options.installCli ?? true) {
      try {
        cliPath = await installCli(home, dirname(fileURLToPath(import.meta.url)))
      } catch (error) {
        orca.log(`could not install the CLI: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (options.timers ?? true) {
      const timer = setInterval(() => void tick(), TICK_MS)
      let watcher: FSWatcher | undefined
      let debounce: ReturnType<typeof setTimeout> | undefined
      try {
        watcher = watch(home, (_event, name) => {
          if (name && !name.startsWith('tasks.json')) return
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => void onFileEvent(), 100)
        })
        watcher.on('error', () => undefined)
      } catch (error) {
        orca.log(`not watching ${home} (polling instead): ${error instanceof Error ? error.message : String(error)}`)
      }
      stop = () => {
        clearInterval(timer)
        if (debounce) clearTimeout(debounce)
        watcher?.close()
      }
    }

    await tick()
    await refresh(true)
  }

  return {
    activate,
    /** One round of the worker's timer: Orca projects, inboxes, bot chats, status bar, reminders.
     *  For tests, which run without timers. */
    tick: (): Promise<void> => runTick?.() ?? Promise.resolve(),
    deactivate(): void {
      stop?.()
      stop = undefined
    }
  }
}

const worker = createWorker()
export default worker.activate
export const deactivate = worker.deactivate
