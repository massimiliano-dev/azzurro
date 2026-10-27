'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AppWindow, Building2, Globe, Plus, Star, Users, UsersRound } from 'lucide-react';
import { graph, portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { PageHeader } from '@/components/page';
import { Badge, Button, Card, Field, IdText, Input, KV, Skeleton } from '@/components/ui';
import { Panel, useToast } from '@/components/overlay';
import { DataTable } from '@/components/table';

export default function EntraOverview() {
  const { t, fmtNumber } = useI18n();
  const toast = useToast();
  const { session, refresh } = useSession();
  const org = useAsync(async () => (await graph.list<any>('/organization'))[0], []);
  const domains = useAsync(() => graph.list<any>('/domains'), []);
  const ov = useAsync(() => portal.get<any>('/overview'), []);
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState('');
  return (
    <>
      <PageHeader title={t('entra.title')} subtitle={t('entra.subtitle')} icon={Building2} />
      <div className="grid cols-3">
        {([['nav.users', '/entra/users', ov.data?.counts.users, Users], ['nav.groups', '/entra/groups', ov.data?.counts.groups, UsersRound], ['nav.apps', '/entra/apps', ov.data?.counts.applications, AppWindow]] as const).map(([k, href, n, I]) => (
          <Link key={k} href={href} className="card stat"><span className="label"><I size={15} />{t(k)}</span><span className="value">{n === undefined ? '…' : fmtNumber(n)}</span></Link>
        ))}
      </div>
      <div className="grid cols-2 mt-24" style={{ alignItems: 'start' }}>
        <Card title={t('common.overview')}>
          {!org.data ? <Skeleton /> : (
            <KV items={[
              [t('entra.tenantName'), org.data.displayName],
              [t('entra.tenantId'), <IdText key="i" value={org.data.id} />],
              [t('entra.primaryDomain'), session?.tenant.defaultDomain],
              [t('entra.license'), t('entra.licenseValue')],
              [t('common.created'), org.data.createdDateTime?.slice(0, 10)],
            ]} />
          )}
        </Card>
        <Card title={t('entra.yourRoles')}>
          {session ? (session.directoryRoles.length ? <div className="row wrap">{session.directoryRoles.map((r) => <Badge key={r.id} tone="info">{r.displayName}</Badge>)}</div> : <p className="muted">—</p>) : <Skeleton rows={2} />}
        </Card>
      </div>
      <section className="mt-24">
        <div className="spread mb-16"><h2>{t('entra.domains')}</h2>{session?.isGlobalAdmin && <Button size="sm" icon={Plus} onClick={() => setOpen(true)}>{t('entra.addDomain')}</Button>}</div>
        <DataTable rows={domains.data} loading={domains.loading} error={domains.error} rowKey={(d) => d.id}
          columns={[
            { key: 'n', header: t('entra.domainName'), render: (d) => <div className="cell-main"><Globe size={15} />{d.id}{d.isDefault && <Badge tone="info">{t('common.default')}</Badge>}</div> },
            { key: 's', header: t('common.status'), render: () => <Badge tone="ok">Verified</Badge> },
            { key: 'a', header: '', render: (d) => !d.isDefault && session?.isGlobalAdmin ? <Button size="sm" variant="ghost" icon={Star} onClick={async () => { try { await graph.patch(`/domains/${d.id}`, { isDefault: true }); await domains.reload(); await refresh(); } catch (e) { toast.error(e); } }}>{t('entra.makeDefault')}</Button> : null },
          ]} />
      </section>
      <Panel open={open} onClose={() => setOpen(false)} title={t('entra.addDomain')} footer={<><Button variant="primary" disabled={!domain.includes('.')} onClick={async () => { try { await graph.post('/domains', { id: domain }); setOpen(false); setDomain(''); await domains.reload(); await refresh(); } catch (e) { toast.error(e); } }}>{t('common.add')}</Button><Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button></>}>
        <Field label={t('entra.domainName')} required htmlFor="dn"><Input id="dn" placeholder="contoso.local" value={domain} onChange={(e) => setDomain(e.target.value.toLowerCase())} /></Field>
      </Panel>
    </>
  );
}
