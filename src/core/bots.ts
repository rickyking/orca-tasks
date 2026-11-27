// Sending a task to an Orca bot. Everything goes through Orca's own CLI:
//
//   orca bot list --json                                   the bots, and what each is for
//   orca orchestration send --to bot:<name> --type handoff|question|status --subject <title>
//                           --body <task> [--chat new|<chat id>]
//   orca bot chats --bot <name> --json                     the chat a handoff landed in
//   orca agent read orca_session_id:<chat> --json          that chat's state and latest reply
//
// Nothing here sends on its own: the panel, the board and the CLI call `sendToBot` only when the
// person presses Send or runs `orca-tasks send`.

import { execFile } from 'node:child_process'
import { activeHandoff } from './tasks.ts'
import type { Handoff, SendType, Task } from './types.ts'

export interface Bot {
  name: string
  id: string | null
  /** The agent it runs on (`claude`, `codex`...), when Orca says. */
  agent: string | null
  /** What it is for: the first paragraph of its SOUL.md. */
  specialty: string
  paused: boolean
}

export interface BotList {
  bots: Bot[]
  /** Paired servers whose bots could not be listed. */
  unreachable: string[]
}

/** What `orca` answered: its exit code and output. */
export interface OrcaRun {
  code: number
  stdout: string
  stderr: string
}

/** Runs the `orca` CLI with these arguments. Injected in tests. */
export type RunOrca = (args: readonly string[]) => Promise<OrcaRun>

export class BotError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Where `orca` is when it is not on PATH (Orca's worker may not have the shell's PATH). */
const ORCA_FALLBACKS = ['/Applications/Orca.app/Contents/Resources/bin/orca', '/usr/local/bin/orca', '/opt/homebrew/bin/orca']

/** Runs `orca` from PATH (or `$ORCA_CLI`), else from where Orca installs it. */
export function defaultRunOrca(env: Record<string, string | undefined> = process.env, timeoutMs = 30_000): RunOrca {
  const candidates = [env.ORCA_CLI, 'orca', ...ORCA_FALLBACKS].filter((c): c is string => typeof c === 'string' && c !== '')
  return async (args) => {
    let last: OrcaRun = { code: 127, stdout: '', stderr: 'orca: command not found' }
    for (const file of candidates) {
      const result = await new Promise<OrcaRun | null>((resolve) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error && typeof (error as unknown as { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0
          if (error && (error as unknown as { code?: unknown }).code === "ENOENT") return resolve(null)
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        })
      })
      if (result) return result
      last = { code: 127, stdout: '', stderr: `${file}: not found` }
    }
    return last
  }
}

