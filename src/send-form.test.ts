// The send forms, every way the person can fill them in: what the panel sends, what Orca's
// `plugin.request` takes (JSON only), what the worker accepts, and the `orca-tasks send` it runs.
// The bug in 0.4.2: an empty instruction went out as `note: undefined`, which Orca refused with
// "input: Invalid input", so nothing was sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './cli.ts'
import type { OrcaRun } from './core/bots.ts'
import { botSendArgs, botSendInput, checkBotSend, checkProjectSend, initialChat, initialThen, rememberedChat, jsonProblem, projectSendInput, readableError, SendFieldError, settleBotForm, withoutUndefined, type BotForm, type ProjectForm } from './core/send-input.ts'
import { applyStatusOp, DEFAULT_STATUSES, defaultSendStatus } from './core/statuses.ts'
import { TaskStore } from './core/store.ts'
import { PROJECT_AGENTS, SEND_TYPES } from './core/types.ts'

const CHATS = ['new', 'home', 'last'] as const
const NOTES = ['', '   ', 'Check progress', "Bob's numbers; use \"last quarter\""]
/** "Then": leave the status, or each status the form offers (the open and on-hold ones). */
const THEN = ['', ...DEFAULT_STATUSES.filter((s) => !s.closed).map((s) => s.id)]
const SURFACES = ['panel', 'board'] as const

/** Every bot form the panel can produce, after its own rules (settleBotForm). */
function* botForms(hasEarlierChat: boolean): Generator<BotForm> {
  const seen = new Set<string>()
  for (const type of SEND_TYPES)
    for (const chat of CHATS)
      for (const note of NOTES)
        for (const state of THEN)
          for (const notes of [true, false]) {
            const form = settleBotForm({ bot: 'Orca', type, chat, note, notes, state }, hasEarlierChat)
            const key = JSON.stringify(form)
            if (seen.has(key)) continue
            seen.add(key)
            yield form
          }
}

test('the 0.4.2 request is what Orca refused: an empty instruction was sent as note: undefined', () => {
  const old = { id: 't-2ec27hs8', bot: 'Orca', type: 'handoff', chat: 'home', note: undefined, notes: true, state: null, by: 'board' }
  assert.equal(jsonProblem(old), 'input.note: undefined is not JSON (leave the field out instead)')
  const now = botSendInput('t-2ec27hs8', { bot: 'Orca', type: 'handoff', chat: 'home', note: '', notes: true, state: '' }, 'panel')
  assert.deepEqual(now, { id: 't-2ec27hs8', bot: 'Orca', type: 'handoff', chat: 'home', notes: true, state: null, by: 'panel' })
  assert.equal(jsonProblem(now), null)
  assert.equal(jsonProblem(withoutUndefined(old)), null, 'the panel strips undefined from every request too')
})

