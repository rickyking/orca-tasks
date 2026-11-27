// What the sidebar and the board tell the worker about events that could be a mouse's back or
// forward gesture, so they land in `orca plugin logs <plugin>` without opening DevTools; only while
// the plugin setting NAV_LOG_SETTING or the page's console switch is on. The page
// picks the events (`navWorthy`), the worker checks what came (`checkNavLog`) and writes one line
// each (`navLine`), at most NAV_LOG_PER_MINUTE a minute. Nothing about tasks is in them: the event's
// type, its button or key (only the keys that could be Back or Forward), the modifiers, and where
// on the page it landed. Pure functions, shared by the page, the worker and the tests.

/** An event as the page saw it. */
export interface RawNavEvent {
  type: string
  button?: number
  buttons?: number
  key?: string
  code?: string
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  deltaX?: number
  deltaY?: number
}

/** One event, as the page sends it to the worker. */
export interface NavEntry {
  /** `sidebar` or `board` (the board tab). */
  surface: string
  /** What was shown: `list`, `board` or `statuses`, with `+details` and `+menu` when open. */
  view: string
  type: string
  button?: number
  buttons?: number
  pointerType?: string
  key?: string
  code?: string
  /** `meta+alt`, or '' for none. */
  mods: string
  deltaX?: number
  deltaY?: number
  /** For `navigate`: the navigation's type. */
  detail?: string
  /** Where it landed: `row`, `card`, `details`, `menu`, `header`, `field` or `page`. */
  target: string
  /** Whether the frame had the keyboard focus. */
  focus: boolean
  /** What the page did: `back`, `forward`, `stopped` (one event of a press already stepped),
   *  another key action, or `none`. */
  taken: string
}

/** Sent once when the page has attached its listeners. */
export interface NavStart {
  surface: string
  views: string[]
  events: string[]
  /** The page is Orca's own frame (not inside another frame). */
  top: boolean
  focus: boolean
  hostApi: string
  platform: string
}

/** What `tasks.navLog` takes: the start line, events, and how many the page left out. */
export interface NavLogInput {
  start?: NavStart
  entries?: NavEntry[]
  dropped?: number
  /** Switched on in the page's console (`agentTasksDebugNav(true)` or `?debug-nav`). */
  debug?: boolean
}

/** The plugin setting that turns the `nav …` lines on (off by default). */
export const NAV_LOG_SETTING = 'logNavigation'

/** The keys that could be Back or Forward with Cmd, Alt or Ctrl (what mouse software sends). */
const NAV_KEYS: ReadonlySet<string> = new Set(['[', ']', 'ArrowLeft', 'ArrowRight', 'BracketLeft', 'BracketRight'])
const BROWSER_KEYS: ReadonlySet<string> = new Set(['BrowserBack', 'BrowserForward'])
const MOUSE_TYPES: ReadonlySet<string> = new Set(['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'])
/** Events of the page itself that a back gesture could cause. */
export const NAV_PAGE_EVENTS = ['popstate', 'hashchange', 'pagehide', 'beforeunload'] as const
/** A sideways wheel at least this far (pixels) is worth a line; a swipe on some mice. */
export const NAV_WHEEL_MIN = 40
/** Lines the worker writes a minute, at most. */
export const NAV_LOG_PER_MINUTE = 60

/** Whether `event` could be a back or forward gesture. */
export function navWorthy(event: RawNavEvent): boolean {
  if (MOUSE_TYPES.has(event.type)) return (event.button ?? 0) >= 3 || ((event.buttons ?? 0) & 24) !== 0
  if (event.type === 'keydown') {
    if (BROWSER_KEYS.has(event.key ?? '') || BROWSER_KEYS.has(event.code ?? '')) return true
    return Boolean(event.meta || event.alt || event.ctrl) && (NAV_KEYS.has(event.key ?? '') || NAV_KEYS.has(event.code ?? ''))
  }
  if (event.type === 'wheel') {
    const dx = Math.abs(event.deltaX ?? 0)
    return dx >= NAV_WHEEL_MIN && dx > 2 * Math.abs(event.deltaY ?? 0)
  }
  return event.type === 'navigate' || (NAV_PAGE_EVENTS as readonly string[]).includes(event.type)
}

/** The modifiers held, as `meta+alt`. */
export function navMods(event: Pick<RawNavEvent, 'meta' | 'ctrl' | 'alt' | 'shift'>): string {
  return [event.meta && 'meta', event.ctrl && 'ctrl', event.alt && 'alt', event.shift && 'shift'].filter(Boolean).join('+')
}

