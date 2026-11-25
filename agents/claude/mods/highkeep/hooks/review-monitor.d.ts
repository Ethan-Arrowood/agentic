// The slice of review-monitor's state this mod reads. review-monitor is
// optional, so it is not listed under `dependencies`: when it isn't loaded,
// `$.state.get` answers `undefined` and no row is drawn. Kept in sync by hand
// with review-monitor's own contract (types/index.d.ts there).
export type ReviewLeg = {
  name: string
  label: string
  role: 'graded' | 'finder' | 'adjudicator' | 'other'
  state: string
  elapsedSecs?: number
  budgetSecs?: number
  typicalSecs?: number
}

export type ReviewRun = {
  runId: string
  state: 'starting' | 'running' | 'finished' | 'failed' | 'aborted'
  phase: 'setup' | 'reviewing' | 'adjudicating' | 'done'
  isAlive: boolean
  legs: ReviewLeg[]
  eta?: { remainingSecs: number }
  isThisChat: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'review-monitor': { runs: ReviewRun[] }
  }
}
