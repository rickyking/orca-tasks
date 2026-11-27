// The sidebar and the board in a real browser, driven with real mouse input: dragging tasks to
// another status and to another place in their own, the status menu, and dragging statuses into
// order. Chrome runs headless and is driven over the DevTools protocol (Input.dispatchMouseEvent,
// the same input path a person's mouse takes, so pointer events fire as they do in Orca's frame).
// No dependencies: the page's TypeScript is served with Node's own type stripping, and the worker
// is a stand-in (test/stub-worker.ts) with demo tasks; nothing touches ~/.orca-tasks.
//
// Skipped when no Chrome is found ($CHROME_BIN, Google Chrome, chromium). `npm run test:browser`;
// with AGENT_TASKS_SHOTS=<folder> it also saves PNGs of what it sees there.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

const CHROMES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter((p): p is string => typeof p === 'string' && p !== '')
const chromePath = CHROMES.find((p) => existsSync(p)) ?? null

/** Orca's frame variables for a light and a dark theme, for screenshots outside Orca (`?theme=`). */
const THEMES: Record<string, string> = {
  light:
    '--orca-background:#f4f4f5;--orca-foreground:#18181b;--orca-card:#ffffff;--orca-popover:#ffffff;--orca-muted:#ececee;--orca-muted-foreground:#71717a;' +
    '--orca-accent:#e4e4e7;--orca-accent-foreground:#18181b;--orca-border:#e0e0e3;--orca-input:#d9d9dd;--orca-primary:#18181b;--orca-primary-foreground:#fafafa;--orca-destructive:#dc2626;--orca-ring:#a1a1aa;',
  dark:
    '--orca-background:#141518;--orca-foreground:#e7e7ea;--orca-card:#1b1c20;--orca-popover:#1f2024;--orca-muted:#24252a;--orca-muted-foreground:#9a9aa3;' +
    '--orca-accent:#2a2b31;--orca-accent-foreground:#f4f4f5;--orca-border:#2c2d33;--orca-input:#34353c;--orca-primary:#e7e7ea;--orca-primary-foreground:#18181b;--orca-destructive:#ef4444;--orca-ring:#52525b;'
}

/** Serves src/ over HTTP: .ts as JavaScript (types stripped), and the two test pages. */
function serve(): Promise<{ server: Server; port: number }> {
  const page = (mode: 'sidebar' | 'board', theme: string | null) =>
    `<!doctype html><html lang="en" data-mode="${mode}"${theme && THEMES[theme] ? ` class="${theme}"` : ''}><head><meta charset="utf-8"><link rel="stylesheet" href="/board/board.css">` +
    `${theme && THEMES[theme] ? `<style>:root{${THEMES[theme]}}</style>` : ''}</head>` +
    `<body><div id="root"></div><script type="module" src="/board/test/stub-worker.ts"></script><script type="module" src="/board/board.ts"></script></body></html>`
  const server = createServer(async (req, res) => {
    const [url, query = ''] = (req.url ?? '/').split('?')
    try {
      if (url === '/sidebar' || url === '/board') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page(url.slice(1) as 'sidebar' | 'board', new URLSearchParams(query).get('theme')))
        return
      }
      const file = join(SRC, url)
      if (!file.startsWith(SRC)) throw new Error('outside src')
      const text = await readFile(file, 'utf8')
      if (url.endsWith('.ts')) {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.end(stripTypeScriptTypes(text, { mode: 'strip' }))
      } else {
        res.writeHead(200, { 'content-type': url.endsWith('.css') ? 'text/css' : 'text/plain' })
        res.end(text)
      }
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })))
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A page in headless Chrome, and the few DevTools commands the tests need. */
class Browser {
  private ws!: WebSocket
  private next = 1
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private chrome: ChildProcess
  private profile: string
  private constructor(chrome: ChildProcess, profile: string) {
    this.chrome = chrome
    this.profile = profile
  }

