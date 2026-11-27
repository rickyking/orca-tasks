// What the send forms ask the worker for, built in one place and checked in one place.
//
// The panel's request reaches the worker through Orca's `plugin.request`, which takes only JSON:
// Orca checks `input` with `z.json()`, and a field set to `undefined` is not JSON. In 0.4.2 the
// panel sent `note: undefined` when the instruction was empty, so every send without one came back
// as "input: Invalid input". `botSendInput` and `projectSendInput` build the request with nothing
// left undefined, `jsonProblem` says what Orca would refuse, and `checkBotSend` and
// `checkProjectSend` are what the worker accepts, with errors that name the form's field.
// Pure functions, shared by the panel, the worker and the tests.

import { defaultSendStatus } from './statuses.ts'
import { PROJECT_AGENTS, SEND_TYPES, type ProjectAgent, type SendType, type StatusDef } from './types.ts'

/** Where the person pressed Send. */
export type SendSurface = 'panel' | 'board'

/** The send-to-a-bot form as the person left it. */
export interface BotForm {
  bot: string
  type: SendType
  chat: 'new' | 'home' | 'last'
  /** The instruction above the task; empty when none. */
  note: string
  notes: boolean
  /** The status to move the task to after sending, or '' to leave it. */
  state: string
}

/** The send-to-its-project form as the person left it. */
export interface ProjectForm {
  agent: ProjectAgent
  note: string
  notes: boolean
  state: string
  /** Show the new workspace in Orca's window once it exists. */
  open: boolean
}

/** What `tasks.send` takes. */
export interface BotSendInput {
  id: string
  bot: string
  type: SendType
  chat: 'new' | 'home' | 'last'
  /** Present only when the person wrote one. */
  note?: string
  notes: boolean
  state: string | null
  by: SendSurface | 'cli'
}

/** What `tasks.sendToProject` takes. */
export interface ProjectSendInput {
  id: string
  agent: ProjectAgent
  note?: string
  notes: boolean
  state: string | null
  open: boolean
  by: SendSurface | 'cli'
}

/** The form after a change, as the panel shows it: a status message cannot start a new chat (it
 *  goes to the Home Chat), and "the chat it had before" is offered only when there is one (the
 *  Home Chat otherwise). */
export function settleBotForm<T extends BotForm>(form: T, hasEarlierChat: boolean): T {
  let chat = form.chat
  if (chat === 'last' && !hasEarlierChat) chat = 'home'
  if (form.type === 'status' && chat === 'new') chat = 'home'
  return chat === form.chat ? form : { ...form, chat }
}

/** What a remembered chat choice counts as. A send from 0.6.0 on keeps `chatChosen`; a "new chat"
 *  kept without it is from before the Home Chat was the default (when a new chat was where the
 *  form started, so it may not have been a choice at all): the form starts at the Home Chat, once,
 *  and what is chosen there is remembered from then on. */
export function rememberedChat(kept: { chat?: unknown; chatChosen?: unknown }): 'new' | 'home' | 'last' {
  if (kept.chat === 'home' || kept.chat === 'last') return kept.chat
  return kept.chat === 'new' && kept.chatChosen === true ? 'new' : 'home'
}

/** Where a send form's Chat starts: the Home Chat (the bot's main chat), unless this project chose
 *  another last time; "the chat it had before" only when the task has one. */
export function initialChat(last: { chat: 'new' | 'home' | 'last' } | null, hasEarlierChat: boolean): 'new' | 'home' | 'last' {
  const chat = last?.chat ?? 'home'
  return chat === 'last' && !hasEarlierChat ? 'home' : chat
}

/** The `orca-tasks send` arguments the worker runs in its terminal for a checked request. */
export function botSendArgs(input: BotSendInput, taskId: string, bot: string): string[] {
  return [
    'send',
    taskId,
    '--to',
    bot,
    '--type',
    input.type,
    '--chat',
    input.chat,
    '--by',
    input.by === 'cli' ? 'panel' : input.by,
    ...(input.note ? ['--note', input.note] : []),
    ...(input.notes ? [] : ['--no-notes']),
    // Without --state the CLI moves a sent task to In Progress; "leave it" has to say so.
    ...(input.state ? ['--state', input.state] : ['--keep-state'])
  ]
}

/** What a send form's Then starts at: the status remembered for this project (while it is still
 *  an open one), "leave it as it is" ('') when that was the choice, else In Progress, else ''
 *  when the person deleted In Progress. `last` is null when nothing is remembered; a remembered
 *  null state without `keepState` (written before 0.5.1, when leaving it was the only default)
 *  counts as nothing remembered. */
export function initialThen(last: { state: string | null; keepState?: boolean } | null, statuses: readonly StatusDef[]): string {
  if (last?.state && statuses.some((s) => s.id === last.state && !s.closed)) return last.state
  if (last?.keepState) return ''
  return defaultSendStatus(statuses)?.id ?? ''
}

/** The request for sending task `id` with the bot form as it is: plain JSON, no `undefined`. */
export function botSendInput(id: string, form: BotForm, by: SendSurface): BotSendInput {
  const note = form.note.trim()
  return { id, bot: form.bot, type: form.type, chat: form.chat, ...(note ? { note } : {}), notes: form.notes, state: form.state || null, by }
}

/** The request for sending task `id` to its project with the form as it is. */
export function projectSendInput(id: string, form: ProjectForm, by: SendSurface): ProjectSendInput {
  const note = form.note.trim()
  return { id, agent: form.agent, ...(note ? { note } : {}), notes: form.notes, state: form.state || null, open: form.open, by }
}

/** The first thing in `value` that is not JSON as Orca's `z.json()` reads it (`input.note:
 *  undefined`), or null when all of it is. */
