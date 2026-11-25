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
  horizon: string
  glow: string
  foliage: string[]
  snowCap: number
  groundSnow: number
  flakes: number
  leaves: number
  leafColors: string[]
  fireflies: number
  bare: boolean
}

const LOOKS: Record<Season, Look> = {
  spring: {
    horizon: '#2d2a3a', glow: '#3d3448', foliage: ['#3f5a3a', '#4d6b41', '#6b5a78'],
    snowCap: 0.55, groundSnow: 0, flakes: 0, leaves: 10, leafColors: ['#c9a3b8', '#e0c4cf'], fireflies: 0, bare: false,
  },
  summer: {
    horizon: '#2a2b3a', glow: '#3a3548', foliage: ['#2f4a33', '#3a5a3b', '#264030'],
    snowCap: 0.35, groundSnow: 0, flakes: 0, leaves: 0, leafColors: [], fireflies: 14, bare: false,
  },
  autumn: {
    horizon: '#3a2630', glow: '#4a2c2c', foliage: ['#8a3f22', '#a8592a', '#7a2f2a', '#b5802e'],
    snowCap: 0.45, groundSnow: 0, flakes: 0, leaves: 14, leafColors: ['#a8592a', '#8a3f22', '#b5802e'], fireflies: 0, bare: false,
  },
  'first-snow': {
    horizon: '#33263a', glow: '#46303a', foliage: ['#7a3a24', '#93512a', '#6a2c28', '#9c7430'],
    snowCap: 0.8, groundSnow: 0.55, flakes: 34, leaves: 6, leafColors: ['#93512a', '#7a3a24'], fireflies: 0, bare: false,
  },
  winter: {
    horizon: '#262a3a', glow: '#2e3448', foliage: ['#3a3438'],
    snowCap: 0.95, groundSnow: 0.9, flakes: 60, leaves: 0, leafColors: [], fireflies: 0, bare: true,
  },
}

const MOON: Record<HighkeepTint, string> = { calm: '#e4e6ee', amber: '#e8b25a', red: '#cf5a44' }
const FLAME: Record<HighkeepTint, string> = { calm: '#ffe6a8', amber: '#f0a032', red: '#d8452e' }

/** A fixed, seeded sequence, so the same scene draws the same way each time. */
function random(seed: number): () => number {
  let s = seed >>> 0

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0

    return s / 4294967296
  }
}

const n = (value: number) => Math.round(value * 10) / 10

function stars(): string {
  const r = random(7)
  let out = ''
  for (let i = 0; i < 46; i += 1) {
    const x = n(r() * 1600)
    const y = n(r() * 380)
    const size = n(0.6 + r() * 1.3)
    const cls = `tw t${i % 3}`
    out += `<circle class="${cls}" cx="${x}" cy="${y}" r="${size}" style="animation-delay:-${n(r() * 12)}s"/>`
  }

  return out
}

function moon(window: HighkeepWindow | undefined): string {
  const used = window ? window.pct / 100 : 0
  const color = MOON[window?.tint ?? 'calm']
  const r = 56
  // The shadow slides in from the left: off the disc at 0%, covering it at 100%.
  const shadowX = n(-2 * r * (1 - used))
  const left = n(1 - used)

  return `<g class="moon-at"><g transform="translate(250 150)">
<circle r="${r * 3}" fill="url(#halo)" class="breathe" opacity="${n(0.25 + 0.6 * left)}"/>
<circle r="${r}" fill="${color}" opacity="0.1"/>
<g mask="url(#wane)"><circle r="${r}" fill="${color}"/>
<circle cx="-14" cy="-10" r="11" fill="#000" opacity="0.07"/><circle cx="18" cy="16" r="15" fill="#000" opacity="0.06"/><circle cx="10" cy="-24" r="6" fill="#000" opacity="0.06"/></g>
<mask id="wane"><circle r="${r + 1}" fill="#fff"/><circle cx="${shadowX}" r="${r + 2}" fill="#000"/></mask>
</g></g>`
}

