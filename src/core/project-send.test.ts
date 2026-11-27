// Sending a task to its project: the target, the workspace name, the agent's first prompt, the
// status words, and the CLI's `orca worktree create`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaRun } from './bots.ts'
import { projectPrompt, projectTarget, PROMPT_MAX, workspaceName, workspaceStatus, workspaceStatusWords } from './project-send.ts'
import { createWorkspaceWithCli, worktreeCreateArgs } from './workspace-cli.ts'
import { matchOrcaProject, type OrcaProject } from './projects.ts'
import { makeTask } from './tasks.ts'

const ORCA: OrcaProject[] = [
  { name: 'online-store', id: 'p-web', kind: 'git', path: '/p/web', hostId: 'local', hidden: false },
  { name: 'Notes', id: 'p-notes', kind: 'folder', path: '/p/notes', hostId: null, hidden: false }
]
const NOW = new Date('2026-11-25T06:00:00.000Z')

test('the project a task goes to: an Orca Git project, else why not', () => {
  const t = (project: string | null) => makeTask({ title: 'Fix the login bug', project }, 't-2ec27hs8', NOW)
  assert.equal((projectTarget(t('Online Store'), ORCA, matchOrcaProject) as { project: OrcaProject }).project.id, 'p-web')
  assert.match((projectTarget(t(null), ORCA, matchOrcaProject) as { error: string }).error, /has no project/)
  assert.match((projectTarget(t('elsewhere'), ORCA, matchOrcaProject) as { error: string }).error, /not one of your Orca projects/)
  assert.match((projectTarget(t('Notes'), ORCA, matchOrcaProject) as { error: string }).error, /folder project/)
  // Another project, picked in the send menu: the task's own does not matter.
  assert.equal((projectTarget(t(null), ORCA, matchOrcaProject, 'online-store') as { project: OrcaProject }).project.id, 'p-web')
  assert.equal((projectTarget(t('elsewhere'), ORCA, matchOrcaProject, 'online-store') as { project: OrcaProject }).project.id, 'p-web')
  assert.match((projectTarget(t('online-store'), ORCA, matchOrcaProject, 'Notes') as { error: string }).error, /folder project/)
  assert.match((projectTarget(t('online-store'), ORCA, matchOrcaProject, 'gone') as { error: string }).error, /^gone is not one of your Orca projects/)
})

test('the workspace name: the title in a few words and the start of the id', () => {
  assert.equal(workspaceName(makeTask({ title: 'Fix the login bug!' }, 't-2ec27hs8', NOW)), 'fix-the-login-bug-2ec2')
  assert.equal(workspaceName(makeTask({ title: '会議の準備' }, 't-abcd1234', NOW)), 'task-abcd')
  const long = workspaceName(makeTask({ title: 'A very long title that goes on and on about many things to do' }, 't-abcd1234', NOW))
  assert.ok(long.length <= 48 && long.endsWith('-abcd') && !long.includes('--'), long)
})

test('the first prompt: the instruction, the task, its source and notes, cut to what Orca takes', () => {
  const task = makeTask({ title: 'Fix the login bug', project: 'online-store', notes: 'Steps:\n- [ ] reproduce', source: 'chat:msg_1', priority: 'high', due: '2026-11-28', tags: ['bug'] }, 't-2ec27hs8', NOW)
  const prompt = projectPrompt(task, { note: 'Write a failing test first', cli: '/h/bin/orca-tasks' })
  assert.match(prompt, /^Your owner sent you this task from Agent Tasks[^\n]*a new branch of online-store\.\n\nWrite a failing test first\n\nTask: Fix the login bug\nDue: 2026-11-28\nPriority: high\nTags: #bug\nSource: chat:msg_1\nTask id: t-2ec27hs8\n\nNotes:\nSteps:\n- \[ \] reproduce\n\nTo read the task again: \/h\/bin\/orca-tasks get t-2ec27hs8 --json/)
  assert.ok(!projectPrompt(task, { notes: false }).includes('Notes:'))
  assert.match(projectPrompt(task, { project: 'docs-site' }), /a new branch of docs-site\./, 'sent to another project: that one is named')
  const huge = makeTask({ title: 'Big', notes: 'x'.repeat(10_000) }, 't-big12345', NOW)
  const cut = projectPrompt(huge)
  assert.ok(cut.length <= PROMPT_MAX, `${cut.length}`)
  assert.match(cut, /…\(the notes go on: orca-tasks get t-big12345\)\n\nTo read the task again/, 'the notes are cut, the way back is kept')
})

test('workspace status: from workspace.list, gone when it is not listed', () => {
  const rows = [{ id: 'w1', status: { state: 'working', unread: false, terminalCount: 1, lastActivityAt: 5 } }, { id: 'w2', status: { state: 'done', unread: true, terminalCount: 1, lastActivityAt: 6 } }]
  assert.deepEqual(workspaceStatus(rows, 'w1'), { state: 'working', unread: false, lastActivityAt: 5 })
  assert.equal(workspaceStatusWords(workspaceStatus(rows, 'w2')), 'done, not read yet')
  assert.equal(workspaceStatus(rows, 'w9').state, 'gone')
  assert.equal(workspaceStatus(rows, 'w9', true).state, 'unknown', 'a cut list cannot say it is gone')
  assert.equal(workspaceStatusWords({ state: 'permission', unread: false, lastActivityAt: null }), 'waiting for your permission')
})

test('the CLI creates the workspace with orca worktree create and records it', async () => {
  const task = makeTask({ title: 'Fix the login bug', project: 'online-store' }, 't-2ec27hs8', NOW)
  const args = worktreeCreateArgs({ task, project: ORCA[0], agent: 'codex', note: 'Go' })
  assert.deepEqual(args.slice(0, 8), ['worktree', 'create', '--project', 'online-store', '--name', 'fix-the-login-bug-2ec2', '--agent', 'codex'])
  assert.equal(args[8], '--prompt')
  assert.deepEqual(args.slice(10), ['--no-parent', '--json'])
  const calls: string[][] = []
  const run = async (a: readonly string[]): Promise<OrcaRun> => {
    calls.push([...a])
    return { code: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { id: 'repo-web::/p/web-wt/fix-the-login-bug-2ec2', displayName: 'fix-the-login-bug-2ec2' }, launch: { outcome: { kind: 'terminal', handle: 'term_9' } } } }), stderr: '' }
  }
  const send = await createWorkspaceWithCli(run, { task, project: ORCA[0], agent: 'claude', by: 'cli', now: () => NOW })
  assert.deepEqual(send, { project: 'online-store', project_id: 'p-web', workspace_id: 'repo-web::/p/web-wt/fix-the-login-bug-2ec2', workspace_name: 'fix-the-login-bug-2ec2', terminal_id: 'term_9', agent: 'claude', sent_at: NOW.toISOString(), by: 'cli' })
  const failing = async (): Promise<OrcaRun> => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no project web' } }), stderr: '' })
  await assert.rejects(createWorkspaceWithCli(failing, { task, project: ORCA[0], agent: 'claude', by: 'cli' }), /orca worktree create failed: no project web/)
})