test('every bot form: plain JSON, accepted by the worker as sent, and a send the CLI takes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-form-'))
  const store = new TaskStore({ home })
  const { task } = await store.add({ title: 'Check the invoices', notes: '- [ ] one', project: 'online-store' })
  // "The chat it had before" is offered only once the task has been in a chat.
  await store.recordHandoff(task.id, { bot: 'Orca', bot_id: 'b1', type: 'handoff', chat: 'new', chat_id: '0bb66c0f-54fa-442a-bc6a-7bba13627dc0', message_id: 'm1', subject: 'Check the invoices', sent_at: '2026-11-20T10:00:00.000Z', by: 'panel', returned_at: null })
  const ok = (result: unknown): OrcaRun => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
  const runOrca = async (args: readonly string[]): Promise<OrcaRun> =>
    args[0] === 'bot' && args[1] === 'list' ? ok({ bots: [{ id: 'b1', name: 'Orca', agent: 'claude', specialty: '', paused: false }], unreachable: [] }) : { code: 1, stdout: '', stderr: 'no real sends in tests' }
  let count = 0
  try {
    for (const earlier of [false, true]) {
      for (const form of botForms(earlier)) {
        for (const by of SURFACES) {
          count += 1
          const label = JSON.stringify({ ...form, by, earlier })
          const input = botSendInput(task.id, form, by)
          assert.equal(jsonProblem(input), null, label)
          assert.deepEqual(JSON.parse(JSON.stringify(input)), input, `${label}: survives JSON as it is`)
          assert.ok(!('note' in input) || (typeof input.note === 'string' && input.note.trim() !== ''), `${label}: no empty instruction`)
          assert.equal(form.type === 'status' && form.chat === 'new', false, `${label}: the form never offers a new chat for a status`)
          if (!earlier) assert.notEqual(form.chat, 'last', `${label}: no earlier chat to offer`)
          const checked = checkBotSend(input)
          assert.deepEqual(checked, input, `${label}: the worker takes it as sent`)
          // The worker runs this in its terminal; the CLI must take it (dry run: nothing is sent).
          const args = [...botSendArgs(checked, task.id, 'Orca'), '--dry-run', '--json']
          let stdout = ''
          let stderr = ''
          const code = await run(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: { ORCA_TASKS_HOME: home }, runOrca })
          assert.equal(code, 0, `${label}: orca-tasks ${args.join(' ')} -> ${stdout}${stderr}`)
          const dry = JSON.parse(stdout)
          assert.deepEqual([dry.type, dry.chat === 'existing' ? 'last' : dry.chat, dry.notes, dry.state], [form.type, form.chat, form.notes, form.state || null], label)
          if (form.note.trim()) assert.ok(dry.body.includes(form.note.trim()), `${label}: the instruction is in the message`)
          if (!form.notes) assert.ok(!dry.body.includes('Notes:'), `${label}: notes left out`)
        }
      }
    }
    assert.ok(count > 200, `covered ${count} forms`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Yi\'s send: Orca, as a handoff, to the Home Chat, leave the status, no instruction, with notes', () => {
  const form = settleBotForm({ bot: 'Orca', type: 'handoff', chat: 'home', note: '', notes: true, state: '' }, false)
  const input = botSendInput('t-2ec27hs8', form, 'panel')
  assert.equal(jsonProblem(input), null)
  assert.deepEqual(botSendArgs(checkBotSend(input), 't-2ec27hs8', 'Orca'), ['send', 't-2ec27hs8', '--to', 'Orca', '--type', 'handoff', '--chat', 'home', '--by', 'panel', '--keep-state'])
})

test('every project form: plain JSON and accepted by the worker as sent', () => {
  let count = 0
  for (const agent of PROJECT_AGENTS)
    for (const note of NOTES)
      for (const state of THEN)
        for (const notes of [true, false])
          for (const open of [true, false])
            for (const by of SURFACES) {
              const form: ProjectForm = { agent, note, notes, state, open }
              const input = projectSendInput('t-1', form, by)
              assert.equal(jsonProblem(input), null, JSON.stringify(form))
              assert.deepEqual(checkProjectSend(input), input)
              count += 1
            }
  assert.equal(count, 2 * 4 * 4 * 2 * 2 * 2)
})

test('a project form for another project than the task\'s own (the send menu): the project goes with it', () => {
  const form: ProjectForm = { agent: 'claude', note: '', notes: true, state: 'in-progress', open: false, project: ' docs-site ' }
  const input = projectSendInput('t-1', form, 'panel')
  assert.deepEqual(input, { id: 't-1', agent: 'claude', notes: true, state: 'in-progress', open: false, by: 'panel', project: 'docs-site' })
  assert.deepEqual(checkProjectSend(input), input)
  assert.equal('project' in projectSendInput('t-1', { ...form, project: '' }, 'panel'), false, 'none chosen: the task\'s own')
  assert.throws(() => checkProjectSend({ id: 't-1', project: 7 }), /^Error: Project: must be text/)
})

