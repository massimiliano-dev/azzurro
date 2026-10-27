'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, CheckCheck, Send, Smartphone, Trash2 } from 'lucide-react';
import { portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { pushState, subscribePush, unsubscribePush, type PushState } from '@/lib/push';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader } from '@/components/page';
import { Badge, Button, Card, Empty, Notice, Skeleton, Switch } from '@/components/ui';
import { useToast } from '@/components/overlay';
import { usePwa } from '@/components/pwa';

const CATS = ['deployments', 'resources', 'access', 'apps', 'security', 'system'] as const;

export default function NotificationsPage() {
  const { t, fmtRelative, fmtDate } = useI18n();
  const toast = useToast();
  const { standalone } = usePwa();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = useAsync(() => portal.get<any>('/settings'), []);
  const devices = useAsync(() => portal.get<{ value: any[] }>('/push/devices'), [state]);
  const list = useAsync(() => portal.get<{ unread: number; value: any[] }>('/notifications?limit=200'), [], { interval: 15000 });
  useEffect(() => { void pushState().then(setState); }, []);
  const ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const toggle = async () => {
    setBusy(true);
    try {
      setState(state === 'subscribed' ? await unsubscribePush() : await subscribePush());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const setPref = async (patch: any) => {
    settings.setData((s: any) => ({ ...s, ...patch, push: { ...(s?.push ?? {}), ...(patch.push ?? {}) } }));
    try { await portal.put('/settings', patch); } catch (e) { toast.error(e); await settings.reload(); }
  };
  return (
    <>
      <PageHeader title={t('notif.title')} subtitle={t('notif.subtitle')} icon={Bell} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Card title={t('notif.push')}>
          <p className="muted mb-16">{t('notif.pushHint')}</p>
          {state === null ? <Skeleton rows={2} /> : state === 'unsupported' ? (
            <Notice tone="warn">{t('notif.notSupported')}{ios && !standalone ? ` ${t('notif.pushHint')}` : ''}</Notice>
          ) : state === 'denied' ? <Notice tone="bad">{t('notif.denied')}</Notice> : (
            <div className="row wrap">
              {state === 'subscribed' && <Badge tone="ok"><BellRing size={12} />{t('notif.enabledHere')}</Badge>}
              <Button variant={state === 'subscribed' ? 'default' : 'primary'} icon={state === 'subscribed' ? BellOff : BellRing} loading={busy} onClick={toggle}>{state === 'subscribed' ? t('notif.disable') : t('notif.enable')}</Button>
              <Button icon={Send} onClick={async () => { try { const r = await portal.post<any>('/push/test'); if (r.devices) toast.ok(t('notif.testSent', { n: r.devices })); else toast.error(t('notif.testNone')); await list.reload(); } catch (e) { toast.error(e); } }}>{t('notif.test')}</Button>
            </div>
          )}
          {state === 'subscribed' && (
            <details className="notif-help mt-16">
              <summary>{t('notif.helpTitle')}</summary>
              <ol>
                <li>{t('notif.help1')}</li>
                <li>{t('notif.help2')}</li>
                <li>{t('notif.help3')}</li>
                <li>{t('notif.help4')}</li>
              </ol>
            </details>
          )}
          <h3 className="mt-24 mb-16">{t('notif.devices')}</h3>
          {devices.data?.value.length ? (
            <div className="stack" style={{ gap: 8 }}>
              {devices.data.value.map((d) => (
                <div key={d.endpoint} className="row small"><Smartphone size={15} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.userAgent}>{d.service} · {(d.userAgent ?? '').replace(/\(.*?\)/g, '').slice(0, 60)}</span><span className="muted">{fmtDate(d.createdAt, 'short')}</span></div>
              ))}
            </div>
          ) : <p className="muted small">—</p>}
        </Card>
        <Card title={t('notif.categories')}>
          {!settings.data ? <Skeleton rows={6} /> : (
            <div className="stack">
              {CATS.map((c) => <Switch key={c} checked={settings.data?.push?.[c] !== false} onChange={(v) => setPref({ push: { [c]: v } })} label={t(`notif.cat.${c}` as MessageKey)} />)}
              <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />
              <Switch checked={settings.data?.notifyOwnActions !== false} onChange={(v) => setPref({ notifyOwnActions: v })} label={t('notif.ownActions')} />
            </div>
          )}
        </Card>
      </div>
      <section className="mt-24">
        <div className="spread mb-16">
          <h2>{t('notif.history')} {list.data?.unread ? <Badge tone="info">{t('notif.unread', { n: list.data.unread })}</Badge> : null}</h2>
          <div className="row">
            <Button size="sm" icon={CheckCheck} disabled={!list.data?.unread} onClick={async () => { await portal.post('/notifications/read', {}); await list.reload(); }}>{t('shell.markAllRead')}</Button>
            <Button size="sm" variant="ghost" icon={Trash2} disabled={!list.data?.value.length} onClick={async () => { await portal.del('/notifications'); await list.reload(); }}>{t('notif.clear')}</Button>
          </div>
        </div>
        {!list.data ? <Skeleton /> : list.data.value.length ? (
          <div className="card">
            {list.data.value.map((n) => (
              <Link key={n.id} href={n.url ?? '#'} className={`notif-item ${n.read ? '' : 'unread'}`} onClick={() => !n.read && portal.post('/notifications/read', { ids: [n.id] })}>
                <span className="dot" aria-hidden />
                <span>
                  <div className="row"><span className="title">{n.title}</span><Badge>{t(`notif.cat.${n.category}` as MessageKey).split(':')[0].split(',')[0]}</Badge></div>
                  <div className="body">{n.body}</div>
                  <div className="when">{fmtRelative(n.ts)}</div>
                </span>
              </Link>
            ))}
          </div>
        ) : <div className="card"><Empty icon={Bell} title={t('notif.empty')} /></div>}
      </section>
    </>
  );
}
