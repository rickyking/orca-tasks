#!/usr/bin/env node
// The `orca-tasks` program. Needs Node 22.18 or newer (it runs TypeScript as is).
import { readFile } from 'node:fs/promises'
import { run } from './cli.ts'
import { loadOrcaProjects } from './core/orca-projects.ts'
import { defaultRunOrca } from './core/bots.ts'

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => resolve(text))
  })
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: readStdin,
  readFile: (path) => readFile(path, 'utf8'),
  env: process.env,
  orcaProjects: (home, refresh) => loadOrcaProjects(home, { refresh }),
  runOrca: defaultRunOrca(process.env)
})
