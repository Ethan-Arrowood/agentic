import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMeasureInput, SessionRateLimit } from 'claude-code'

import type { ReviewRun } from './review-monitor'
import { scene, seasonOf, tintOf } from './scene'

// 2026-11-25 12:00 UTC: late fall, first snow.
const NOW = Date.UTC(2026, 10, 25, 12)
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

const BACKDROP = {
  plugin: 'highkeep',
  component: 'Backdrop',
  requestId: 'backdrop',
  props: { scene: 'highkeep-castle', plugin: 'highkeep', glass: { blur: 18, tint: '#15131a', opacity: 0.55 } },
} as const

const BAND = {
  plugin: 'highkeep',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** The engine beneath: a clock, a store, a theme that draws, and usage that reports `limits`. */
type Spy = { looks: unknown[]; writes: unknown[] }

function world(on: On, limits: SessionRateLimit[], stored: Record<string, unknown> = {}): Spy {
  const spy: Spy = { looks: [], writes: [] }
  const store = new Map(Object.entries(stored))
  mock.clock(on, { now: NOW })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    spy.writes.push(e.value)
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('theme.set', (_, e) => {
    spy.looks.push(e)

    return { value: { isDrawn: true, requestId: 'backdrop' } }
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: limits } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  return spy
}

const measure = (limits: SessionRateLimit[]): SessionMeasureInput => ({
  context: { window: 200_000 },
  rateLimits: limits,
  changed: ['rateLimits'],
})

async function backdropSource($: Engine, surface: 'desktop' | 'mobile' = 'desktop') {
  const ui = await $.ui.mount({ ...BACKDROP, surface })
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()

  return svg?.props.source as string | undefined
}

test('seasons turn on the calendar', () => {
  expect(seasonOf(Date.UTC(2026, 10, 25, 12))).toBe('first-snow')
  expect(seasonOf(Date.UTC(2026, 9, 10, 12))).toBe('autumn')
  expect(seasonOf(Date.UTC(2027, 0, 10, 12))).toBe('winter')
  expect(seasonOf(Date.UTC(2027, 3, 10, 12))).toBe('spring')
  expect(seasonOf(Date.UTC(2027, 6, 10, 12))).toBe('summer')
})

test('tint: calm on pace, amber ahead of the clock, red past 90', () => {
  // Half the five hours gone.
  const resets = iso(NOW + 2.5 * HOUR)
  expect(tintOf('five_hour', 40, resets, NOW)).toBe('calm')
  expect(tintOf('five_hour', 60, resets, NOW)).toBe('amber')
  expect(tintOf('five_hour', 91, resets, NOW)).toBe('red')
  expect(tintOf('seven_day', 50, undefined, NOW)).toBe('calm')
})

test('the scene stays within the engine limits and has no pictures or fonts', () => {
  for (const at of [NOW, Date.UTC(2027, 0, 10), Date.UTC(2027, 6, 10)]) {
    const svg = scene({
      reading: { windows: [{ kind: 'five_hour', pct: 50, tint: 'calm' }, { kind: 'seven_day', pct: 30, tint: 'amber' }], at },
      at,
    })
    expect(svg.length).toBeLessThan(131_072)
    expect(svg).not.toMatch(/<image|<text|@font-face|href|CDATA|<script/)
  }
})

test('the five-hour candle draws only when that limit exists', () => {
  const withFive = scene({ reading: { windows: [{ kind: 'five_hour', pct: 10, tint: 'calm' }], at: NOW }, at: NOW })
  const without = scene({ reading: { windows: [{ kind: 'seven_day', pct: 10, tint: 'calm' }], at: NOW }, at: NOW })
  expect(withFive).toContain('class="flame"')
  expect(without).not.toContain('class="flame"')
})

test('session start sets the look and keeps the reading in the store', async ($, on) => {
  const limits = [
    { kind: 'seven_day', percentUsed: 42.7, resetsAt: iso(NOW + 84 * HOUR) },
    { kind: 'five_hour', percentUsed: 12.2, resetsAt: iso(NOW + 4.5 * HOUR) },
  ]
  const spy = world(on, limits)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(spy.looks).toHaveLength(1)
  expect(spy.looks[0]).toMatchObject({ overrideColorScheme: 'dark', backdrop: { scene: 'highkeep-castle' } })
  expect((spy.looks[0] as { colors?: unknown }).colors).toBeDefined()
  expect(spy.writes.at(-1)).toEqual({
    windows: [
      { kind: 'five_hour', pct: 12, tint: 'amber' },
      { kind: 'seven_day', pct: 42, tint: 'calm' },
    ],
    at: NOW,
  })
})

test('the backdrop redraws only when a window moves a whole point', async ($, on) => {
  const at = (pct: number) => [{ kind: 'seven_day', percentUsed: pct, resetsAt: iso(NOW + 84 * HOUR) }]
  const spy = world(on, at(20))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const first = await backdropSource($)
  expect(spy.writes).toHaveLength(1)

  await $.session.measure(measure(at(20.6)))
  expect(spy.writes).toHaveLength(1)
  expect(await backdropSource($)).toBe(first)

  await $.session.measure(measure(at(21.1)))
  expect(spy.writes).toHaveLength(2)
  expect(await backdropSource($)).not.toBe(first)
})

test('a reading an earlier session stored draws before the first measurement', async ($, on) => {
  world(on, [], { reading: { windows: [{ kind: 'seven_day', pct: 95, tint: 'red' }], at: NOW - HOUR } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const source = await backdropSource($, 'mobile')
  // The red moon.
  expect(source).toContain('#cf5a44')
})

test('a malformed stored reading is ignored', async ($, on) => {
  world(on, [], { reading: { windows: 'nope' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const source = await backdropSource($)
  expect(source).toContain('<svg')
  expect(source).not.toContain('class="flame"')
})

test('a backdrop another mod set is left alone', async ($, on) => {
  world(on, [])
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>other</Text>
  })
  const ui = await $.ui.mount({ ...BACKDROP, props: { ...BACKDROP.props, scene: 'someone-else' }, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

const RUN: ReviewRun = {
  runId: 'r1',
  state: 'running',
  phase: 'reviewing',
  isAlive: true,
  isThisChat: true,
  eta: { remainingSecs: 420 },
  legs: [
    { name: 'codex', label: 'codex', role: 'graded', state: 'running', elapsedSecs: 120, typicalSecs: 240 },
    { name: 'gemini', label: 'gemini', role: 'finder', state: 'finished', elapsedSecs: 200 },
    { name: 'domain', label: 'adjudicator', role: 'adjudicator', state: 'pending' },
  ],
}

function reviewMonitor(on: On, runs: ReviewRun[] | undefined) {
  on('state.get', (_, e, next) =>
    e.plugin === 'review-monitor' && e.key === 'runs' ? { value: { value: runs, version: runs ? 1 : 0 } } : next(e),
  )
}

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const NO_ROW: [string, ReviewRun[] | undefined][] = [
  ['review-monitor is not loaded', undefined],
  ['the only review finished', [{ ...RUN, state: 'finished' }]],
  ['the review process died', [{ ...RUN, isAlive: false }]],
]

for (const [why, runs] of NO_ROW) {
  test(`no row when ${why}`, async ($, on) => {
    reviewMonitor(on, runs)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Reviewing/ })).toBeUndefined()
      await ui.unmount()
    }
  })
}

test('a running review shows one row: word, mark, a bar per reviewer and time left', async ($, on) => {
  reviewMonitor(on, [RUN])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Reviewing/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /~7m/ }))?.text).toBe('~7m')
    // The adjudicator is not a reviewer and gets no bar.
    expect(await ui.find({ text: /adjudicator/ })).toBeUndefined()
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: /^codex/ }))?.text).toBe('codex ━━━───')
      expect((await ui.find({ type: 'Text', text: /^gemini/ }))?.text).toBe('gemini ━━━━━━')
    } else {
      // Progress reads as its label and figure (mobile keeps it whole).
      expect(await ui.find({ text: /^codex 50%$/ })).toBeDefined()
      expect(await ui.find({ text: /^gemini 100%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
    }
    await ui.unmount()
  }
})