  static async open(): Promise<Browser> {
    const port = await freePort()
    const profile = await mkdtemp(join(tmpdir(), 'agent-tasks-chrome-'))
    const chrome = spawn(chromePath as string, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {})
    const browser = new Browser(chrome, profile)
    let target: { webSocketDebuggerUrl?: string; type?: string }[] = []
    for (let i = 0; i < 100; i += 1) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as typeof target
        if (target.some((t) => t.type === 'page')) break
      } catch {
        // Not up yet.
      }
      await sleep(100)
    }
    const url = target.find((t) => t.type === 'page')?.webSocketDebuggerUrl
    if (!url) throw new Error('Chrome did not open a page')
    browser.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      browser.ws.onopen = resolve
      browser.ws.onerror = reject
    })
    browser.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (msg.id === undefined) return
      const wait = browser.waiting.get(msg.id)
      browser.waiting.delete(msg.id)
      if (msg.error) wait?.reject(new Error(msg.error.message))
      else wait?.resolve(msg.result)
    }
    return browser
  }

  /** Sends a DevTools command. Chrome can drop the answer to one sent while a page navigates, so a
   *  command that gets none in 20 seconds fails instead of holding the test (and CI) forever. */
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`DevTools gave no answer to ${method} in 20 s`))
      }, 20_000)
      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  async eval<T>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }

  async load(url: string, width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await this.send('Page.navigate', { url })
    for (let i = 0; i < 100; i += 1) {
      await sleep(50)
      if (await this.eval<boolean>(`!!document.querySelector('.row, .card')`).catch(() => false)) return
    }
    throw new Error(`${url} did not show any task`)
  }

  /** A point on the first element matching `selector` whose text has `text`: its upper third (so a
   *  task dropped there lands before it), or its middle with `middle`. */
  async point(selector: string, text = '', middle = false): Promise<{ x: number; y: number }> {
    const at = await this.eval<{ x: number; y: number } | null>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height * (${middle} ? 0.5 : 0.3)) }
    })()`)
    if (!at) throw new Error(`nothing matches ${selector} ${text}`)
    return at
  }

  mouse(type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number, buttons: number): Promise<unknown> {
    return this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  }

  /** Presses at `from`, moves in steps to `to`, and releases there (or presses Escape first). */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, options: { escape?: boolean } = {}): Promise<void> {
    await this.mouse('mouseMoved', from.x, from.y, 0)
    await this.mouse('mousePressed', from.x, from.y, 1)
    for (let i = 1; i <= 8; i += 1) {
      await this.mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8), 1)
      await sleep(10)
    }
    if (options.escape) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await this.mouse('mouseReleased', to.x, to.y, 0)
    await sleep(150)
  }

  /** With AGENT_TASKS_SHOTS set, saves what the page shows as <name>.png there. */
  async shot(name: string): Promise<void> {
    const dir = process.env.AGENT_TASKS_SHOTS
    if (!dir) return
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    await writeFile(join(dir, `${name}.png`), Buffer.from(data, 'base64'))
  }

  /** Presses at `from` and moves to `to` without releasing; `release` finishes the drag. */
  async hold(from: { x: number; y: number }, to: { x: number; y: number }): Promise<() => Promise<void>> {
    await this.mouse('mouseMoved', from.x, from.y, 0)
    await this.mouse('mousePressed', from.x, from.y, 1)
    for (let i = 1; i <= 8; i += 1) await this.mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8), 1)
    await sleep(50)
    return async () => {
      await this.mouse('mouseReleased', to.x, to.y, 0)
      await sleep(150)
    }
  }

  async click(at: { x: number; y: number }): Promise<void> {
    await this.mouse('mouseMoved', at.x, at.y, 0)
    await this.mouse('mousePressed', at.x, at.y, 1)
    await this.mouse('mouseReleased', at.x, at.y, 0)
    await sleep(150)
  }

  async close(): Promise<void> {
    this.ws.close()
    this.chrome.kill()
    await sleep(200)
    await rm(this.profile, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The task ids in each status section as shown. */
const SECTIONS = `Object.fromEntries([...document.querySelectorAll('[data-drop-status]')].map((g) => [g.dataset.dropStatus, [...g.querySelectorAll('[data-id]')].map((r) => r.dataset.id)]))`
const CALLS = (name: string) => `window.__calls.filter((c) => c.name === ${JSON.stringify(name)}).map((c) => c.input)`

test('dragging in the sidebar and on the board, with a real mouse', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  const base = `http://127.0.0.1:${port}`
  try {
    // ---- The sidebar ----
    await browser.load(`${base}/sidebar`, 380, 900)
    assert.deepEqual(await browser.eval(SECTIONS), {
      todo: ['t-alice', 't-memo', 't-plan'],
      'in-progress': ['t-layers'],
      pending: ['t-pack'],
      done: [],
      cancelled: []
    }, 'closed sections (Done, Cancelled) start closed: their tasks are not shown')

    // A click is still a click: it opens the task, it does not move it.
    await browser.click(await browser.point('.row', 'Send the board memo'))
    assert.equal(await browser.eval(`!!document.querySelector('.pane')`), true)
    assert.deepEqual(await browser.eval(CALLS('tasks.move')), [])
    await browser.eval(`document.querySelector('[aria-label="Close details"]').click()`)
    await sleep(100)

    // To Do -> In Progress, dropped above "Load the sample data"; the target is marked meanwhile.
    await browser.shot('sidebar')
    const release = await browser.hold(await browser.point('.row', 'Reply to Alice'), await browser.point('.row', 'Load the sample data'))
    assert.deepEqual(await browser.eval(`[document.querySelector('.group.drop')?.dataset.dropStatus, document.querySelector('.insert-before')?.dataset.id, document.querySelectorAll('.drag-ghost').length]`), ['in-progress', 't-layers', 1])
    await browser.shot('sidebar-dragging')
    await release()
    let moves = await browser.eval<{ id: string; state: string | null; order: string[] }[]>(CALLS('tasks.move'))
    assert.deepEqual(moves.at(-1), { id: 't-alice', state: 'in-progress', order: ['t-alice', 't-layers'] })
    let sections = await browser.eval<Record<string, string[]>>(SECTIONS)
    assert.deepEqual([sections.todo, sections['in-progress']], [['t-memo', 't-plan'], ['t-alice', 't-layers']])

    // Reordering within To Do: "Review the Q4 plan" above "Send the board memo".
    await browser.drag(await browser.point('.row', 'Review the Q4 plan'), await browser.point('.row', 'Send the board memo'))
    moves = await browser.eval(CALLS('tasks.move'))
    assert.deepEqual(moves.at(-1), { id: 't-plan', state: null, order: ['t-plan', 't-memo'] })
    assert.deepEqual((await browser.eval<Record<string, string[]>>(SECTIONS)).todo, ['t-plan', 't-memo'], 'the new order shows, and stays after the reload')

    // Onto the header of the closed Done section: it lands there and Done opens.
    await browser.drag(await browser.point('.row', 'Send the board memo'), await browser.point('.group-head', 'Done', true))
    moves = await browser.eval(CALLS('tasks.move'))
    assert.deepEqual(moves.at(-1), { id: 't-memo', state: 'done', order: ['t-memo', 't-notes'] })
    sections = await browser.eval(SECTIONS)
    assert.deepEqual(sections.done, ['t-memo', 't-notes'])
    const memo = await browser.eval<{ status: string; done_at: string | null }>(`(({ status, done_at }) => ({ status, done_at }))(window.__tasks.find((t) => t.id === 't-memo'))`)
    assert.equal(memo.status, 'done', 'dropped on Done: completed, as scripts using the CLI see it')
    assert.ok(memo.done_at)

    // Escape cancels a drag: nothing moves.
    const before = (await browser.eval<unknown[]>(CALLS('tasks.move'))).length
    await browser.drag(await browser.point('.row', 'Review the Q4 plan'), await browser.point('.row', 'Finalize the release notes'), { escape: true })
    assert.equal((await browser.eval<unknown[]>(CALLS('tasks.move'))).length, before)
    assert.equal(await browser.eval(`document.querySelectorAll('.drag-ghost').length`), 0)

    // The status menu on a row's dot: no dragging needed.
    await browser.click(await browser.point('.row .status-button'))
    assert.equal(await browser.eval(`!!document.querySelector('.menu')`), true)
    await browser.click(await browser.point('.menu-item', 'Pending'))
    const updates = await browser.eval<{ id: string; patch: { state: string } }[]>(CALLS('tasks.update'))
    assert.deepEqual(updates.at(-1), { id: 't-plan', patch: { state: 'pending' } })
    assert.ok((await browser.eval<Record<string, string[]>>(SECTIONS)).pending.includes('t-plan'))

    await browser.shot('sidebar-after')
    // Statuses: drag Cancelled by its grip to the top.
    await browser.eval(`document.querySelector('[aria-label="Statuses"]').click()`)
    await sleep(100)
    await browser.shot('sidebar-statuses')
    await browser.drag(await browser.point('.status-row[data-status-row="cancelled"] .grip', '', true), await browser.point('.status-row', ''))
    const ops = await browser.eval<{ op: string; id: string; index: number }[]>(CALLS('tasks.statuses'))
    assert.deepEqual(ops.at(-1), { op: 'move', id: 'cancelled', index: 0 })
    assert.equal(await browser.eval(`document.querySelector('.status-row input').value`), 'Cancelled')

    // ---- The board ----
    await browser.load(`${base}/board`, 1400, 800)
    await browser.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Board').click()`)
    await sleep(100)
    await browser.shot('board')
    await browser.drag(await browser.point('.card', 'Reply to Alice'), await browser.point('.column[data-section="pending"] .column-head', '', true))
    moves = await browser.eval(CALLS('tasks.move'))
    assert.deepEqual(moves.at(-1), { id: 't-alice', state: 'pending', order: ['t-alice', 't-pack'] }, 'a column header: above its first card')
    const alice = await browser.eval<{ status: string; held_at: string | null }>(`(({ status, held_at }) => ({ status, held_at }))(window.__tasks.find((t) => t.id === 't-alice'))`)
    assert.equal(alice.status, 'hold')
    // Within a column: "Review the Q4 plan" to the top of To Do.
    await browser.drag(await browser.point('.card', 'Review the Q4 plan'), await browser.point('.card', 'Send the board memo'))
    moves = await browser.eval(CALLS('tasks.move'))
    assert.deepEqual(moves.at(-1), { id: 't-plan', state: null, order: ['t-plan', 't-memo'] })
    assert.deepEqual(await browser.eval(`[...document.querySelectorAll('.column[data-section="todo"] .card')].map((c) => c.dataset.id)`), ['t-plan', 't-memo'])
  } finally {
    await browser.close()
    server.close()
  }
})

