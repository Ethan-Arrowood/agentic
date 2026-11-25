import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, ThemeSetArgs } from 'claude-code'

import type { HighkeepReading, HighkeepWindow } from '../types'
import { makeColors } from './make-colors.js'
import type { ReviewLeg, ReviewRun } from './review-monitor'
import { scene, tintOf } from './scene'

const SCENE = 'highkeep-peaks'
const STORE_KEY = 'reading'

const reading = atom({ plugin: 'highkeep', key: 'reading' } as const, null as HighkeepReading | null)
const reviews = { plugin: 'review-monitor', key: 'runs' } as const

// Alpine twilight: cool slate grays, an alpenglow accent.
const { theme, problems } = makeColors({
  label: 'Highkeep',
  only: 'dark',
  roles: { accent: '#e08e6d', danger: '#c4473c', success: '#6fa36a', warning: '#d9a441', pro: '#8f86c9' },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#10151e',
        'surface-1': '#151b26',
        'surface-2': '#1a212d',
        'surface-3': '#1d2530',
        'text-primary': '#e6ebf2',
        'text-secondary': '#c2cad6',
        'text-muted': '#9aa4b2',
      },
    },
  },
})

/** Set when Desktop would refuse the palette; the scene still draws. */
export const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))

const LOOK: ThemeSetArgs = {
  ...(unpainted === undefined ? { colors: theme } : {}),
  overrideColorScheme: 'dark',
  backdrop: { scene: SCENE, glass: { blur: 18, tint: '#10151e', opacity: 0.55 } },
}

const KINDS = new Set(['five_hour', 'seven_day'])

/** The two windows this mod draws, each rounded down to a whole point. */
export function windowsOf(limits: readonly SessionRateLimit[], now: number): HighkeepWindow[] {
  return limits
    .filter(limit => KINDS.has(limit.kind))
    .map(limit => {
      const kind = limit.kind as HighkeepWindow['kind']
      const pct = Math.max(0, Math.min(100, Math.floor(limit.percentUsed)))

      return { kind, pct, tint: tintOf(kind, pct, limit.resetsAt, now) }
    })
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

const sameWindows = (a: readonly HighkeepWindow[], b: readonly HighkeepWindow[]) =>
  a.length === b.length &&
  a.every((w, i) => {
    const other = b[i]

    return other !== undefined && w.kind === other.kind && w.pct === other.pct && w.tint === other.tint
  })

/** Keeps a new reading only when a window moved a whole point, changed tint, or came or went. */
async function take($: EngineInterface, limits: readonly SessionRateLimit[]) {
  if (limits.length === 0) return
  const now = await $.clock.now()
  const windows = windowsOf(limits, now)
  if (windows.length === 0) return
  const last = await read($, reading)
  if (last && sameWindows(last.windows, windows)) return
  const next: HighkeepReading = { windows, at: now }
  await update($, reading, () => next)
  await $.store.set(STORE_KEY, next)
}

const isReading = (value: unknown): value is HighkeepReading =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as HighkeepReading).windows) &&
  (value as HighkeepReading).windows.every(
    w => KINDS.has(w?.kind) && typeof w.pct === 'number' && ['calm', 'amber', 'red'].includes(w.tint),
  )

const isActive = (run: ReviewRun) => run.isAlive && (run.state === 'running' || run.state === 'starting')

const WORD: Record<ReviewRun['phase'], string> = {
  setup: 'Gathering',
  reviewing: 'Reviewing',
  adjudicating: 'Judging',
  done: 'Finishing',
}

const DONE = new Set(['finished', 'adjudicated'])

/** How far a reviewer is through its typical run, or undefined when there is no yardstick. */
export function legValue(leg: ReviewLeg): number | undefined {
  if (DONE.has(leg.state) || leg.state === 'failed' || leg.state === 'skipped') return 1
  if (leg.state === 'pending') return 0
  const span = leg.typicalSecs ?? leg.budgetSecs
  if (!span || leg.elapsedSecs === undefined) return undefined

  return Math.min(0.99, leg.elapsedSecs / span)
}

const WIDTH = 6

/** A six-cell bar; a reviewer with no yardstick shows a dotted one. */
export function cells(value: number | undefined): [string, string] {
  if (value === undefined) return ['', '┄'.repeat(WIDTH)]
  const done = Math.round(Math.max(0, Math.min(1, value)) * WIDTH)

  return ['━'.repeat(done), '─'.repeat(WIDTH - done)]
}

export function timeLeft(secs: number | undefined): string {
  if (secs === undefined || !Number.isFinite(secs)) return '…'
  if (secs < 60) return '<1m'

  return `~${Math.round(secs / 60)}m`
}

// Two peaks, the taller one capped with snow.
const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><path d="M1 12 L5 6 L7 8.5 L9.5 3 L13 12 Z" fill="#e08e6d"/>' +
  '<path d="M9.5 3 L11 6.3 L9.7 5.6 L8.4 6.4 Z" fill="#e6ebf2"/></svg>'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    if ((await read($, reading)) === null && isReading(stored)) {
      await update($, reading, () => stored)
    }
    // isDrawn is false on the terminal and editors: they keep their own look.
    await $.theme.set(LOOK)
    const result = await next(e)
    await take($, (await $.session.usage()).rateLimits)

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await take($, e.rateLimits)
    }

    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || e.props.scene !== SCENE) {
      return next(e)
    }
    const { Svg } = $.ui.resolve(e)
    const last = await read($, reading)
    const at = await $.clock.now()

    return (
      <Svg
        source={scene({ reading: last ?? null, at })}
        alt="Snow-capped mountains at twilight under a waning moon, with spruce and aspen below and a meadow in front"
        isInteractive
      />
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { value: runs } = await $.state.get(reviews)
    const live = (runs ?? []).filter(isActive)
    const run = live.find(r => r.isThisChat) ?? live[0]
    if (run === undefined) return next(e)

    const reviewers = run.legs.filter(leg => leg.role === 'graded' || leg.role === 'finder')
    const left = timeLeft(run.eta?.remainingSecs)

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)

      // A text bar per reviewer: Progress takes two full-width rows here.
      return (
        <Box flexDirection="row" gap={2}>
          <Text color="claude">✦ {WORD[run.phase]}</Text>
          {reviewers.map(leg => {
            const [done, rest] = cells(legValue(leg))

            return (
              <Text>
                {leg.label} <Text color="claude">{done}</Text>
                <Text dimColor>{rest}</Text>
              </Text>
            )
          })}
          <Text dimColor>{left}</Text>
        </Box>
      )
    }
    const { Box, Text, Progress, Svg } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={2} alignItems="center">
        <Svg source={MARK} alt="Highkeep peaks" width={14} height={14} />
        <Text color="claude">{WORD[run.phase]}</Text>
        {reviewers.map(leg => (
          <Box width={16}>
            <Progress label={leg.label} value={legValue(leg)} />
          </Box>
        ))}
        <Text dimColor>{left}</Text>
      </Box>
    )
  })
}
