// The send menu ▷ opens (send-menu.ts): which tasks get it, and the bots and projects it lists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaProject } from '../core/projects.ts'
import { makeTask, patchTask } from '../core/tasks.ts'
import type { Handoff } from '../core/types.ts'
import type { BotOffer } from '../protocol.ts'
import { botChoices, opensSendMenu, projectChoices } from './send-menu.ts'

const NOW = new Date('2026-11-24T10:00:00.000Z')
const handoff: Handoff = { bot: 'Orca', bot_id: 'b1', type: 'handoff', chat: 'home', chat_id: 'c1', message_id: 'm1', subject: 'x', sent_at: NOW.toISOString(), by: 'panel', returned_at: null }
const bot = (name: string, paused = false) => ({ name, id: `b-${name}`, agent: 'claude', specialty: '', paused })
const offer = (fields: Partial<BotOffer> = {}): BotOffer => ({
  bots: [bot('online-store'), bot('Orca'), bot('docs-site'), bot('archive', true)],
  project: 'online-store',
  main: 'Orca',
  default: 'online-store',
  unreachable: [],
  error: null,
  lastChat: null,
  last: null,
  ...fields
})
const project = (name: string, fields: Partial<OrcaProject> = {}): OrcaProject => ({ name, id: `p-${name}`, kind: 'git', path: `/p/${name}`, hostId: 'local', hidden: false, ...fields })

test('▷ opens the send menu for an open task; a closed one, or one a bot has, keeps the plain move', () => {
  const open = makeTask({ title: 'Fix the rounding' }, 't-1', NOW)
  assert.equal(opensSendMenu(open), true)
  assert.equal(opensSendMenu({ ...open, state: 'pending', status: 'hold' }), true, 'on hold: still sendable')
  assert.equal(opensSendMenu(patchTask(open, { done_at: NOW.toISOString() }, NOW)), false)
  assert.equal(opensSendMenu({ ...open, handoffs: [handoff] }), false, 'with a bot')
  assert.equal(opensSendMenu({ ...open, handoffs: [{ ...handoff, returned_at: NOW.toISOString() }] }), true, 'taken back from the bot')
})

test('the bots: the one Send would pick first, then the others in the offer order, each with its note', () => {
  assert.deepEqual(botChoices(offer()), [
    { name: 'online-store', note: "this project's bot", paused: false },
    { name: 'Orca', note: 'main bot', paused: false },
    { name: 'docs-site', note: '', paused: false },
    { name: 'archive', note: 'paused', paused: true }
  ])
  // The bot chosen last time for this project comes first, as the send form starts there.
  const last = { bot: 'docs-site', type: 'handoff' as const, chat: 'home' as const, notes: true, state: null, keepState: false, chatChosen: true }
  assert.deepEqual(botChoices(offer({ last })).map((b) => b.name), ['docs-site', 'online-store', 'Orca', 'archive'])
  // No project bot: Orca is the default.
  assert.deepEqual(botChoices(offer({ bots: [bot('docs-site'), bot('Orca')], project: null, default: 'Orca' })).map((b) => b.name), ['Orca', 'docs-site'])
  assert.deepEqual(botChoices(offer({ bots: [], default: null })), [])
})

test('the projects: the task’s own first, then the others in Orca’s order; no folder or hidden projects', () => {
  const orca = [project('docs-site'), project('online-store'), project('notes', { kind: 'folder' }), project('old-site', { hidden: true }), project('mobile-app')]
  assert.deepEqual(projectChoices(orca, 'Online Store'), [
    { name: 'online-store', own: true },
    { name: 'docs-site', own: false },
    { name: 'mobile-app', own: false }
  ])
  assert.deepEqual(projectChoices(orca, null).map((p) => p.name), ['docs-site', 'online-store', 'mobile-app'])
  assert.deepEqual(projectChoices(orca, 'notes').map((p) => p.own), [false, false, false], 'a folder project is not offered, even as its own')
  assert.deepEqual(projectChoices(orca, 'old-site')[0], { name: 'old-site', own: true }, 'its own project, even when hidden from the project filter')
  assert.deepEqual(projectChoices(orca, 'somewhere-else').map((p) => p.name), ['docs-site', 'online-store', 'mobile-app'])
  assert.deepEqual(projectChoices([], 'online-store'), [])
})