test('the worker names the field it refuses, and takes what 0.4.x panels sent', () => {
  const refuse = (input: unknown, field: string, why: RegExp) => {
    assert.throws(() => checkBotSend(input), (error: unknown) => error instanceof SendFieldError && error.field === field && why.test(error.message))
  }
  refuse({ id: 't-1', bot: 'Orca', chat: 'nowhere' }, 'Chat', /^Chat: must be a new chat, the Home Chat or the earlier chat/)
  refuse({ id: 't-1', bot: 'Orca', type: 'status', chat: 'new' }, 'Chat', /cannot start a new chat/)
  refuse({ id: 't-1', bot: '' }, 'Send to', /^Send to: nothing chosen$/)
  refuse({ id: 't-1', bot: 'Orca', type: 'memo' }, 'As', /^As: must be handoff, question or status/)
  refuse({ id: 't-1', bot: 'Orca', notes: 'yes' }, 'Include the notes', /must be on or off/)
  refuse({ id: 't-1', bot: 'Orca', note: 7 }, 'Instruction', /must be text/)
  refuse({ id: 't-1', bot: 'Orca', state: 3 }, 'Then', /must be text/)
  assert.throws(() => checkProjectSend({ id: 't-1', agent: 'gemini' }), /^Error: Agent: must be claude or codex/)
  // 0.4.x sent "" for "leave the status" and could leave the note out or empty.
  assert.deepEqual(checkBotSend({ id: 't-1', bot: 'Orca', chat: 'home', note: '', state: '', by: 'board' }), { id: 't-1', bot: 'Orca', type: 'handoff', chat: 'home', notes: true, state: null, by: 'board' })
})

test('errors read as the form\'s field and why, not "input: Invalid input"', () => {
  const host = (message: string, code = 'invalid_params') => Object.assign(new Error(message), { code })
  assert.equal(readableError(host('input.note: Invalid input')), 'Instruction: Orca would not take what the form sent.')
  assert.equal(readableError(host('input.chat: Invalid option: expected one of "new"|"home"')), 'Chat: Invalid option: expected one of "new"|"home".')
  assert.match(readableError(host('input: Invalid input')), /^Orca refused the request: Orca would not take what the form sent\. /)
  assert.equal(readableError(new SendFieldError('Chat', 'a status message cannot start a new chat')), 'Chat: a status message cannot start a new chat')
  assert.equal(readableError(host('Sending to Orca failed: no_active_sender_terminal', 'action_failed')), 'Sending to Orca failed: no_active_sender_terminal')
})

test('Then starts at In Progress, unless this project chose otherwise; without In Progress, leave it', () => {
  const statuses = DEFAULT_STATUSES.map((s) => ({ ...s }))
  assert.equal(defaultSendStatus(statuses)?.id, 'in-progress')
  // Nothing remembered for this project: In Progress (bot and project forms alike).
  assert.equal(initialThen(null, statuses), 'in-progress')
  // Remembered: a status, or "leave the status as it is".
  assert.equal(initialThen({ state: 'pending', keepState: false }, statuses), 'pending')
  assert.equal(initialThen({ state: null, keepState: true }, statuses), '')
  // Written before 0.5.1, when leaving it was the only default: counts as nothing remembered.
  assert.equal(initialThen({ state: null }, statuses), 'in-progress')
  assert.equal(initialThen({ state: null, keepState: false }, statuses), 'in-progress')
  // A remembered status that is gone or closed now: back to In Progress.
  assert.equal(initialThen({ state: 'blocked', keepState: false }, statuses), 'in-progress')
  assert.equal(initialThen({ state: 'done', keepState: false }, statuses), 'in-progress')

  // Found by name in any case or spacing, or as the status that started as In Progress.
  assert.equal(defaultSendStatus([...statuses.filter((s) => s.id !== 'in-progress'), { id: 'wip', name: 'in progress', color: 'blue', kind: 'open', closed: false }])?.id, 'wip')
  const renamed = applyStatusOp(statuses, { op: 'update', id: 'in-progress', name: 'Doing' }).statuses
  assert.equal(initialThen(null, renamed), 'in-progress')
  // Deleted: leave the status as it is.
  const without = applyStatusOp(statuses, { op: 'remove', id: 'in-progress' }).statuses
  assert.equal(defaultSendStatus(without), null)
  assert.equal(initialThen(null, without), '')
  assert.equal(initialThen({ state: null, keepState: false }, without), '')
  // A closed status named In Progress is not one to send to.
  assert.equal(defaultSendStatus([{ id: 'x', name: 'In Progress', color: 'gray', kind: 'done', closed: true }, ...without]), null)
})

