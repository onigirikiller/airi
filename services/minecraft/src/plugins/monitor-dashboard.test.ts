import { describe, expect, it } from 'vitest'

import { buildDashboardHtml } from './monitor-dashboard'

describe('monitor dashboard html', () => {
  it('hydrates the current monitor state from the api on load', () => {
    const html = buildDashboardHtml()

    expect(html).toContain('fetch(\'/api/state\'')
    expect(html).toContain('monitorStatePollTimer = setInterval(fetchMonitorState, 2500);')
  })

  it('falls back to runner status when no explicit goal event is active', () => {
    const html = buildDashboardHtml()

    expect(html).toContain('function updateGoalFromRunnerState')
    expect(html).toContain('goalSource: \'phaseStep=\' + phaseStep')
    expect(html).toContain('ブロック中')
  })
})
