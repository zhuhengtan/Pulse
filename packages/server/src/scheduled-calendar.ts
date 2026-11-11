import { z } from 'zod'

const timeZone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true } catch { return false }
})
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const date = z.string().regex(/^(?:19[7-9]\d|[2-9]\d{3})-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
})
export const calendarScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), date, time, timeZone }).strict(),
  z.object({ kind: z.literal('daily'), time, timeZone }).strict(),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length), time, timeZone }).strict(),
])
export type CalendarSchedule = z.infer<typeof calendarScheduleSchema>
const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(at: number, zone: string): number[] {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    if (formatters.size > 100) formatters.clear()
    formatters.set(zone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(values[key]))
}

/** Resolve a wall clock minute. Gaps are skipped; folds use the earlier instant. */
export function calendarInstant(date: string, time: string, zone: string): number | undefined {
  const target = Date.parse(`${date}T${time}:00Z`)
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = target + hours * 3_600_000
    const [y, m, d, h, minute, s] = parts(sample, zone)
    offsets.add(Date.UTC(y!, m! - 1, d!, h!, minute!, s!) - sample)
  }
  const expected = `${date}T${time}`
  const matches: number[] = []
  for (const offset of offsets) {
    const candidate = target - offset
    const [y, m, d, h, minute] = parts(candidate, zone)
    const actual = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    if (actual === expected) matches.push(candidate)
  }
  return matches.length ? Math.min(...matches) : undefined
}

/** Next distinct occurrence strictly after `after`, independent of machine TZ. */
export function nextCalendarOccurrence(schedule: CalendarSchedule, after: number): number | undefined {
  if (schedule.kind === 'once') {
    const instant = calendarInstant(schedule.date, schedule.time, schedule.timeZone)
    return instant !== undefined && instant > after ? instant : undefined
  }
  const [year, month, day] = parts(after, schedule.timeZone)
  const start = Date.UTC(year!, month! - 1, day!)
  // Includes a skipped civil day (e.g. Pacific/Apia) and a skipped DST week.
  for (let index = 0; index < 16; index++) {
    const date = new Date(start + index * 86_400_000)
    if (schedule.kind === 'weekly' && !schedule.days.includes(date.getUTCDay())) continue
    const instant = calendarInstant(date.toISOString().slice(0, 10), schedule.time, schedule.timeZone)
    if (instant !== undefined && instant > after) return instant
  }
  throw new Error('CALENDAR_OCCURRENCE_NOT_FOUND')
}