function squash(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The JSON `orca ... --json` printed, or a BotError with Orca's own message. */
function parseAnswer(run: OrcaRun, what: string): Record<string, unknown> {
  let answer: Record<string, unknown> = {}
  try {
    answer = record(JSON.parse(run.stdout))
  } catch {
    const said = (run.stderr || run.stdout).trim().split('\n').slice(0, 3).join(' ')
    throw new BotError(run.code === 127 ? 'orca_missing' : 'orca_failed', `${what} failed${said ? `: ${said}` : ''}`)
  }
  if (answer.ok === false || run.code !== 0) {
    const error = record(answer.error)
    const message = typeof error.message === 'string' ? error.message : (run.stderr || 'no details').trim()
    throw new BotError(typeof error.code === 'string' ? error.code : 'orca_failed', `${what} failed: ${message}`)
  }
  return record(answer.result ?? answer)
}

/** The bots `orca bot list --json` answered. */
export function parseBotList(result: Record<string, unknown>): BotList {
  const rows = Array.isArray(result.bots) ? result.bots : []
  const bots: Bot[] = []
  for (const row of rows) {
    const b = record(row)
    if (typeof b.name !== 'string' || b.name === '') continue
    bots.push({
      name: b.name,
      id: typeof b.id === 'string' ? b.id : null,
      agent: typeof b.agent === 'string' ? b.agent : null,
      specialty: typeof b.specialty === 'string' ? b.specialty : '',
      paused: b.paused === true
    })
  }
  const unreachable = (Array.isArray(result.unreachable) ? result.unreachable : [])
    .map((u) => record(u).name)
    .filter((name): name is string => typeof name === 'string')
  return { bots, unreachable }
}

export async function listBots(run: RunOrca): Promise<BotList> {
  return parseBotList(parseAnswer(await run(['bot', 'list', '--json']), 'orca bot list'))
}

/** The main bot: the one named "Orca". */
export function mainBot(bots: readonly Bot[]): Bot | null {
  return bots.find((b) => b.name === 'Orca') ?? bots.find((b) => b.name.toLowerCase() === 'orca') ?? null
}

/**
 * The bot for a project: one named after it (`online-store`, `Online Store`), else
 * one whose "what it is for" names it. Null when none does.
 */
export function projectBot(bots: readonly Bot[], project: string | null): Bot | null {
  if (!project) return null
  const key = squash(project)
  if (key === '') return null
  const named = bots.find((b) => squash(b.name) === key)
  if (named) return named
  const lower = project.toLowerCase()
  return bots.find((b) => b.specialty.toLowerCase().includes(lower) || (key.length >= 4 && squash(b.specialty).includes(key))) ?? null
}

export interface BotChoices {
  /** The bot of the task's project, when one is. */
  project: Bot | null
  /** "Orca", when there is one and it is not already `project`. */
  main: Bot | null
  /** Every other bot, by name. */
  others: Bot[]
}

/** Which bots to offer for a task: its project's bot first, then Orca, then the rest. */
export function botChoices(bots: readonly Bot[], project: string | null): BotChoices {
  const forProject = projectBot(bots, project)
  const main = mainBot(bots)
  const picked = new Set([forProject?.name, main?.name])
  return {
    project: forProject,
    main: main && main.name !== forProject?.name ? main : null,
    others: bots.filter((b) => !picked.has(b.name)).sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** The bot to send to when none is named: the project's, else Orca. */
export function defaultBot(bots: readonly Bot[], project: string | null): Bot | null {
  return projectBot(bots, project) ?? mainBot(bots)
}

const SUBJECT_PREFIX: Record<SendType, string> = { handoff: '', question: 'Question: ', status: 'FYI: ' }

/** The subject of a message about a task: its title (after `Question: ` or `FYI: `), cut to fit.
 *  Orca titles a new chat from it. */
export function handoffSubject(task: Task, type: SendType = 'handoff'): string {
  const subject = `${SUBJECT_PREFIX[type]}${task.title}`
  return subject.length > 120 ? `${subject.slice(0, 119)}…` : subject
}

export interface BodyOptions {
  /** A line from the person ("check progress"), put above the task. */
  note?: string
  /** The CLI's path, named so the bot can read the task again. */
  cli?: string
  /** `handoff` (the default), `question` or `status`. */
  type?: SendType
  /** Whether the task's notes go with it (default yes). */
  notes?: boolean
}

const OPENING: Record<SendType, string> = {
  handoff: 'Your owner sent you this task from Agent Tasks (their task list in Orca). It is yours to do.',
  question: 'Your owner has a question about this task from Agent Tasks (their task list in Orca). Answer it; do not take the task on unless they ask you to.',
  status: 'For your information, from Agent Tasks (your owner\'s task list in Orca). Nothing to do and no reply needed.'
}

/** The body of a message about a task: what the person asks, everything the task says, and how
 *  to answer. */
export function handoffBody(task: Task, options: BodyOptions = {}): string {
  const type = options.type ?? 'handoff'
  const lines = [OPENING[type], '']
  if (options.note && options.note.trim() !== '') lines.push(options.note.trim(), '')
  lines.push(`Task: ${task.title}`)
  if (task.due) lines.push(`Due: ${task.due}${task.due_time ? ` ${task.due_time}` : ''}`)
  if (task.priority !== 'none') lines.push(`Priority: ${task.priority}`)
  if (task.project) lines.push(`Project: ${task.project}`)
  if (task.tags.length) lines.push(`Tags: ${task.tags.map((t) => `#${t}`).join(' ')}`)
  if (task.source) lines.push(`Source: ${task.source}`)
  if (task.state_name) lines.push(`Status: ${task.state_name}`)
  if (task.waiting_on) lines.push(`On hold, waiting on: ${task.waiting_on}`)
  lines.push(`Task id: ${task.id}`)
  if (options.notes !== false && task.notes.trim() !== '') lines.push('', 'Notes:', task.notes.trim())
  const cli = options.cli ?? 'orca-tasks'
  const reread = `To read the task again: ${cli} get ${task.id} --json`
  const answer = 'in your reply here, in this chat: Agent Tasks reads it from this chat, and the terminal that sent this closes right away, so do not answer it by mail.'
  if (type === 'handoff') lines.push('', `When you have finished, say what you did ${answer} Your owner ticks the task off. ${reread}`)
  else if (type === 'question') lines.push('', `Answer ${answer} ${reread}`)
  else lines.push('', reread)
  return lines.join('\n')
}

const SESSION_RE = /orca_session_id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The message id and chat id somewhere in what `orchestration send --json --full` answered. */
export function findSendIds(result: unknown): { messageId: string | null; chatId: string | null } {
  let messageId: string | null = null
  let chatId: string | null = null
  const visit = (value: unknown, key: string, depth: number) => {
    if (depth > 6 || value === null || value === undefined) return
    if (typeof value === 'string') {
      if (!messageId && /^messageId$/i.test(key)) messageId = value
      if (!chatId && /^(chatId|chatSessionId|botChatId|sessionId|orcaSessionId)$/i.test(key) && UUID_RE.test(value)) chatId = value
      const session = SESSION_RE.exec(value)
      if (!chatId && session && /^(to|chat|recipient|target|address)$/i.test(key)) chatId = session[1]
      return
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item) => visit(item, key, depth + 1))
      return
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (!messageId && key === 'message' && typeof obj.id === 'string') messageId = obj.id
      if (!chatId && /^chat$/i.test(key) && typeof obj.id === 'string' && UUID_RE.test(obj.id)) chatId = obj.id
      for (const [k, v] of Object.entries(obj)) visit(v, k, depth + 1)
    }
  }
  visit(result, '', 0)
  return { messageId, chatId }
}

export interface BotChat {
  id: string
  title: string | null
  lastActivityAt: number | null
  lastSaid: string | null
  home: boolean
}

export async function listBotChats(run: RunOrca, bot: string): Promise<BotChat[]> {
  const result = parseAnswer(await run(['bot', 'chats', '--bot', bot, '--json']), 'orca bot chats')
  const rows = Array.isArray(result.chats) ? result.chats : []
  return rows
    .map((row) => record(row))
    .filter((c) => typeof c.id === 'string')
    .map((c) => ({
      id: c.id as string,
      title: typeof c.title === 'string' ? c.title : null,
      lastActivityAt: typeof c.lastActivityAt === 'number' ? c.lastActivityAt : null,
      lastSaid: typeof c.lastSaid === 'string' ? c.lastSaid : null,
      home: c.home === true
    }))
}

export interface SendOptions {
  bot: Bot
  task: Task
  /** `new` (the default): a chat of its own; `home`: the bot's Home Chat; `existing`: the chat
   *  `chatId` names (one of the bot's, such as the task's earlier chat). */
  chat?: 'new' | 'home' | 'existing'
  chatId?: string
  /** `handoff` (the default), `question` or `status`. A status message cannot start a new chat. */
  type?: SendType
  /** Whether the task's notes go with it (default yes). */
  notes?: boolean
  /** A line from the person, put above the task. */
  note?: string
  by: Handoff['by']
  now?: () => Date
  /** The CLI's path, named in the body so the bot can read the task again. */
  cli?: string
  /** How long to wait between looks for the new chat (tests use 0). */
  retryMs?: number
}

/**
 * The chat a handoff landed in, among a bot's chats: its Home Chat, or the new chat Orca titled
 * from the subject ("your owner's agent: <subject>"), the newest one active since it was sent.
 */
export function findHandoffChat(chats: readonly BotChat[], handoff: Pick<Handoff, 'chat' | 'subject' | 'sent_at'> & { chat_id?: string | null }): string | null {
  if (handoff.chat === 'existing') return handoff.chat_id ?? null
  if (handoff.chat === 'home') return chats.find((c) => c.home)?.id ?? null
  const since = Date.parse(handoff.sent_at) - 60_000
  const key = handoff.subject.trim().toLowerCase().slice(0, 60)
  if (key === '') return null
  const hits = chats
    .filter((c) => !c.home && c.title !== null && c.title.toLowerCase().includes(key))
    .filter((c) => c.lastActivityAt === null || Number.isNaN(since) || c.lastActivityAt >= since)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  return hits[0]?.id ?? null
}

/** Sends the task to the bot and answers the handoff record to keep on the task. */
export async function sendToBot(run: RunOrca, options: SendOptions): Promise<Handoff> {
  const { bot, task } = options
  const chat = options.chat ?? 'new'
  const type = options.type ?? 'handoff'
  const now = options.now ?? (() => new Date())
  if (task.done_at || task.closed_at) throw new BotError('invalid_params', `${task.id} is closed; reopen it before sending it to a bot`)
  if (type === 'status' && chat === 'new') throw new BotError('invalid_params', 'a status message cannot start a new chat; send it to the Home Chat or an existing chat')
  if (chat === 'existing' && !options.chatId) throw new BotError('invalid_params', 'no chat to send to: the task has not been in a chat of this bot yet')
  const subject = handoffSubject(task, type)
  const args = ['orchestration', 'send', '--to', `bot:${bot.name}`, '--type', type, '--subject', subject, '--body', handoffBody(task, { note: options.note, cli: options.cli, type, notes: options.notes })]
  if (chat === 'new') args.push('--chat', 'new')
  if (chat === 'existing' && options.chatId) args.push('--chat', options.chatId)
  args.push('--json', '--full')
  const sentAt = now()
  const result = parseAnswer(await run(args), `Sending to ${bot.name}`)
  let { messageId, chatId } = findSendIds(result)
  if (chat === 'existing' && options.chatId) chatId = options.chatId
  // Orca does not name the chat in its answer: find it among the bot's chats. A new chat may take
  // a moment to appear; the worker looks again later if it is still missing.
  for (let attempt = 0; !chatId && attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 700))
    const chats = await listBotChats(run, bot.name).catch(() => [] as BotChat[])
    chatId = findHandoffChat(chats, { chat, subject, sent_at: sentAt.toISOString() })
  }
  return {
    bot: bot.name,
    bot_id: bot.id,
    type,
    chat,
    chat_id: chatId,
    message_id: messageId,
    subject,
    sent_at: sentAt.toISOString(),
    by: options.by,
    returned_at: null
  }
}