/** Sets a select or checkbox in the open details pane the way a person does, by its label. */
const SET = (label: string, value: string | boolean) => `(() => {
  const el = document.querySelector('.details [aria-label=${JSON.stringify(label)}]') ?? [...document.querySelectorAll('.details label.check-line')].find((l) => l.textContent.includes(${JSON.stringify(label)}))?.querySelector('input')
  if (!el) throw new Error('no field ' + ${JSON.stringify(label)})
  if (el.type === 'checkbox') { if (el.checked !== ${JSON.stringify(value)}) el.click() }
  else if (el.tagName === 'INPUT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')) }
  else { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change')) }
})()`

test('the send form, every chat, Then, instruction and notes choice, sends what Orca takes; picking and merging', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  try {
    await browser.load(`http://127.0.0.1:${port}/sidebar`, 380, 1100)
    // What 0.4.2 sent with an empty instruction; this stand-in refuses it as Orca does.
    assert.equal(await browser.eval(`orca.plugin.request('tasks.send', { id: 't-layers', bot: 'Orca', type: 'handoff', chat: 'home', note: undefined, notes: true, state: null, by: 'board' }).then(() => 'sent', (e) => e.message)`), 'input: Invalid input')
    await browser.click(await browser.point('.row', 'Load the sample data'))
    const button = (text: string) => `(() => { const b = [...document.querySelectorAll('.details button')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click() })()`
    let sends = 0
    for (const chat of ['home', 'new', 'last']) {
      for (const then of ['', 'todo', 'in-progress', 'pending']) {
        for (const note of ['', 'Check progress']) {
          for (const notes of [true, false]) {
            await browser.eval(button('Send'))
            await sleep(120)
            await browser.eval(SET('Kind', 'handoff'))
            await browser.eval(SET('Chat', chat))
            await browser.eval(SET('Then', then))
            await browser.eval(SET('Instruction for the bot', note))
            await browser.eval(SET('Include the notes', notes))
            await sleep(30)
            await browser.eval(button('Send to Orca'))
            await sleep(150)
            sends += 1
            const label = JSON.stringify({ chat, then, note, notes })
            const errors = await browser.eval<string[]>(`[...document.querySelectorAll('.notice.error')].map((n) => n.textContent)`)
            assert.deepEqual(errors, [], label)
            const sent = await browser.eval<Record<string, unknown>[]>(CALLS('tasks.send'))
            assert.equal(sent.length, sends, label)
            const expected: Record<string, unknown> = { id: 't-layers', bot: 'Orca', type: 'handoff', chat, notes, state: then || null, by: 'panel' }
            if (note) expected.note = note
            assert.deepEqual(sent.at(-1), expected, label)
          }
        }
      }
    }
    // Yi's choice: a status message to the Home Chat, nothing else; Then starts at In Progress.
    await browser.eval(button('Send'))
    await sleep(120)
    assert.equal(await browser.eval(`document.querySelector('.details [aria-label="Then"]').value`), 'in-progress', 'Then starts at In Progress')
    await browser.eval(SET('Kind', 'status'))
    assert.equal(await browser.eval(`[...document.querySelectorAll('.details [aria-label="Chat"] option')].some((o) => o.value === 'new')`), false, 'no new chat for a status message')
    await browser.eval(button('Send to Orca'))
    await sleep(150)
    assert.deepEqual((await browser.eval<Record<string, unknown>[]>(CALLS('tasks.send'))).at(-1), { id: 't-layers', bot: 'Orca', type: 'status', chat: 'home', notes: true, state: 'in-progress', by: 'panel' })

    // Cmd-click picks tasks; Merge… opens the confirm step; Merge folds them into the kept one.
    await browser.eval(`document.querySelector('[aria-label="Close details"]')?.click()`)
    await sleep(100)
    for (const title of ['Reply to Alice', 'Review the Q4 plan']) {
      const at = await browser.point('.row', title)
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 4 })
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 4 })
      await sleep(120)
    }
    assert.deepEqual(await browser.eval(`[...document.querySelectorAll('.row.picked')].map((r) => r.dataset.id)`), ['t-alice', 't-plan'])
    await browser.eval(`[...document.querySelectorAll('.picked-bar button')].find((b) => b.textContent.includes('Merge')).click()`)
    await sleep(120)
    assert.match(await browser.eval<string>(`document.querySelector('.pane.merge').textContent`), /Merge 2 tasks/)
    await browser.shot('sidebar-merge')
    await browser.eval(`[...document.querySelectorAll('.pane.merge button')].find((b) => b.textContent.startsWith('Merge into')).click()`)
    await sleep(200)
    const merges = await browser.eval<Record<string, unknown>[]>(CALLS('tasks.merge'))
    assert.deepEqual(merges.at(-1), { keep: 't-alice', ids: ['t-plan'], due: 'earliest', priority: 'highest', created: 'earliest' })
    const plan = await browser.eval<{ state: string; merged_into: string }>(`(({ state, merged_into }) => ({ state, merged_into }))(window.__tasks.find((t) => t.id === 't-plan'))`)
    assert.deepEqual(plan, { state: 'cancelled', merged_into: 't-alice' })
    assert.match(await browser.eval<string>(`document.querySelector('.notice').textContent`), /Merged 1 task into "Reply to Alice"/)
  } finally {
    await browser.close()
    server.close()
  }
})

