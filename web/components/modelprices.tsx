'use client';

import { useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { portal } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { DataTable } from './table';
import { Badge, Card, Notice, Select, Switch } from './ui';

type Deployment = 'global' | 'datazone' | 'regional';
interface Row { family: string; model: string; deployment: Deployment; flags: string[]; input?: number; cachedInput?: number; output?: number }
interface ClaudeRow { model: string; id: string; input: number; cachedInput: number; output: number; batchInput?: number; batchOutput?: number; note?: { it: string; en: string } }
interface ModelList { region: string; regions: string[]; source: 'live' | 'cache' | 'snapshot'; fetchedAt: string; rows: Row[]; claude: { currency: 'USD'; asOf: string; rows: ClaudeRow[] } }

const DEP_LABEL: Record<Deployment, { it: string; en: string }> = {
  global: { it: 'Globale', en: 'Global' },
  datazone: { it: 'Data Zone', en: 'Data Zone' },
  regional: { it: 'Regionale', en: 'Regional' },
};
const FLAG_LABEL: Record<string, { it: string; en: string }> = {
  Batch: { it: 'Batch', en: 'Batch' },
  Priority: { it: 'Priorità', en: 'Priority' },
  Flex: { it: 'Flex', en: 'Flex' },
  'Long context': { it: 'Contesto lungo', en: 'Long context' },
  'Fine-tuned': { it: 'Fine-tuned', en: 'Fine-tuned' },
};

/** Prezzi per token dei modelli AI: Azure OpenAI / Foundry (EUR, per regione) e Claude su Foundry (USD). */
export function ModelPrices() {
  const { locale, fmtDate } = useI18n();
  const L = (it: string, en: string) => (locale === 'it' ? it : en);
  const [region, setRegion] = useState('swedencentral');
  const [family, setFamily] = useState<string | null>(null);
  const [dep, setDep] = useState<Deployment | 'all'>('global');
  const [variants, setVariants] = useState(false);
  const data = useAsync(() => portal.get<ModelList>(`/pricing/models?region=${region}`), [region]);
  const eur = useMemo(() => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }), [locale]);
  const usd = useMemo(() => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }), [locale]);
  // Azure pubblica alcuni prezzi per 1.000 token con 4 decimali: sotto 0,10 € per 1M diventano 0
  const money = (n: number | undefined, f: Intl.NumberFormat) => (n === undefined ? <span className="muted">—</span> : n === 0 ? <span className="mono" title={L('Prezzo pubblicato arrotondato a zero da Azure', 'Price published by Azure rounded to zero')}>&lt; {f.format(0.1)}</span> : <span className="mono">{f.format(n)}</span>);
  const rows = data.data?.rows ?? [];
  const families = useMemo(() => [...new Set(rows.map((r) => r.family))].sort(), [rows]);
  const shown = rows.filter((r) => (!family || r.family === family) && (dep === 'all' || r.deployment === dep) && (variants || !r.flags.length));

  return (
    <div className="stack model-prices" style={{ gap: 16 }}>
      <Card title={<span className="row" style={{ gap: 8 }}><Sparkles size={18} aria-hidden />{L('Claude su Microsoft Foundry', 'Claude on Microsoft Foundry')}</span>} padded={false}>
        <div className="scroll-x"><table className="table">
          <thead><tr><th>{L('Modello', 'Model')}</th><th className="num">{L('Input', 'Input')}</th><th className="num">{L('Input in cache', 'Cached input')}</th><th className="num">{L('Output', 'Output')}</th><th className="num">Batch</th><th>{L('Note', 'Notes')}</th></tr></thead>
          <tbody>{(data.data?.claude.rows ?? []).map((c) => (
            <tr key={c.id}>
              <td><div className="cell-main"><span>{c.model}</span><span className="mono small muted">{c.id}</span></div></td>
              <td className="num">{money(c.input, usd)}</td>
              <td className="num">{money(c.cachedInput, usd)}</td>
              <td className="num">{money(c.output, usd)}</td>
              <td className="num">{c.batchInput !== undefined ? <span className="mono small">{usd.format(c.batchInput)} / {usd.format(c.batchOutput!)}</span> : <span className="muted">—</span>}</td>
              <td className="small note">{c.note?.[locale] ?? ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="small muted card-body" style={{ margin: 0 }}>{L(
          'Prezzi per 1M token in dollari: su Foundry Claude è venduto da Anthropic tramite Azure Marketplace, al listino Anthropic, e fatturato con la sottoscrizione Azure. Disponibilità del modello e regione si scelgono nel catalogo Foundry.',
          'Prices per 1M tokens in US dollars: on Foundry, Claude is sold by Anthropic through Azure Marketplace at Anthropic list price and billed to the Azure subscription. Model availability and region are chosen in the Foundry catalog.',
        )}</p>
      </Card>

      <Card title={L('Modelli Azure OpenAI e Foundry', 'Azure OpenAI and Foundry models')} padded={false}
        actions={data.data && <span className="small muted">{data.data.source === 'live' ? L('Listino Azure aggiornato', 'Azure price list, updated') : data.data.source === 'cache' ? L('Copia del', 'Copy from') : L('Copia salvata del', 'Saved copy from')} {fmtDate(data.data.fetchedAt)}</span>}>
        {data.data?.source === 'snapshot' && <div className="card-body"><Notice tone="warn">{L('Azure Retail Prices non è raggiungibile: prezzi della copia inclusa nell\'app (Sweden Central).', 'Azure Retail Prices is unreachable: prices from the copy bundled with the app (Sweden Central).')}</Notice></div>}
        <div className="chips card-body" style={{ paddingBottom: 0 }}>
          <button className={`chip ${!family ? 'on' : ''}`} onClick={() => setFamily(null)}>{L('Tutti', 'All')}</button>
          {families.map((f) => <button key={f} className={`chip ${family === f ? 'on' : ''}`} onClick={() => setFamily(f)}>{f}</button>)}
        </div>
        <DataTable<Row>
          rows={data.data ? shown : undefined}
          loading={data.loading && !data.data}
          error={data.error}
          onRetry={data.reload}
          rowKey={(r) => `${r.family}|${r.model}|${r.deployment}|${r.flags.join(',')}`}
          search={(r) => `${r.family} ${r.model} ${r.flags.join(' ')}`}
          searchPlaceholder={L('Cerca un modello (es. gpt-5.1, grok, llama)', 'Search a model (e.g. gpt-5.1, grok, llama)')}
          initialSort={{ key: 'model' }}
          filters={
            <>
              <Select aria-label={L('Regione', 'Region')} value={region} onChange={(e) => setRegion(e.target.value)}>
                {(data.data?.regions ?? [region]).map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
              <div className="seg" role="group" aria-label={L('Tipo di distribuzione', 'Deployment type')}>
                {(['global', 'datazone', 'regional', 'all'] as const).map((d) => <button key={d} type="button" className={dep === d ? 'on' : ''} onClick={() => setDep(d)}>{d === 'all' ? L('Tutte', 'All') : DEP_LABEL[d][locale]}</button>)}
              </div>
              <Switch checked={variants} onChange={setVariants} label={L('Batch, priorità e altre varianti', 'Batch, priority and other variants')} />
            </>
          }
          empty={L('Nessun modello con questi filtri in questa regione.', 'No model matches these filters in this region.')}
          columns={[
            { key: 'model', header: L('Modello', 'Model'), sort: (r) => `${r.family} ${r.model}`, render: (r) => <div className="cell-main"><span>{r.model}</span><span className="small muted">{r.family}</span></div> },
            { key: 'dep', header: L('Distribuzione', 'Deployment'), sort: (r) => r.deployment, render: (r) => <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}><span className="small">{DEP_LABEL[r.deployment][locale]}</span>{r.flags.map((f) => <Badge key={f} tone="info">{FLAG_LABEL[f]?.[locale] ?? f}</Badge>)}</span> },
            { key: 'in', header: L('Input', 'Input'), className: 'num', sort: (r) => r.input ?? null, render: (r) => money(r.input, eur) },
            { key: 'cached', header: L('Input in cache', 'Cached input'), className: 'num', sort: (r) => r.cachedInput ?? null, render: (r) => money(r.cachedInput, eur) },
            { key: 'out', header: L('Output', 'Output'), className: 'num', sort: (r) => r.output ?? null, render: (r) => money(r.output, eur) },
          ]}
        />
        <p className="small muted card-body" style={{ margin: 0 }}>{L(
          'Euro per 1M token, prezzi a consumo pubblici di Azure (API Azure Retail Prices) per la regione scelta, IVA esclusa. Globale = il traffico può essere elaborato in qualsiasi regione Azure; Data Zone = solo nell\'area UE o USA; Regionale = solo nella regione. Unità provisioned (PTU), immagini, audio orari e training sono a parte nel listino Azure.',
          'Euro per 1M tokens, public Azure pay-as-you-go prices (Azure Retail Prices API) for the chosen region, excluding VAT. Global = traffic may be processed in any Azure region; Data Zone = only within the EU or US zone; Regional = only in the region. Provisioned units (PTU), images, hourly audio and training are listed separately by Azure.',
        )}</p>
      </Card>
    </div>
  );
}
