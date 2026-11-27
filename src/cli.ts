// The agent interface: `orca-tasks <command> ...`, reading and writing the same file the Orca
// panel shows. `run` does the work and answers an exit code, so tests call it in process;
// src/cli-bin.ts is the program.

import { DateInputError, localDay, parseDay, parseDue, parseInstant, parseTime } from './core/dates.ts'
import { BotError, botChoices, defaultBot, handoffBody, handoffSubject, listBots, mainBot, sendToBot, taskBotStatus, type Bot, type RunOrca } from './core/bots.ts'
import { checklist } from './core/checklist.ts'
import { keeperOf, type MergeChoices } from './core/merge.ts'
import { agentFromEnv, SuggestError, suggestMerges } from './core/suggest.ts'
import { projectPrompt, projectTarget, workspaceName } from './core/project-send.ts'
import { createWorkspaceWithCli } from './core/workspace-cli.ts'
import { formatLine, parseLine } from './core/line.ts'
import { canonicalProject, groupByProject, matchOrcaProject, summarizeProjects, type OrcaProject } from './core/projects.ts'
import type { LoadedProjects } from './core/orca-projects.ts'
import { defaultSendStatus, firstOfKind, KIND_LABELS, resolveStatus, StatusError, type StatusOp } from './core/statuses.ts'
import { StoreError, TaskStore } from './core/store.ts'
import { activeHandoff, findTask, isClosed, lastChat, TaskInputError, TaskNotFoundError } from './core/tasks.ts'
import { PRIORITIES, PROJECT_AGENTS, SEND_TYPES, type ProjectAgent, STATUS_COLORS, STATUS_KINDS, STATUSES, VIEWS, type NewTask, type SendType, type StatusColor, type StatusDef, type StatusKind, type TaskStatus, type Priority, type Task, type TaskFilter, type TaskPatch, type View } from './core/types.ts'

export const VERSION = '0.6.6'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Reads all of standard input (for `import -`). */
  stdin?: () => Promise<string>
  /** Reads a file (for `import <file>`). */
  readFile?: (path: string) => Promise<string>
  env?: Record<string, string | undefined>
  now?: () => Date
  /** The person's Orca projects (the worker's cache, else `orca repo list`); none when absent. */
  orcaProjects?: (home: string, refresh: boolean) => Promise<LoadedProjects>
  /** Runs Orca's own CLI, for `bots`, `send` and `bot-status`. */
  runOrca?: RunOrca
}