test('keys in the sidebar and on the board: move, open, tick, Esc closes from the top, typing is left alone', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  const VK: Record<string, number> = { Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38, ' ': 32 }
  const key = async (name: string, modifiers = 0) => {
    const printable = name.length === 1
    // Only letters, Space, / and ? are typed here; each with its real key code (Linux Chrome reads it).
    const code = printable ? (name === ' ' ? 'Space' : name === '?' || name === '/' ? 'Slash' : `Key${name.toUpperCase()}`) : name
    const vk = VK[name] ?? (name === '?' || name === '/' ? 191 : name.toUpperCase().charCodeAt(0))
    await browser.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, modifiers, ...(printable ? { text: name } : {}) })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, modifiers })
    await sleep(80)
  }
  const cursor = () => browser.eval<string | null>(`document.querySelector('.row.cursor, .card.cursor')?.dataset.id ?? null`)
  const pane = () => browser.eval<string | null>(`document.querySelector('.details .pane-title')?.value ?? null`)
  try {
    await browser.load(`http://127.0.0.1:${port}/sidebar`, 380, 1000)
    // J/K move a cursor through the list without opening anything (the details would hide it).
    await key('j')
    assert.deepEqual([await cursor(), await pane()], ['t-alice', null])
    await key('ArrowDown')
    await key('j')
    assert.equal(await cursor(), 't-plan')
    await key('k')
    assert.equal(await cursor(), 't-memo')
    // Enter opens it; J then moves the open details; Esc closes them and keeps the cursor.
    await key('Enter')
    assert.equal(await pane(), 'Send the board memo')
    await key('j')
    assert.equal(await pane(), 'Review the Q4 plan', 'the open details follow')
    await key('Escape')
    assert.deepEqual([await pane(), await cursor()], [null, 't-plan'])
    // X ticks the task under the cursor.
    await key('x')
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.setDone'))).at(-1), { id: 't-plan', done: true })
    await key(' ')
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.setDone'))).at(-1), { id: 't-plan', done: false }, 'Space too')

    // In quick add the keys are typing: nothing moves, nothing is ticked, Esc keeps the text.
    const ticks = (await browser.eval<unknown[]>(CALLS('tasks.setDone'))).length
    await key('n')
    assert.equal(await browser.eval(`document.activeElement?.getAttribute('aria-label')`), 'New task')
    for (const k of ['x', 'j', 'k', ' ', 'v', '?', '/']) await key(k, k === '?' ? 8 : 0)
    assert.equal(await browser.eval(`document.activeElement.value`), 'xjk v?/')
    assert.equal((await browser.eval<unknown[]>(CALLS('tasks.setDone'))).length, ticks)
    assert.deepEqual([await cursor(), await pane()], ['t-plan', null])
    await key('Escape')
    assert.deepEqual(await browser.eval(`[document.activeElement === document.body, document.querySelector('[aria-label="New task"]').value]`), [true, 'xjk v?/'])
    await browser.eval(`document.querySelector('[aria-label="New task"]').value = ''`)

    // Esc in the notes: what was typed is saved, then the details close.
    await key('Enter')
    await browser.eval(`document.querySelector('.details [aria-label="Notes"]').focus()`)
    for (const k of ['o', 'k']) await key(k)
    assert.equal(await browser.eval(`document.querySelector('.details [aria-label="Notes"]').value`), 'ok')
    await key('Escape')
    await sleep(100)
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.update'))).at(-1), { id: 't-plan', patch: { notes: 'ok' } })
    assert.equal(await pane(), null)
    // Cmd/Ctrl+Enter saves the notes and leaves the pane open.
    await key('Enter')
    await browser.eval(`document.querySelector('.details [aria-label="Notes"]').focus()`)
    await key('z')
    await key('Enter', 2)
    await sleep(100)
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.update'))).at(-1), { id: 't-plan', patch: { notes: 'okz' } })
    assert.equal(await pane(), 'Review the Q4 plan')

    // The send form: Esc closes it before the details; with an instruction typed, it asks first.
    await browser.eval(`[...document.querySelectorAll('.details button')].find((b) => b.textContent.includes('Send to a bot')).click()`)
    await sleep(150)
    await browser.eval(`document.querySelector('.details [aria-label="Instruction for the bot"]').focus()`)
    await key('h')
    await key('Escape')
    assert.equal(await browser.eval(`!!document.querySelector('.bot-box')`), true, 'a typed instruction is not dropped on the first Esc')
    assert.match(await browser.eval<string>(`document.querySelector('.notice').textContent`), /Press Esc \(or the mouse back button\) again to discard it/)
    await key('Escape')
    assert.deepEqual([await browser.eval(`!!document.querySelector('.bot-box')`), await pane()], [false, 'Review the Q4 plan'], 'the second Esc closes the form, not the details')
    await browser.eval(`[...document.querySelectorAll('.details button')].find((b) => b.textContent.includes('Send to a bot')).click()`)
    await sleep(150)
    await key('Escape')
    assert.equal(await browser.eval(`!!document.querySelector('.bot-box')`), false, 'nothing typed: one Esc closes it')
    await key('Escape')
    assert.equal(await pane(), null)
    assert.equal((await browser.eval<unknown[]>(CALLS('tasks.send'))).length, 0, 'nothing was sent')

    // ? lists the shortcuts; Esc hides them. The menu closes on Esc before anything else.
    await key('?', 8)
    assert.match(await browser.eval<string>(`document.querySelector('.shortcuts')?.textContent ?? ''`), /Move between tasks[\s\S]*Esc/)
    await browser.shot('sidebar-shortcuts')
    await key('Escape')
    assert.equal(await browser.eval(`!!document.querySelector('.shortcuts')`), false)
    await browser.click(await browser.point('.row .status-button'))
    await key('Enter')
    assert.equal(await browser.eval(`!!document.querySelector('.menu')`), true)
    await key('Escape')
    assert.equal(await browser.eval(`!!document.querySelector('.menu')`), false)

    // The board: the same keys over the cards, / searches and V switches the view.
    await browser.load(`http://127.0.0.1:${port}/board`, 1400, 800)
    await key('v')
    assert.equal(await browser.eval(`!!document.querySelector('.board')`), true)
    await key('j')
    assert.equal(await cursor(), 't-alice')
    await key('Enter')
    assert.equal(await pane(), 'Reply to Alice')
    await key('Escape')
    assert.equal(await pane(), null)
    await key('/')
    assert.equal(await browser.eval(`document.activeElement?.getAttribute('aria-label')`), 'Search tasks')
    await key('Escape')
    await key('?', 8)
    assert.match(await browser.eval<string>(`document.querySelector('.shortcuts').textContent`), /List or board/)
  } finally {
    await browser.close()
    server.close()
  }
})

