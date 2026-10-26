// Bounded best-effort diagnostic journal for the live projection path.
//
// The durable pipeline fails silent by design (bad-event isolation, resync
// flags instead of throws), so an operator looking at a panel that shows zero
// has no local trace of WHERE events were dropped. This journal writes a few
// structured lines per run to `$DSH_HOME/data/token-dashboard/live-diag.log`
// (never the panel path, never SQLite), truncating itself to stay bounded.
// Every write is fire-and-forget: diagnostics must never break collection.

import { appendFileSync, statSync, truncateSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_BYTES = 256 * 1024

let diagPath: string | undefined

function resolvePath(): string {
  if (diagPath === undefined) {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    diagPath = join(home, 'data', 'token-dashboard', 'live-diag.log')
  }
  return diagPath
}

/**
 * Append one diagnostic line with an ISO timestamp. Failures are swallowed.
 * The file self-truncates (keep the newest half) once it passes the cap.
 */
export function diag(scope: string, message: string, detail?: unknown): void {
  try {
    const path = resolvePath()
    let suffix = ''
    if (detail !== undefined) {
      suffix = ' ' + String(detail instanceof Error ? (detail.stack ?? detail.message) : JSON.stringify(detail)).slice(0, 600)
    }
    appendFileSync(path, `${new Date().toISOString()} [${scope}] ${message}${suffix}\n`)
    try {
      if (statSync(path).size > MAX_BYTES) truncateSync(path, 0)
    } catch {
      // Stat/truncate races are irrelevant.
    }
  } catch {
    // Unwritable home: diagnostics stay silent.
  }
}
