// Made-up tasks, projects, bots and agents for the README's screenshots and the plugin page. The
// stand-in worker (stub-worker.ts) answers with these when the page is opened with `?demo`;
// board.browser.test.ts takes the screenshots with AGENT_TASKS_README_SHOTS=<folder>. Nothing here
// comes from a real task list.

import type { BotStatus } from '../../core/bots.ts'
import type { WorkspaceStatus } from '../../core/project-send.ts'
import type { OrcaProject } from '../../core/projects.ts'
import { makeTask, patchTask } from '../../core/tasks.ts'
import type { Handoff, NewTask, StatusDef, Task, TaskPatch } from '../../core/types.ts'

/** Tuesday 24 November 2026, 10:00 local time: the clock in every screenshot. */
export const DEMO_NOW = new Date(2026, 10, 24, 10)
export const DEMO_TODAY = '2026-11-24'

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString()

export const DEMO_PROJECTS: OrcaProject[] = ['online-store', 'docs-site', 'mobile-app'].map((name) => ({
  name,
  id: `p-${name}`,
  kind: 'git',
  path: `/home/demo/${name}`,
  hostId: 'local',
  hidden: false
}))

function handoff(bot: string, subject: string, sentAt: string): Handoff {
  return { bot, bot_id: `b-${bot}`, type: 'handoff', chat: 'home', chat_id: `chat-${bot}`, message_id: 'msg_demo', subject, sent_at: sentAt, by: 'panel', returned_at: null }
}

export function demoData(statuses: readonly StatusDef[]): { tasks: Task[]; bots: Record<string, BotStatus>; workspaces: Record<string, WorkspaceStatus> } {
  const make = (id: string, input: NewTask, patch: TaskPatch = {}, created = at(20, 9)): Task =>
    patchTask(makeTask(input, id, new Date(created), statuses), patch, DEMO_NOW, DEMO_PROJECTS, statuses)
  const tasks: Task[] = [
    make('t-round01', {
      title: 'Fix the rounding in the checkout total',
      priority: 'urgent',
      due: DEMO_TODAY,
      due_time: '15:00',
      project: 'online-store',
      tags: ['bug'],
      notes: 'Totals with three items or more are off by a cent.\n\n- [x] Reproduce it\n- [ ] Write a failing test\n- [ ] Fix and ship',
      source: 'https://github.com/example/online-store/issues/412'
    }),
    make('t-reply001', { title: 'Reply to Alice about the launch date', priority: 'high', due: '2026-11-23', tags: ['email'], source: 'mail:launch-date' }),
    make('t-roadmap1', {
      title: 'Review the Q1 roadmap',
      priority: 'medium',
      due: DEMO_TODAY,
      project: 'planning',
      notes: 'Comments due before the Thursday call.\n\n- [x] Read the draft\n- [ ] Check the estimates\n- [ ] Send comments to Alice'
    }),
    make('t-notes001', { title: 'Write the release notes for 2.3', priority: 'medium', due: '2026-11-27', project: 'docs-site' }),
    make('t-tls00001', { title: 'Renew the TLS certificate', due: '2026-11-30', tags: ['ops'] }),
    make('t-audit001', { title: 'Read the accessibility audit', tags: ['reading'] }),
    make('t-guide001', { title: 'Update the onboarding guide', project: 'docs-site' }),
    make('t-images01', { title: 'Move image uploads to the EU bucket', priority: 'high', due: '2026-11-25', due_time: '10:00', project: 'online-store' }, { state: 'in-progress' }),
    make('t-darkmd01', { title: 'Add dark mode to the settings screen', priority: 'medium', project: 'mobile-app' }, { state: 'in-progress' }),
    make('t-pricing1', { title: 'Finalize the pricing page copy', due: '2026-11-23', project: 'online-store' }, { waiting_on: "Bob's review" }),
    make('t-keys0001', { title: 'Rotate the staging API keys', project: 'online-store' }, { done_at: at(24, 9) }),
    make('t-stand001', { title: 'Standup notes', tags: ['team'] }, { done_at: at(24, 9) })
  ]
  const byId = (id: string) => tasks.find((t) => t.id === id) as Task
  byId('t-images01').handoffs = [handoff('Orca', 'Move image uploads to the EU bucket', at(24, 9))]
  byId('t-guide001').handoffs = [handoff('docs-site', 'Update the onboarding guide', at(23, 16))]
  byId('t-darkmd01').workspaces = [
    { project: 'mobile-app', project_id: 'p-mobile-app', workspace_id: 'w-dark-mode', workspace_name: 'add-dark-mode-to-the-settings-darkm', terminal_id: null, agent: 'claude', sent_at: at(24, 8), by: 'board' }
  ]
  return {
    tasks,
    bots: {
      't-images01': { state: 'working', reply: null },
      't-guide001': { state: 'done', reply: 'Done: the guide covers the sign-up flow with SSO. The pull request is open for review.' }
    },
    workspaces: {
      't-darkmd01': { state: 'working', unread: false, lastActivityAt: DEMO_NOW.getTime() }
    }
  }
}
