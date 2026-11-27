// The data model, shared by the store, the CLI, the worker and the panel. Plain JSON only.

/** Most pressing first. `none` is a task without a priority. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const
export type Priority = (typeof PRIORITIES)[number]

/** `open`, `hold` (waiting on someone else's input) or `done` (closed). Kept from 0.1.0-0.3.0 for
 *  readers that know only these: since 0.4.0 it follows the task's `state` (one of the person's
 *  statuses) by that status's kind: open -> `open`, hold -> `hold`, done and cancelled -> `done`. */
export const STATUSES = ['open', 'hold', 'done'] as const
export type TaskStatus = (typeof STATUSES)[number]

/** What a status means, whatever it is called: `open` (to do, in progress...), `hold` (open,
 *  waiting on someone else's input), `done` (closed, completed) or `cancelled` (closed, not
 *  completed). Since 0.4.0. */
export const STATUS_KINDS = ['open', 'hold', 'done', 'cancelled'] as const
export type StatusKind = (typeof STATUS_KINDS)[number]

/** The colours a status can have; the panel and the board draw each in the theme's own shade. */
export const STATUS_COLORS = ['gray', 'blue', 'purple', 'teal', 'green', 'amber', 'orange', 'red', 'pink'] as const
export type StatusColor = (typeof STATUS_COLORS)[number]

/** One of the person's task statuses (the file's `statuses`, in the order shown). Since 0.4.0. */
export interface StatusDef {
  /** Stable: tasks name their status by it. Lowercase letters, digits and `-`. */
  id: string
  /** What the person calls it; unique, any case. */
  name: string
  color: StatusColor
  kind: StatusKind
  /** Done and cancelled statuses are closed; written so readers of the file need not work it out. */
  closed: boolean
  /** Fields written by a newer version are kept as they are. */
  [extra: string]: unknown
}

export interface Task {
  /** Stable id, never reused or changed: `t-` and lowercase letters and digits. */
  id: string
  title: string
  /** Free text; empty when there are none. */
  notes: string
  /** ISO 8601 timestamp (UTC). */
  created_at: string
  /** ISO 8601 timestamp (UTC) of the last change. */
  updated_at: string
  /** The day it is due, `YYYY-MM-DD` in local time, or null for none (the Inbox). */
  due: string | null
  priority: Priority
  /** Free name, or null. */
  project: string | null
  /** Without the `#`. */
  tags: string[]
  /** Where the task came from: an issue URL, `chat:<id>`, `issue:<id>`... or null. */
  source: string | null
  /** ISO 8601 timestamp (UTC) when it was completed, or null while it is open. */
  done_at: string | null
  /** `open`, `hold` or `done`, from the kind of `state` (done and cancelled are both `done`). */
  status: TaskStatus
  /** On hold: who or what it waits on ("Bob's review"), or null. */
  waiting_on: string | null
  /** On hold: when it was put on hold (ISO 8601, UTC), or null. */
  held_at: string | null
  /** The id of its status, one of the file's `statuses`. Since 0.4.0. */
  state: string
  /** That status's name, written so readers of the file need not look it up. Since 0.4.0. */
  state_name: string
  /** When it was closed (done or cancelled; ISO 8601, UTC), or null while it is open. Equal to
   *  `done_at` for a done task; a cancelled task has `closed_at` and no `done_at`. Since 0.4.0. */
  closed_at: string | null
  /** A time of day on the due day, `HH:MM` in local time, or null (due by the end of the day).
   *  Only set when `due` is. Since 0.3.0. */
  due_time: string | null
  /** Each time the task was sent to an Orca bot, oldest first. Since 0.3.0. */
  handoffs: Handoff[]
  /** Each time the task was sent to its project: a new Orca workspace with a coding agent, oldest
   *  first. Missing on tasks never sent to a project. Since 0.5.0. */
  workspaces?: ProjectSend[]
  /** Every source the task holds, its own `source` first, then those of tasks merged into it.
   *  Missing on tasks nothing was merged into. Since 0.5.0. */
  sources?: string[]
  /** Set on a task merged into another: the id of the task it was merged into (the keeper). The
   *  task stays, cancelled, so it can still be found. Since 0.5.0. */
  merged_into?: string | null
  /** When it was merged into `merged_into` (ISO 8601, UTC). Since 0.5.0. */
  merged_at?: string | null
  /** On a keeper: the ids of the tasks merged into it, oldest merge first. Since 0.5.0. */
  merged_from?: string[]
  /** Its place within its status when the person ordered the section by dragging: lower first.
   *  Missing (or null) on tasks never dragged into place; those come first, in the usual order
   *  (due day, then priority). Only the panel and the board use it. Since 0.4.1. */
  rank?: number | null
  /** Fields written by a newer version are kept as they are. */
  [extra: string]: unknown
}

/** What a message to a bot asks of it (`orca orchestration send --type`): `handoff`, the bot owns
 *  the job; `question`, it only answers; `status`, information with nothing back. Since 0.4.0. */
export const SEND_TYPES = ['handoff', 'question', 'status'] as const
export type SendType = (typeof SEND_TYPES)[number]