/** What a bot is doing with a task, from its chat. */
export interface BotStatus {
  /** The chat's latest turn: `working`, `done`, `waiting` or `blocked`; `unknown` when Orca does
   *  not say, `unreachable` when it could not be read. */
  state: 'working' | 'done' | 'waiting' | 'blocked' | 'unknown' | 'unreachable'
  /** The bot's latest reply in that chat, cut to 2000 characters, or null. */
  reply: string | null
  /** Why it could not be read. */
  error?: string
}

/** Reads the chat a handoff landed in: `orca agent read orca_session_id:<chat> --json`. */
export async function botChatStatus(run: RunOrca, chatId: string): Promise<BotStatus> {
  try {
    const result = parseAnswer(await run(['agent', 'read', `orca_session_id:${chatId}`, '--json', '--limit', '30']), 'orca agent read')
    const entries = Array.isArray(result.entries) ? result.entries.map(record) : []
    const replies = entries.filter((e) => e.kind === 'message' && e.role === 'assistant' && typeof e.text === 'string' && e.text.trim() !== '' && e.text.trim() !== 'NO_REPLY')
    const last = replies.at(-1)
    const text = typeof last?.text === 'string' ? last.text.trim() : null
    const state = result.state
    return {
      state: state === 'working' || state === 'done' || state === 'waiting' || state === 'blocked' ? state : 'unknown',
      reply: text === null ? null : text.length > 2000 ? `${text.slice(0, 1999)}…` : text
    }
  } catch (error) {
    return { state: 'unreachable', reply: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The status of the bot a task is with now, or null when it is with none (or its chat is unknown). */
export async function taskBotStatus(run: RunOrca, task: Task): Promise<BotStatus | null> {
  const handoff = activeHandoff(task) ?? task.handoffs.at(-1) ?? null
  if (!handoff || !handoff.chat_id) return null
  return botChatStatus(run, handoff.chat_id)
}