export const HELP = `orca-tasks ${VERSION}: the task list the Agent Tasks panel in Orca shows, for agents and scripts.

Usage: orca-tasks <command> [arguments] [options]

Commands
  list                     List tasks (open ones unless a filter says otherwise)
  get <id>                 Show one task
  add <title...>           Add a task
  done <id...>             Complete tasks (--at <time> to backdate)
  undone <id...>           Reopen completed tasks
  hold <id...> --on <text> Put on hold, waiting on someone's input (--on "Bob's review")
  unhold <id...>           Take off hold (back to open)
  edit <id>                Change a task's fields (--state moves it to another status)
  rm <id...>               Delete tasks for good
  statuses                 The statuses tasks can be in, in order, with counts
  statuses add <name>      Add a status (--kind, --color, --position)
  statuses edit <status>   Rename, recolour, change the kind of or move a status
  statuses rm <status>     Delete a status; its tasks move (--move-to <status>)
  import [<file>|-]        Add tasks from Simple Todo lines: - [ ] text !high @project #tag due:YYYY-MM-DD
  projects                 Orca projects and the other projects tasks use, with counts
  bots [<id>]              Orca's bots (orca bot list); with an id, which one send would pick
  send <id>                Send a task to an Orca bot as a handoff, and record it on the task
  send <id> --to-project   Start a new Orca workspace in the task's project with a coding agent
                           whose first prompt is the task, and record it on the task
  merge <keep> <id...>     Merge duplicate tasks into <keep>: the others are cancelled and point
                           to it (--dry-run shows what it would do; merge --undo undoes the last)
  suggest-merges           Ask Claude Code which open tasks look like duplicates; prints each
                           group with the task to keep, a reason and a confidence. Merges nothing.
                           Sends the open tasks' title, notes, sources, tags, project, due day and
                           status to Claude Code (claude --print, no tools); --timeout <seconds>
  bot-status <id>          The bot a task was sent to: its chat's state and latest reply
  take-back <id>           Take a task back from the bot it was sent to
  path                     Print where the list, its lock and the inbox live
  help                     This text

List filters
  --status <s>             open | hold | done | all, or several: --status open,hold (default open).
                           done is every closed task: done or cancelled
  --open | --hold | --done | --all   Short for --status open / hold / done / all
  --state <status>         In this status of yours (name or id), or several: --state "To Do,Pending";
                           every open or closed one unless --status also says
  --done-since <time>      Completed at or after <time> (implies --done)
  --due <day>              Due on that day
  --due-from <day>         Due on or after <day>
  --due-to <day>           Due on or before <day>
  --overdue                Open and past due: before today, or today at a time already past
  --with-bot | --no-bot    Sent to a bot (and not taken back) / not
  --no-due | --has-due     Without / with a due day
  --view <view>            today | upcoming | inbox | done, as in the panel
  --project <name>         In that project
  --tag <tag>              Has the tag (repeat for several)
  --source <text>          Exactly this source
  --search <text>          Text in the title or notes
  --limit <n>              At most n tasks
  --group project          Group the tasks by project (JSON: {"groups":[...]})

Fields (add, edit)
  --title <text>           edit: the new title
  --notes <text>           Notes ("" clears)
  --due <day>              Due day, optionally with a time: fri, fri@15:30, 2026-11-25T09:00;
                           "none" clears
  --time <HH:MM>           A time on the due day (15:30, 9am); "none" leaves only the day
  --priority <p>           urgent | high | medium | low | none
  --project <name>         Project; "none" clears. A name that matches an Orca project
                           (any case, - or space) is stored as that project's exact name
  --tag <tag>              add: a tag (repeat); edit: replaces the tags (repeat)
  --add-tag / --remove-tag edit: one tag more / less (repeat)
  --source <text>          Where it came from: an issue URL, chat:<id>, issue:<id>...
  --parse                  add: read !high @project #tag due:... markers out of the title
  --dedupe                 add: if a task with the same --source exists, return it instead (the
                           task it was merged into, when it was merged)
  --done                   add: add it already completed
  --state <status>         Its status, by name or id ("In Progress"); add: default the first open one
  --on <text>              edit: what it waits on (puts an open task on hold)

Statuses (statuses add / edit)
  --name <text>            edit: the new name
  --kind <kind>            open | hold (open, waiting on someone) | done | cancelled (closed)
  --color <colour>         gray | blue | purple | teal | green | amber | orange | red | pink
  --position <n>           Where it goes, from 1 (first)
  --move-to <status>       rm: where its tasks go (default the first other one of its kind)
  At least one open, one hold and one done status always stay.

Projects
  --refresh                projects: ask Orca again (orca repo list) instead of the cache

Send (only when you run it; nothing is sent otherwise)
  --to <bot>               The bot's name; default the bot of the task's project, else "Orca"
  --type <type>            handoff (default: the bot owns the job) | question (it only answers)
                           | status (for its information; nothing back)
  --chat <where>           home: the bot's Home Chat, its main chat (default) | new: a new chat
                           of its own | last: the chat the task was last sent to
                           | <chat id>: that chat
  --note <text>            An instruction for the bot above the task ("check progress")
  --no-notes               Leave the task's notes out
  --state <status>         Then move the task to this status; a hold status ("Pending") waits on
                           the bot. Default: In Progress (when you have that status)
  --keep-state             Leave the task's status as it is
  --dry-run                Print what would be sent, and send nothing
  Needs a sender: run it in an Orca terminal (ORCA_TERMINAL_HANDLE), as the panel does

Send to the project (send <id> --to-project)
  --agent <agent>          claude (default) | codex
  --note, --no-notes, --state, --keep-state, --dry-run   As for a bot
  --open                   Show the new workspace in Orca
  Runs orca worktree create --project <the task's project> --agent <agent> --prompt <the task>

Merge (merge <keep> <id...>)
  The kept task keeps its title and status, and gets the others' notes (each under "Merged from
  <title> (<id>)"), sources, tags, bot and workspace history, the earliest created date, the
  earliest due day and the highest priority. The others move to Cancelled with merged_into set;
  get <old id> shows the kept task, and add --dedupe on their source answers it.
  --due <day>              earliest (default) | keep | none | a day (fri, 2026-12-01, fri@15:30)
  --priority <p>           highest (default) | keep | urgent | high | medium | low | none
  --created <which>        earliest (default) | keep
  --dry-run                Print what the merge would do, and change nothing
  --undo                   Undo the latest merge (only if none of its tasks changed since)

Output
  --json                   Machine-readable JSON on stdout (errors too, as {"error":{...}})
  --format line            list: one Simple Todo line per task

Days: YYYY-MM-DD, today, tomorrow, yesterday, +3d, -1d, +2w, mon..sun (the next one).
Times: ISO 8601, YYYY-MM-DD or today/yesterday (local midnight), now, -24h, -30m, -7d.
Ids: the full id, or any prefix of at least 3 characters that only one task has.
Data: $ORCA_TASKS_HOME/tasks.json, default ~/.orca-tasks/tasks.json.
Exit codes: 0 ok, 1 error, 2 bad usage, 3 no such task.
`

class UsageError extends Error {
  readonly code = 'usage'
}

type OptionSpec = Record<string, 'flag' | 'value' | 'list'>

interface Parsed {
  positional: string[]
  options: Record<string, string | boolean | string[]>
}

const COMMON: OptionSpec = { json: 'flag', help: 'flag', 'no-inbox': 'flag' }
const FIELD_OPTIONS: OptionSpec = {
  notes: 'value',
  due: 'value',
  time: 'value',
  priority: 'value',
  project: 'value',
  tag: 'list',
  source: 'value'
}
const SPECS: Record<string, OptionSpec> = {
  list: {
    status: 'value',
    state: 'value',
    hold: 'flag',
    open: 'flag',
    done: 'flag',
    all: 'flag',
    'done-since': 'value',
    due: 'value',
    'due-from': 'value',
    'due-to': 'value',
    overdue: 'flag',
    'no-due': 'flag',
    'has-due': 'flag',
    view: 'value',
    project: 'value',
    tag: 'list',
    source: 'value',
    search: 'value',
    'with-bot': 'flag',
    'no-bot': 'flag',
    limit: 'value',
    format: 'value',
    group: 'value'
  },
  get: {},
  add: { ...FIELD_OPTIONS, parse: 'flag', dedupe: 'flag', done: 'flag', state: 'value' },
  edit: { ...FIELD_OPTIONS, title: 'value', 'add-tag': 'list', 'remove-tag': 'list', state: 'value', on: 'value' },
  done: { at: 'value' },
  undone: {},
  hold: { on: 'value' },
  unhold: {},
  rm: {},
  import: { source: 'value' },
  path: {},
  projects: { refresh: 'flag' },
  bots: {},
  send: { to: 'value', chat: 'value', note: 'value', 'dry-run': 'flag', by: 'value', type: 'value', 'no-notes': 'flag', state: 'value', 'keep-state': 'flag', 'to-project': 'flag', agent: 'value', open: 'flag' },
  merge: { due: 'value', priority: 'value', created: 'value', 'dry-run': 'flag', undo: 'flag' },
  'suggest-merges': { timeout: 'value' },
  statuses: { name: 'value', kind: 'value', color: 'value', position: 'value', 'move-to': 'value' },
  'bot-status': {},
  'take-back': {},
  help: {}
}
const ALIASES: Record<string, string> = {
  ls: 'list',
  show: 'get',
  new: 'add',
  complete: 'done',
  reopen: 'undone',
  uncomplete: 'undone',
  update: 'edit',
  delete: 'rm',
  remove: 'rm'
}