export function jsonProblem(value: unknown, path = 'input'): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path}: ${value} is not a JSON number`
  if (value === undefined) return `${path}: undefined is not JSON (leave the field out instead)`
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const problem = jsonProblem(value[i], `${path}.${i}`)
      if (problem) return problem
    }
    return null
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return `${path}: a ${proto?.constructor?.name ?? 'non-plain'} object is not JSON`
    for (const [key, item] of Object.entries(value)) {
      const problem = jsonProblem(item, `${path}.${key}`)
      if (problem) return problem
    }
    return null
  }
  return `${path}: a ${typeof value} is not JSON`
}

/** `value` with every `undefined` field left out (and `undefined` in a list made null), as
 *  JSON.stringify would send it. */
export function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : withoutUndefined(item))) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = withoutUndefined(item)
    return out as T
  }
  return value
}

/** A send form's field the person can fix, and why it is refused. */
export class SendFieldError extends Error {
  readonly code = 'invalid_params'
  readonly field: string
  constructor(field: string, why: string) {
    super(`${field}: ${why}`)
    this.field = field
  }
}

/** The form's names for the request's fields, so an error says which one to change. */
export const FIELD_LABELS: Record<string, string> = {
  id: 'Task',
  bot: 'Send to',
  type: 'As',
  chat: 'Chat',
  note: 'Instruction',
  notes: 'Include the notes',
  state: 'Then',
  by: 'Sent from',
  agent: 'Agent',
  open: 'Show it in Orca'
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SendFieldError('Task', 'the request is not an object')
  return value as Record<string, unknown>
}

function text(raw: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null || (value === '' && !required)) {
    if (required) throw new SendFieldError(FIELD_LABELS[key] ?? key, 'nothing chosen')
    return undefined
  }
  if (typeof value !== 'string') throw new SendFieldError(FIELD_LABELS[key] ?? key, `must be text, not ${JSON.stringify(value)}`)
  if (required && value.trim() === '') throw new SendFieldError(FIELD_LABELS[key] ?? key, 'nothing chosen')
  return value
}

function flag(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new SendFieldError(FIELD_LABELS[key] ?? key, `must be on or off, not ${JSON.stringify(value)}`)
  return value
}

function by(raw: Record<string, unknown>): 'panel' | 'board' | 'cli' {
  const value = raw.by ?? 'panel'
  if (value !== 'panel' && value !== 'board' && value !== 'cli') throw new SendFieldError('Sent from', `must be panel, board or cli, not ${JSON.stringify(value)}`)
  return value
}

function note(raw: Record<string, unknown>): string | undefined {
  const value = text(raw, 'note', false)?.trim()
  if (value && value.length > 2000) throw new SendFieldError('Instruction', 'is longer than 2000 characters')
  return value || undefined
}

function state(raw: Record<string, unknown>): string | null {
  return text(raw, 'state', false) ?? null
}

/** What `tasks.send` accepts, checked; the errors name the form's field ("Chat: …"). Also takes
 *  what 0.4.x panels sent (`note` empty or left out, `state` '' for "leave it"). */
export function checkBotSend(input: unknown): BotSendInput {
  const raw = record(input)
  const id = text(raw, 'id', true) as string
  const bot = text(raw, 'bot', true) as string
  const type = (raw.type ?? 'handoff') as SendType
  if (!(SEND_TYPES as readonly unknown[]).includes(type)) throw new SendFieldError('As', `must be handoff, question or status, not ${JSON.stringify(raw.type)}`)
  // Without one, the Home Chat, as the form and the CLI start (a new chat before 0.6.0).
  const chat = raw.chat ?? 'home'
  if (chat !== 'new' && chat !== 'home' && chat !== 'last') throw new SendFieldError('Chat', `must be a new chat, the Home Chat or the earlier chat, not ${JSON.stringify(raw.chat)}`)
  if (type === 'status' && chat === 'new') throw new SendFieldError('Chat', 'a status message cannot start a new chat: send it to the Home Chat or the earlier chat')
  const n = note(raw)
  return { id, bot, type, chat, ...(n ? { note: n } : {}), notes: flag(raw, 'notes', true), state: state(raw), by: by(raw) }
}

/** What `tasks.sendToProject` accepts, checked. */
export function checkProjectSend(input: unknown): ProjectSendInput {
  const raw = record(input)
  const id = text(raw, 'id', true) as string
  const agent = raw.agent ?? 'claude'
  if (!(PROJECT_AGENTS as readonly unknown[]).includes(agent)) throw new SendFieldError('Agent', `must be ${PROJECT_AGENTS.join(' or ')}, not ${JSON.stringify(raw.agent)}`)
  const n = note(raw)
  return { id, agent: agent as ProjectAgent, ...(n ? { note: n } : {}), notes: flag(raw, 'notes', true), state: state(raw), open: flag(raw, 'open', false), by: by(raw) }
}

/**
 * An error as the person should read it in the form. Orca refuses a request that is not what the
 * host API takes with `invalid_params` and "<path>: <what zod said>" ("input: Invalid input"):
 * that becomes the form's field and a plain reason. Anything else is shown as it is.
 */
export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  const refused = /^(input|params|\(root\))(?:\.([\w.]+))?: (.+)$/s.exec(message)
  if (!refused || (code !== '' && code !== 'invalid_params' && code !== 'invalid_request')) return message
  const key = refused[2]?.split('.')[0]
  const field = key ? (FIELD_LABELS[key] ?? key) : null
  const why = refused[3] === 'Invalid input' ? 'Orca would not take what the form sent' : refused[3]
  return field ? `${field}: ${why}.` : `Orca refused the request: ${why}. Close the form and try again; if it keeps happening, run the same send with orca-tasks send in a terminal to see the full error.`
}
