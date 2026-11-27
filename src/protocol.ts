// The sidebar/board <-> worker contract, declared once: src/board/board.ts (the sidebar panel and
// the board tab) and src/worker.ts both read it.
import type { Bot, BotStatus } from './core/bots.ts'
import type { CreatedChoice, DueChoice, PriorityChoice } from './core/merge.ts'
import type { WorkspaceStatus } from './core/project-send.ts'
import type { OrcaProject, ProjectSummary } from './core/projects.ts'
import type { NavLogInput } from './core/nav-log.ts'
import type { BotSendInput, ProjectSendInput } from './core/send-input.ts'
import type { SuggestResult } from './core/suggest.ts'
import type { StatusOp } from './core/statuses.ts'
import type { Handoff, ProjectAgent, ProjectSend, SendType, StatusDef, Task, TaskPatch, View } from './core/types.ts'

export interface TaskPaths {
  /** The folder everything lives in, `~/.orca-tasks`. */
  home: string
  /** The task list, `~/.orca-tasks/tasks.json`. */
  data: string
  /** The append-only inbox, `~/.orca-tasks/inbox.md`. */
  inbox: string
  /** The CLI the worker installed for agents, or null when it could not. */
  cli: string | null
}

/** What the send form chose last time, per project (the worker keeps it in
 *  `~/.orca-tasks/send-prefs.json`). The instruction line is not kept. */
export interface SendPrefs {
  bot: string
  type: SendType
  /** `last`: the chat the task was last sent to, when it has one. */
  chat: 'new' | 'home' | 'last'
  /** Whether the notes go with it. */
  notes: boolean
  /** The status to move the task to after sending (an id), or null. */
  state: string | null
  /** The person chose to leave the status as it is (state null). Null state without it: nothing
   *  remembered, so the form starts at In Progress. */
  keepState: boolean
  /** The chat was chosen in 0.6.0 or later, when the form starts at the Home Chat. A remembered
   *  new chat without it is from before and starts at the Home Chat once. */
  chatChosen: boolean
}

/** What the send-to-project form chose last time, per project. */
export interface ProjectPrefs {
  agent: ProjectAgent
  notes: boolean
  state: string | null
  /** As for a bot send: "leave the status as it is" was the choice. */
  keepState: boolean
  open: boolean
}

/** Whether a task can be sent to its project. */
export interface ProjectOffer {
  /** The Orca project it would start a workspace in, by name, or null. */
  project: string | null
  /** Why it cannot be sent (no project, not an Orca project, a folder project), else null. */
  error: string | null
  /** What to approve when Orca has not given Agent Tasks the capabilities it needs, else null. */
  access: string | null
  agents: ProjectAgent[]
  last: ProjectPrefs | null
}

