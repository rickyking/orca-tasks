// A stand-in for Claude Code in the merge-suggestion tests: an executable script that answers as
// $STUB_MODE says (good, fenced, none, bad, fail, slow) and writes what it was given to $STUB_SEEN.
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A stand-in agent: what it does is in $STUB_MODE; it writes its arguments and the prompt it
 *  read to $STUB_SEEN. */
export async function stubAgent(dir: string): Promise<string> {
  const file = join(dir, 'fake-claude')
  await writeFile(
    file,
    `#!/usr/bin/env node
const fs = require('fs')
let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  if (process.env.STUB_SEEN) fs.writeFileSync(process.env.STUB_SEEN, JSON.stringify({ args: process.argv.slice(2), prompt: input, cwd: process.cwd() }))
  const ids = [...input.matchAll(/"id":"(t-[a-z0-9]+)"/g)].map((m) => m[1])
  const mode = process.env.STUB_MODE || 'good'
  if (mode === 'good') process.stdout.write(JSON.stringify({ groups: [{ ids: [ids[0], ids[1]], keep: ids[1], reason: 'Both ask for the Q4 memo', confidence: 0.92 }, { ids: [ids[2], 't-madeup'], keep: ids[2], reason: 'no', confidence: 0.9 }] }))
  else if (mode === 'fenced') process.stdout.write('Here you go:\\n\`\`\`json\\n' + JSON.stringify({ groups: [{ ids: [ids[0], ids[1]], keep: ids[0], reason: 'Same', confidence: 'high' }] }) + '\\n\`\`\`\\n')
  else if (mode === 'none') process.stdout.write('{"groups":[]}')
  else if (mode === 'bad') process.stdout.write('I think t-1 and t-2 are the same.')
  else if (mode === 'fail') { process.stderr.write('Invalid API key · Please run /login'); process.exit(1) }
  else if (mode === 'slow') setTimeout(() => process.stdout.write('{"groups":[]}'), 30000)
})
`,
    'utf8'
  )
  await chmod(file, 0o755)
  return file
}

