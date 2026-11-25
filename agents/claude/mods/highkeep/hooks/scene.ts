import type { HighkeepReading, HighkeepTint, HighkeepWindow } from '../types'

export type Season = 'spring' | 'summer' | 'autumn' | 'first-snow' | 'winter'

/** The season for a date, northern hemisphere. Late fall turns to first snow on Nov 15. */
export function seasonOf(at: number): Season {
  const date = new Date(at)
  const month = date.getMonth()
  const day = date.getDate()

  if (month >= 2 && month <= 4) return 'spring'
  if (month >= 5 && month <= 7) return 'summer'
  if (month === 8 || month === 9 || (month === 10 && day < 15)) return 'autumn'
  if (month === 10 || (month === 11 && day < 21)) return 'first-snow'

  return 'winter'
}

const HOUR = 3_600_000
const LENGTH: Record<HighkeepWindow['kind'], number> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR }

/**
 * Red past 90%. Amber when the share used runs ahead of the share of the
 * window's time gone, by more than one point.
 */
export function tintOf(kind: HighkeepWindow['kind'], pct: number, resetsAt: string | undefined, now: number): HighkeepTint {
  if (pct > 90) return 'red'
  const resets = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (!Number.isFinite(resets)) return 'calm'
  const elapsed = Math.min(1, Math.max(0, 1 - (resets - now) / LENGTH[kind]))

  return pct / 100 > elapsed + 0.01 ? 'amber' : 'calm'
}

type Look = {
  /** Sky color at the horizon. */
  horizon: string
  /** Haze between the ranges and the forest. */
  haze: string
  /** Aspen leaf colors. */
  aspens: string[]
  /** How far down the peaks the snow reaches, 0 to 1. */
  snowCap: number
  /** Snow on the ground and the trees, 0 to 1. Past 0.7 the spruce are laden. */
  groundSnow: number
  flakes: number
  /** Falling leaves or petals, and their colors. */
  drift: number
  driftShape: 'leaf' | 'petal'
  driftColors: string[]
  /** Wildflowers in the foreground meadow, and their colors. */
  flowers: number
  flowerColors: string[]
  fireflies: number
  bare: boolean
}

const LOOKS: Record<Season, Look> = {
  spring: {
    horizon: '#3a4864', haze: '#4a5874', aspens: ['#8fb35a', '#a3c46a', '#7ea350'],
    snowCap: 0.5, groundSnow: 0, flakes: 0,
    drift: 14, driftShape: 'petal', driftColors: ['#f4f0e6', '#e8cf6a'],
    flowers: 46, flowerColors: ['#f4f0e6', '#e8cf6a', '#c79ad8'], fireflies: 0, bare: false,
  },
  summer: {
    horizon: '#34485f', haze: '#45566e', aspens: ['#5f8f4a', '#6e9c52', '#4f7e42'],
    snowCap: 0.14, groundSnow: 0, flakes: 0,
    drift: 0, driftShape: 'petal', driftColors: [],
    flowers: 56, flowerColors: ['#8f86d8', '#e8cf6a', '#d8566a', '#7fa8e0', '#f4f0e6'], fireflies: 16, bare: false,
  },
  autumn: {
    horizon: '#4a4256', haze: '#5a4e5e', aspens: ['#e8c13a', '#f0cd5a', '#d6a83a', '#e8c13a', '#c9822e'],
    snowCap: 0.3, groundSnow: 0, flakes: 0,
    drift: 18, driftShape: 'leaf', driftColors: ['#f0cd5a', '#e8c13a', '#d6a83a'],
    flowers: 0, flowerColors: [], fireflies: 0, bare: false,
  },
  'first-snow': {
    horizon: '#3e4660', haze: '#50546a', aspens: ['#c9a23a', '#b8903a', '#a8782e'],
    snowCap: 0.6, groundSnow: 0.5, flakes: 34,
    drift: 6, driftShape: 'leaf', driftColors: ['#d6a83a', '#b8903a'],
    flowers: 0, flowerColors: [], fireflies: 0, bare: false,
  },
  winter: {
    horizon: '#2e3c56', haze: '#3c4a66', aspens: [],
    snowCap: 0.9, groundSnow: 0.9, flakes: 60,
    drift: 0, driftShape: 'leaf', driftColors: [],
    flowers: 0, flowerColors: [], fireflies: 0, bare: true,
  },
}

