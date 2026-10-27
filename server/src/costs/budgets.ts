/** Budget (Microsoft.Consumption/budgets): spesa attuale e prevista, avvisi push alle soglie. */
import * as store from '../db/store.ts';
import { notifyLater } from '../push.ts';
import { userByUpn } from '../directory.ts';
import { scopeWatchers } from '../arm/rbac.ts';
import { infoFromId } from '../arm/generic.ts';
import { facts, usagesUnder } from './engine.ts';
import { CURRENCY, period } from './query.ts';

export function budgetScope(id: string): string {
  return id.split(/\/providers\/microsoft\.consumption\/budgets\//i)[0];
}

export async function spendFor(scope: string, now = Date.now()): Promise<{ actual: number; forecast: number }> {
  const { from, to } = period({ timeframe: 'MonthToDate' }, now, true);
  const all = facts(await usagesUnder(scope), from, to, now, true);
  const actual = all.filter((f) => !f.forecast).reduce((s, f) => s + f.cost, 0);
  const forecast = actual + all.filter((f) => f.forecast).reduce((s, f) => s + f.cost, 0);
  return { actual: Math.round(actual * 100) / 100, forecast: Math.round(forecast * 100) / 100 };
}

export async function enrichBudget(view: any): Promise<any> {
  if (!view?.id || !/microsoft\.consumption\/budgets/i.test(view.type ?? '')) return view;
  const s = await spendFor(budgetScope(view.id));
  view.properties = { ...view.properties, currentSpend: { amount: s.actual, unit: CURRENCY }, forecastSpend: { amount: s.forecast, unit: CURRENCY } };
  return view;
}

/** Controlla i budget e avvisa una volta per soglia e per mese. */
export async function checkBudgets(): Promise<void> {
  const budgets = await store.list('resource', { match: { _type: 'microsoft.consumption/budgets' } });
  const month = new Date().toISOString().slice(0, 7);
  for (const b of budgets) {
    const amount = Number(b.properties?.amount);
    if (!(amount > 0)) continue;
    const scope = budgetScope(b.id);
    const s = await spendFor(scope);
    const sent = new Set<string>((b._budgetNotified?.month === month ? b._budgetNotified.keys : []) as string[]);
    const before = sent.size;
    const notifications = Object.entries(b.properties?.notifications ?? {}) as [string, any][];
    const rules = notifications.length ? notifications : [['default', { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual' }]] as [string, any][];
    for (const [key, n] of rules) {
      if (n?.enabled === false || sent.has(key)) continue;
      const value = String(n?.thresholdType ?? 'Actual').toLowerCase() === 'forecasted' ? s.forecast : s.actual;
      const pct = (value / amount) * 100;
      const th = Number(n?.threshold ?? 100);
      if (!(String(n?.operator ?? '').toLowerCase() === 'greaterthan' ? pct > th : pct >= th)) continue;
      sent.add(key);
      const creator = b.systemData?.createdBy ? await userByUpn(b.systemData.createdBy) : null;
      const watchers = await scopeWatchers(scope);
      const users = [...new Set([...(creator ? [creator.id] : []), ...watchers])];
      notifyLater(users, {
        category: 'system', key: String(n?.thresholdType ?? 'Actual').toLowerCase() === 'forecasted' ? 'budgetForecast' : 'budgetThreshold',
        params: { name: b.name, pct: String(Math.round(pct)), threshold: String(th), amount: amount.toFixed(2), spent: value.toFixed(2), currency: CURRENCY },
        url: '/costs',
      });
    }
    if (sent.size !== before) {
      b._budgetNotified = { month, keys: [...sent] };
      await store.put('resource', b.id, b, infoFromId(b.id)?.parentKey ?? null);
    }
  }
}
