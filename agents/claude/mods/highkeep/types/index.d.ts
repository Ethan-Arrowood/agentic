/** How a window's spending reads: on pace, ahead of the clock, or nearly spent. */
export type HighkeepTint = 'calm' | 'amber' | 'red'

/** One rate-limit window, rounded down to a whole point. */
export type HighkeepWindow = {
  kind: 'five_hour' | 'seven_day'
  /** Whole percent used, 0 to 100. */
  pct: number
  tint: HighkeepTint
}

/** The last usage reading the scene draws from. */
export type HighkeepReading = {
  windows: HighkeepWindow[]
  /** When it was read, in `$.clock.now()` milliseconds. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    highkeep: { reading: HighkeepReading | null }
  }
}