test('the mouse back and forward buttons: back closes the task, then goes back a view; the page never navigates away', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  // The thumb buttons as a mouse sends them: button 3 (back) and 4 (forward), pressed and released.
  const thumb = async (which: 'back' | 'forward', at = { x: 200, y: 300 }) => {
    const buttons = which === 'back' ? 8 : 16
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', buttons: 0 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: which, buttons, clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: which, buttons: 0, clickCount: 1 })
    await sleep(150)
  }
  const pane = () => browser.eval<string | null>(`document.querySelector('.details .pane-title')?.value ?? null`)
  const shown = () => browser.eval<string>(`document.querySelector('[aria-label="Show"]').value`)
  const setShow = (value: string) => browser.eval(`(() => { const el = document.querySelector('[aria-label="Show"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change')) })()`)
  // Every event of those buttons is stopped by the page (defaultPrevented), so the browser does
  // not take it as "go back" in the frame. (The page's listener comes first on the window, in the
  // capture phase, and stops it there: this one is beside it.)
  const listen = `window.__thumb = []; for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) window.addEventListener(type, (e) => { if (e.button > 2) window.__thumb.push([type, e.button, e.defaultPrevented]) }, true)`
  // One press of the back button as only some of its events, sent to the row under the pointer:
  // what a frame gets when the others are lost on the way.
  const partial = async (types: string[], button = 3) => {
    await browser.eval(`(() => {
      const el = document.querySelector('.row') ?? document.body
      for (const type of ${JSON.stringify(types)}) {
        const Kind = type.startsWith('pointer') ? PointerEvent : MouseEvent
        el.dispatchEvent(new Kind(type, { button: ${button}, buttons: type.endsWith('down') ? ${button === 3 ? 8 : 16} : 0, bubbles: true, cancelable: true, composed: true, pointerType: 'mouse' }))
      }
    })()`)
    // Release events this close to a step count as the same press.
    await sleep(450)
  }
  const cmd = async (key: string, code: string, keyCode: number) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: 4 })
    await sleep(150)
  }
  const base = `http://127.0.0.1:${port}`
  try {
    // about:blank is the entry before the page: a back that got through would land there.
    await browser.load(`${base}/sidebar`, 380, 1000)
    const href = await browser.eval<string>('location.href')
    const entries = await browser.eval<number>('history.length')
    await browser.eval(listen)
    await browser.click(await browser.point('.row', 'Send the board memo'))
    assert.equal(await pane(), 'Send the board memo')
    await thumb('back')
    assert.equal(await pane(), null, 'back closes the open task, as Esc does')
    // Every event of the press is stopped. (The page cancels pointerdown, so Chrome sends no
    // mousedown and mouseup after it; auxclick comes on some platforms only.)
    const seen = await browser.eval<[string, number, boolean][]>('window.__thumb')
    assert.deepEqual(seen.filter(([type]) => type.startsWith('pointer')), [['pointerdown', 3, true], ['pointerup', 3, true]])
    assert.ok(seen.every(([, , prevented]) => prevented), JSON.stringify(seen))
    await thumb('forward')
    assert.equal(await pane(), 'Send the board memo', 'forward opens it again')
    await thumb('back')

    // The view before: the Show filter, step by step.
    await setShow('today')
    await setShow('overdue')
    assert.equal(await shown(), 'overdue')
    await thumb('back')
    assert.equal(await shown(), 'today')
    await thumb('back')
    assert.equal(await shown(), 'all')
    await thumb('back')
    assert.equal(await shown(), 'all', 'nothing before: nothing happens')
    await thumb('forward')
    assert.equal(await shown(), 'today')
    await thumb('back')
    assert.equal(await shown(), 'all')

    // The send form closes before the details; a typed instruction is not dropped on the first back.
    await browser.click(await browser.point('.row', 'Load the sample data'))
    await browser.eval(`[...document.querySelectorAll('.details button')].find((b) => b.textContent.includes('Send to a bot')).click()`)
    await sleep(150)
    await browser.eval(`(() => { const el = document.querySelector('.details [aria-label="Instruction for the bot"]'); el.value = 'Check'; el.dispatchEvent(new Event('input')) })()`)
    await thumb('back')
    assert.equal(await browser.eval(`!!document.querySelector('.bot-box')`), true)
    assert.match(await browser.eval<string>(`document.querySelector('.notice').textContent`), /again to discard it/)
    await thumb('back')
    assert.deepEqual([await browser.eval(`!!document.querySelector('.bot-box')`), await pane()], [false, 'Load the sample data'])
    await thumb('back')
    assert.equal(await pane(), null)

    // Whichever events of a press arrive, one press is one step back.
    await setShow('today')
    await setShow('overdue')
    await setShow('upcoming')
    await partial(['pointerdown', 'pointerup'])
    assert.equal(await shown(), 'overdue', 'the pointer events alone')
    await partial(['mousedown', 'mouseup', 'auxclick'])
    assert.equal(await shown(), 'today', 'the mouse events alone, auxclick after them not a second step')
    await partial(['auxclick'])
    assert.equal(await shown(), 'all', 'auxclick alone')
    await partial(['pointerdown', 'pointerup'], 4)
    assert.equal(await shown(), 'today', 'the forward button, as pointer events')

    // Cmd+[ and Cmd+] (what Logi Options+ and other mouse software send on macOS), Cmd+Left.
    await setShow('overdue')
    await cmd('[', 'BracketLeft', 219)
    assert.equal(await shown(), 'today', 'Cmd+[')
    await cmd(']', 'BracketRight', 221)
    assert.equal(await shown(), 'overdue', 'Cmd+]')
    await cmd('ArrowLeft', 'ArrowLeft', 37)
    assert.equal(await shown(), 'today', 'Cmd+Left')
    await cmd('[', 'BracketLeft', 219)
    assert.equal(await shown(), 'all')

    // The Browser Back key (some mice and keyboards send it) is the same back.
    await setShow('upcoming')
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'BrowserBack', code: 'BrowserBack', windowsVirtualKeyCode: 166 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'BrowserBack', code: 'BrowserBack', windowsVirtualKeyCode: 166 })
    await sleep(150)
    assert.equal(await shown(), 'all')
    assert.equal((await browser.eval<unknown[]>(CALLS('tasks.send'))).length, 0, 'nothing was sent')
    assert.deepEqual([await browser.eval('location.href'), await browser.eval('history.length')], [href, entries], 'still the same page, and no history entries added')

    // The board: list or board is a view too.
    await browser.load(`${base}/board`, 1400, 800)
    await browser.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Board').click()`)
    await sleep(100)
    assert.equal(await browser.eval(`!!document.querySelector('.board')`), true)
    await browser.click(await browser.point('.card', 'Reply to Alice'))
    assert.equal(await pane(), 'Reply to Alice')
    await thumb('back', { x: 700, y: 20 })
    assert.equal(await pane(), null)
    await thumb('back', { x: 700, y: 20 })
    assert.equal(await browser.eval(`!!document.querySelector('.board')`), false, 'back to the list')
    await thumb('forward', { x: 700, y: 20 })
    assert.equal(await browser.eval(`!!document.querySelector('.board')`), true)
    assert.equal(await browser.eval('location.pathname'), '/board')
  } finally {
    await browser.close()
    server.close()
  }
})