function parseArgs(args: readonly string[], spec: OptionSpec): Parsed {
  const all = { ...COMMON, ...spec }
  const positional: string[] = []
  const options: Parsed['options'] = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (!arg.startsWith('--') || arg === '-') {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    const kind = all[name]
    if (!kind) throw new UsageError(`unknown option --${name}`)
    if (kind === 'flag') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`)
      options[name] = true
      continue
    }
    let value: string
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      if (i + 1 >= args.length) throw new UsageError(`--${name} needs a value`)
      value = args[(i += 1)]
    }
    if (kind === 'list') options[name] = [...((options[name] as string[] | undefined) ?? []), value]
    else options[name] = value
  }
  return { positional, options }
}

function str(options: Parsed['options'], name: string): string | undefined {
  const value = options[name]
  return typeof value === 'string' ? value : undefined
}

function list(options: Parsed['options'], name: string): string[] | undefined {
  const value = options[name]
  return Array.isArray(value) ? value : undefined
}

function statusesOf(text: string): TaskStatus[] {
  const names = text.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '')
  if (names.includes('all')) return [...STATUSES]
  const out: TaskStatus[] = []
  for (const name of names) {
    const status = name === 'held' || name === 'on-hold' ? 'hold' : name
    if (!(STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status must be open, hold, done or all (got ${name})`)
    if (!out.includes(status as TaskStatus)) out.push(status as TaskStatus)
  }
  if (out.length === 0) throw new UsageError('--status needs a value')
  return out
}

function priorityOf(text: string): Priority {
  const value = text.trim().toLowerCase().replace(/^!/, '')
  if ((PRIORITIES as readonly string[]).includes(value)) return value as Priority
  throw new UsageError(`--priority must be one of ${PRIORITIES.join(', ')}`)
}

function clearable(text: string): string | null {
  const value = text.trim()
  return value === '' || value.toLowerCase() === 'none' || value === '-' ? null : value
}

/** Statuses as `describe` needs them: set once per run, after the file is read. */
let known: readonly StatusDef[] = []

function describe(task: Task): string {
  const meta: string[] = []
  // Only a status other than the first of its kind is named, so To Do, Pending and Done tasks
  // print as they did before statuses.
  const def = known.find((s) => s.id === task.state)
  if (def && known.length > 0 && firstOfKind(known, def.kind).id !== def.id) meta.push(`status ${def.name}`)
  if (task.due) meta.push(`due ${task.due}${task.due_time ? ` ${task.due_time}` : ''}`)
  if (task.priority !== 'none') meta.push(`!${task.priority}`)
  if (task.project) meta.push(`@${task.project}`)
  for (const tag of task.tags) meta.push(`#${tag}`)
  if (task.status === 'hold') meta.push(`on hold${task.waiting_on ? `: waiting on ${task.waiting_on}` : ''} since ${task.held_at}`)
  if (task.done_at) meta.push(`done ${task.done_at}`)
  if (task.source) meta.push(`source ${task.source}`)
  const handoff = activeHandoff(task)
  if (handoff) meta.push(`with bot ${handoff.bot} since ${handoff.sent_at}`)
  if (!task.done_at && task.closed_at) meta.push(`cancelled ${task.closed_at}`)
  if (task.merged_into) meta.push(`merged into ${task.merged_into}`)
  const workspace = task.workspaces?.at(-1)
  if (workspace && !isClosed(task)) meta.push(`in workspace ${workspace.workspace_name} (${workspace.agent})`)
  const box = task.done_at ? '[x]' : task.closed_at ? '[-]' : task.status === 'hold' ? '[~]' : '[ ]'
  return `${box} ${task.id}  ${task.title}${meta.length ? `  (${meta.join(', ')})` : ''}`
}

function describeLong(task: Task): string {
  const lines = [describe(task), `    created ${task.created_at}, updated ${task.updated_at}`]
  const list = checklist(task.notes)
  if (list.total) lines.push(`    checklist ${list.done}/${list.total}`)
  for (const h of task.handoffs) {
    lines.push(`    ${h.type === 'question' ? 'asked' : h.type === 'status' ? 'told' : 'sent to'} ${h.bot} (${chatWords(h.chat)}${h.chat_id ? ` ${h.chat_id}` : ''}) at ${h.sent_at}${h.returned_at ? `, taken back ${h.returned_at}` : ''}`)
  }
  for (const w of task.workspaces ?? []) lines.push(`    sent to project ${w.project}: workspace ${w.workspace_name} (${w.workspace_id}) with ${w.agent} at ${w.sent_at}`)
  if (task.merged_from?.length) lines.push(`    merged from ${task.merged_from.join(', ')}`)
  if ((task.sources ?? []).length > 1) lines.push(`    sources ${(task.sources ?? []).join(', ')}`)
  if (task.notes) lines.push(...task.notes.split('\n').map((line) => `    | ${line}`))
  return lines.join('\n')
}

function chatWords(chat: 'new' | 'home' | 'existing'): string {
  return chat === 'new' ? 'new chat' : chat === 'home' ? 'Home Chat' : 'earlier chat'
}

function statusLine(s: StatusDef, count: number | null, index: number): string {
  return `${String(index + 1).padStart(2)}. ${s.name}  [${s.id}] ${KIND_LABELS[s.kind].toLowerCase()}, ${s.color}${count === null ? '' : `, ${count} task${count === 1 ? '' : 's'}`}`
}

