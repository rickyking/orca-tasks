// Where the CLI gets the person's Orca projects. The plugin's worker asks Orca (`project.list`)
// and keeps the answer in `<home>/orca-projects.json`; the CLI reads that file, and when there is
// none (the plugin has not run yet) or `--refresh` is given, it runs `orca repo list --json`.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fromOrcaCli, type OrcaProject, type OrcaProjectsFile } from './projects.ts'

export const ORCA_PROJECTS_FILE = 'orca-projects.json'

export async function readProjectsCache(home: string): Promise<OrcaProjectsFile | null> {
  try {
    const raw = JSON.parse(await readFile(join(home, ORCA_PROJECTS_FILE), 'utf8')) as OrcaProjectsFile
    return raw && Array.isArray(raw.projects) ? raw : null
  } catch {
    return null
  }
}

/** Writes the cache in one step (temp file, then rename); answers false when nothing changed. */
export async function writeProjectsCache(home: string, file: OrcaProjectsFile): Promise<boolean> {
  const previous = await readProjectsCache(home)
  if (previous && previous.from === file.from && JSON.stringify(previous.projects) === JSON.stringify(file.projects)) return false
  await mkdir(home, { recursive: true })
  const path = join(home, ORCA_PROJECTS_FILE)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  await rename(temp, path)
  return true
}

/** `orca repo list --json`, or null when the orca CLI is missing or Orca does not answer. */
export function projectsFromOrcaCli(timeoutMs = 8000): Promise<OrcaProject[] | null> {
  return new Promise((resolve) => {
    execFile('orca', ['repo', 'list', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        const answer = JSON.parse(stdout) as { ok?: boolean; result?: { repos?: unknown } }
        const repos = answer.result?.repos
        resolve(answer.ok !== false && Array.isArray(repos) ? fromOrcaCli(repos) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

export interface LoadedProjects {
  projects: OrcaProject[]
  /** Where they came from: the worker's cache, the orca CLI, or nowhere (empty list). */
  from: 'host-api' | 'orca-cli' | 'none'
  updated_at: string | null
}

export async function loadOrcaProjects(home: string, options: { refresh?: boolean } = {}): Promise<LoadedProjects> {
  const cached = options.refresh ? null : await readProjectsCache(home)
  if (cached) return { projects: cached.projects, from: cached.from, updated_at: cached.updated_at }
  const live = await projectsFromOrcaCli()
  if (live) {
    const file: OrcaProjectsFile = { updated_at: new Date().toISOString(), from: 'orca-cli', projects: live }
    // Keep the worker's (host API) answer when there is one; only fill an empty cache.
    if (!(await readProjectsCache(home))) await writeProjectsCache(home, file).catch(() => false)
    return { projects: live, from: 'orca-cli', updated_at: file.updated_at }
  }
  const stale = await readProjectsCache(home)
  if (stale) return { projects: stale.projects, from: stale.from, updated_at: stale.updated_at }
  return { projects: [], from: 'none', updated_at: null }
}