test('leaving the status as it is goes to the CLI as --keep-state (its default is In Progress)', () => {
  const leave = checkBotSend(botSendInput('t-1', { bot: 'Orca', type: 'handoff', chat: 'home', note: '', notes: true, state: '' }, 'board'))
  assert.equal(botSendArgs(leave, 't-1', 'Orca').at(-1), '--keep-state')
  const move = checkBotSend(botSendInput('t-1', { bot: 'Orca', type: 'handoff', chat: 'home', note: '', notes: true, state: 'in-progress' }, 'board'))
  assert.deepEqual(botSendArgs(move, 't-1', 'Orca').slice(-2), ['--state', 'in-progress'])
  assert.ok(!botSendArgs(move, 't-1', 'Orca').includes('--keep-state'))
})

test('Chat starts at the bot\'s Home Chat; a remembered choice keeps working; a new chat kept before 0.6.0 starts at Home once', () => {
  // Nothing remembered for this project: the Home Chat, with or without an earlier chat.
  assert.equal(initialChat(null, false), 'home')
  assert.equal(initialChat(null, true), 'home')
  // Remembered: what was chosen, as long as it still makes sense.
  assert.equal(initialChat({ chat: 'new' }, false), 'new')
  assert.equal(initialChat({ chat: 'last' }, true), 'last')
  assert.equal(initialChat({ chat: 'last' }, false), 'home', 'no earlier chat for this task: Home, not a new chat')
  // What send-prefs.json holds: 0.6.0 writes chatChosen; a "new" without it starts at Home.
  assert.equal(rememberedChat({ chat: 'new' }), 'home', 'kept by 0.5.1 or earlier, when a new chat was where the form started')
  assert.equal(rememberedChat({ chat: 'new', chatChosen: false }), 'home')
  assert.equal(rememberedChat({ chat: 'new', chatChosen: true }), 'new', 'chosen in 0.6.0: kept')
  assert.equal(rememberedChat({ chat: 'home' }), 'home')
  assert.equal(rememberedChat({ chat: 'last' }), 'last', 'an earlier chat was always a choice')
  assert.equal(rememberedChat({}), 'home')
  assert.equal(rememberedChat({ chat: 'elsewhere', chatChosen: true }), 'home')
  // The form's own rules: an earlier chat that is gone falls back to Home, for every kind.
  for (const type of SEND_TYPES) assert.equal(settleBotForm({ bot: 'Orca', type, chat: 'last', note: '', notes: true, state: '' }, false).chat, 'home', type)
  // A request without a chat (what an older panel could send) goes to the Home Chat too.
  assert.equal(checkBotSend({ id: 't-1', bot: 'Orca' }).chat, 'home')
})

test('orca-tasks send to a bot goes to its Home Chat without --chat; --chat new still starts one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-tasks-chat-'))
  const store = new TaskStore({ home })
  const { task } = await store.add({ title: 'Check the invoices' })
  const ok = (result: unknown): OrcaRun => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
  const runOrca = async (args: readonly string[]): Promise<OrcaRun> =>
    args[0] === 'bot' && args[1] === 'list' ? ok({ bots: [{ id: 'b1', name: 'Orca', agent: 'claude', specialty: '', paused: false }], unreachable: [] }) : { code: 1, stdout: '', stderr: 'no real sends in tests' }
  const dry = async (...more: string[]) => {
    let stdout = ''
    const code = await run(['send', task.id, ...more, '--dry-run', '--json'], { stdout: (t) => (stdout += t), stderr: () => undefined, env: { ORCA_TASKS_HOME: home }, runOrca })
    assert.equal(code, 0, stdout)
    return JSON.parse(stdout) as { chat: string; type: string }
  }
  try {
    for (const type of SEND_TYPES) assert.equal((await dry('--type', type)).chat, 'home', type)
    assert.equal((await dry()).chat, 'home')
    assert.equal((await dry('--chat', 'new')).chat, 'new')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