function kindOf(text: string): StatusKind {
  const value = text.trim().toLowerCase()
  const kind = value === 'waiting' || value === 'on-hold' || value === 'held' || value === 'pending' ? 'hold' : value === 'closed' ? 'done' : value === 'canceled' ? 'cancelled' : value
  if (!(STATUS_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${STATUS_KINDS.join(', ')}`)
  return kind as StatusKind
}

function colorOf(text: string): StatusColor {
  const value = text.trim().toLowerCase().replace(/^grey$/, 'gray')
  if (!(STATUS_COLORS as readonly string[]).includes(value)) throw new UsageError(`--color must be one of ${STATUS_COLORS.join(', ')}`)
  return value as StatusColor
}

function positionOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--position must be a whole number from 1')
  return n - 1
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const env = io.env ?? {}
  const now = io.now ?? (() => new Date())
  const wantsJson = argv.includes('--json')
  const out = (value: unknown, text: string) => io.stdout(wantsJson ? `${JSON.stringify(value, null, 2)}\n` : text.endsWith('\n') || text === '' ? text : `${text}\n`)
  const fail = (code: string, message: string, exit: number) => {
    if (wantsJson) io.stdout(`${JSON.stringify({ error: { code, message } })}\n`)
    else io.stderr(`orca-tasks: ${message}\n`)
    return exit
  }
  try {
    const [first, ...rest] = argv
    if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
      io.stdout(HELP)
      return 0
    }
    if (first === '--version' || first === 'version') {
      io.stdout(`${VERSION}\n`)
      return 0
    }
    const command = ALIASES[first] ?? first
    const spec = SPECS[command]
    if (!spec) throw new UsageError(`unknown command "${first}"; run orca-tasks help`)
    const { positional, options } = parseArgs(rest, spec)
    if (options.help) {
      io.stdout(HELP)
      return 0
    }
    const home = env.ORCA_TASKS_HOME && env.ORCA_TASKS_HOME.trim() !== '' ? env.ORCA_TASKS_HOME : undefined
    let orca: Promise<LoadedProjects> | undefined
    const loadOrca = (refresh = false): Promise<LoadedProjects> => {
      if (!orca || refresh) {
        orca = io.orcaProjects
          ? io.orcaProjects(home ?? new TaskStore().home, refresh).catch((): LoadedProjects => ({ projects: [], from: 'none', updated_at: null }))
          : Promise.resolve({ projects: [], from: 'none', updated_at: null })
      }
      return orca
    }
    const orcaList = async (): Promise<readonly OrcaProject[]> => (await loadOrca()).projects
    const store = new TaskStore({ home: home ?? undefined, now, orcaProjects: orcaList })
    const today = localDay(now())
    if (command === 'path') {
      const paths = { home: store.home, data: store.path, lock: store.lockPath, inbox: store.inboxPath }
      out(paths, `${store.path}\n`)
      return 0
    }
    // Lines appended to the inbox count as tasks for every command, as they do in the panel.
    if (!options['no-inbox']) await store.takeInbox(store.inboxPath, 0)
    known = await store.statuses()

    switch (command) {
      case 'list': {
        if (positional.length > 0) throw new UsageError(`list takes no arguments (got "${positional[0]}")`)
        const filter: TaskFilter = {}
        const given = ['open', 'hold', 'done', 'all'].filter((name) => options[name])
        const statusText = str(options, 'status')
        if (given.length + (statusText ? 1 : 0) > 1) throw new UsageError('give only one of --status, --open, --hold, --done, --all')
        const chosen = statusText ?? given[0]
        if (chosen) filter.statuses = statusesOf(chosen)
        else filter.statuses = ['open']
        const stateText = str(options, 'state')
        if (stateText !== undefined) {
          const names = stateText.split(',').map((n) => n.trim()).filter((n) => n !== '')
          if (names.length === 0) throw new UsageError('--state needs a status')
          filter.states = names.map((name) => resolveStatus(known, name).id)
          if (!chosen) filter.statuses = undefined
        }
        const doneSince = str(options, 'done-since')
        if (doneSince) {
          filter.doneSince = parseInstant(doneSince, now())
          if (!chosen) filter.statuses = ['done']
        }
        const view = str(options, 'view')
        if (view) {
          if (!(VIEWS as readonly string[]).includes(view)) throw new UsageError(`--view must be one of ${VIEWS.join(', ')}`)
          filter.view = view as View
          if (!chosen) filter.statuses = undefined
        }
        const due = str(options, 'due')
        if (due) {
          const day = parseDay(due, today)
          if (day === null) filter.noDue = true
          else filter.dueFrom = filter.dueTo = day
        }
        const from = str(options, 'due-from')
        if (from) filter.dueFrom = parseDay(from, today) ?? undefined
        const to = str(options, 'due-to')
        if (to) filter.dueTo = parseDay(to, today) ?? undefined
        if (options.overdue) {
          filter.overdue = true
          filter.statuses = ['open']
        }
        if (options['with-bot'] && options['no-bot']) throw new UsageError('give only one of --with-bot, --no-bot')
        if (options['with-bot']) filter.withBot = true
        if (options['no-bot']) filter.withBot = false
        if (options['no-due'] && options['has-due']) throw new UsageError('give only one of --no-due, --has-due')
        if (options['no-due']) filter.noDue = true
        if (options['has-due']) filter.noDue = false
        const project = str(options, 'project')
        filter.project = project === undefined ? undefined : (canonicalProject(project, await orcaList()) ?? project)
        filter.tags = list(options, 'tag')
        filter.source = str(options, 'source')
        filter.text = str(options, 'search')
        let tasks = await store.list(filter)
        const limit = str(options, 'limit')
        if (limit !== undefined) {
          const n = Number(limit)
          if (!Number.isInteger(n) || n < 0) throw new UsageError('--limit must be a whole number')
          tasks = tasks.slice(0, n)
        }
        const format = str(options, 'format')
        if (format !== undefined && format !== 'line' && format !== 'text') throw new UsageError('--format must be line or text')
        const group = str(options, 'group')
        if (group !== undefined) {
          if (group !== 'project') throw new UsageError('--group must be project')
          const groups = groupByProject(tasks, await orcaList())
          const show = format === 'line' ? formatLine : describe
          const text = groups.length === 0
            ? 'No tasks.\n'
            : `${groups.map((g) => `${g.project === null ? 'No project' : g.project}${g.orca ? ' (Orca)' : ''}: ${g.open} open, ${g.hold ? `${g.hold} on hold, ` : ''}${g.total} total\n${g.tasks.map((t) => `  ${show(t)}`).join('\n')}`).join('\n\n')}\n`
          out({ today, groups }, text)
          return 0
        }
        const text = tasks.length === 0 ? 'No tasks.\n' : `${tasks.map(format === 'line' ? formatLine : describe).join('\n')}\n`
        out({ today, tasks }, text)
        return 0
      }
      case 'get': {
        if (positional.length !== 1) throw new UsageError('get takes one id')
        const all = (await store.read()).tasks
        const task = findTask(all, positional[0])
        if (task.merged_into) {
          // A merged task points to the task it now lives in.
          const keeper = keeperOf(all, task)
          out({ task, merged_into: keeper.id === task.id ? null : keeper }, `${describeLong(task)}\nMerged into ${keeper.id}: ${keeper.title}\n${describeLong(keeper)}`)
          return 0
        }
        out({ task }, describeLong(task))
        return 0
      }
      case 'add': {
        let title = positional.join(' ').trim()
        if (title === '') throw new UsageError('add needs a title: orca-tasks add "Call Alice" --due tomorrow')
        const input: NewTask = { title }
        if (options.parse) {
          const parsed = parseLine(title, today)
          if (!parsed) throw new UsageError('nothing left of the title after reading its markers')
          const { done, ...fields } = parsed
          Object.assign(input, fields)
          if (done) input.done_at = now().toISOString()
          title = parsed.title
        }
        Object.assign(input, fieldsFrom(options, today, 'add'))
        if (options.done) input.done_at = now().toISOString()
        const addState = str(options, 'state')
        if (addState !== undefined) input.state = resolveStatus(known, addState).id
        const { task, created } = await store.add(input, { dedupe: Boolean(options.dedupe) })
        out({ task, created }, `${created ? 'Added' : 'Exists'} ${describe(task)}`)
        return 0
      }
      case 'edit': {
        if (positional.length !== 1) throw new UsageError('edit takes one id, then the fields to change')
        const patch: TaskPatch = fieldsFrom(options, today, 'edit')
        const editState = str(options, 'state')
        if (editState !== undefined) patch.state = resolveStatus(known, editState).id
        const on = str(options, 'on')
        if (on !== undefined) patch.waiting_on = on
        const addTags = list(options, 'add-tag') ?? []
        const removeTags = (list(options, 'remove-tag') ?? []).map((tag) => tag.replace(/^#/, ''))
        if (Object.keys(patch).length === 0 && addTags.length === 0 && removeTags.length === 0) {
          throw new UsageError('edit needs at least one field to change (see orca-tasks help)')
        }
        const task = await store.update(positional[0], (current) => {
          if (!addTags.length && !removeTags.length) return patch
          const base = patch.tags ?? current.tags
          return { ...patch, tags: [...base, ...addTags].filter((tag) => !removeTags.includes(tag.replace(/^#/, ''))) }
        })
        out({ task }, `Changed ${describe(task)}`)
        return 0
      }
      case 'done':
      case 'undone': {
        if (positional.length === 0) throw new UsageError(`${command} takes one or more ids`)
        const atText = str(options, 'at')
        const at = atText ? parseInstant(atText, now()) : undefined
        const tasks: Task[] = []
        for (const id of positional) tasks.push(await store.setDone(id, command === 'done', at))
        out({ tasks }, tasks.map(describe).join('\n'))
        return 0
      }
      case 'hold':
      case 'unhold': {
        if (positional.length === 0) throw new UsageError(`${command} takes one or more ids`)
        const on = str(options, 'on')
        if (command === 'hold' && (on === undefined || on.trim() === '')) {
          throw new UsageError('hold needs --on "<who or what it waits on>", e.g. --on "Bob\'s review"')
        }
        const tasks: Task[] = []
        for (const id of positional) {
          tasks.push(
            await store.update(id, (task) => {
              if (isClosed(task)) throw new TaskInputError(`${task.id} is ${task.done_at ? 'done' : 'closed'}; reopen it (undone) before putting it on hold`)
              return { waiting_on: command === 'hold' ? (on ?? '') : null }
            })
          )
        }
        out({ tasks }, tasks.map(describe).join('\n'))
        return 0
      }
      case 'rm': {
        if (positional.length === 0) throw new UsageError('rm takes one or more ids')
        const tasks: Task[] = []
        for (const id of positional) tasks.push(await store.remove(id))
        out({ tasks }, tasks.map((task) => `Deleted ${describe(task)}`).join('\n'))
        return 0
      }
      case 'import': {
        if (positional.length > 1) throw new UsageError('import takes one file, or - for standard input')
        const from = positional[0] ?? '-'
        let text: string
        if (from === '-') {
          if (!io.stdin) throw new UsageError('no standard input to read')
          text = await io.stdin()
        } else {
          if (!io.readFile) throw new UsageError('cannot read files here')
          text = await io.readFile(from)
        }
        const tasks = await store.importLines(text, { source: str(options, 'source') })
        out({ tasks }, tasks.length ? tasks.map((task) => `Added ${describe(task)}`).join('\n') : 'No task lines found.')
        return 0
      }
      case 'projects': {
        if (positional.length > 0) throw new UsageError('projects takes no arguments')
        const loaded = await loadOrca(Boolean(options.refresh))
        const projects = summarizeProjects((await store.read()).tasks, loaded.projects)
        const text = projects.length === 0
          ? 'No projects.\n'
          : `${projects.map((p) => `${p.orca ? '[orca]' : '      '} ${p.name}${p.hidden ? ' (hidden)' : ''}  ${p.open} open, ${p.hold ? `${p.hold} on hold, ` : ''}${p.done} done`).join('\n')}\n`
        out({ from: loaded.from, updated_at: loaded.updated_at, projects }, text)
        return 0
      }
      case 'bots': {
        if (positional.length > 1) throw new UsageError('bots takes at most one task id')
        const runOrca = needOrca(io)
        const { bots, unreachable } = await listBots(runOrca)
        const task = positional[0] ? await store.get(positional[0]) : null
        const choices = botChoices(bots, task?.project ?? null)
        const pick = defaultBot(bots, task?.project ?? null)
        const main = mainBot(bots)
        const role = (b: Bot) => (b.name === choices.project?.name ? 'project' : b.name === main?.name ? 'main' : null)
        const rows = bots.map((b) => ({ ...b, role: role(b) }))
        const text = bots.length === 0
          ? 'No bots. Make one in Orca first.\n'
          : `${rows.map((b) => `${b.name === pick?.name && task ? '* ' : '  '}${b.name}${b.role === 'project' ? ` (bot of ${task?.project})` : b.role === 'main' ? ' (main bot)' : ''}${b.paused ? ' [paused]' : ''}  ${b.specialty}`).join('\n')}\n${unreachable.length ? `Not reachable now: ${unreachable.join(', ')}\n` : ''}`
        out({ bots: rows, unreachable, default: pick?.name ?? null }, text)
        return 0
      }
      case 'send': {
        if (options['to-project']) return await sendToProject(positional, options, { store, io, out, now, known, loadOrca })
        if (options.agent !== undefined || options.open) throw new UsageError('--agent and --open go with --to-project')
        if (positional.length !== 1) throw new UsageError('send takes one task id: orca-tasks send <id> [--to <bot>] [--type handoff|question|status] [--chat new|home|last|<id>]')
        const typeText = (str(options, 'type') ?? 'handoff').trim().toLowerCase()
        if (!(SEND_TYPES as readonly string[]).includes(typeText)) throw new UsageError(`--type must be one of ${SEND_TYPES.join(', ')}`)
        const type = typeText as SendType
        // The bot's Home Chat unless --chat says otherwise (a new chat before 0.6.0).
        const chatText = (str(options, 'chat') ?? 'home').trim()
        const task = await store.get(positional[0])
        if (isClosed(task)) throw new TaskInputError(`${task.id} is ${task.done_at ? 'done' : 'closed'}; reopen it (undone) before sending it to a bot`)
        let chat: 'new' | 'home' | 'existing'
        let chatId: string | undefined
        if (chatText === 'new' || chatText === 'home') chat = chatText
        else if (chatText === 'last') {
          chat = 'existing'
          chatId = lastChat(task) ?? undefined
          if (!chatId) throw new UsageError(`${task.id} has not been in a bot's chat yet; use --chat new or home`)
        } else if (/^(orca_session_id:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatText)) {
          chat = 'existing'
          chatId = chatText.replace(/^orca_session_id:/, '')
        } else throw new UsageError('--chat must be new, home, last or a chat id')
        if (type === 'status' && chat === 'new') throw new UsageError('a status message cannot start a new chat: use --chat home, last or a chat id')
        const after = sendStatus(options, known)
        const notes = !options['no-notes']
        const runOrca = needOrca(io)
        const { bots } = await listBots(runOrca)
        const wanted = str(options, 'to')
        const bot = wanted ? (bots.find((b) => b.name === wanted) ?? bots.find((b) => b.name.toLowerCase() === wanted.toLowerCase().replace(/^bot:/, ''))) : defaultBot(bots, task.project)
        if (!bot) {
          throw new UsageError(wanted ? `no bot named ${wanted}; orca-tasks bots lists them` : 'no bot for this task: its project has none and there is no "Orca" bot; give --to <bot>')
        }
        const note = str(options, 'note')
        const where = chat === 'new' ? 'a new chat' : chat === 'home' ? 'its Home Chat' : `chat ${chatId}`
        if (options['dry-run']) {
          const preview = { bot: bot.name, type, chat, chat_id: chatId ?? null, notes, state: after?.id ?? null, subject: handoffSubject(task, type), body: handoffBody(task, { note, type, notes }) }
          out({ dryRun: true, ...preview }, `Would send a ${type} to ${bot.name} (${where})${after ? `, then move the task to ${after.name}` : ''}:\n${preview.subject}\n\n${preview.body}`)
          return 0
        }
        const byText = str(options, 'by') ?? 'cli'
        if (byText !== 'cli' && byText !== 'panel' && byText !== 'board') throw new UsageError('--by must be cli, panel or board')
        const handoff = await sendToBot(runOrca, { bot, task, chat, chatId, type, notes, note, by: byText, now })
        let saved = await store.recordHandoff(task.id, handoff)
        if (after) saved = await store.update(task.id, { state: after.id, ...(after.kind === 'hold' ? { waiting_on: bot.name } : {}) })
        out(
          { task: saved, handoff },
          `Sent ${task.id} to ${bot.name} as a ${type}${handoff.chat_id ? ` (chat ${handoff.chat_id})` : ''}${handoff.message_id ? `, message ${handoff.message_id}` : ''}${after ? `; now ${after.name}` : ''}`
        )
        return 0
      }
      case 'merge': {
        if (options.undo) {
          if (positional.length > 0) throw new UsageError('merge --undo takes no ids')
          const { keeper, restored } = await store.undoMerge()
          out({ keeper, restored }, `Undid the merge into ${keeper.id}:\n${[keeper, ...restored].map(describe).join('\n')}`)
          return 0
        }
        if (positional.length < 2) throw new UsageError('merge takes the id to keep, then one or more ids to merge into it: orca-tasks merge <keep> <id> [<id>...]')
        const [keepId, ...ids] = positional
        const choices: MergeChoices = {}
        const dueText = str(options, 'due')
        if (dueText !== undefined) {
          const word = dueText.trim().toLowerCase()
          if (word === 'earliest' || word === 'keep' || word === 'none') choices.due = word
          else {
            const parsed = parseDue(dueText, today)
            choices.due = parsed.day === null ? 'none' : { due: parsed.day, due_time: parsed.time }
          }
        }
        const priorityText = str(options, 'priority')
        if (priorityText !== undefined) {
          const word = priorityText.trim().toLowerCase()
          choices.priority = word === 'highest' || word === 'keep' ? word : priorityOf(word)
        }
        const createdText = str(options, 'created')
        if (createdText !== undefined) {
          const word = createdText.trim().toLowerCase()
          if (word !== 'earliest' && word !== 'keep') throw new UsageError('--created must be earliest or keep')
          choices.created = word
        }
        const dryRun = Boolean(options['dry-run'])
        const { keeper, merged } = await store.merge(keepId, ids, choices, { dryRun })
        const head = dryRun ? `Would merge ${merged.map((t) => t.id).join(', ')} into ${keeper.id}:` : `Merged ${merged.map((t) => t.id).join(', ')} into ${keeper.id}:`
        out({ dryRun, keeper, merged }, `${head}\n${describeLong(keeper)}\n${merged.map(describe).join('\n')}${dryRun ? '' : '\nUndo with: orca-tasks merge --undo'}`)
        return 0
      }
      case 'suggest-merges': {
        if (positional.length > 0) throw new UsageError('suggest-merges takes no arguments: orca-tasks suggest-merges [--timeout <seconds>] [--json]')
        const timeoutText = str(options, 'timeout')
        const seconds = timeoutText === undefined ? undefined : Number(timeoutText)
        if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new UsageError('--timeout must be a number of seconds')
        const { tasks } = await store.read()
        const result = await suggestMerges(tasks, store.home, { command: agentFromEnv(env), env, ...(seconds ? { timeoutMs: seconds * 1000 } : {}) })
        const byId = new Map(tasks.map((t) => [t.id, t]))
        const title = (id: string) => `${id} "${byId.get(id)?.title ?? ''}"`
        const lines = result.suggestions.map((s, i) =>
          [
            `${i + 1}. Keep ${title(s.keep)} (${Math.round(s.confidence * 100)}%): ${s.reason}`,
            ...s.ids.filter((id) => id !== s.keep).map((id) => `   merge ${title(id)}`),
            `   orca-tasks merge ${s.keep} ${s.ids.filter((id) => id !== s.keep).join(' ')}`
          ].join('\n')
        )
        const head = result.suggestions.length === 0
          ? `No likely duplicates among ${result.considered} open tasks (${result.agent}).`
          : `${result.suggestions.length} likely duplicate group${result.suggestions.length === 1 ? '' : 's'} among ${result.considered} open tasks (${result.agent}). Nothing is merged until you run merge:`
        const tail = [result.hidden ? `${result.hidden} dismissed before, not shown.` : '', result.leftOut ? `${result.leftOut} older open tasks were left out (at most 300 at a time).` : ''].filter(Boolean)
        out(result, [head, ...lines, ...tail].join('\n'))
        return 0
      }
      case 'bot-status': {
        if (positional.length !== 1) throw new UsageError('bot-status takes one task id')
        const task = await store.get(positional[0])
        const handoff = task.handoffs.at(-1) ?? null
        if (!handoff) {
          out({ task, handoff: null, status: null }, `${task.id} has not been sent to a bot.`)
          return 0
        }
        const status = await taskBotStatus(needOrca(io), task)
        const head = `${task.id} sent to ${handoff.bot} at ${handoff.sent_at}${handoff.returned_at ? `, taken back ${handoff.returned_at}` : ''}`
        const text = status === null
          ? `${head}\nIts chat is not known, so its status cannot be read.`
          : `${head}\nState: ${status.state}${status.error ? ` (${status.error})` : ''}${status.reply ? `\nLatest reply:\n${status.reply}` : ''}`
        out({ task, handoff, status }, text)
        return 0
      }
      case 'take-back': {
        if (positional.length !== 1) throw new UsageError('take-back takes one task id')
        const task = await store.returnHandoff(positional[0])
        out({ task }, `Took back ${describe(task)}`)
        return 0
      }
      case 'statuses': {
        const [sub, ...args] = positional
        const counts = async () => {
          const tasks = (await store.read()).tasks
          return (id: string) => tasks.filter((t) => t.state === id).length
        }
        const show = async (statuses: StatusDef[], head: string) => {
          const count = await counts()
          const rows = statuses.map((s) => ({ ...s, tasks: count(s.id) }))
          out({ statuses: rows }, `${head}${rows.map((s, i) => statusLine(s, s.tasks, i)).join('\n')}\n`)
          return 0
        }
        if (sub === undefined || sub === 'list') {
          if (args.length > 0) throw new UsageError('statuses takes no arguments')
          return show(known.slice(), '')
        }
        const name = args.join(' ').trim()
        if (name === '') throw new UsageError(`statuses ${sub} needs a status name`)
        const kind = str(options, 'kind')
        const color = str(options, 'color')
        const position = positionOf(str(options, 'position'))
        let op: StatusOp
        let head: string
        if (sub === 'add') {
          op = { op: 'add', name, kind: kind === undefined ? undefined : kindOf(kind), color: color === undefined ? undefined : colorOf(color), index: position }
          head = `Added ${name}.\n`
        } else if (sub === 'edit') {
          const def = resolveStatus(known, name)
          const rename = str(options, 'name')
          if (rename === undefined && kind === undefined && color === undefined && position === undefined) throw new UsageError('statuses edit needs --name, --kind, --color or --position')
          if (rename !== undefined || kind !== undefined || color !== undefined) {
            await store.editStatuses({ op: 'update', id: def.id, name: rename, kind: kind === undefined ? undefined : kindOf(kind), color: color === undefined ? undefined : colorOf(color) })
          }
          op = { op: 'move', id: def.id, index: position ?? known.findIndex((s) => s.id === def.id) }
          head = `Changed ${def.name}.\n`
        } else if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
          const def = resolveStatus(known, name)
          const moveTo = str(options, 'move-to')
          op = { op: 'remove', id: def.id, moveTo: moveTo === undefined ? undefined : resolveStatus(known, moveTo).id }
          head = `Deleted ${def.name}.\n`
        } else throw new UsageError(`unknown statuses command "${sub}": use add, edit or rm`)
        return show(await store.editStatuses(op), head)
      }
      case 'help':
        io.stdout(HELP)
        return 0
    }
    throw new UsageError(`unknown command "${first}"`)
  } catch (error) {
    if (error instanceof UsageError) return fail('usage', error.message, 2)
    if (error instanceof DateInputError) return fail('usage', error.message, 2)
    if (error instanceof TaskNotFoundError) return fail('not_found', error.message, 3)
    if (error instanceof TaskInputError) return fail('invalid_params', error.message, 2)
    if (error instanceof StatusError) return fail('invalid_params', error.message, 2)
    if (error instanceof StoreError) return fail(error.code, error.message, 1)
    if (error instanceof BotError) return fail(error.code, error.message, 1)
    if (error instanceof SuggestError) return fail(error.code, error.message, 1)
    const message = error instanceof Error ? error.message : String(error)
    return fail('error', message, 1)
  }
}

