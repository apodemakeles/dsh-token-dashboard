// zh/en dictionaries for the token-dashboard surface, registered on the
// shared locale service under namespace 'token-dashboard' (05 decision:
// bilingual UI).

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'token-dashboard': TokenKey
  }
}

export type TokenKey =
  | 'title'
  | 'today'
  | 'week'
  | 'month30'
  | 'all'
  | 'weekView'
  | 'dayView'
  | 'refresh'
  | 'refreshedAt'
  | 'close'
  | 'older'
  | 'newer'
  | 'recentWeeks'
  | 'rangeWeeks'
  | 'legendLess'
  | 'legendMore'
  | 'hoverTotal'
  | 'hoverRequests'
  | 'loading'
  | 'error'
  | 'entryLabel'
  | 'others'
  | 'sessions'
  | 'empty'
  | 'initializing'
  | 'recovering'
  | 'degraded'
  | 'warnings'
  | 'pending'

export const zh: Record<TokenKey, string> = {
  title: 'Token 用量',
  today: '今日',
  week: '本周',
  month30: '近 30 天',
  all: '全部',
  weekView: '周视图',
  dayView: '日视图',
  refresh: '刷新',
  refreshedAt: '上次更新',
  close: '关闭',
  older: '← 更早',
  newer: '更新 →',
  recentWeeks: '最近 {n} 周',
  rangeWeeks: '第 {n} 周',
  legendLess: '少',
  legendMore: '多',
  hoverTotal: '{date} · {total} tokens',
  hoverRequests: '{n} 次请求',
  loading: '加载中…',
  error: '加载失败：{message}',
  entryLabel: 'Token 用量',
  others: 'others',
  sessions: '{n} 个会话',
  empty: '暂无数据',
  initializing: '初始化中…',
  recovering: '恢复中…',
  degraded: '数据不完整',
  warnings: '{n} 条警告',
  pending: '{n} 个批次待写入',
}

export const en: Record<TokenKey, string> = {
  title: 'Token Usage',
  today: 'Today',
  week: 'This week',
  month30: 'Last 30 days',
  all: 'All time',
  weekView: 'Week',
  dayView: 'Day',
  refresh: 'Refresh',
  refreshedAt: 'Updated',
  close: 'Close',
  older: '← Older',
  newer: 'Newer →',
  recentWeeks: 'Last {n} weeks',
  rangeWeeks: 'Weeks {n}',
  legendLess: 'Less',
  legendMore: 'More',
  hoverTotal: '{date} · {total} tokens',
  hoverRequests: '{n} requests',
  loading: 'Loading…',
  error: 'Failed to load: {message}',
  entryLabel: 'Token usage',
  others: 'others',
  sessions: '{n} sessions',
  empty: 'No data yet',
  initializing: 'Initializing…',
  recovering: 'Recovering…',
  degraded: 'Incomplete data',
  warnings: '{n} warnings',
  pending: '{n} batches pending',
}