function candle(window: HighkeepWindow | undefined): string {
  if (window === undefined) {
    // No five-hour limit: the great window stays dark.
    return `<path d="M1318 278 V222 Q1330 198 1342 222 V278 Z" fill="#1d1820"/>`
  }
  const left = 1 - window.pct / 100
  const wax = n(4 + 46 * left)
  const top = n(274 - wax)
  const flame = FLAME[window.tint]
  const glow = n(18 + 44 * left)

  return `<path d="M1318 278 V222 Q1330 198 1342 222 V278 Z" fill="#2a1d1a"/>
<circle cx="1330" cy="${top - 6}" r="${glow}" fill="url(#ember)" opacity="${n(0.35 + 0.5 * left)}" class="breathe"/>
<rect x="1325.5" y="${top}" width="9" height="${wax}" rx="1.5" fill="#e9dcc4"/>
<rect x="1322" y="274" width="16" height="4" rx="1" fill="#5a4636"/>
<g transform="translate(1330 ${top - 1})"><ellipse class="flame" cx="0" cy="-6" rx="3.4" ry="7" fill="${flame}"/></g>`
}

function caps(snow: number): string {
  if (snow <= 0) return ''

  return `<g fill="#e8ecf2" opacity="${snow}">
<path d="M160 430 L205 392 L250 434 L228 428 L205 440 L184 428 Z"/>
<path d="M520 400 L575 348 L630 404 L604 396 L576 410 L548 396 Z"/>
<path d="M900 420 L950 378 L1000 424 L978 416 L952 430 L926 418 Z"/>
<path d="M1540 410 L1580 380 L1620 420 L1600 414 L1580 424 L1560 416 Z"/>
</g>`
}

function roofCaps(snow: number): string {
  if (snow <= 0) return ''

  return `<g fill="#e8ecf2" opacity="${n(Math.min(1, snow + 0.1))}">
<path d="M1330 105 L1346 134 L1330 128 L1314 134 Z"/>
<path d="M1207 215 L1218 236 L1207 232 L1196 236 Z"/>
<path d="M1462 228 L1472 247 L1462 243 L1452 247 Z"/>
<path d="M1397 200 L1405 216 L1397 213 L1389 216 Z"/>
<rect x="1190" y="327" width="290" height="3" rx="1.5"/>
</g>`
}

function castle(five: HighkeepWindow | undefined, look: Look): string {
  return `<g class="castle-at">
<path d="M1060 900 L1100 520 L1160 430 L1190 408 L1190 420 L1480 420 L1480 396 L1540 440 L1600 470 L1600 900 Z" fill="#17131c"/>
<g fill="#100d14">
<rect x="1190" y="330" width="290" height="90"/>
<rect x="1190" y="258" width="35" height="162"/><path d="M1184 260 L1207 215 L1231 260 Z"/>
<rect x="1445" y="270" width="35" height="150"/><path d="M1439 272 L1462 228 L1486 272 Z"/>
<rect x="1385" y="235" width="25" height="100"/><path d="M1380 237 L1397 200 L1415 237 Z"/>
<rect x="1290" y="168" width="80" height="220"/><path d="M1282 170 L1330 105 L1378 170 Z"/>
<path d="M1190 330 h12 v-8 h10 v8 h12 v-8 h10 v8 h12 v-8 h10 v8 h12 v-8 h10 v8 h12 v-8 h10 v8 h12 v-8 h10 v8"/>
</g>
<g fill="#e8a24a" class="hearth">
<rect x="1203" y="290" width="6" height="11" rx="3"/><rect x="1459" y="300" width="6" height="11" rx="3"/>
<rect x="1394" y="262" width="5" height="9" rx="2.5"/><rect x="1240" y="352" width="5" height="8" rx="2.5" opacity="0.6"/>
<rect x="1302" y="320" width="6" height="10" rx="3" opacity="0.7"/>
</g>
${candle(five)}
${roofCaps(look.snowCap)}
<path d="M1100 520 L1160 430 L1190 408 L1190 414 L1164 436 L1106 522 Z M1480 396 L1540 440 L1600 470 L1600 476 L1538 446 L1480 403 Z" fill="#e8ecf2" opacity="${n(look.groundSnow * 0.8)}"/>
</g>`
}

