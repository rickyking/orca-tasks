// The task list on disk, shared by the Orca panel (through the plugin's worker) and by agents
// (through the CLI). One JSON file, `<home>/tasks.json`, where `<home>` is `~/.orca-tasks`.
//
// Safe when several programs write at once:
// - every change takes `<home>/tasks.json.lock` (created exclusively), reads the file, changes
//   it, writes a temporary file beside it and renames it over `tasks.json`, then lets the lock go;
// - readers never take the lock: a rename replaces the file in one step, so a reader sees the
//   old list or the new one, never half of either;
// - a lock left by a process that died (its pid is gone, or it is older than `staleLockMs`) is
//   cleared by the next writer.

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localDay, localTime } from './dates.ts'
import { parseLines } from './line.ts'
import { canonicalProject, type OrcaProject } from './projects.ts'
import { applyStatusOp, normalizeStatuses, type StatusOp } from './statuses.ts'
import { keeperOf, mergeTasks, type MergeChoices } from './merge.ts'
import { emptyFile, filterTasks, findTask, isClosed, makeTask, newId, normalizeTask, patchTask, restateTask, sourcesOf, TaskInputError } from './tasks.ts'
import { SCHEMA, type Handoff, type NewTask, type ProjectSend, type StatusDef, type Task, type TaskFile, type TaskFilter, type TaskPatch } from './types.ts'

export const DATA_FILE = 'tasks.json'
export const INBOX_FILE = 'inbox.md'

/** `ORCA_TASKS_HOME` when set (tests, a second list), else `~/.orca-tasks`. */
export function defaultHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.ORCA_TASKS_HOME
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.orca-tasks')
}

export interface StoreOptions {
  /** The folder that holds tasks.json; defaults to defaultHome(). */
  home?: string
  now?: () => Date
  random?: () => number
  /** How long a writer waits for the lock before giving up. */
  lockTimeoutMs?: number
  /** A lock older than this is taken to be left by a process that died. */
  staleLockMs?: number
  /** The person's Orca projects: a project typed loosely (`@Online-Store`) is stored as
   *  the Orca project's exact name. */
  orcaProjects?: () => Promise<readonly OrcaProject[]> | readonly OrcaProject[]
}

export class StoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

export interface AddResult {
  task: Task
  /** False when `dedupe` found a task with the same source and returned it instead. */
  created: boolean
}

export class TaskStore {
  readonly home: string
  readonly path: string
  readonly lockPath: string
  readonly inboxPath: string
  private readonly now: () => Date
  private readonly random: () => number
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number
  private readonly orcaProjects: () => Promise<readonly OrcaProject[]> | readonly OrcaProject[]

  constructor(options: StoreOptions = {}) {
    this.home = options.home ?? defaultHome()
    this.path = join(this.home, DATA_FILE)
    this.lockPath = `${this.path}.lock`
    this.inboxPath = join(this.home, INBOX_FILE)
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000
    this.staleLockMs = options.staleLockMs ?? 30_000
    this.orcaProjects = options.orcaProjects ?? (() => [])
  }

  today(): string {
    return localDay(this.now())
  }

