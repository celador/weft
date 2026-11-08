// SDK-only, uncompiled ESM. No direct gateway requests, file access, or core UI selectors.
import { host, useValue, useQuery, Button, Badge } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const secondary = { color: 'var(--ui-text-secondary)' }
const mono = { fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' }
const section = { borderTop: '1px solid var(--ui-stroke-secondary)', paddingTop: 12, marginTop: 12 }

export function Feed({ ctx }) {
  const cwd = useValue(host.state.cwd)
  const gateway = useValue(host.state.gateway)
  const session = useValue(host.state.activeSessionId)
  const q = useQuery({
    queryKey: ['weft', 'status', gateway, session],
    queryFn: () => ctx.rest('/status'),
    refetchInterval: 5000,
    retry: 1,
  })
  if (q.isLoading) return jsx('p', { style: secondary, children: 'Reading Weft activity…' })
  if (q.error) return jsxs('div', { children: [
    jsx('p', { children: 'Weft activity is unavailable.' }),
    jsx('p', { style: secondary, children: 'Enable the Weft agent plugin on this gateway, then retry.' }),
    jsx(Button, { onClick: () => q.refetch(), children: 'Retry' }),
  ] })
  const agents = q.data?.agents || []
  const here = agents.filter(a => a.worktree && (cwd === a.worktree || cwd?.startsWith(a.worktree + '/')))
  const shown = here.length ? here : agents.filter(a => a.live)
  return jsxs('div', {
    style: { padding: 16, fontSize: 13, lineHeight: 1.5, height: '100%', overflow: 'auto' },
    children: [
      jsxs('header', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 }, children: [
        jsxs('div', { children: [jsx('strong', { children: 'Weft' }),
          jsx('div', { style: secondary, children: 'Catch collisions before the commit.' })] }),
        jsx(Button, { size: 'sm', variant: 'ghost', onClick: () => q.refetch(), children: 'Refresh' }),
      ] }),
      !shown.length && jsxs('section', { style: section, children: [
        jsx('strong', { children: 'No linked sessions yet' }),
        jsx('p', { style: secondary, children: 'Run /weft setup in your repository, then save its agent token in Hermes → Plugins → Weft. Local is the default; hosted is opt-in.' }),
        jsx('code', { style: mono, children: '/weft status' }),
      ] }),
      ...shown.map(a => jsxs('section', { style: section, children: [
        jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
          jsx('strong', { children: a.agent }),
          jsx(Badge, { children: a.mode }),
          jsx(Badge, { children: a.reachable === false ? 'Unreachable · unchecked' : a.live ? 'Live' : 'Ended' }),
        ] }),
        jsx('div', { title: a.worktree, style: { ...secondary, ...mono, fontSize: 11 }, children: a.worktree?.split('/').pop() || a.repo }),
        jsx('p', { style: secondary, children: `${a.counters?.accepted || 0} clean · ${a.counters?.warned || 0} warnings · ${a.counters?.rejected || 0} rejected` }),
        jsx('strong', { children: a.open?.length ? `${a.open.length} open conflict(s)` : 'No open conflicts' }),
        ...(a.open || []).map(d => jsxs('div', { role: 'status', style: { padding: '8px 0' }, children: [
          jsx(Badge, { children: d.code }),
          jsx('div', { style: mono, children: d.symbol || d.file }),
          jsx('div', { style: secondary, children: d.message }),
        ] }, `${d.code}-${d.symbol}-${d.seq}`)),
        jsx('h4', { children: 'Recent activity' }),
        ...(a.events || []).slice(-6).reverse().map((e, i) => jsxs('div', {
          style: { padding: '6px 0', borderBottom: '1px solid var(--ui-stroke-secondary)' }, children: [
            jsx('span', { children: `${e.kind} · ${e.verdict || e.gate || ''}` }),
            jsx('div', { style: { ...secondary, ...mono, fontSize: 11 }, children: (e.keys || e.files || []).join(', ') }),
          ],
        }, i)),
      ] }, `${a.change}-${a.pid}`)),
      jsx('footer', { style: { ...section, ...secondary, fontSize: 11 }, children: 'Local snapshots · refreshes every 5s · /weft feed opens the full shared feed' }),
    ],
  })
}

export default {
  id: 'weft',
  name: 'Weft — edit-time coordination',
  register(ctx) {
    ctx.register({ id: 'feed', area: 'panes', title: 'Weft', data: { placement: 'right', width: '360px' }, render: () => jsx(Feed, { ctx }) })
  },
}