/** A task sent to an Orca bot with `orca orchestration send --to bot:<name> --type <type>`. */
export interface Handoff {
  /** The bot's name, as `orca bot list` gives it. */
  bot: string
  /** The bot's id, when known. */
  bot_id: string | null
  /** `handoff`, `question` or `status`; `handoff` for records written before 0.4.0. */
  type: SendType
  /** `new`: a chat of its own (`--chat new`); `home`: the bot's Home Chat; `existing`: a chat it
   *  already had (`--chat <id>`, the task's earlier chat). */
  chat: 'new' | 'home' | 'existing'
  /** The chat it landed in (its Orca session id, without `orca_session_id:`), when known. */
  chat_id: string | null
  /** The message id `orca orchestration send` answered, when known. */
  message_id: string | null
  subject: string
  /** ISO 8601 (UTC). */
  sent_at: string
  /** Where the person pressed send: the panel, the board or the CLI. */
  by: 'panel' | 'board' | 'cli'
  /** When it was taken back from the bot (ISO 8601, UTC), or null while the bot has it. */
  returned_at: string | null
}

/** The coding agents a task can be sent to its project with (`workspace.create`'s `agent`). */
export const PROJECT_AGENTS = ['claude', 'codex'] as const
export type ProjectAgent = (typeof PROJECT_AGENTS)[number]

/** A task sent to its project: a new Orca workspace (a branch and worktree of the project) with a
 *  coding agent whose first prompt is the task. Since 0.5.0. */
export interface ProjectSend {
  /** The task's project, by name, as Orca's `project.list` gives it. */
  project: string
  /** Orca's id for it. */
  project_id: string | null
  /** The new workspace, as `workspace.list` (or `orca worktree list`) gives its id. */
  workspace_id: string
  /** The name it was created with (its branch takes it too). */
  workspace_name: string
  /** The agent's terminal, when Orca named it. */
  terminal_id: string | null
  agent: ProjectAgent
  /** ISO 8601 (UTC). */
  sent_at: string
  /** Where the person pressed send: the panel, the board or the CLI. */
  by: 'panel' | 'board' | 'cli'
}

/** The data schema this version writes. 1: 0.1.0 and 0.2.0 files (no `schema` field); 2: 0.3.0
 *  adds `due_time` and `handoffs` on every task; 3: 0.4.0 adds the file's `statuses` and each
 *  task's `state`, `state_name` and `closed_at`. 0.5.0 stays at 3: its new fields are optional and
 *  only on the tasks they apply to (`workspaces` when sent to a project; `sources`, `merged_into`,
 *  `merged_at`, `merged_from` when merged) and the file's `last_merge`, and older readers keep
 *  fields they do not know, so this is not a format `version` change either. */
export const SCHEMA = 3

/** The whole file at `<home>/tasks.json`. */
export interface TaskFile {
  format: 'orca-tasks'
  /** Bumped only for a change older readers cannot read. */
  version: 1
  /** Which fields tasks carry (see SCHEMA); missing in files written before 0.3.0. */
  schema?: number
  /** The person's statuses, in the order shown. Missing before 0.4.0: the defaults. */
  statuses?: StatusDef[]
  /** Goes up by one on every write, so a reader can tell whether anything changed. */
  revision: number
  updated_at: string
  tasks: Task[]
  /** The latest merge, so it can be undone: every task it changed, as it was before. Since 0.5.0. */
  last_merge?: LastMerge | null
  [extra: string]: unknown
}

/** What undoing the latest merge puts back. */
export interface LastMerge {
  /** When it was merged (ISO 8601, UTC); a task changed after it is not put back. */
  at: string
  keeper: string
  merged: string[]
  /** The keeper and the merged tasks as they were before. */
  before: Task[]
}

/** What a caller may set when it adds a task. */
export interface NewTask {
  title: string
  notes?: string
  due?: string | null
  priority?: Priority
  project?: string | null
  tags?: string[]
  source?: string | null
  /** Add it already completed, at this time (ISO 8601). */
  done_at?: string | null
  /** Add it on hold, waiting on this. */
  waiting_on?: string | null
  /** `HH:MM` on the due day. */
  due_time?: string | null
  /** Its status, by id or name; default from done_at and waiting_on, else the first open one. */
  state?: string | null
}

/** What a caller may change on a task; an absent field is left alone. */
export interface TaskPatch {
  title?: string
  notes?: string
  due?: string | null
  priority?: Priority
  project?: string | null
  tags?: string[]
  source?: string | null
  /** Completing a task takes it off hold. */
  done_at?: string | null
  /** A string puts the task on hold (keeping when it first went on hold); null takes it off. */
  waiting_on?: string | null
  /** `HH:MM` on the due day, or null. Cleared when the due day is. */
  due_time?: string | null
  /** Its status, by id or name. Wins over done_at and waiting_on for which status it lands in;
   *  waiting_on still sets what a hold status waits on, done_at when a done one was completed. */
  state?: string
}

export type View = 'today' | 'upcoming' | 'inbox' | 'done'
export const VIEWS: readonly View[] = ['today', 'upcoming', 'inbox', 'done']

export interface TaskFilter {
  /** Which statuses; default all of them. The CLI defaults to `open`. */
  statuses?: readonly TaskStatus[]
  /** In one of these of the person's statuses (ids). */
  states?: readonly string[]
  /** Completed at or after this instant (ISO 8601). Implies done tasks. */
  doneSince?: string
  /** Due on or after this day (`YYYY-MM-DD`). */
  dueFrom?: string
  /** Due on or before this day (`YYYY-MM-DD`). */
  dueTo?: string
  /** true: only tasks without a due day; false: only tasks with one. */
  noDue?: boolean
  project?: string
  /** Every tag listed must be on the task. */
  tags?: string[]
  /** Exact match. */
  source?: string
  /** Case-insensitive text in the title or notes. */
  text?: string
  /** One of the panel's views, worked out for `today`. */
  view?: View
  /** Open, not on hold, and past due: due before today, or today at a time already past. */
  overdue?: boolean
  /** Sent to a bot and not taken back. */
  withBot?: boolean
}
