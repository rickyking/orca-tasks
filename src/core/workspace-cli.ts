// `orca-tasks send <id> --to-project`: a new Orca workspace in the task's project with a coding
// agent, made with Orca's own CLI (`orca worktree create --project ... --agent ... --prompt ...`).
// Runs only when someone runs that command. The worker uses Orca's host API instead.

import { BotError, type RunOrca } from './bots.ts'
import { projectPrompt, workspaceName } from './project-send.ts'
import type { ProjectAgent, ProjectSend, Task } from './types.ts'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export interface CliCreateOptions {
  task: Task
  project: { name: string; id: string | null }
  agent: ProjectAgent
  note?: string
  notes?: boolean
  cli?: string
  by: ProjectSend['by']
  now?: () => Date
  /** Show it in Orca's window. */
  activate?: boolean
}

/** The `orca worktree create` arguments the CLI sends a task to its project with. */
export function worktreeCreateArgs(options: Omit<CliCreateOptions, 'by' | 'now'>): string[] {
  const prompt = projectPrompt(options.task, { note: options.note, notes: options.notes, cli: options.cli })
  const args = ['worktree', 'create', '--project', options.project.name, '--name', workspaceName(options.task), '--agent', options.agent, '--prompt', prompt, '--no-parent']
  if (options.activate) args.push('--activate')
  args.push('--json')
  return args
}

/** Creates the workspace with Orca's CLI (`orca-tasks send --to-project`) and answers the record
 *  to keep on the task. */
export async function createWorkspaceWithCli(run: RunOrca, options: CliCreateOptions): Promise<ProjectSend> {
  const now = options.now ?? (() => new Date())
  const args = worktreeCreateArgs(options)
  const sentAt = now()
  const answer = await run(args)
  let parsed: Record<string, unknown> = {}
  try {
    parsed = record(JSON.parse(answer.stdout))
  } catch {
    const said = (answer.stderr || answer.stdout).trim().split('\n').slice(0, 3).join(' ')
    throw new BotError(answer.code === 127 ? 'orca_missing' : 'orca_failed', `orca worktree create failed${said ? `: ${said}` : ''}`)
  }
  if (parsed.ok === false || answer.code !== 0) {
    const error = record(parsed.error)
    throw new BotError(typeof error.code === 'string' ? error.code : 'orca_failed', `orca worktree create failed: ${typeof error.message === 'string' ? error.message : (answer.stderr || 'no details').trim()}`)
  }
  const result = record(parsed.result ?? parsed)
  const worktree = record(result.worktree ?? result)
  const id = typeof worktree.id === 'string' ? worktree.id : null
  if (!id) throw new BotError('orca_failed', 'orca worktree create did not name the new workspace')
  const launch = record(result.launch)
  const outcome = record(launch.outcome)
  const terminal = typeof result.agentTerminalHandle === 'string' ? result.agentTerminalHandle : typeof outcome.handle === 'string' ? outcome.handle : null
  return {
    project: options.project.name,
    project_id: options.project.id,
    workspace_id: id,
    workspace_name: typeof worktree.displayName === 'string' && worktree.displayName !== '' ? worktree.displayName : workspaceName(options.task),
    terminal_id: terminal,
    agent: options.agent,
    sent_at: sentAt.toISOString(),
    by: options.by
  }
}
