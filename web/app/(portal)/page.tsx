'use client';

import Link from 'next/link';
import { AppWindow, FileCode2, FolderPlus, LayoutGrid, PlugZap, Plus, UserPlus } from 'lucide-react';
import { portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { loadCatalog, resourceHref, typeLabel } from '@/lib/arm';
import { useI18n, type MessageKey } from '@/i18n';
import { Empty, ErrorNotice, Skeleton } from '@/components/ui';
import { ResourceIcon } from '@/components/resource';
import { Score } from '@/components/score';
import { HomeCosts } from '@/components/homecosts';
import { useFavorites } from '@/lib/favorites';

function verbOf(op: string): { label: string; cls: string } {
  const last = op.split('/').pop()?.toLowerCase();
  if (last === 'delete') return { label: 'DELETE', cls: 'delete' };
  if (last === 'write') return { label: 'PUT', cls: 'write' };
  if (last === 'action') return { label: 'POST', cls: 'action' };
  return { label: 'GET', cls: '' };
}

export default function Home() {
  const { t, fmtRelative, locale, fmtNumber } = useI18n();
  const { session } = useSession();
  const ov = useAsync(() => portal.get<any>('/overview'), [], { interval: 20_000 });
  const cat = useAsync(() => loadCatalog(), []);
  const h = new Date().getHours();
  const greet: MessageKey = h < 12 ? 'home.greeting.morning' : h < 18 ? 'home.greeting.afternoon' : 'home.greeting.evening';
  const c = ov.data?.counts;
  const ledger: [MessageKey, string, number | undefined, ('alert' | 'running')?][] = [
    ['home.stats.subscriptions', '/subscriptions', c?.subscriptions],
    ['home.stats.resourceGroups', '/resource-groups', c?.resourceGroups],
    ['home.stats.resources', '/resources', c?.resources],
    ['home.stats.deploymentsRunning', '/deployments', c?.deploymentsRunning, 'running'],
    ['home.stats.deploymentsFailed', '/deployments', c?.deploymentsFailed, 'alert'],
    ['home.stats.applications', '/entra/apps', c?.applications],
    ['home.stats.users', '/entra/users', c?.users],
    ['home.stats.groups', '/entra/groups', c?.groups],
  ];
  const max = ov.data?.byType?.[0]?.count ?? 1;
  const { favs } = useFavorites();
  return (
    <>
      <header className="page-head">
        <div className="titles">
          <h1 className="display">{session ? t(greet, { name: session.user.givenName || session.user.displayName }) : ' '}</h1>
          <div className="sub">{session ? t('home.subtitle', { tenant: `${session.tenant.displayName} · ${session.tenant.defaultDomain}` }) : ''}</div>
        </div>
        <nav className="actions-row" aria-label={t('home.quick')}>
          <Link className="btn primary" href="/create"><Plus size={16} />{t('home.quickCreateResource')}</Link>
          <Link className="btn" href="/resource-groups?new=1"><FolderPlus size={16} />{t('home.quickCreateRg')}</Link>
          <Link className="btn" href="/deploy"><FileCode2 size={16} />{t('home.quickDeploy')}</Link>
          <Link className="btn" href="/entra/apps/new"><AppWindow size={16} />{t('home.quickRegisterApp')}</Link>
          <Link className="btn" href="/entra/users?new=1"><UserPlus size={16} />{t('home.quickCreateUser')}</Link>
          <Link className="btn" href="/connect"><PlugZap size={16} />{t('home.quickConnect')}</Link>
        </nav>
      </header>

      {ov.error ? <ErrorNotice error={ov.error} onRetry={ov.reload} /> : null}
      {favs.length > 0 && (
        <nav className="favs" aria-label={t('home.favorites')}>
          {favs.map((f) => <Link key={f.id} className="fav" href={resourceHref(f.id)}><ResourceIcon type={f.type} size="sm" />{f.name}</Link>)}
        </nav>
      )}
      <div className="board">
        <section aria-label={t('home.inventory')} className="ledger">
          {ledger.map(([k, href, n, tone]) => (
            <Link key={k} href={href} className={`${tone && n ? tone : ''} ${n === 0 ? 'zero' : ''}`}>
              <span className="label">{t(k)}</span>
              <span className="value">{n === undefined || n === null ? '–' : <Score value={n} format={fmtNumber} />}</span>
            </Link>
          ))}
        </section>
        {ov.data?.subscriptions?.length ? <HomeCosts subscriptions={ov.data.subscriptions.map((x: any) => ({ id: x.subscriptionId, name: x.displayName }))} /> : null}
        <section className="board-cell span-7 stack">
          <div className="card-head"><h2>{t('home.recentResources')}</h2><Link href="/resources" className="small">{t('shell.seeAll')}</Link></div>
            {!ov.data ? <div className="card-body"><Skeleton /></div> : ov.data.recentResources.length ? (
              <div className="scroll-x"><table className="table">
                <tbody>
                  {ov.data.recentResources.map((r: any) => (
                    <tr key={r.id}>
                      <td><div className="cell-main"><ResourceIcon type={r.type} size="sm" /><Link href={resourceHref(r.id)}>{r.name}</Link></div></td>
                      <td className="muted small">{typeLabel(cat.data?.all, r.type, locale)}</td>
                      <td className="small mono">{r.resourceGroup ?? '—'}</td>
                      <td className="muted small num" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{fmtRelative(r.changedTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            ) : <Empty icon={LayoutGrid} title={t('home.noRecent')} action={<Link className="btn primary" href="/create"><Plus size={16} />{t('home.quickCreateResource')}</Link>} />}
          {ov.data?.byType?.length ? (
            <div className="cell-sub">
              <div className="card-head"><h2>{t('home.byType')}</h2></div>
              <div className="card-body">
                <div className="bars">
                  {ov.data.byType.slice(0, 6).map((b: any) => (
                    <div key={b.type} className="bar-row">
                      <ResourceIcon type={b.type} size="sm" />
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{typeLabel(cat.data?.all, b.type, locale)}</span>
                      <span className="track"><span className="fill" style={{ width: `${(b.count / max) * 100}%`, ['--gap' as string]: `${Math.round(14 - 11 * (b.count / max))}px` }} /></span>
                      <span className="num" style={{ textAlign: 'right' }}>{b.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </section>
        <section className="board-cell span-5">
          <div className="card-head"><h2>{t('home.recentActivity')}</h2><Link href="/activity" className="small">{t('shell.seeAll')}</Link></div>
          <div className="card-body">
            {!ov.data ? <Skeleton /> : ov.data.recentActivity.length ? (
              <div className="timeline">
                {ov.data.recentActivity.map((e: any) => {
                  const v = verbOf(e.operationName.value);
                  return (
                    <div className="ev" key={e.eventDataId}>
                      <span className={`verb ${v.cls} ${e.status.value === 'Failed' ? 'failed' : ''}`}>{v.label}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.operationName.value}>{e.operationName.value.split('/').slice(0, -1).join('/')}</div>
                        <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <Link href={resourceHref(e.resourceId)}>{e.resourceId.split('/').pop()}</Link> · {e.caller} · {fmtRelative(e.eventTimestamp)}{e.status.value === 'Failed' ? ` · ${t('act.status.Failed')}` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="muted">{t('act.empty')}</p>}
          </div>
        </section>
      </div>
    </>
  );
}