const MOON: Record<HighkeepTint, string> = { calm: '#e4e6ee', amber: '#e8b25a', red: '#cf5a44' }
const GLOW: Record<HighkeepTint, string> = { calm: '#f4b6a2', amber: '#f0a032', red: '#d8452e' }
const SNOW = '#dfe6f0'

/** A fixed, seeded sequence, so the same scene draws the same way each time. */
function random(seed: number): () => number {
  let s = seed >>> 0

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0

    return s / 4294967296
  }
}

const n = (value: number) => Math.round(value * 10) / 10

type Point = [number, number]

const path = (points: Point[]) => `M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z`

// The far range, west to east. Every peak sits between two valleys.
const FAR: Point[] = [
  [0, 520], [120, 470], [260, 360], [360, 430], [470, 400], [620, 290], [760, 410], [880, 380],
  [1000, 300], [1120, 420], [1240, 370], [1380, 270], [1500, 380], [1600, 340],
]
const NEAR: Point[] = [
  [0, 600], [150, 520], [300, 560], [450, 490], [600, 560], [760, 520], [900, 575], [1050, 505],
  [1200, 560], [1350, 515], [1500, 570], [1600, 540],
]

const range = (points: Point[]) => path([...points, [1600, 900], [0, 900]])

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** Snow on each peak, reaching `depth` of the way down to its valleys, with a ragged lower edge. */
function caps(points: Point[], depth: number, opacity = 1): string {
  if (depth <= 0) return ''
  let out = ''
  for (let i = 1; i < points.length - 1; i += 1) {
    const [left, tip, right] = [points[i - 1], points[i], points[i + 1]] as [Point, Point, Point]
    if (tip[1] >= left[1] || tip[1] >= right[1]) continue
    const l = lerp(tip, left, depth)
    const r = lerp(tip, right, depth)
    const low = Math.min(l[1], r[1])
    const notch = (low - tip[1]) * 0.25
    const a = lerp(r, l, 0.3)
    const b = lerp(r, l, 0.7)
    out += `<path d="${path([tip, r, [a[0], a[1] - notch], [tip[0], low - notch * 0.4], [b[0], b[1] - notch], l])}"/>`
  }

  return `<g class="caps" fill="${SNOW}" opacity="${opacity}">${out}</g>`
}

/** The shaded east face of each peak, away from the last light. */
function faces(points: Point[], opacity: number): string {
  let out = ''
  for (let i = 1; i < points.length - 1; i += 1) {
    const [left, tip, right] = [points[i - 1], points[i], points[i + 1]] as [Point, Point, Point]
    if (tip[1] >= left[1] || tip[1] >= right[1]) continue
    const foot: Point = [tip[0] + (right[0] - tip[0]) * 0.2, right[1] + 40]
    out += `<path d="${path([tip, right, [right[0], right[1] + 40], foot])}"/>`
  }

  return `<g fill="url(#face)" opacity="${opacity}">${out}</g>`
}

function stars(): string {
  const r = random(7)
  let out = ''
  for (let i = 0; i < 32; i += 1) {
    const x = n(r() * 1600)
    const y = n(r() * 300)
    const size = n(0.5 + r() * 1.1)
    out += `<circle class="tw t${i % 3}" cx="${x}" cy="${y}" r="${size}" style="animation-delay:-${n(r() * 12)}s"/>`
  }

  return out
}

function moon(window: HighkeepWindow | undefined): string {
  const used = window ? window.pct / 100 : 0
  const color = MOON[window?.tint ?? 'calm']
  const r = 48
  // The shadow slides in from the left: off the disc at 0%, covering it at 100%.
  const shadowX = n(-2 * r * (1 - used))
  const left = n(1 - used)

  return `<g class="moon-at"><g transform="translate(250 140)">
<circle r="${r * 3}" fill="url(#halo)" class="breathe" opacity="${n(0.2 + 0.5 * left)}"/>
<circle r="${r}" fill="${color}" opacity="0.1"/>
<g mask="url(#wane)"><circle r="${r}" fill="${color}"/>
<circle cx="-12" cy="-9" r="9" fill="#000" opacity="0.07"/><circle cx="15" cy="14" r="13" fill="#000" opacity="0.06"/><circle cx="9" cy="-20" r="5" fill="#000" opacity="0.06"/></g>
<mask id="wane"><circle r="${r + 1}" fill="#fff"/><circle cx="${shadowX}" r="${r + 2}" fill="#000"/></mask>
</g></g>`
}