/**
 * Leaves out what is not worth a line or comes too fast: at most `burst` lines, refilled at
 * `perSecond`, and a sideways wheel at most once per `wheelGapMs` (a swipe sends dozens).
 */
export class NavThrottle {
  private readonly burst: number
  private readonly perSecond: number
  private readonly wheelGapMs: number
  private tokens: number
  private last = 0
  private lastWheel = -Infinity
  dropped = 0
  constructor(burst = 20, perSecond = 2, wheelGapMs = 500) {
    this.burst = burst
    this.perSecond = perSecond
    this.wheelGapMs = wheelGapMs
    this.tokens = burst
  }

  allow(type: string, time: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((time - this.last) / 1000) * this.perSecond)
    this.last = time
    if (type === 'wheel') {
      if (time - this.lastWheel < this.wheelGapMs) return false
      this.lastWheel = time
    }
    if (this.tokens < 1) {
      this.dropped += 1
      return false
    }
    this.tokens -= 1
    return true
  }
}

const WORD = /^[A-Za-z0-9_+\-.[\]]{0,32}$/

function word(value: unknown, fallback = '?'): string {
  return typeof value === 'string' && WORD.test(value) ? value : fallback
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

/** A key as it may be logged: one of the Back/Forward keys, else `?` (never what was typed). */
function navKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return typeof value === 'string' && (NAV_KEYS.has(value) || BROWSER_KEYS.has(value)) ? value : '?'
}

/** What `tasks.navLog` accepts: at most 50 entries, each field a short word or a number. */
export function checkNavLog(input: unknown): { start: NavStart | null; entries: NavEntry[]; dropped: number; debug: boolean } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = raw.start && typeof raw.start === 'object' ? (raw.start as Record<string, unknown>) : null
  const list = (value: unknown) => (Array.isArray(value) ? value.slice(0, 12).map((v) => word(v)) : [])
  const start: NavStart | null = s
    ? { surface: word(s.surface), views: list(s.views), events: list(s.events), top: s.top === true, focus: s.focus === true, hostApi: word(s.hostApi), platform: word(s.platform) }
    : null
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).slice(0, 50).flatMap((value): NavEntry[] => {
    if (!value || typeof value !== 'object') return []
    const e = value as Record<string, unknown>
    const entry: NavEntry = { surface: word(e.surface), view: word(e.view), type: word(e.type), mods: word(e.mods, ''), target: word(e.target), focus: e.focus === true, taken: word(e.taken, 'none') }
    const numbers = { button: int(e.button), buttons: int(e.buttons), deltaX: int(e.deltaX), deltaY: int(e.deltaY) }
    for (const [k, v] of Object.entries(numbers)) if (v !== undefined) (entry as unknown as Record<string, unknown>)[k] = v
    const key = navKey(e.key)
    const code = navKey(e.code)
    if (key) entry.key = key
    if (code) entry.code = code
    if (e.pointerType !== undefined && e.pointerType !== '') entry.pointerType = word(e.pointerType)
    if (e.detail !== undefined && e.detail !== '') entry.detail = word(e.detail)
    return [entry]
  })
  return { start, entries, dropped: Math.max(0, int(raw.dropped) ?? 0), debug: raw.debug === true }
}

/** The log line for one event: `nav sidebar/list+details pointerdown button=3 buttons=8
 *  pointer=mouse on=row focus=no -> stopped`. */
export function navLine(e: NavEntry): string {
  const parts = [`nav ${e.surface}/${e.view} ${e.type}`]
  if (e.button !== undefined) parts.push(`button=${e.button}`)
  if (e.buttons !== undefined) parts.push(`buttons=${e.buttons}`)
  if (e.pointerType) parts.push(`pointer=${e.pointerType}`)
  if (e.key) parts.push(`key=${e.key}`)
  if (e.code) parts.push(`code=${e.code}`)
  if (e.deltaX !== undefined) parts.push(`dx=${e.deltaX}`)
  if (e.deltaY !== undefined) parts.push(`dy=${e.deltaY}`)
  if (e.detail) parts.push(`navigation=${e.detail}`)
  parts.push(`mods=${e.mods || 'none'}`, `on=${e.target}`, `focus=${e.focus ? 'yes' : 'no'}`, `-> ${e.taken}`)
  return parts.join(' ')
}

/** The line written once a page has attached its listeners. */
export function navStartLine(s: NavStart): string {
  return `nav listeners attached: ${s.surface} (views ${s.views.join(', ')}; ${s.top ? 'top frame' : 'nested frame'}; focus=${s.focus ? 'yes' : 'no'}; host API ${s.hostApi}; ${s.platform}): ${s.events.join(', ')}`
}
