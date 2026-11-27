// The send menu that ▷ on a row or a card opens: the Orca bots and the projects to send the task
// to in one click, without opening the task. Which tasks get it, and what it lists in what order.
// Pure, tested in send-menu.test.ts; board.ts draws it and sends.

import { matchOrcaProject, type OrcaProject } from '../core/projects.ts'
import { activeHandoff, isClosed } from '../core/tasks.ts'
import type { Task } from '../core/types.ts'
import type { BotOffer } from '../protocol.ts'

/** ▷ opens the send menu for an open task that is not with a bot; a closed task or one a bot has
 *  keeps the plain move to In Progress. */
export function opensSendMenu(task: Task): boolean {
  return !isClosed(task) && activeHandoff(task) === null
}

export interface BotChoice {
  name: string
  /** "this project's bot", "main bot", "paused", or ''. */
  note: string
  paused: boolean
}

/** The bots, as the send form offers them: the one it would pick first (the bot chosen last time
 *  for this project, else the project's bot, else Orca), then the others in the offer's order. */
export function botChoices(offer: BotOffer): BotChoice[] {
  const first = offer.last?.bot ?? offer.default ?? offer.bots[0]?.name ?? null
  const ordered = [...offer.bots.filter((b) => b.name === first), ...offer.bots.filter((b) => b.name !== first)]
  return ordered.map((b) => ({
    name: b.name,
    note: b.paused ? 'paused' : b.name === offer.project ? "this project's bot" : b.name === offer.main ? 'main bot' : '',
    paused: b.paused
  }))
}

export interface ProjectChoice {
  name: string
  /** The task's own project. */
  own: boolean
}

/** The projects a workspace for the task can start in: the task's own project first when it is one of the
 *  person's Orca Git projects, then the others in Orca's order. Folder projects (Orca starts no
 *  workspaces there) and hidden ones are left out. */
export function projectChoices(orca: readonly OrcaProject[], taskProject: string | null): ProjectChoice[] {
  const usable = orca.filter((p) => p.id !== null && p.kind !== 'folder')
  const own = taskProject ? matchOrcaProject(taskProject, orca) : null
  const ownChoice = own && usable.includes(own) ? own : null
  return [
    ...(ownChoice ? [{ name: ownChoice.name, own: true }] : []),
    ...usable.filter((p) => p !== ownChoice && !p.hidden).map((p) => ({ name: p.name, own: false }))
  ]
}