/** Last light on the high peaks. It fades as the five-hour window is spent, and is gone with no such limit. */
function alpenglow(window: HighkeepWindow | undefined): string {
  if (window === undefined) return ''
  const left = 1 - window.pct / 100

  return `<g opacity="${n(0.08 + 0.62 * left)}"><path class="alpenglow" d="${range(FAR)}" fill="url(#alpen)"/></g>`
}

// Snow on a spruce: tips after the first snow, every tier laden in deep winter.
const DUSTED = 'M0 -60 L5 -50 L0 -52 L-5 -50 Z M6 -38 L-6 -38 L0 -42 Z M9 -18 L-9 -18 L0 -22 Z'
const LADEN =
  'M0 -60 L9 -42 Q0 -46 -9 -42 Z M-6 -38 L-15 -20 Q-8 -24 -3 -33 Z M6 -38 L15 -20 Q8 -24 3 -33 Z ' +
  'M-9 -18 L-19 -1 Q-10 -5 -5 -13 Z M9 -18 L19 -1 Q10 -5 5 -13 Z M-11 -38 L11 -38 L8 -36 L-8 -36 Z M-16 -18 L16 -18 L13 -16 L-13 -16 Z'

function spruce(x: number, y: number, scale: number, color: string, snow: number): string {
  const cover = snow > 0.7 ? LADEN : snow > 0 ? DUSTED : ''

  return `<g transform="translate(${x} ${y}) scale(${scale})">
<path d="M0 -60 L11 -38 L6 -38 L16 -18 L9 -18 L20 0 L-20 0 L-9 -18 L-16 -18 L-6 -38 L-11 -38 Z" fill="${color}"/>
${cover ? `<path d="${cover}" fill="${SNOW}" opacity="${n(Math.min(1, snow + 0.05))}"/>` : ''}
</g>`
}

function aspen(x: number, y: number, scale: number, color: string, bare: boolean, snow: number): string {
  const trunk = `<rect x="-1.3" y="-46" width="2.6" height="46" fill="#a9aba6"/>
<path d="M-1.3 -12 h2.6 M-1.3 -24 h1.8 M-1.3 -34 h2.6" stroke="#4a4f57" stroke-width="1"/>`
  if (bare) {
    return `<g transform="translate(${x} ${y}) scale(${scale})">${trunk}
<path d="M0 -30 L-7 -40 M0 -36 L6 -46 M0 -42 L-4 -50" stroke="#a9aba6" stroke-width="1.4" fill="none" stroke-linecap="round"/>
${snow > 0 ? `<path d="M-7 -40 L-4 -38 M6 -46 L3 -43" stroke="${SNOW}" stroke-width="1.4" opacity="${n(snow)}"/>` : ''}
</g>`
  }

  return `<g transform="translate(${x} ${y}) scale(${scale})">${trunk}
<ellipse cy="-38" rx="9" ry="16" fill="${color}"/><ellipse cx="-5" cy="-28" rx="6" ry="8" fill="${color}"/><ellipse cx="5" cy="-31" rx="5" ry="7" fill="${color}"/>
${snow > 0 ? `<path d="M-7 -46 Q0 -56 7 -46 Q0 -50 -7 -46 Z" fill="${SNOW}" opacity="${n(snow)}"/>` : ''}
</g>`
}

/** One band of trees along a ridge: spruce, with aspen groves among them. */
function trees(seed: number, count: number, baseY: number, spread: number, scale: [number, number], spruceColor: string, look: Look): string {
  const r = random(seed)
  let out = ''
  for (let i = 0; i < count; i += 1) {
    const x = n((i + r() * 0.9) * (1600 / count))
    const y = n(baseY + r() * spread)
    const s = n(scale[0] + r() * (scale[1] - scale[0]))
    // Aspens grow in groves, so they cluster where a slow wave says so.
    const grove = Math.sin(i * 0.7 + seed) > 0.2
    if (grove && r() < 0.75) {
      out += aspen(x, y, s, look.aspens[i % Math.max(1, look.aspens.length)] ?? '#a9aba6', look.bare, look.groundSnow * 0.8)
    } else {
      out += spruce(x, y, s, spruceColor, look.groundSnow)
    }
  }

  return out
}

