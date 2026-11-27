// The manifest's commands and shortcuts, without Orca: `npm test`.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { VERSION as CLI_VERSION } from './cli.ts'
import { VERSION as WORKER_VERSION } from './worker.ts'

type Command = { id: string; title: string; action?: string; when?: string }
type Keybinding = { command: string; key: string; when?: string }

/** A file at the top of the repository. */
const file = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url).href)
const manifest = JSON.parse(await readFile(file('orca-plugin.json'), 'utf8'))
const commands: Command[] = manifest.contributes.commands
const keybindings: Keybinding[] = manifest.contributes.keybindings

/** Every default chord of Orca's own shortcuts, on any platform (src/shared/keybindings in
 *  stablyai/orca, November 2026). A plugin chord equal to one of these would replace Orca's. */
const ORCA_DEFAULT_CHORDS = [
  'Alt+1', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Shift+C', 'Alt+Shift+D', 'Alt+Shift+N', 'Alt+Z',
  'Ctrl+1', 'Ctrl+C', 'Ctrl+PageDown', 'Ctrl+PageUp', 'Ctrl+Shift+A', 'Ctrl+Shift+C', 'Ctrl+Shift+V',
  'Ctrl+Tab', 'Ctrl+V', 'Ctrl+Y', 'Mod+0', 'Mod+1', 'Mod+A', 'Mod+Alt+A', 'Mod+Alt+ArrowDown',
  'Mod+Alt+ArrowLeft', 'Mod+Alt+ArrowRight', 'Mod+Alt+ArrowUp', 'Mod+Alt+B', 'Mod+Alt+BracketLeft',
  'Mod+Alt+BracketRight', 'Mod+Alt+C', 'Mod+Alt+F', 'Mod+Alt+P', 'Mod+Alt+R', 'Mod+Alt+Shift+A',
  'Mod+Alt+Shift+C', 'Mod+Alt+Shift+E', 'Mod+Alt+T', 'Mod+Alt+W', 'Mod+Alt+X', 'Mod+B',
  'Mod+Backspace', 'Mod+BracketLeft', 'Mod+BracketRight', 'Mod+C', 'Mod+Comma', 'Mod+D', 'Mod+E',
  'Mod+Equal', 'Mod+F', 'Mod+H', 'Mod+K', 'Mod+L', 'Mod+Minus', 'Mod+N', 'Mod+NumpadAdd',
  'Mod+NumpadSubtract', 'Mod+P', 'Mod+R', 'Mod+S', 'Mod+Shift+0', 'Mod+Shift+A',
  'Mod+Shift+ArrowDown', 'Mod+Shift+ArrowUp', 'Mod+Shift+B', 'Mod+Shift+Backspace',
  'Mod+Shift+BracketLeft', 'Mod+Shift+BracketRight', 'Mod+Shift+C', 'Mod+Shift+D', 'Mod+Shift+E',
  'Mod+Shift+Enter', 'Mod+Shift+F', 'Mod+Shift+F11', 'Mod+Shift+G', 'Mod+Shift+H', 'Mod+Shift+I',
  'Mod+Shift+J', 'Mod+Shift+M', 'Mod+Shift+N', 'Mod+Shift+O', 'Mod+Shift+Plus', 'Mod+Shift+R',
  'Mod+Shift+T', 'Mod+Shift+V', 'Mod+Shift+Y', 'Mod+Shift+Z', 'Mod+T', 'Mod+V', 'Mod+W', 'Mod+Y',
  'Mod+Z', 'Mod+Q', 'Mod+M', 'Shift+F7', 'Shift+Insert', 'F7'
]

/** Chords the code editor (Monaco) and macOS already use with Mod+Shift. */
const OTHER_TAKEN_CHORDS = ['Mod+Shift+K', 'Mod+Shift+L', 'Mod+Shift+3', 'Mod+Shift+4', 'Mod+Shift+5', 'Mod+Shift+Q', 'Mod+Shift+Slash']

/** One spelling per chord: Ctrl is Mod on Windows and Linux, modifiers in a fixed order. */
function chord(key: string): string {
  const parts = key.split('+')
  const last = parts.pop()!.toUpperCase()
  const mods = parts.map((part) => (part === 'Ctrl' || part === 'Cmd' ? 'Mod' : part)).sort()
  return [...mods, last].join('+')
}

test('every shortcut runs a command the plugin contributes, with the same scope', () => {
  assert.ok(keybindings.length >= 2)
  for (const binding of keybindings) {
    const command = commands.find((c) => c.id === binding.command)
    assert.ok(command, `${binding.key} runs ${binding.command}, which is not in contributes.commands`)
    assert.equal(binding.when ?? 'global', command.when ?? 'global')
  }
})

test('the shortcuts are the sidebar toggle and the board, on Mod+Shift+U and Mod+Shift+X', () => {
  const byCommand = Object.fromEntries(keybindings.map((b) => [b.command, b.key]))
  assert.deepEqual(byCommand, { 'agent-tasks.toggleSidebar': 'Mod+Shift+U', 'agent-tasks.openBoard': 'Mod+Shift+X' })
  const toggle = commands.find((c) => c.id === 'agent-tasks.toggleSidebar')
  assert.equal(toggle?.action, 'sidebar.right.toggle', 'a declarative command: it never starts the worker')
  assert.equal(commands.find((c) => c.id === 'agent-tasks.openBoard')?.action, undefined, 'the board command runs in the worker')
})

test('no shortcut takes one of Orca\'s own, the editor\'s or macOS\'s, or uses Ctrl+Alt', () => {
  const taken = new Set([...ORCA_DEFAULT_CHORDS, ...OTHER_TAKEN_CHORDS].map(chord))
  const seen = new Set<string>()
  for (const { key } of keybindings) {
    const normal = chord(key)
    assert.ok(!taken.has(normal), `${key} is already an Orca, editor or macOS shortcut`)
    assert.ok(!seen.has(normal), `${key} is bound twice`)
    seen.add(normal)
    // Mod+Alt is Ctrl+Alt on Windows and Linux: AltGr text input there.
    assert.ok(!(normal.includes('Mod') && normal.includes('Alt')), `${key} would be Ctrl+Alt on Windows and Linux`)
  }
})

test('the README lists every shortcut, as macOS and as Windows/Linux keys', async () => {
  const readme = await readFile(file('README.md'), 'utf8')
  for (const { command, key } of keybindings) {
    const title = commands.find((c) => c.id === command)!.title
    assert.ok(readme.includes(title), `README names ${title}`)
    const letter = key.split('+').at(-1)
    assert.ok(readme.includes(`Cmd+Shift+${letter}`) && readme.includes(`Ctrl+Shift+${letter}`), `README lists ${key}`)
  }
})

test('the version is the same in the manifest, package.json, the CLI and the worker', async () => {
  const pkg = JSON.parse(await readFile(file('package.json'), 'utf8'))
  assert.deepEqual([pkg.version, CLI_VERSION, WORKER_VERSION], [manifest.version, manifest.version, manifest.version])
  const changelog = await readFile(file('CHANGELOG.md'), 'utf8')
  assert.match(changelog, new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}$`, 'm'))
})