  /** The whole file as it is now; an empty list when there is no file yet. */
  async read(): Promise<TaskFile> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyFile(this.now())
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new StoreError('corrupt', `${this.path} is not valid JSON; fix or move it away (nothing was changed)`)
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as TaskFile).tasks)) {
      throw new StoreError('corrupt', `${this.path} is not an orca-tasks file (no "tasks" list)`)
    }
    const file = raw as TaskFile
    if (typeof file.version === 'number' && file.version > 1) {
      throw new StoreError('too_new', `${this.path} was written by a newer orca-tasks (format version ${file.version})`)
    }
    return migrateFile(file)
  }

  /** The person's statuses, in order. */
  async statuses(): Promise<StatusDef[]> {
    return (await this.read()).statuses ?? normalizeStatuses(undefined)
  }

  /** Changes the list of statuses (add, rename, recolour, change kind, move, delete) under the
   *  lock, and brings every task in line: tasks of a deleted status move as the change says, and
   *  tasks of a status whose kind or name changed get the fields that follow from it. */
  async editStatuses(op: StatusOp): Promise<StatusDef[]> {
    return this.mutate((file) => {
      const { statuses, moves } = applyStatusOp(file.statuses ?? normalizeStatuses(undefined), op)
      file.statuses = statuses
      file.tasks = file.tasks.map((task) => restateTask(task, statuses, moves, this.now()))
      return statuses
    })
  }

  /** The schema the file on disk has: 1 for files written before 0.3.0. */
  async schemaOnDisk(): Promise<number> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as { schema?: unknown }
      return typeof raw.schema === 'number' ? raw.schema : 1
    } catch {
      return SCHEMA
    }
  }

  /** Writes the file in the current schema when it is older; answers whether it wrote. Reading
   *  already migrates in memory, so this only makes the change last. */
  async migrate(): Promise<boolean> {
    if ((await this.schemaOnDisk()) >= SCHEMA) return false
    return this.mutate(() => true)
  }

  /**
   * Runs `change` on the current file under the lock and writes what it leaves, unless it returns
   * `{ write: false }`. Everything that changes the list goes through here.
   */
  async mutate<T>(change: (file: TaskFile) => T | { result: T; write: false }): Promise<T> {
    await mkdir(this.home, { recursive: true })
    await this.lock()
    try {
      const file = await this.read()
      const outcome = change(file)
      if (outcome && typeof outcome === 'object' && (outcome as { write?: unknown }).write === false) {
        return (outcome as { result: T }).result
      }
      file.revision += 1
      file.updated_at = this.now().toISOString()
      file.schema = Math.max(SCHEMA, file.schema ?? SCHEMA)
      await this.write(file)
      return outcome as T
    } finally {
      await this.unlock()
    }
  }

  private async write(file: TaskFile): Promise<void> {
    const temp = `${this.path}.${process.pid}.${Math.floor(this.random() * 1e9).toString(36)}.tmp`
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temp, this.path)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }

  private async lock(): Promise<void> {
    const started = Date.now()
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx')
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
        } finally {
          await handle.close()
        }
        return
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      if (await this.clearStaleLock()) continue
      if (Date.now() - started > this.lockTimeoutMs) {
        throw new StoreError('locked', `${this.lockPath} has been held for over ${this.lockTimeoutMs} ms; if no orca-tasks program is running, delete it`)
      }
      await sleep(Math.min(100, 5 + attempt * 5) + Math.floor(this.random() * 10))
    }
  }

  /** Removes a lock its owner left behind; true when it did. */
  private async clearStaleLock(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath)
      let owner: { pid?: unknown } = {}
      try {
        owner = JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: unknown }
      } catch {
        // Being written right now, or empty: judge by age alone.
      }
      const ownerGone = typeof owner.pid === 'number' && owner.pid !== process.pid && !pidAlive(owner.pid)
      const tooOld = Date.now() - info.mtimeMs > this.staleLockMs
      if (!ownerGone && !tooOld) return false
      // Move it aside first, so two writers clearing the same stale lock cannot remove each
      // other's fresh one: only one rename of it succeeds.
      const aside = `${this.lockPath}.stale.${process.pid}.${Math.floor(this.random() * 1e9).toString(36)}`
      await rename(this.lockPath, aside)
      await unlink(aside).catch(() => undefined)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      throw error
    }
  }

  private async unlock(): Promise<void> {
    await unlink(this.lockPath).catch(() => undefined)
  }

  // ---- The operations the CLI and the worker offer ----

  /** `fields` with its project named as the Orca project it means, when it means one. */
  private async withOrcaProject<T extends { project?: string | null }>(fields: T): Promise<T> {
    if (fields.project === undefined || fields.project === null) return fields
    const orca = await Promise.resolve(this.orcaProjects()).catch(() => [] as readonly OrcaProject[])
    return { ...fields, project: canonicalProject(fields.project, orca) }
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const file = await this.read()
    return filterTasks(file.tasks, filter, this.today(), localTime(this.now()))
  }

  async get(id: string): Promise<Task> {
    return findTask((await this.read()).tasks, id)
  }

  /** Adds a task. With `dedupe` and a `source`, a task that already holds that source (open or
   *  closed) is answered instead; when it was merged into another task, that task (the keeper),
   *  so a merged duplicate is never added again. */
  async add(given: NewTask, options: { dedupe?: boolean } = {}): Promise<AddResult> {
    const input = await this.withOrcaProject(given)
    return this.mutate((file): AddResult | { result: AddResult; write: false } => {
      if (options.dedupe && input.source) {
        const source = input.source.trim()
        const existing = file.tasks.find((task) => task.source === source) ?? file.tasks.find((task) => sourcesOf(task).includes(source))
        if (existing) return { result: { task: keeperOf(file.tasks, existing), created: false }, write: false }
      }
      const id = newId(new Set(file.tasks.map((task) => task.id)), this.random)
      const task = makeTask(input, id, this.now(), file.statuses)
      file.tasks.push(task)
      return { task, created: true }
    })
  }

  async addMany(given: readonly NewTask[]): Promise<Task[]> {
    if (given.length === 0) return []
    const inputs = await Promise.all(given.map((input) => this.withOrcaProject(input)))
    return this.mutate((file) => {
      const taken = new Set(file.tasks.map((task) => task.id))
      const added: Task[] = []
      for (const input of inputs) {
        const id = newId(taken, this.random)
        taken.add(id)
        const task = makeTask(input, id, this.now(), file.statuses)
        file.tasks.push(task)
        added.push(task)
      }
      return added
    })
  }

  /** Changes a task; `patch` may be worked out from the task as it is under the lock. */
  async update(id: string, patch: TaskPatch | ((task: Task) => TaskPatch)): Promise<Task> {
    const orca = await Promise.resolve(this.orcaProjects()).catch(() => [] as readonly OrcaProject[])
    return this.mutate((file) => {
      const task = findTask(file.tasks, id)
      const next = patchTask(task, typeof patch === 'function' ? patch(task) : patch, this.now(), orca, file.statuses)
      file.tasks[file.tasks.indexOf(task)] = next
      return next
    })
  }

  /**
   * Moves a task to status `state` (when given and different) and sets the order of that status's
   * section to `order` (task ids, first to last), in one write: what dragging a task in the panel or
   * the board does. Ids in `order` that are not in that status are left alone. Only the moved task
   * counts as changed (`updated_at`); the others just get their `rank`.
   */
  async move(id: string, state: string | null, order: readonly string[]): Promise<Task> {
    const orca = await Promise.resolve(this.orcaProjects()).catch(() => [] as readonly OrcaProject[])
    return this.mutate((file) => {
      const task = findTask(file.tasks, id)
      let moved = task
      if (state && state !== task.state) moved = patchTask(task, { state }, this.now(), orca, file.statuses)
      file.tasks[file.tasks.indexOf(task)] = moved
      const rankOf = new Map(order.map((taskId, i) => [taskId, i + 1]))
      file.tasks = file.tasks.map((t) => {
        const rank = rankOf.get(t.id)
        if (rank === undefined || t.state !== moved.state || t.rank === rank) return t
        return t.id === moved.id ? { ...t, rank, updated_at: this.now().toISOString() } : { ...t, rank }
      })
      return file.tasks.find((t) => t.id === moved.id) as Task
    })
  }

  /** Completes a task (at `at`, default now) or reopens it. Completing a done task keeps its done_at. */
  async setDone(id: string, done: boolean, at?: string): Promise<Task> {
    return this.mutate((file): Task | { result: Task; write: false } => {
      const task = findTask(file.tasks, id)
      if (done && task.done_at && !at) return { result: task, write: false }
      if (!done && !isClosed(task)) return { result: task, write: false }
      const next = patchTask(task, { done_at: done ? (at ?? this.now().toISOString()) : null }, this.now(), [], file.statuses)
      file.tasks[file.tasks.indexOf(task)] = next
      return next
    })
  }

  /** Records that the task was sent to a bot. */
  async recordHandoff(id: string, handoff: Handoff): Promise<Task> {
    return this.mutate((file) => {
      const task = findTask(file.tasks, id)
      const next: Task = { ...task, handoffs: [...task.handoffs, handoff], updated_at: this.now().toISOString() }
      file.tasks[file.tasks.indexOf(task)] = next
      return next
    })
  }

  /** Records that the task was sent to its project (a new workspace with an agent). */
  async recordWorkspace(id: string, send: ProjectSend): Promise<Task> {
    return this.mutate((file) => {
      const task = findTask(file.tasks, id)
      const next: Task = { ...task, workspaces: [...(task.workspaces ?? []), send], updated_at: this.now().toISOString() }
      file.tasks[file.tasks.indexOf(task)] = next
      return next
    })
  }

  /**
   * Merges the tasks `ids` into `keepId` (see core/merge.ts), in one write, and keeps what they
   * were before so `undoMerge` can put them back. With `dryRun`, answers what it would do and
   * writes nothing.
   */
  async merge(keepId: string, ids: readonly string[], choices: MergeChoices = {}, options: { dryRun?: boolean } = {}): Promise<{ keeper: Task; merged: Task[] }> {
    return this.mutate((file) => {
      const keeper = findTask(file.tasks, keepId)
      const others = ids.map((id) => findTask(file.tasks, id))
      const plan = mergeTasks(keeper, others, choices, this.now(), file.statuses ?? normalizeStatuses(undefined))
      if (options.dryRun) return { result: plan, write: false as const }
      const changed = new Map([plan.keeper, ...plan.merged].map((t) => [t.id, t]))
      file.last_merge = { at: plan.keeper.updated_at, keeper: keeper.id, merged: others.map((t) => t.id), before: [keeper, ...others] }
      file.tasks = file.tasks.map((t) => changed.get(t.id) ?? t)
      return plan
    })
  }

  /** Undoes the latest merge: puts the keeper and the merged tasks back as they were, unless one
   *  of them changed since (then nothing changes and it says which). */
  async undoMerge(): Promise<{ keeper: Task; restored: Task[] }> {
    return this.mutate((file) => {
      const last = file.last_merge
      if (!last || !Array.isArray(last.before) || last.before.length === 0) throw new TaskInputError('there is no merge to undo')
      const ids = [last.keeper, ...last.merged]
      for (const id of ids) {
        const now = file.tasks.find((t) => t.id === id)
        if (!now) throw new TaskInputError(`${id} was deleted after the merge, so it cannot be undone`)
        if (now.updated_at !== last.at) throw new TaskInputError(`${now.id} ("${now.title}") changed after the merge, so it cannot be undone; edit it by hand instead`)
      }
      const statuses = file.statuses ?? normalizeStatuses(undefined)
      const before = new Map(last.before.map((raw) => normalizeTask(raw, statuses)).filter((t): t is Task => t !== null).map((t) => [t.id, t]))
      file.tasks = file.tasks.map((t) => before.get(t.id) ?? t)
      file.last_merge = null
      const restored = ids.map((id) => before.get(id)).filter((t): t is Task => t !== undefined)
      return { keeper: restored[0], restored: restored.slice(1) }
    })
  }

  /** Fills in the chat of the task's latest handoff, found after it was sent. */
  async setHandoffChat(id: string, chatId: string): Promise<Task> {
    return this.mutate((file): Task | { result: Task; write: false } => {
      const task = findTask(file.tasks, id)
      const last = task.handoffs.at(-1)
      if (!last || last.chat_id === chatId) return { result: task, write: false }
      const next: Task = { ...task, handoffs: [...task.handoffs.slice(0, -1), { ...last, chat_id: chatId }], updated_at: this.now().toISOString() }
      file.tasks[file.tasks.indexOf(task)] = next
      return next
    })
  }

  /** Takes the task back from the bot it was sent to (its latest handoff); a no-op when none. */
  async returnHandoff(id: string): Promise<Task> {
    return this.mutate((file): Task | { result: Task; write: false } => {
      const task = findTask(file.tasks, id)
      const last = task.handoffs.at(-1)
      if (!last || last.returned_at !== null) return { result: task, write: false }
      const at = this.now().toISOString()
      const next: Task = { ...task, handoffs: [...task.handoffs.slice(0, -1), { ...last, returned_at: at }], updated_at: at }
      file.tasks[file.tasks.indexOf(task)] = next
      return next
    })
  }

  async remove(id: string): Promise<Task> {
    return this.mutate((file) => {
      const task = findTask(file.tasks, id)
      file.tasks.splice(file.tasks.indexOf(task), 1)
      return task
    })
  }

  /** Adds every task line of `text` (the Simple Todo inbox format). */
  async importLines(text: string, extra: { source?: string } = {}): Promise<Task[]> {
    const now = this.now()
    const parsed = parseLines(text, localDay(now))
    return this.addMany(
      parsed.map(({ done, ...task }) => ({
        ...task,
        source: task.source ?? extra.source ?? null,
        done_at: done ? now.toISOString() : null
      }))
    )
  }

  /**
   * Takes in an append-only inbox file: moves it aside in one step (so lines appended meanwhile
   * start a new file rather than being lost), adds its lines, then deletes it.
   */
  async takeInbox(path: string = this.inboxPath, settleMs = 50): Promise<Task[]> {
    try {
      const info = await stat(path)
      if (info.size === 0) return []
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const taking = `${path}.${process.pid}.${Math.floor(this.random() * 1e9).toString(36)}.taking`
    try {
      await rename(path, taking)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    // A writer that opened the file just before the rename finishes into the moved file.
    if (settleMs > 0) await sleep(settleMs)
    const text = await readFile(taking, 'utf8')
    try {
      const added = await this.importLines(text)
      await unlink(taking).catch(() => undefined)
      return added
    } catch (error) {
      // Put the lines back for the next try rather than lose them.
      await writeFile(path, text, { encoding: 'utf8', flag: 'a' }).catch(() => undefined)
      await unlink(taking).catch(() => undefined)
      throw error
    }
  }
}

/**
 * A file as read from disk, brought to the current schema in memory (normalizeTask does the
 * tasks). Unknown fields on the file and its tasks are kept, and `version` stays 1, so 0.2.0 and
 * 0.3.0 still read and write a migrated file.
 *
 * - Schema 1 (0.1.0, 0.2.0) to 2 (0.3.0): every task gets `due_time: null` and `handoffs: []`.
 * - Schema 2 to 3 (0.4.0): the file gets `statuses` (To Do, In Progress, Pending, Done, Cancelled)
 *   and every task its `state`, `state_name` and `closed_at`: open -> To Do; on hold, or waiting
 *   on someone -> Pending; done -> Done. `status`, `done_at`, `held_at` and `waiting_on` stay as
 *   they were.
 */
export function migrateFile(file: TaskFile): TaskFile {
  const from = typeof file.schema === 'number' ? file.schema : 1
  const { tasks, ...rest } = file
  const statuses = normalizeStatuses(file.statuses)
  return {
    ...rest,
    format: 'orca-tasks',
    version: 1,
    schema: Math.max(from, SCHEMA),
    revision: typeof file.revision === 'number' ? file.revision : 0,
    updated_at: typeof file.updated_at === 'string' ? file.updated_at : new Date(0).toISOString(),
    statuses,
    tasks: tasks.map((raw) => normalizeTask(raw, statuses)).filter((task): task is Task => task !== null)
  }
}