test('Suggest merges: the list, Review merge opens the merge step filled in, Dismiss, nothing merges unconfirmed; the In Progress dot pulses', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  const base = `http://127.0.0.1:${port}`
  const box = () => browser.eval<string>(`document.querySelector('.notice.suggestions')?.textContent ?? ''`)
  const press = (label: string) => browser.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)} || x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.click() })()`)
  const inSuggestion = (keep: string, label: string) => browser.eval(`[...document.querySelectorAll('.suggestion[data-keep="${keep}"] button')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`)
  try {
    await browser.load(`${base}/sidebar`, 380, 1100)
    // The In Progress dot pulses; the others stay still; with less motion asked for, it too.
    const pulse = (id: string) => browser.eval<string>(`getComputedStyle(document.querySelector('[data-id="${id}"] .status-button .dot')).animationName`)
    assert.equal(await pulse('t-layers'), 'dot-pulse')
    assert.equal(await pulse('t-alice'), 'none')
    assert.equal(await pulse('t-pack'), 'none', 'Pending stays still')
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await pulse('t-layers'), 'none', 'prefers-reduced-motion: no animation')
    await browser.send('Emulation.setEmulatedMedia', { features: [] })

    await press('Suggest merges')
    assert.match(await box(), /Asking Claude Code which open tasks look like duplicates/)
    await sleep(400)
    assert.match(await box(), /2 likely duplicates: review each before it merges/)
    assert.match(await box(), /Keep "Send the board memo"88%\+ "Review the Q4 plan"Both are about sending the board the Q4 memo/)
    assert.match(await box(), /Only the open tasks' title, notes, sources, tags, project, due day and status go to Claude Code/)
    await browser.shot('sidebar-suggestions')
    assert.deepEqual(await browser.eval(CALLS('tasks.merge')), [], 'nothing merged yet')

    // Dismiss: gone from the list, and the worker remembers it.
    await inSuggestion('t-alice', 'Dismiss')
    await sleep(100)
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.dismissMerge'))).at(-1), { ids: ['t-alice', 't-pack'] })
    assert.equal(await browser.eval(`document.querySelectorAll('.suggestion').length`), 1)

    // Review merge…: the merge step with the keeper, earliest due and highest priority; Esc closes the step first.
    await inSuggestion('t-memo', 'Review merge')
    await sleep(100)
    assert.match(await browser.eval<string>(`document.querySelector('.pane.merge').textContent`), /Merge 2 tasks[\s\S]*Merge into "Send the board memo"/)
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(100)
    assert.deepEqual([await browser.eval(`!!document.querySelector('.pane.merge')`), (await box()) !== ''], [false, true])
    assert.deepEqual(await browser.eval(CALLS('tasks.merge')), [], 'closing the step merges nothing')
    await inSuggestion('t-memo', 'Review merge')
    await sleep(100)
    await browser.eval(`[...document.querySelectorAll('.pane.merge button')].find((b) => b.textContent.startsWith('Merge into')).click()`)
    await sleep(200)
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.merge'))).at(-1), { keep: 't-memo', ids: ['t-plan'], due: 'earliest', priority: 'highest', created: 'earliest' })
    assert.match(await box(), /No likely duplicates/, 'a merged suggestion drops out')
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(100)
    assert.equal(await box(), '', 'Esc closes the suggestions')

    // Claude Code not installed: what to install.
    await browser.eval(`window.__suggestMode = 'missing'`)
    await press('Suggest merges')
    await sleep(400)
    assert.match(await browser.eval<string>(`document.querySelector('.notice.suggestions.error')?.textContent ?? ''`), /was not found\. Install Claude Code/)

    // The board has the button with its name.
    await browser.load(`${base}/board`, 1400, 800)
    assert.equal(await browser.eval(`[...document.querySelectorAll('.header button')].some((b) => b.textContent.trim() === 'Suggest merges')`), true)
    await press('Suggest merges')
    await sleep(400)
    assert.equal(await browser.eval(`document.querySelectorAll('.suggestion').length`), 2)
    await browser.shot('board-suggestions')
  } finally {
    await browser.close()
    server.close()
  }
})

test('hover quick actions: an icon per status at the right edge, shown on hover or focus, a click moves the task without opening it; P and C', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  const base = `http://127.0.0.1:${port}`
  const quick = (id: string) => `document.querySelector('[data-id="${id}"] .quick')`
  // The icons fade in and out (120ms): wait until the fade has finished.
  const shown = async (id: string) => {
    const opacity = () => browser.eval<string>(`getComputedStyle(${quick(id)}).opacity`)
    for (let i = 0; i < 20; i += 1) {
      const value = await opacity()
      if (value === '0' || value === '1') return value
      await sleep(50)
    }
    return opacity()
  }
  const icons = (id: string) => browser.eval<[string, string][]>(`[...${quick(id)}.querySelectorAll('button')].map((b) => [b.dataset.status ?? 'more', b.title])`)
  const hover = async (id: string) => {
    const at = await browser.point(`[data-id="${id}"]`, '', true)
    await browser.mouse('mouseMoved', at.x, at.y, 0)
    await sleep(250)
  }
  const button = async (id: string, status: string) => {
    const at = await browser.eval<{ x: number; y: number }>(`(() => { const r = ${quick(id)}.querySelector('${status === 'more' ? '.more' : `[data-status="${status}"]`}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await browser.click(at)
  }
  const pane = () => browser.eval<string | null>(`document.querySelector('.details .pane-title')?.value ?? null`)
  const updates = () => browser.eval<{ id: string; patch: Record<string, unknown> }[]>(CALLS('tasks.update'))
  const key = async (name: string) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) })
    await sleep(150)
  }
  try {
    await browser.load(`${base}/sidebar`, 380, 1000)
    await browser.mouse('mouseMoved', 5, 5, 0)
    assert.equal(await shown('t-alice'), '0', 'hidden until hovered: the rows stay clean')
    const title = `document.querySelector('[data-id="t-alice"] .row-title').getBoundingClientRect().width + ',' + document.querySelector('[data-id="t-alice"]').getBoundingClientRect().height`
    const before = await browser.eval<string>(title)
    await hover('t-alice')
    assert.equal(await shown('t-alice'), '1')
    assert.equal(await shown('t-memo'), '0', 'only the hovered row')
    assert.equal(await browser.eval<string>(title), before, 'laid over the row: nothing moves')
    // To Do: every other status, in order, named as the person named them (▷ In Progress opens
    // the send menu, tested below); then "…".
    assert.deepEqual(await icons('t-alice'), [['in-progress', 'Send to a bot or a project…'], ['pending', 'Pending'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['more', 'More']])
    await browser.shot('sidebar-quick')

    // ✓ Done: moved, not opened.
    await button('t-alice', 'done')
    assert.deepEqual((await updates()).at(-1), { id: 't-alice', patch: { state: 'done' } })
    assert.equal(await pane(), null, 'a click on an icon does not open the task')
    // The clock: Pending (on hold), not opened.
    await hover('t-memo')
    await button('t-memo', 'pending')
    assert.deepEqual((await updates()).at(-1), { id: 't-memo', patch: { state: 'pending' } })
    assert.equal(await browser.eval(`window.__tasks.find((t) => t.id === 't-memo').status`), 'hold')
    assert.equal(await pane(), null)

    // "…": the other actions; Send to a bot… opens the task with its send form.
    await hover('t-plan')
    await button('t-plan', 'more')
    assert.deepEqual(await browser.eval(`[...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent)`), ['Open', 'Send to a bot…', 'Send to the project…', 'Merge…', 'Pick for a merge'])
    await browser.eval(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent === 'Send to a bot…').click()`)
    await sleep(200)
    assert.deepEqual([await pane(), await browser.eval(`!!document.querySelector('.bot-box')`)], ['Review the Q4 plan', true])
    await browser.eval(`document.querySelector('[aria-label="Close details"]').click()`)
    await sleep(100)

    // Keyboard focus shows them too; P puts the task under the cursor on hold, C cancels, C again reopens.
    await browser.mouse('mouseMoved', 5, 5, 0)
    await key('j')
    const cursor = await browser.eval<string>(`document.querySelector('.row.cursor').dataset.id`)
    assert.equal(await shown(cursor), '1', 'shown on keyboard focus')
    await key('p')
    assert.deepEqual((await updates()).at(-1), { id: cursor, patch: { state: 'pending' } })
    await key('c')
    assert.deepEqual((await updates()).at(-1), { id: cursor, patch: { state: 'cancelled' } })
    await key('c')
    assert.deepEqual((await updates()).at(-1), { id: cursor, patch: { state: 'todo' } })
    assert.equal(await pane(), null)

    // The board's cards: three icons (Done, ▷ send, Pending first); the rest under "…".
    await browser.load(`${base}/board`, 1400, 800)
    await browser.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Board').click()`)
    await sleep(100)
    await hover('t-plan')
    assert.equal(await shown('t-plan'), '1')
    assert.deepEqual(await icons('t-plan'), [['in-progress', 'Send to a bot or a project…'], ['pending', 'Pending'], ['done', 'Done'], ['more', 'More']])
    await browser.shot('board-quick')
    await button('t-plan', 'more')
    assert.ok((await browser.eval<string[]>(`[...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent)`)).includes('Move to Cancelled'))
    await browser.eval(`[...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent === 'Move to Cancelled').click()`)
    await sleep(150)
    assert.deepEqual((await updates()).at(-1), { id: 't-plan', patch: { state: 'cancelled' } })
    await hover('t-alice')
    await button('t-alice', 'done')
    assert.deepEqual((await updates()).at(-1), { id: 't-alice', patch: { state: 'done' } })
    assert.equal(await pane(), null, 'not opened on the board either')
  } finally {
    await browser.close()
    server.close()
  }
})