function flowers(look: Look): string {
  const r = random(43)
  let out = ''
  for (let i = 0; i < look.flowers; i += 1) {
    const x = n(r() * 1600)
    const y = n(800 + r() * 90)
    const s = n(0.8 + r() * 0.8)
    const color = look.flowerColors[i % look.flowerColors.length] ?? '#f4f0e6'
    out += `<g transform="translate(${x} ${y}) scale(${s})"><g class="stem" style="animation-delay:-${n(r() * 12)}s">`
    out += `<path d="M0 0 Q1.5 -6 0 -12" stroke="#2f4034" stroke-width="1.2" fill="none"/>`
    out += `<circle cy="-13.5" r="2.8" fill="${color}"/><circle cy="-13.5" r="1" fill="#f6e7a8" opacity="0.8"/></g></g>`
  }

  return out
}

/** Each fall draws twice, one screen apart, so the loop has no seam. */
function falling(look: Look): string {
  const r = random(31)
  let out = ''
  for (let i = 0; i < look.flakes; i += 1) {
    const x = n(r() * 1600)
    const y = n(r() * 900)
    const size = n(1.4 + r() * 2.6)
    const speed = i % 3
    out += `<g class="fall f${speed}" style="animation-delay:-${n(r() * 40)}s"><g class="sway" style="animation-delay:-${n(r() * 9)}s">`
    out += `<circle cx="${x}" cy="${y}" r="${size}"/><circle cx="${x}" cy="${n(y - 900)}" r="${size}"/></g></g>`
  }
  const shape = look.driftShape === 'petal' ? 'M0 -3.5 Q3 0 0 3.5 Q-3 0 0 -3.5 Z' : 'M0 -5 Q5 -1 0 5 Q-5 -1 0 -5 Z'
  for (let i = 0; i < look.drift; i += 1) {
    const x = n(r() * 1600)
    const y = n(r() * 900)
    const color = look.driftColors[i % look.driftColors.length] ?? '#e8c13a'
    const piece = (cy: number) => `<g transform="translate(${x} ${cy})"><path class="spin" d="${shape}" fill="${color}"/></g>`
    out += `<g class="fall f${3 + (i % 2)}" style="animation-delay:-${n(r() * 50)}s"><g class="drift" style="animation-delay:-${n(r() * 11)}s">`
    out += `${piece(y)}${piece(n(y - 900))}</g></g>`
  }
  for (let i = 0; i < look.fireflies; i += 1) {
    out += `<circle class="glimmer" cx="${n(r() * 1600)}" cy="${n(680 + r() * 190)}" r="1.8" fill="#e8d27a" style="animation-delay:-${n(r() * 14)}s"/>`
  }

  return out
}

const STYLE = `
.tw { fill: #eef2f8; opacity: 0.45; animation: twinkle 11s ease-in-out infinite alternate; }
.t1 { animation-duration: 14s; } .t2 { animation-duration: 17s; }
.breathe { transform-box: fill-box; transform-origin: center; animation: breathe 14s ease-in-out infinite alternate; }
.alpenglow { opacity: 0.9; animation: glow 16s ease-in-out infinite alternate; }
.cloud { animation: cloud 180s ease-in-out infinite alternate; }
.fall { fill: #f2f5fa; opacity: 0.85; animation: fall 30s linear infinite; }
.f1 { animation-duration: 38s; opacity: 0.65; } .f2 { animation-duration: 48s; opacity: 0.5; }
.f3 { animation-duration: 44s; } .f4 { animation-duration: 56s; }
.sway { animation: sway 9s ease-in-out infinite alternate; }
.drift { animation: drift 11s ease-in-out infinite alternate; }
.spin { animation: spin 13s ease-in-out infinite alternate; }
.stem { transform-box: fill-box; transform-origin: 50% 100%; animation: stem 12s ease-in-out infinite alternate; }
.glimmer { opacity: 0.5; animation: twinkle 7s ease-in-out infinite alternate; }
.snowfield { animation: settle 900s ease-out 1 both; }
@keyframes twinkle { from { opacity: 0.2; } to { opacity: 0.7; } }
@keyframes breathe { from { transform: scale(0.97); } to { transform: scale(1.03); } }
@keyframes glow { from { opacity: 0.75; } to { opacity: 1; } }
@keyframes cloud { from { transform: translateX(-60px); } to { transform: translateX(60px); } }
@keyframes fall { from { transform: translateY(0); } to { transform: translateY(900px); } }
@keyframes sway { from { transform: translateX(-10px); } to { transform: translateX(10px); } }
@keyframes drift { from { transform: translateX(-28px); } to { transform: translateX(28px); } }
@keyframes spin { from { transform: rotate(-50deg); } to { transform: rotate(50deg); } }
@keyframes stem { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
@keyframes settle { from { opacity: 0.35; } to { opacity: 1; } }
@media (max-aspect-ratio: 3/4) {
  .moon-at { transform: translate(420px, 20px); }
}
`

