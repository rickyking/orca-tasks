// Sending a task to its project: a new Orca workspace (a branch and worktree of the project) with
// a coding agent whose first prompt is the task. The worker does it with Orca's host API
// (`workspace.create` with `agent` and `prompt`, which needs the `workspace:create` and
// `agent:launch` capabilities); the CLI with `orca worktree create --project ... --agent ...
// --prompt ...`. Nothing here sends on its own: only when the person presses the button or runs
// `orca-tasks send <id> --to-project` (core/workspace-cli.ts). Pure functions: the panel uses
// them too.

import type { OrcaProject } from './projects.ts'
import { sourcesOf } from './tasks.ts'
import type { ProjectAgent, Task } from './types.ts'

/** The longest first prompt Orca takes (`workspace.create`'s `prompt`). */
export const PROMPT_MAX = 4096
/** The longest workspace name used (Orca takes 200; the branch takes it too). */
const NAME_MAX = 48

/** The Orca project a task can be sent to, or why it cannot: its own project, or `chosen` (any
 *  of the person's Orca projects, picked in the send menu) when given. */
export function projectTarget(
  task: Task,
  orca: readonly OrcaProject[],
  match: (name: string, orca: readonly OrcaProject[]) => OrcaProject | null,
  chosen?: string
): { project: OrcaProject } | { error: string } {
  const name = chosen ?? task.project
  if (!name) return { error: 'This task has no project: set its Project to one of your Orca projects first.' }
  const project = match(name, orca)
  if (!project || !project.id) return { error: `${name} is not one of your Orca projects, so there is nowhere to start a workspace.` }
  if (project.kind === 'folder') return { error: `${project.name} is a folder project; Orca starts new workspaces only in Git projects.` }
  return { project }
}

/** A name for the new workspace: the task's title in a few words, and the start of its id so two
 *  tasks with the same title get two names (`fix-the-login-bug-2ec2`). */
export function workspaceName(task: Task): string {
  const words = task.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const tail = task.id.replace(/^t-/, '').slice(0, 4)
  let base = words.slice(0, NAME_MAX - tail.length - 1).replace(/-+$/, '')
  if (base === '') base = 'task'
  return `${base}-${tail}`
}

export interface PromptOptions {
  /** A line from the person, put above the task. */
  note?: string
  /** Whether the task's notes go with it (default yes). */
  notes?: boolean
  /** The CLI's path, so the agent can read the task again and tick it off. */
  cli?: string
  /** The project the workspace is in, when it is not the task's own. */
  project?: string
}

/** The agent's first prompt: what the person asks, the task (title, due, priority, tags, source,
 *  notes), and how to report back; cut to PROMPT_MAX, notes first. */
export function projectPrompt(task: Task, options: PromptOptions = {}): string {
  const cli = options.cli ?? 'orca-tasks'
  const head = [`Your owner sent you this task from Agent Tasks (their task list in Orca). Work on it in this workspace, a new branch of ${options.project ?? task.project ?? 'the project'}.`, '']
  if (options.note && options.note.trim() !== '') head.push(options.note.trim(), '')
  head.push(`Task: ${task.title}`)
  if (task.due) head.push(`Due: ${task.due}${task.due_time ? ` ${task.due_time}` : ''}`)
  if (task.priority !== 'none') head.push(`Priority: ${task.priority}`)
  if (task.tags.length) head.push(`Tags: ${task.tags.map((t) => `#${t}`).join(' ')}`)
  const sources = sourcesOf(task)
  if (sources.length === 1) head.push(`Source: ${sources[0]}`)
  else if (sources.length > 1) head.push(`Sources: ${sources.join(', ')}`)
  head.push(`Task id: ${task.id}`)
  const tail = ['', `To read the task again: ${cli} get ${task.id} --json. When you have finished, say what you did here; your owner ticks the task off.`]
  const notes = options.notes !== false ? task.notes.trim() : ''
  const without = [...head, ...tail].join('\n')
  if (notes === '') return cut(without)
  const room = PROMPT_MAX - without.length - '\n\nNotes:\n'.length
  const cutNote = `\n…(the notes go on: ${cli} get ${task.id})`
  const body = notes.length <= room ? notes : room > cutNote.length + 20 ? `${notes.slice(0, room - cutNote.length)}${cutNote}` : null
  return cut(body === null ? without : [...head, '', 'Notes:', body, ...tail].join('\n'))
}

function cut(text: string): string {
  return text.length <= PROMPT_MAX ? text : `${text.slice(0, PROMPT_MAX - 1)}…`
}

/** What an agent in a workspace is doing, as `workspace.list` with `includeStatus` says. */
export interface WorkspaceStatus {
  /** `working`, `permission` (waiting for the person to allow something), `done`, `active` (open,
   *  no agent turn), `inactive`; `gone` when the workspace is no longer listed, `unknown` when
   *  Orca could not be asked. */
  state: 'working' | 'permission' | 'done' | 'active' | 'inactive' | 'gone' | 'unknown'
  unread: boolean
  lastActivityAt: number | null
  /** Why it could not be read. */
  error?: string
}

interface ListedWorkspace {
  id: string
  name?: string
  status?: { state: string; unread: boolean; lastActivityAt: number | null }
}

const STATES = new Set(['working', 'permission', 'done', 'active', 'inactive'])

/** The status of workspace `id` among those `workspace.list` gave. */
export function workspaceStatus(workspaces: readonly ListedWorkspace[], id: string, truncated = false): WorkspaceStatus {
  const row = workspaces.find((w) => w.id === id)
  if (!row) return { state: truncated ? 'unknown' : 'gone', unread: false, lastActivityAt: null }
  const s = row.status
  return { state: s && STATES.has(s.state) ? (s.state as WorkspaceStatus['state']) : 'unknown', unread: s?.unread === true, lastActivityAt: s?.lastActivityAt ?? null }
}

/** Words for a workspace status, for the panel and the CLI. */
export function workspaceStatusWords(status: WorkspaceStatus | null | undefined): string {
  switch (status?.state) {
    case 'working':
      return 'working'
    case 'permission':
      return 'waiting for your permission'
    case 'done':
      return status.unread ? 'done, not read yet' : 'done'
    case 'active':
      return 'open, idle'
    case 'inactive':
      return 'asleep'
    case 'gone':
      return 'workspace removed'
    default:
      return 'status not known'
  }
}