interface SendContext {
  store: TaskStore
  io: CliIo
  out: (value: unknown, text: string) => void
  now: () => Date
  known: readonly StatusDef[]
  loadOrca: (refresh?: boolean) => Promise<LoadedProjects>
}

/** The status a sent task moves to: --state, none with --keep-state, else In Progress (none when
 *  the person deleted it). */
function sendStatus(options: Parsed['options'], known: readonly StatusDef[]): StatusDef | null {
  const thenState = str(options, 'state')
  if (options['keep-state']) {
    if (thenState !== undefined) throw new UsageError('--state and --keep-state do not go together')
    return null
  }
  return thenState === undefined ? defaultSendStatus(known) : resolveStatus(known, thenState)
}

/** `send <id> --to-project`: a new workspace in the task's project with a coding agent. */
async function sendToProject(positional: readonly string[], options: Parsed['options'], ctx: SendContext): Promise<number> {
  if (positional.length !== 1) throw new UsageError('send --to-project takes one task id: orca-tasks send <id> --to-project [--agent claude|codex]')
  for (const name of ['to', 'chat', 'type']) if (options[name] !== undefined) throw new UsageError(`--${name} is for sending to a bot, not --to-project`)
  const agentText = (str(options, 'agent') ?? 'claude').trim().toLowerCase()
  if (!(PROJECT_AGENTS as readonly string[]).includes(agentText)) throw new UsageError(`--agent must be one of ${PROJECT_AGENTS.join(', ')}`)
  const agent = agentText as ProjectAgent
  const task = await ctx.store.get(positional[0])
  if (isClosed(task)) throw new TaskInputError(`${task.id} is ${task.done_at ? 'done' : 'closed'}; reopen it (undone) before sending it to its project`)
  const loaded = await ctx.loadOrca(true)
  const target = projectTarget(task, loaded.projects, matchOrcaProject)
  if ('error' in target) throw new TaskInputError(target.error)
  const after = sendStatus(options, ctx.known)
  const notes = !options['no-notes']
  const note = str(options, 'note')
  const cli = ctx.io.env?.ORCA_TASKS_CLI
  if (options['dry-run']) {
    const preview = { project: target.project.name, project_id: target.project.id, workspace_name: workspaceName(task), agent, notes, state: after?.id ?? null, prompt: projectPrompt(task, { note, notes, cli }) }
    ctx.out({ dryRun: true, ...preview }, `Would start workspace ${preview.workspace_name} in ${preview.project} with ${agent}${after ? `, then move the task to ${after.name}` : ''}. Its first prompt:\n\n${preview.prompt}`)
    return 0
  }
  const byText = str(options, 'by') ?? 'cli'
  if (byText !== 'cli' && byText !== 'panel' && byText !== 'board') throw new UsageError('--by must be cli, panel or board')
  const send = await createWorkspaceWithCli(needOrca(ctx.io), { task, project: target.project, agent, note, notes, cli, by: byText, now: ctx.now, activate: Boolean(options.open) })
  let saved = await ctx.store.recordWorkspace(task.id, send)
  if (after) saved = await ctx.store.update(task.id, { state: after.id, ...(after.kind === 'hold' ? { waiting_on: `${agent} in ${send.workspace_name}` } : {}) })
  ctx.out({ task: saved, workspace: send }, `Started workspace ${send.workspace_name} in ${send.project} with ${agent} (${send.workspace_id})${after ? `; now ${after.name}` : ''}`)
  return 0
}