export type SceneInput = { reading: HighkeepReading | null; at: number }

/** The whole backdrop as one SVG document. */
export function scene({ reading, at }: SceneInput): string {
  const season = seasonOf(at)
  const look = LOOKS[season]
  const seven = reading?.windows.find(w => w.kind === 'seven_day')
  const five = reading?.windows.find(w => w.kind === 'five_hour')
  const glow = GLOW[five?.tint ?? 'calm']
  const halo = MOON[seven?.tint ?? 'calm']

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<style>${STYLE}</style>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#0b1120"/><stop offset="0.5" stop-color="#17233a"/><stop offset="1" stop-color="${look.horizon}"/>
</linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${halo}" stop-opacity="0.3"/><stop offset="1" stop-color="${halo}" stop-opacity="0"/></radialGradient>
<linearGradient id="alpen" gradientUnits="userSpaceOnUse" x1="0" y1="260" x2="0" y2="480">
<stop offset="0" stop-color="${glow}" stop-opacity="0.75"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/>
</linearGradient>
<linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#0b1120"/><stop offset="0.6" stop-color="#0b1120" stop-opacity="0.6"/><stop offset="1" stop-color="#0b1120" stop-opacity="0"/>
</linearGradient>
<linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${look.haze}" stop-opacity="0"/><stop offset="0.55" stop-color="${look.haze}" stop-opacity="0.45"/><stop offset="1" stop-color="${look.haze}" stop-opacity="0"/>
</linearGradient>
</defs>
<!-- sky -->
<rect width="1600" height="900" fill="url(#sky)"/>
<g>${stars()}</g>
${moon(seven)}
<g class="cloud" fill="#2c3a54" opacity="0.45">
<ellipse cx="560" cy="210" rx="220" ry="12"/><ellipse cx="680" cy="224" rx="150" ry="9"/><ellipse cx="1120" cy="170" rx="200" ry="11"/>
</g>
<!-- far range -->
<path d="${range(FAR)}" fill="#3a4a66"/>
${caps(FAR, look.snowCap)}
${faces(FAR, 0.3)}
${alpenglow(five)}
<rect y="380" width="1600" height="260" fill="url(#haze)"/>
<!-- near range -->
<path d="${range(NEAR)}" fill="#26334a"/>
${caps(NEAR, Math.max(0, look.snowCap - 0.45) * 1.6, 0.85)}
${faces(NEAR, 0.24)}
<!-- midground forest -->
<path d="M0 690 Q220 655 460 675 T940 668 T1400 662 T1600 670 V900 H0 Z" fill="#1a2536"/>
<g>${trees(19, 44, 668, 26, [0.55, 0.85], '#1d2a3a', look)}</g>
<rect y="600" width="1600" height="160" fill="url(#haze)" opacity="0.6"/>
<path d="M0 735 Q260 712 560 728 T1160 722 T1600 728 V900 H0 Z" fill="#131c29"/>
<g>${trees(23, 30, 726, 30, [0.9, 1.45], '#14202c', look)}</g>
${look.groundSnow > 0 ? `<path class="snowfield" d="M0 735 Q260 712 560 728 T1160 722 T1600 728 V736 Q1160 734 560 740 Q260 726 0 745 Z" fill="${SNOW}" opacity="${n(look.groundSnow * 0.8)}"/>` : ''}
<!-- foreground meadow -->
<path d="M0 800 Q320 776 660 792 T1320 786 T1600 782 V900 H0 Z" fill="#0d131c"/>
${look.groundSnow > 0 ? `<path class="snowfield" d="M0 800 Q320 776 660 792 T1320 786 T1600 782 V900 H0 Z" fill="${SNOW}" opacity="${n(look.groundSnow * 0.85)}"/>` : ''}
<g>${flowers(look)}</g>
<g>${falling(look)}</g>
</svg>`
}