test('the send menu (▷): bots and projects in one click, without opening the task; Esc, a click elsewhere, the keyboard; a task with a bot keeps the plain move', { skip: chromePath ? false : 'no Chrome found (set CHROME_BIN)' }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  const base = `http://127.0.0.1:${port}`
  const hover = async (id: string) => {
    const at = await browser.point(`[data-id="${id}"]`, '', true)
    await browser.mouse('mouseMoved', at.x, at.y, 0)
    await sleep(250)
  }
  const sendButton = async (id: string) => {
    await hover(id)
    const at = await browser.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-id="${id}"] .quick [data-send]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await browser.click(at)
    await sleep(150)
  }
  const choices = () => browser.eval<string[]>(`[...document.querySelectorAll('.send-menu [data-send-to]')].map((b) => b.dataset.sendTo)`)
  const groups = () => browser.eval<string[]>(`[...document.querySelectorAll('.send-menu .menu-label')].map((x) => x.textContent)`)
  const focused = () => browser.eval<string | null>(`document.activeElement?.dataset.sendTo ?? (document.activeElement?.dataset.id ? 'row:' + document.activeElement.dataset.id : document.activeElement?.className ?? null)`)
  const open = () => browser.eval<boolean>(`!!document.querySelector('.send-menu')`)
  const pane = () => browser.eval<string | null>(`document.querySelector('.details .pane-title')?.value ?? null`)
  const notice = () => browser.eval<string>(`document.querySelector('.notice')?.textContent ?? ''`)
  const task = (id: string) => browser.eval<{ state: string; handoffs: unknown[]; workspaces?: unknown[] }>(`window.__tasks.find((t) => t.id === '${id}')`)
  const key = async (name: string, code = name) => {
    // Enter as a keyboard types it (with its character), so a focused button is pressed.
    await browser.send('Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: { Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38 }[name] ?? 0, ...(name === 'Enter' ? { text: '\r' } : {}) })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: { Escape: 27, Enter: 13, ArrowDown: 40, ArrowUp: 38 }[name] ?? 0 })
    await sleep(150)
  }
  try {
    await browser.load(`${base}/sidebar`, 380, 1000)

    // ▷ opens the menu by the button; the task stays closed. Bots, then the projects: the task's
    // own first (planning), then the other Git projects (not the folder one); then the plain move.
    await sendButton('t-plan')
    assert.equal(await open(), true)
    assert.equal(await pane(), null, 'the task is not opened')
    assert.deepEqual(await groups(), ['Bots', 'Projects'])
    assert.deepEqual(await choices(), ['bot:Orca', 'project:planning', 'project:website', 'none'])
    assert.match(await browser.eval<string>(`document.querySelector('[data-send-to="project:planning"]').textContent`), /planningthis project/)
    assert.equal(await focused(), 'bot:Orca', 'the keyboard starts on the first bot')

    // Arrows move, Esc closes and gives the keyboard back to the row; nothing was sent.
    await key('ArrowDown')
    assert.equal(await focused(), 'project:planning')
    await key('ArrowUp')
    assert.equal(await focused(), 'bot:Orca')
    await key('Escape')
    assert.deepEqual([await open(), await focused(), await pane()], [false, 'row:t-plan', null])

    // A click elsewhere closes it too.
    await sendButton('t-plan')
    await browser.click({ x: 190, y: 980 })
    assert.equal(await open(), false)

    // Enter picks: a project. The worker is asked for that project's last choices, then starts a
    // workspace there with them (Claude Code at first) and moves the task to In Progress.
    await sendButton('t-plan')
    await key('ArrowDown')
    await key('ArrowDown')
    assert.equal(await focused(), 'project:website')
    await key('Enter')
    await sleep(300)
    assert.equal(await open(), false)
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.projectOffer'))).at(-1), { id: 't-plan', project: 'website' })
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.sendToProject'))).at(-1), { id: 't-plan', agent: 'claude', notes: true, state: 'in-progress', open: false, by: 'panel', project: 'website' })
    assert.match(await notice(), /Started claude in a new workspace of website, t-plan-ws\. The task is In Progress\./)
    assert.equal((await task('t-plan')).state, 'in-progress')
    assert.equal(await pane(), null, 'still not opened')
    assert.equal(await focused(), 'row:t-plan', 'the keyboard is back on the row')

    // A click picks: a bot, to its Home Chat as a handoff, then In Progress.
    await sendButton('t-alice')
    await sleep(100)
    await browser.click(await browser.point('.send-menu [data-send-to="bot:Orca"]', '', true))
    await sleep(300)
    assert.deepEqual((await browser.eval<unknown[]>(CALLS('tasks.send'))).at(-1), { id: 't-alice', bot: 'Orca', type: 'handoff', chat: 'home', notes: true, state: 'in-progress', by: 'panel' })
    assert.match(await notice(), /Sent to Orca in its Home Chat\. The task is In Progress\./)
    assert.equal((await task('t-alice')).handoffs.length, 1)

    // "Only move to In Progress": no send.
    const sends = (await browser.eval<unknown[]>(CALLS('tasks.send'))).length
    await sendButton('t-memo')
    await browser.click(await browser.point('.send-menu [data-send-to="none"]', '', true))
    await sleep(200)
    assert.equal((await task('t-memo')).state, 'in-progress')
    assert.equal((await browser.eval<unknown[]>(CALLS('tasks.send'))).length, sends)

    // A task a bot has keeps the plain ▷: it moves the task, no menu. (t-alice, taken back to To Do.)
    await browser.eval(`window.orca.plugin.request('tasks.update', { id: 't-alice', patch: { state: 'todo' } })`)
    await sleep(300)
    await hover('t-alice')
    assert.equal(await browser.eval(`!!document.querySelector('[data-id="t-alice"] .quick [data-send]')`), false)
    await browser.eval(`document.querySelector('[data-id="t-alice"] .quick [data-status="in-progress"]').click()`)
    await sleep(200)
    assert.equal(await open(), false)
    assert.equal((await task('t-alice')).state, 'in-progress')

    // The board's cards, from demo data: the project's bot first, then Orca; the task's project
    // first. Dark too.
    await browser.load(`${base}/board?demo&theme=dark`, 1280, 800)
    await browser.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Board').click()`)
    await sleep(200)
    await sendButton('t-round01')
    await sleep(100)
    assert.deepEqual(await choices(), ['bot:online-store', 'bot:Orca', 'bot:docs-site', 'project:online-store', 'project:docs-site', 'project:mobile-app', 'none'])
    assert.equal(await pane(), null)
    await browser.shot('board-send-menu')
    await key('Escape')
    assert.deepEqual([await open(), await focused()], [false, 'row:t-round01'])
  } finally {
    await browser.close()
    server.close()
  }
})