/** The bots to offer for one task: its project's bot first, then Orca, then the rest. */
export interface BotOffer {
  bots: Bot[]
  /** The bot of the task's project, by name, or null. */
  project: string | null
  /** The main bot ("Orca"), by name, or null. */
  main: string | null
  /** The one Send picks unless the person chooses another. */
  default: string | null
  unreachable: string[]
  /** Why the bots could not be listed (Orca's CLI missing or failing), else null. */
  error: string | null
  /** The chat the task was last sent to, when Orca named it; "its earlier chat" sends there. */
  lastChat: string | null
  /** What was chosen the last time a task of this project (or of no project) was sent. */
  last: SendPrefs | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Every task, with the revision of the file they were read from, and what the bots a task
     *  was sent to last said (by task id; only tasks with a bot and a known chat). */
    'tasks.list': { output: { tasks: Task[]; revision: number; today: string; bots: Record<string, BotStatus>; workspaces?: Record<string, WorkspaceStatus>; statuses: StatusDef[]; canUndoMerge?: boolean } }
    /** Changes the statuses (add, rename, recolour, change kind, move, delete); tasks follow. */
    'tasks.statuses': { input: StatusOp; output: { statuses: StatusDef[] } }
    /** Adds a task from one line of text, markers and all (`!high @project #tag due:fri@15:30`,
     *  and `@today`/`@fri` for the due day). `view` gives a due day when the line names none:
     *  today for Today, tomorrow for Upcoming. `project` is used when the line names none. */
    'tasks.add': { input: { text: string; view?: View; project?: string | null; hold?: boolean; state?: string }; output: { task: Task } }
    'tasks.update': { input: { id: string; patch: TaskPatch }; output: { task: Task } }
    /** Dragging: moves a task to status `state` (null: the one it is in) and sets that section's
     *  order to `order` (task ids, first to last). */
    'tasks.move': { input: { id: string; state: string | null; order: string[] }; output: { task: Task } }
    /** What the sidebar or the board was showing (open sections, filters, view), kept by the worker
     *  in `~/.orca-tasks/ui-state.json` because an isolated frame may not keep its own storage. */
    'tasks.uiState': { input: { surface: 'sidebar' | 'board'; set?: Record<string, unknown> }; output: { state: Record<string, unknown> | null } }
    'tasks.setDone': { input: { id: string; done: boolean }; output: { task: Task } }
    'tasks.delete': { input: { id: string }; output: { task: Task } }
    /** The person's Orca projects (from Orca's `project.list`), and every project with counts. */
    'tasks.projects': { output: { orca: OrcaProject[]; summary: ProjectSummary[] } }
    /** Shows an Orca project's workspace in Orca: its own checkout or folder, else its first one. */
    'tasks.openProject': { input: { name: string }; output: { opened: boolean; workspace: string } }
    /** Where the list, the inbox and the CLI are, for the panel's "For agents" section. */
    'tasks.paths': { output: TaskPaths }
    /** Orca's bots (`orca bot list`), with the ones to offer for this task. */
    'tasks.bots': { input: { id?: string }; output: BotOffer }
    /** Sends the task to a bot (`orca orchestration send --to bot:<name> --type <type>`), records
     *  it on the task, moves the task to `state` when given, and remembers the choices for the
     *  task's project. Only ever called when the person presses Send. The input is plain JSON
     *  (core/send-input.ts builds it): Orca refuses a field set to `undefined`. */
    'tasks.send': {
      input: Pick<BotSendInput, 'id' | 'bot'> & Partial<BotSendInput>
      output: { task: Task; handoff: Handoff }
    }
    /** Whether the task can be sent to its project (or to `project`, another of the person's Orca
     *  projects), and the choices made last time for that project. */
    'tasks.projectOffer': { input: { id: string; project?: string }; output: ProjectOffer }
    /** Sends the task to its project (or to `project`, from the send menu): a new Orca workspace (`workspace.create`) with `agent`, whose
     *  first prompt is the task; records it on the task and moves it to `state` when given. Only
     *  ever called when the person presses Send to project. */
    'tasks.sendToProject': { input: Pick<ProjectSendInput, 'id'> & Partial<ProjectSendInput>; output: { task: Task; workspace: ProjectSend } }
    /** Reads the agent status of the workspace the task was sent to, now. */
    'tasks.workspaceStatus': { input: { id: string }; output: { status: WorkspaceStatus | null } }
    /** Shows the workspace the task was sent to in Orca. */
    'tasks.openWorkspace': { input: { id: string }; output: { opened: boolean; workspace: string } }
    /** Merges the tasks `ids` into `keep` (core/merge.ts); with `dryRun`, only says what it would do. */
    'tasks.merge': {
      input: { keep: string; ids: string[]; due?: DueChoice; priority?: PriorityChoice; created?: CreatedChoice; dryRun?: boolean }
      output: { keeper: Task; merged: Task[] }
    }
    /** Asks Claude Code which open tasks look like duplicates (core/suggest.ts): groups with the
     *  task to keep, a reason and a confidence, without the ones dismissed before. Merges nothing;
     *  only ever called when the person presses Suggest merges. */
    'tasks.suggestMerges': { output: SuggestResult }
    /** Dismisses a suggestion: its pairs of tasks are not suggested again. */
    'tasks.dismissMerge': { input: { ids: string[] }; output: { dismissed: boolean } }
    /** Undoes the latest merge, when nothing it touched changed since. */
    'tasks.undoMerge': { output: { keeper: Task; restored: Task[] } }
    /** Reads the chat the task was sent to, now. */
    'tasks.botStatus': { input: { id: string }; output: { status: BotStatus | null } }
    /** Takes the task back from its bot. */
    'tasks.takeBack': { input: { id: string }; output: { task: Task } }
    /** Opens the board (the center tab) in Orca's focused workspace. */
    'tasks.openBoard': { output: { opened: boolean; reason?: string } }
    /** Writes what the page saw of events that could be a mouse's back or forward gesture to the
     *  plugin's log (core/nav-log.ts); nothing about tasks. */
    'tasks.navLog': { input: NavLogInput; output: { logged: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the file changed, from the panel, an agent or the inbox,
     *  or when the day turned over, or when a bot's chat changed. */
    'tasks.changed': { revision: number; today: string }
  }
}
