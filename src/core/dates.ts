// Days and instants. A due day is a calendar day in local time (`YYYY-MM-DD`); created_at,
// updated_at and done_at are instants (ISO 8601, UTC).

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** The local calendar day of an instant. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Whether `text` is a real `YYYY-MM-DD` day (no 2026-02-30). */
export function isDay(text: string): boolean {
  const m = DAY_RE.exec(text)
  if (!m) return false
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
  return localDay(date) === text
}

/** Local noon of a day, so adding days never trips over a daylight-saving change. */
function noonOf(day: string): Date {
  const m = DAY_RE.exec(day)
  if (!m) throw new RangeError(`not a day: ${day}`)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
}

export function addDays(day: string, n: number): string {
  const date = noonOf(day)
  date.setDate(date.getDate() + n)
  return localDay(date)
}

/** Local midnight at the start of a day, as an instant. */
export function startOfDay(day: string): Date {
  const date = noonOf(day)
  date.setHours(0, 0, 0, 0)
  return date
}

export class DateInputError extends Error {}

/**
 * A due day from what a person or agent typed: `YYYY-MM-DD`, `today`, `tomorrow`, `yesterday`,
 * `+3` or `+3d` (days from today), `+2w`, or a weekday (`fri`, `friday`: the next one, not today).
 * `none`, `-` and the empty string clear it (null). Anything else throws DateInputError.
 */
export function parseDay(text: string, today: string): string | null {
  const value = text.trim().toLowerCase()
  if (value === '' || value === 'none' || value === '-' || value === 'null') return null
  if (DAY_RE.test(value)) {
    if (!isDay(value)) throw new DateInputError(`not a real day: ${text}`)
    return value
  }
  if (value === 'today' || value === 'tod') return today
  if (value === 'tomorrow' || value === 'tmr' || value === 'tom') return addDays(today, 1)
  if (value === 'yesterday') return addDays(today, -1)
  const rel = /^([+-]?)(\d{1,4})([dw]?)$/.exec(value)
  if (rel && (rel[1] !== '' || rel[3] !== '')) {
    const n = Number(rel[2]) * (rel[3] === 'w' ? 7 : 1) * (rel[1] === '-' ? -1 : 1)
    return addDays(today, n)
  }
  const weekday = WEEKDAYS.findIndex((name) => value.length >= 3 && name.startsWith(value))
  if (weekday >= 0) {
    const current = noonOf(today).getDay()
    const ahead = ((weekday - current + 7) % 7) || 7
    return addDays(today, ahead)
  }
  throw new DateInputError(`cannot read a day from "${text}" (use YYYY-MM-DD, today, tomorrow, +3d, fri)`)
}

/**
 * An instant from what a person or agent typed: an ISO 8601 time (`2026-11-23T09:00:00+09:00`),
 * a day (`2026-11-23`, `today`, `yesterday`: local midnight at its start), `now`, a span back
 * from now (`-2h`, `-30m`, `-1d`, `-1w`), or Unix milliseconds. Answers ISO 8601 in UTC.
 */
export function parseInstant(text: string, now: Date): string {
  const value = text.trim()
  const lower = value.toLowerCase()
  if (lower === 'now') return now.toISOString()
  if (lower === 'today') return startOfDay(localDay(now)).toISOString()
  if (lower === 'yesterday') return startOfDay(addDays(localDay(now), -1)).toISOString()
  if (DAY_RE.test(value)) {
    if (!isDay(value)) throw new DateInputError(`not a real day: ${text}`)
    return startOfDay(value).toISOString()
  }
  const span = /^-(\d+)([mhdw])$/.exec(lower)
  if (span) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[span[2] as 'm' | 'h' | 'd' | 'w']
    return new Date(now.getTime() - Number(span[1]) * unit).toISOString()
  }
  if (/^\d{12,14}$/.test(value)) return new Date(Number(value)).toISOString()
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  throw new DateInputError(`cannot read a time from "${text}" (use ISO 8601, YYYY-MM-DD, today, -24h)`)
}

// ---- Times of day (0.3.0) ----
// A due day may carry a time, `HH:MM` in local time, kept in its own field (`due_time`) so readers
// of `due` still see a plain day.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Whether `text` is a real `HH:MM` time (24-hour). */
export function isTime(text: string): boolean {
  return TIME_RE.test(text)
}

/** The local `HH:MM` of an instant. */
export function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * A time of day from what a person typed: `15:30`, `9:05`, `9`, `9am`, `9:30pm`, `noon`,
 * `midnight`. `none` and the empty string clear it (null). Anything else throws DateInputError.
 */
export function parseTime(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, '')
  if (value === '' || value === 'none' || value === '-' || value === 'null') return null
  if (value === 'noon') return '12:00'
  if (value === 'midnight') return '00:00'
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(value)
  if (m) {
    let hours = Number(m[1])
    const minutes = m[2] === undefined ? 0 : Number(m[2])
    const half = m[3]?.[0]
    if (half) {
      if (hours < 1 || hours > 12) throw new DateInputError(`not a time: ${text}`)
      if (half === 'a' && hours === 12) hours = 0
      if (half === 'p' && hours !== 12) hours += 12
    } else if (m[2] === undefined && m[1].length > 2) {
      throw new DateInputError(`not a time: ${text}`)
    }
    if (hours > 23 || minutes > 59) throw new DateInputError(`not a time: ${text}`)
    return `${pad(hours)}:${pad(minutes)}`
  }
  throw new DateInputError(`cannot read a time of day from "${text}" (use 15:30, 9am, 9:30pm)`)
}

/**
 * A due day and optional time: anything parseDay reads, optionally followed by `@<time>`,
 * `T<time>` or a space and a time (`fri@15:30`, `2026-11-25T09:00`, `tomorrow 9am`). A bare time
 * (`15:30`, `5pm`) means today at that time.
 */
export function parseDue(text: string, today: string): { day: string | null; time: string | null } {
  const value = text.trim()
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})(?::\d{2})?$/.exec(value)
  if (iso) return { day: parseDay(iso[1], today), time: parseTime(iso[2]) }
  const split = /^(.+?)(?:@|\s+)(\S+)$/.exec(value)
  if (split) {
    const day = parseDay(split[1], today)
    if (day === null) throw new DateInputError(`a time needs a day: ${text}`)
    return { day, time: parseTime(split[2]) }
  }
  if (/^\d{1,2}(:\d{2})?\s*(am|pm|a|p)$/i.test(value) || /^\d{1,2}:\d{2}$/.test(value)) {
    return { day: today, time: parseTime(value) }
  }
  return { day: parseDay(value, today), time: null }
}

/** The instant a due day (and time) falls due: the time it names, or the end of its day. */
export function dueInstant(day: string, time: string | null): Date {
  const date = noonOf(day)
  if (time) {
    const [h, m] = time.split(':').map(Number)
    date.setHours(h, m, 0, 0)
  } else {
    date.setHours(23, 59, 59, 999)
  }
  return date
}

/** When to remind: at the due time, or at `morning` (`HH:MM`) on the due day when it has none. */
export function remindInstant(day: string, time: string | null, morning: string): Date {
  return dueInstant(day, time ?? (isTime(morning) ? morning : '09:00'))
}