// The README's screenshots and the plugin page's cover and screenshots, from the made-up tasks in
// test/demo-data.ts (`?demo`) and a light and a dark theme (`?theme=`). Runs only when asked:
// AGENT_TASKS_README_SHOTS=docs/screenshots npm run test:browser
const README_SHOTS = process.env.AGENT_TASKS_README_SHOTS
test('README screenshots, from demo data', { skip: !chromePath ? 'no Chrome found (set CHROME_BIN)' : !README_SHOTS ? 'set AGENT_TASKS_README_SHOTS=<folder> to take them' : false }, async () => {
  const { server, port } = await serve()
  const browser = await Browser.open()
  const base = `http://127.0.0.1:${port}`
  const save = async (name: string) => {
    const { data } = (await browser.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    await writeFile(join(README_SHOTS as string, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const clickButton = (scope: string, text: string) =>
    browser.eval(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`)
  try {
    for (const theme of ['light', 'dark']) {
      // The board's columns.
      await browser.load(`${base}/board?demo&theme=${theme}`, 1280, 800)
      await clickButton('', 'Board')
      await sleep(300)
      await save(`board-${theme}`)
      // The list with a task's details open.
      await browser.load(`${base}/board?demo&theme=${theme}`, 1280, 800)
      await browser.click(await browser.point('.row', 'Fix the rounding in the checkout total'))
      await sleep(300)
      await save(`details-${theme}`)
      // Send to a bot, from the details.
      await clickButton('.details', 'Send to a bot')
      await sleep(400)
      await browser.eval(`document.querySelector('.bot-box').scrollIntoView({ block: 'end' })`)
      await sleep(100)
      await save(`send-${theme}`)
      // The sidebar panel.
      await browser.load(`${base}/sidebar?demo&theme=${theme}`, 380, 800)
      await sleep(300)
      await save(`sidebar-${theme}`)
      // ▷ on a row: the send menu.
      const row = await browser.point('.row', 'Fix the rounding in the checkout total', true)
      await browser.mouse('mouseMoved', row.x, row.y, 0)
      await sleep(250)
      await browser.click(
        await browser.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-id="t-round01"] .quick [data-send]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      )
      await sleep(300)
      await save(`send-menu-${theme}`)
    }
    // The plugin page's cover: the board, 16:10 at 1600×1000.
    await browser.load(`${base}/board?demo&theme=light`, 1600, 1000)
    await clickButton('', 'Board')
    await sleep(300)
    await save('cover')
  } finally {
    await browser.close()
    server.close()
  }
})
