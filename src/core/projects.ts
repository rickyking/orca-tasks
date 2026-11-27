// Projects: a task's `project` is free text, but when it names one of the person's Orca projects
// it holds that project's name exactly, so tasks line up with Orca's sidebar. Pure functions,
// shared by the CLI, the worker and the panel.

import { statusOf } from './tasks.ts'
import type { Task } from './types.ts'

/** One of the person's Orca projects, as Orca's `project.list` (or `orca repo list`) reports it. */
export interface OrcaProject {
  name: string
  /** Orca's id: `project.list`'s id from the worker, the repo id from `orca repo list`. */
  id: string | null
  kind: 'git' | 'folder' | null
  path: string | null
  hostId: string | null
  hidden: boolean
}

/** What `<home>/orca-projects.json` holds: the worker writes it, the CLI reads it. */
export interface OrcaProjectsFile {
  updated_at: string
  /** `host-api` from the plugin's worker, `orca-cli` from `orca repo list`. */
  from: 'host-api' | 'orca-cli'
  projects: OrcaProject[]
}

function squash(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * The Orca project a typed name means, or null: the exact name, else the same name in another
 * case, else the same letters and digits (`online store` and `@Online-Store` both
 * mean `online-store`). An ambiguous loose match means none.
 */
export function matchOrcaProject(name: string, orca: readonly OrcaProject[]): OrcaProject | null {
  const typed = name.trim()
  if (typed === '') return null
  const exact = orca.find((p) => p.name === typed)
  if (exact) return exact
  const lower = typed.toLowerCase()
  const caseless = orca.filter((p) => p.name.toLowerCase() === lower)
  if (caseless.length === 1) return caseless[0]
  const key = squash(typed)
  if (key === '') return null
  const loose = orca.filter((p) => squash(p.name) === key)
  return loose.length === 1 ? loose[0] : null
}

/** The project name to store: the Orca project's exact name when it names one, else as typed. */
export function canonicalProject(name: string | null | undefined, orca: readonly OrcaProject[]): string | null | undefined {
  if (name === null || name === undefined) return name
  const typed = name.trim()
  if (typed === '') return null
  return matchOrcaProject(typed, orca)?.name ?? typed
}

/** Orca project names that start with (or contain) what was typed, Orca's order kept; at most `limit`. */
export function suggestProjects(typed: string, orca: readonly OrcaProject[], inUse: readonly string[], limit = 6): { name: string; orca: boolean }[] {
  const needle = squash(typed)
  const visible = orca.filter((p) => !p.hidden)
  const score = (name: string) => {
    const key = squash(name)
    if (needle === '') return 1
    if (key.startsWith(needle)) return 2
    if (key.includes(needle)) return 1
    return 0
  }
  const orcaHits = visible
    .map((p) => ({ name: p.name, s: score(p.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => ({ name: x.name, orca: true }))
  const orcaNames = new Set(orca.map((p) => p.name))
  const freeHits = inUse
    .filter((name) => !orcaNames.has(name) && score(name) > 0)
    .sort((a, b) => score(b) - score(a))
    .map((name) => ({ name, orca: false }))
  return [...orcaHits, ...freeHits].slice(0, limit)
}

export interface ProjectGroup<T extends Task = Task> {
  /** null for tasks without a project. */
  project: string | null
  /** Whether `project` is one of the person's Orca projects. */
  orca: boolean
  /** Open tasks: not done and not on hold. */
  open: number
  /** On hold. */
  hold: number
  total: number
  tasks: T[]
}

/**
 * Tasks grouped by project, in the order given within each group. Groups with more open tasks
 * come first (then more tasks, then by name); "No project" is always last.
 */
export function groupByProject<T extends Task>(tasks: readonly T[], orca: readonly OrcaProject[]): ProjectGroup<T>[] {
  const orcaNames = new Set(orca.map((p) => p.name))
  const groups = new Map<string | null, ProjectGroup<T>>()
  for (const task of tasks) {
    const key = task.project
    let group = groups.get(key)
    if (!group) {
      group = { project: key, orca: key !== null && orcaNames.has(key), open: 0, hold: 0, total: 0, tasks: [] }
      groups.set(key, group)
    }
    group.tasks.push(task)
    group.total += 1
    const status = statusOf(task)
    if (status === 'open') group.open += 1
    else if (status === 'hold') group.hold += 1
  }
  return [...groups.values()].sort((a, b) => {
    if (a.project === null) return 1
    if (b.project === null) return -1
    return b.open - a.open || b.total - a.total || a.project.localeCompare(b.project)
  })
}

export interface ProjectSummary {
  name: string
  orca: boolean
  /** Orca's details when `orca` is true. */
  id: string | null
  kind: 'git' | 'folder' | null
  path: string | null
  hidden: boolean
  /** Not done and not on hold. */
  open: number
  hold: number
  done: number
  total: number
}

/**
 * Every Orca project, then every other project tasks use. Orca projects come first, ordered by
 * open tasks, then name; then free-text projects the same way.
 */
export function summarizeProjects(tasks: readonly Task[], orca: readonly OrcaProject[]): ProjectSummary[] {
  const counts = new Map<string, { open: number; hold: number; done: number }>()
  for (const task of tasks) {
    if (task.project === null) continue
    const c = counts.get(task.project) ?? { open: 0, hold: 0, done: 0 }
    const status = statusOf(task)
    if (status === 'done') c.done += 1
    else if (status === 'hold') c.hold += 1
    else c.open += 1
    counts.set(task.project, c)
  }
  const rows: ProjectSummary[] = []
  const seen = new Set<string>()
  for (const p of orca) {
    if (seen.has(p.name)) continue
    seen.add(p.name)
    const c = counts.get(p.name) ?? { open: 0, hold: 0, done: 0 }
    rows.push({ name: p.name, orca: true, id: p.id, kind: p.kind, path: p.path, hidden: p.hidden, open: c.open, hold: c.hold, done: c.done, total: c.open + c.hold + c.done })
  }
  for (const [name, c] of counts) {
    if (seen.has(name)) continue
    rows.push({ name, orca: false, id: null, kind: null, path: null, hidden: false, open: c.open, hold: c.hold, done: c.done, total: c.open + c.hold + c.done })
  }
  return rows.sort((a, b) => Number(b.orca) - Number(a.orca) || b.open - a.open || b.total - a.total || a.name.localeCompare(b.name))
}

/** A project list from Orca's `project.list` answer. */
export function fromHostApi(projects: readonly { id: string; name: string; kind: string; hostId: string | null; path: string; hidden?: boolean }[]): OrcaProject[] {
  return projects.map((p) => ({
    name: p.name,
    id: p.id,
    kind: p.kind === 'git' || p.kind === 'folder' ? p.kind : null,
    path: p.path,
    hostId: p.hostId,
    hidden: p.hidden === true
  }))
}

/** A project list from `orca repo list --json`'s `result.repos`. */
export function fromOrcaCli(repos: readonly { id?: unknown; displayName?: unknown; kind?: unknown; path?: unknown }[]): OrcaProject[] {
  return repos
    .filter((r) => typeof r.displayName === 'string' && r.displayName !== '')
    .map((r) => ({
      name: r.displayName as string,
      id: typeof r.id === 'string' ? r.id : null,
      kind: r.kind === 'git' || r.kind === 'folder' ? r.kind : null,
      path: typeof r.path === 'string' ? r.path : null,
      hostId: 'local',
      hidden: false
    }))
}