function tree(x: number, y: number, scale: number, color: string, bare: boolean, frost: number): string {
  if (bare) {
    return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="#3a3340" stroke-width="2.4" fill="none" stroke-linecap="round">
<path d="M0 0 V-34 M0 -18 L-10 -30 M0 -24 L9 -36 M0 -30 L-5 -42"/></g>`
  }

  return `<g transform="translate(${x} ${y}) scale(${scale})">
<rect x="-1.5" y="-14" width="3" height="14" fill="#16121a"/>
<circle cx="0" cy="-24" r="12" fill="${color}"/><circle cx="-7" cy="-18" r="8" fill="${color}"/><circle cx="7" cy="-19" r="8" fill="${color}"/>
${frost > 0 ? `<path d="M-9 -31 Q0 -40 9 -31 Q0 -35 -9 -31 Z" fill="#e8ecf2" opacity="${n(frost)}"/>` : ''}
</g>`
}

function pine(x: number, y: number, scale: number, frost: number): string {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
<path d="M0 -46 L13 -14 L-13 -14 Z M0 -32 L16 0 L-16 0 Z" fill="#141a1a"/>
${frost > 0 ? `<path d="M0 -46 L5 -34 L0 -36 L-5 -34 Z M0 -32 L6 -20 L0 -22 L-6 -20 Z" fill="#e8ecf2" opacity="${n(frost)}"/>` : ''}
</g>`
}

function forest(look: Look): string {
  const r = random(19)
  let out = ''
  for (let i = 0; i < 34; i += 1) {
    const x = n(r() * 1600)
    const y = n(690 + r() * 70)
    const scale = n(0.8 + r() * 0.7)
    if (r() < 0.4) {
      out += pine(x, y, scale, look.groundSnow)
    } else {
      out += tree(x, y, scale, look.foliage[i % look.foliage.length] ?? '#3a3438', look.bare, look.groundSnow * 0.8)
    }
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
    const size = n(1.2 + r() * 2.2)
    const speed = i % 3
    out += `<g class="fall f${speed}" style="animation-delay:-${n(r() * 40)}s"><g class="sway" style="animation-delay:-${n(r() * 9)}s">`
    out += `<circle cx="${x}" cy="${y}" r="${size}"/><circle cx="${x}" cy="${n(y - 900)}" r="${size}"/></g></g>`
  }
  for (let i = 0; i < look.leaves; i += 1) {
    const x = n(r() * 1600)
    const y = n(r() * 900)
    const color = look.leafColors[i % look.leafColors.length] ?? '#93512a'
    const leaf = (cy: number) =>
      `<g transform="translate(${x} ${cy})"><path class="spin" d="M0 -5 Q5 0 0 5 Q-5 0 0 -5 Z" fill="${color}"/></g>`
    out += `<g class="fall f${3 + (i % 2)}" style="animation-delay:-${n(r() * 50)}s"><g class="drift" style="animation-delay:-${n(r() * 11)}s">`
    out += `${leaf(y)}${leaf(n(y - 900))}</g></g>`
  }
  for (let i = 0; i < look.fireflies; i += 1) {
    out += `<circle class="glimmer" cx="${n(r() * 1600)}" cy="${n(600 + r() * 220)}" r="1.8" fill="#e8d27a" style="animation-delay:-${n(r() * 14)}s"/>`
  }

  return out
}

const STYLE = `
.tw { fill: #f1ede4; opacity: 0.55; animation: twinkle 11s ease-in-out infinite alternate; }
.t1 { animation-duration: 14s; } .t2 { animation-duration: 17s; }
.breathe { animation: breathe 14s ease-in-out infinite alternate; }
.hearth { opacity: 0.8; animation: hearth 9s ease-in-out infinite alternate; }
.flame { transform-box: fill-box; transform-origin: 50% 100%; animation: sway-flame 6s ease-in-out infinite alternate; }
.cloud { animation: cloud 180s ease-in-out infinite alternate; }
.mist { animation: mist 120s ease-in-out infinite alternate; }
.fall { fill: #eef1f6; opacity: 0.8; animation: fall 30s linear infinite; }
.f1 { animation-duration: 38s; opacity: 0.6; } .f2 { animation-duration: 48s; opacity: 0.45; }
.f3 { animation-duration: 44s; } .f4 { animation-duration: 56s; }
.sway { animation: sway 9s ease-in-out infinite alternate; }
.drift { animation: drift 11s ease-in-out infinite alternate; }
.spin { animation: spin 13s ease-in-out infinite alternate; }
.glimmer { opacity: 0.5; animation: twinkle 7s ease-in-out infinite alternate; }
.snowfield { animation: settle 900s ease-out 1 both; }
@keyframes twinkle { from { opacity: 0.25; } to { opacity: 0.75; } }
@keyframes breathe { from { transform: scale(0.97); } to { transform: scale(1.03); } }
@keyframes hearth { from { opacity: 0.65; } to { opacity: 0.9; } }
@keyframes sway-flame { from { transform: rotate(-4deg) scaleY(0.94); } to { transform: rotate(4deg) scaleY(1.04); } }
@keyframes cloud { from { transform: translateX(-60px); } to { transform: translateX(60px); } }
@keyframes mist { from { transform: translateX(-40px); } to { transform: translateX(40px); } }
@keyframes fall { from { transform: translateY(0); } to { transform: translateY(900px); } }
@keyframes sway { from { transform: translateX(-10px); } to { transform: translateX(10px); } }
@keyframes drift { from { transform: translateX(-28px); } to { transform: translateX(28px); } }
@keyframes spin { from { transform: rotate(-50deg); } to { transform: rotate(50deg); } }
@keyframes settle { from { opacity: 0.35; } to { opacity: 1; } }
.breathe { transform-box: fill-box; transform-origin: center; }
@media (max-aspect-ratio: 3/4) {
  .moon-at { transform: translate(400px, 10px); }
  .castle-at { transform: translate(-460px, 40px); }
}
`

export type SceneInput = { reading: HighkeepReading | null; at: number }

/** The whole backdrop as one SVG document. */
export function scene({ reading, at }: SceneInput): string {
  const season = seasonOf(at)
  const look = LOOKS[season]
  const seven = reading?.windows.find(w => w.kind === 'seven_day')
  const five = reading?.windows.find(w => w.kind === 'five_hour')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
<style>${STYLE}</style>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#0d0b14"/><stop offset="0.55" stop-color="#1a1623"/><stop offset="1" stop-color="${look.horizon}"/>
</linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${MOON[seven?.tint ?? 'calm']}" stop-opacity="0.35"/><stop offset="1" stop-color="${MOON[seven?.tint ?? 'calm']}" stop-opacity="0"/></radialGradient>
<radialGradient id="ember"><stop offset="0" stop-color="${FLAME[five?.tint ?? 'calm']}" stop-opacity="0.7"/><stop offset="1" stop-color="${FLAME[five?.tint ?? 'calm']}" stop-opacity="0"/></radialGradient>
<radialGradient id="dusk" cx="0.5" cy="1" r="0.8"><stop offset="0" stop-color="${look.glow}" stop-opacity="0.8"/><stop offset="1" stop-color="${look.glow}" stop-opacity="0"/></radialGradient>
</defs>
<!-- sky -->
<rect width="1600" height="900" fill="url(#sky)"/>
<rect y="300" width="1600" height="600" fill="url(#dusk)"/>
<g>${stars()}</g>
${moon(seven)}
<g class="cloud" fill="#2a2433" opacity="0.5">
<ellipse cx="520" cy="230" rx="220" ry="16"/><ellipse cx="640" cy="246" rx="160" ry="12"/><ellipse cx="1060" cy="190" rx="200" ry="14"/>
</g>
<!-- far range -->
<path d="M0 470 L90 440 L205 392 L300 450 L420 420 L575 348 L700 430 L820 410 L950 378 L1080 440 L1180 420 L1300 460 L1420 430 L1580 380 L1600 390 L1600 900 L0 900 Z" fill="#221d2a"/>
${caps(look.snowCap)}
<!-- near range -->
<path d="M0 560 L120 520 L260 548 L380 500 L520 540 L660 510 L800 560 L940 530 L1060 560 L1060 900 L0 900 Z" fill="#1b1722"/>
${castle(five, look)}
<g class="mist" fill="#3a3344" opacity="0.22"><ellipse cx="500" cy="620" rx="520" ry="26"/><ellipse cx="1200" cy="640" rx="460" ry="22"/></g>
<!-- forest and foreground -->
<path d="M0 700 Q200 670 420 690 T860 690 T1300 684 T1600 690 V900 H0 Z" fill="#141119"/>
<g>${forest(look)}</g>
<path d="M0 760 Q260 730 560 752 T1100 748 T1600 744 V900 H0 Z" fill="#0f0d13"/>
${look.groundSnow > 0 ? `<path class="snowfield" d="M0 760 Q260 730 560 752 T1100 748 T1600 744 V756 Q1300 760 1100 762 T560 764 Q260 744 0 772 Z" fill="#dfe4ec" opacity="${look.groundSnow}"/>` : ''}
<g>${falling(look)}</g>
</svg>`
}
