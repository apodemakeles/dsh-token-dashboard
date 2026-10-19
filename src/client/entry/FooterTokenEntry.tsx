// Sidebar footer entry: the today-usage capsule rendered into the
// shell-declared sidebar.footer.action seat (01, §2.2), beside Settings.
// A quiet live capsule — green dot + today's total — refreshed by the
// visibility-gated feed in today-usage.ts; clicking it opens the panel.

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fmt } from '../fmt'
import { togglePanel } from '../store'
import { useTodayUsage } from './today-usage'

export type FooterTokenEntryProps = PropsLocale<'token-dashboard'> & { wide: boolean }

export function FooterTokenEntry({ t, wide }: FooterTokenEntryProps) {
  const today = useTodayUsage()
  return (
    <button className="td-entry" onClick={togglePanel} title={t('entryLabel')} aria-label={t('entryLabel')}>
      <span className="td-entry-dot" aria-hidden="true" />
      {wide && (
        <span className="td-entry-label">
          {t('today')} <span className="td-entry-num">{today === undefined ? '—' : fmt(today)}</span>
        </span>
      )}
      {wide && <span className="td-entry-unit">tokens</span>}
    </button>
  )
}
