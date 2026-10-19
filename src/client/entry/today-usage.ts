// Today-usage feed for the sidebar capsule: visibility-gated refreshes with
// no idle cost. One lightweight snapshot read (weeks=1, server-side cached)
// fires on mount, on window focus, when the panel closes, and every 30s
// while the window is visible; hidden tabs stop the timer entirely.

import { useEffect, useState } from 'react'
import { fetchSnapshot } from '../snapshot'
import { panelStore } from '../store'

const REFRESH_WHILE_VISIBLE_MS = 30_000
const FOCUS_DEBOUNCE_MS = 300

/** Latest `summary.today` in tokens, or undefined before the first success. */
export function useTodayUsage(): number | undefined {
  const [today, setToday] = useState<number | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    let focusTimer: number | undefined

    const refresh = (): void => {
      fetchSnapshot({ weeks: 1 })
        .then((snapshot) => {
          if (!disposed) setToday(snapshot.summary.today)
        })
        .catch(() => {
          // Keep the last value; the panel surfaces full error states.
        })
    }

    const applyVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        if (timer === undefined) {
          refresh()
          timer = window.setInterval(refresh, REFRESH_WHILE_VISIBLE_MS)
        }
      } else if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }

    const onFocus = (): void => {
      window.clearTimeout(focusTimer)
      focusTimer = window.setTimeout(refresh, FOCUS_DEBOUNCE_MS)
    }

    const unsubscribePanel = panelStore.subscribe(() => {
      if (!panelStore.getSnapshot()) refresh()
    })

    document.addEventListener('visibilitychange', applyVisibility)
    window.addEventListener('focus', onFocus)
    applyVisibility()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', applyVisibility)
      window.removeEventListener('focus', onFocus)
      window.clearTimeout(focusTimer)
      window.clearInterval(timer)
      unsubscribePanel()
    }
  }, [])

  return today
}
