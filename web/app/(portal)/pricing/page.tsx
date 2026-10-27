'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Coins, Search, Tags } from 'lucide-react';
import { useAsync } from '@/lib/hooks';
import { useI18n, type MessageKey } from '@/i18n';
import { PageHeader } from '@/components/page';
import { ErrorNotice, Input, Notice, Skeleton, Switch } from '@/components/ui';
import { ResourceIcon } from '@/components/resource';
import { loadPricing, PriceCard, type PriceType } from '@/components/pricing';

const CATEGORIES = ['compute', 'containers', 'web', 'storage', 'databases', 'networking', 'identity', 'security', 'integration', 'monitor', 'ai', 'management'];

export default function PricingPage() {
  const { t, locale } = useI18n();
  const data = useAsync(() => loadPricing(), []);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const types: PriceType[] = data.data?.types ?? [];
  const shown = useMemo(() => types.filter((p) =>
    (all || (!p.hidden && p.model !== 'included')) &&
    (!category || p.category === category) &&
    (!q || `${p.label[locale]} ${p.type} ${p.service} ${p.plans.map((x) => x.sku).join(' ')}`.toLowerCase().includes(q.toLowerCase())),
  ), [types, all, category, q, locale]);
  const paid = shown.filter((p) => p.model !== 'free' && p.model !== 'included');
  const free = shown.filter((p) => p.model === 'free' || p.model === 'included');

  return (
    <>
      <PageHeader title={t('pricing.title')} subtitle={t('pricing.subtitle')} icon={Tags} actions={<Link className="btn" href="/costs"><Coins size={16} />{t('nav.costs')}</Link>} />
      {data.data && <Notice tone="warn">{data.data.disclaimer[locale]}</Notice>}
      <div className="toolbar pricing-tools" role="toolbar">
        <div className="input-icon"><Search size={16} aria-hidden /><Input type="search" placeholder={t('pricing.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('pricing.search')} /></div>
        <Switch checked={all} onChange={setAll} label={t('pricing.showAll')} />
      </div>
      <div className="chips">
        <button className={`chip ${!category ? 'on' : ''}`} onClick={() => setCategory(null)}>{t('common.all')}</button>
        {CATEGORIES.filter((c) => types.some((x) => x.category === c)).map((c) => (
          <button key={c} className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>{t(`create.category.${c}` as MessageKey)}</button>
        ))}
      </div>
      {data.error ? <ErrorNotice error={data.error} onRetry={data.reload} /> : !data.data ? <Skeleton rows={8} /> : (
        <>
          <div className="board price-board">
            {paid.map((p) => <PriceCard key={p.type} p={p} />)}
            {!paid.length && <div className="board-cell span-12 card-body muted">{t('pricing.noMatch')}</div>}
          </div>
          {free.length > 0 && (
            <section className="free-list">
              <h2>{t('pricing.freeTitle')}</h2>
              <div className="scroll-x"><table className="table">
                <thead><tr><th>{t('common.type')}</th><th>{t('pricing.service')}</th><th>{t('pricing.billing')}</th></tr></thead>
                <tbody>{free.map((p) => (
                  <tr key={p.type}>
                    <td><div className="cell-main"><ResourceIcon type={p.type} size="sm" /><span>{p.label[locale]}</span><span className="mono small muted">{p.type}</span></div></td>
                    <td className="small">{p.service}</td>
                    <td className="small">{p.model === 'included' ? t('pricing.includedIn', { what: p.billedWith?.[locale] ?? '' }) : p.notes?.[locale] ?? t('pricing.free')}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </section>
          )}
        </>
      )}
      {data.data && <p className="small muted" style={{ marginTop: 16 }}>{t('pricing.footer', { hours: String(data.data.hoursPerMonth) })}</p>}
    </>
  );
}