function needOrca(io: CliIo): RunOrca {
  if (!io.runOrca) throw new UsageError('this command needs Orca\'s CLI (orca), which is not available here')
  return io.runOrca
}

/** The task fields given as options, checked. */
function fieldsFrom(options: Parsed['options'], today: string, command: 'add' | 'edit'): TaskPatch {
  const patch: TaskPatch = {}
  const title = str(options, 'title')
  if (title !== undefined) patch.title = title
  const notes = str(options, 'notes')
  if (notes !== undefined) patch.notes = notes
  const due = str(options, 'due')
  if (due !== undefined) {
    const parsed = parseDue(due, today)
    patch.due = parsed.day
    patch.due_time = parsed.time
  }
  const time = str(options, 'time')
  if (time !== undefined) {
    patch.due_time = parseTime(time)
    if (command === 'add' && patch.due_time !== null && !patch.due) throw new UsageError('--time needs a due day: --due <day> --time <HH:MM>, or --due fri@15:30')
  }
  const priority = str(options, 'priority')
  if (priority !== undefined) patch.priority = priorityOf(priority)
  const project = str(options, 'project')
  if (project !== undefined) patch.project = clearable(project)
  const tags = list(options, 'tag')
  if (tags !== undefined) patch.tags = tags.flatMap((tag) => tag.split(',')).map((tag) => tag.trim()).filter((tag) => tag !== '' && tag !== 'none')
  const source = str(options, 'source')
  if (source !== undefined) patch.source = clearable(source)
  if (command === 'add' && patch.tags === undefined) delete patch.tags
  return patch
}
