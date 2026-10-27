import webpush from 'web-push';
import { config } from './config.ts';
import { q } from './db/pool.ts';
import * as store from './db/store.ts';
import { vapidKeys } from './auth/keys.ts';
import { t, pickLocale, type Locale } from './i18n.ts';

export const CATEGORIES = ['deployments', 'resources', 'access', 'apps', 'security', 'system'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface UserSettings {
  locale?: Locale;
  theme?: 'system' | 'light' | 'dark';
  push?: Partial<Record<Category, boolean>>;
  notifyOwnActions?: boolean;
}

export function initPush(): void {
  const v = vapidKeys();
  webpush.setVapidDetails(config.vapidSubject, v.publicKey, v.privateKey);
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const rows = await q('SELECT data FROM user_settings WHERE user_id = $1', [userId]);
  return (rows[0]?.data as UserSettings) ?? {};
}

export async function saveSettings(userId: string, patch: UserSettings): Promise<UserSettings> {
  const cur = await getSettings(userId);
  const next: UserSettings = { ...cur, ...patch, push: { ...(cur.push ?? {}), ...(patch.push ?? {}) } };
  await q(
    `INSERT INTO user_settings (user_id, data) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, JSON.stringify(next)],
  );
  return next;
}

export async function userLocale(userId: string): Promise<Locale> {
  const s = await getSettings(userId);
  if (s.locale) return s.locale;
  const u = await store.get('user', userId);
  return pickLocale(u?.preferredLanguage);
}

export interface Notice {
  category: Category;
  key: string;
  params?: Record<string, unknown>;
  url?: string;
  /** utente che ha causato l'evento */
  actorId?: string;
  /** parametri tradotti per lingua (es. nomi di tipo localizzati) */
  localizedParams?: Partial<Record<Locale, Record<string, unknown>>>;
}

export async function sendToUser(userId: string, payload: Record<string, unknown>): Promise<number> {
  const subs = await q('SELECT endpoint, data FROM push_subscriptions WHERE user_id = $1', [userId]);
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s.data, JSON.stringify(payload), { TTL: 3600, urgency: 'normal' });
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await q('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
        } else if (!config.quiet) {
          console.warn('[push] invio non riuscito:', e?.statusCode ?? e?.message ?? e);
        }
      }
    }),
  );
  return sent;
}

export async function notify(userIds: string[], n: Notice): Promise<void> {
  for (const uid of new Set(userIds)) {
    const settings = await getSettings(uid);
    if (n.actorId === uid && settings.notifyOwnActions === false) continue;
    const locale = settings.locale ?? pickLocale((await store.get('user', uid))?.preferredLanguage);
    const params = { ...(n.params ?? {}), ...(n.localizedParams?.[locale] ?? {}) };
    if (params.actor === undefined || params.actor === null) params.actor = t(locale, 'n.unknownActor');
    const title = t(locale, `n.${n.key}.title`, params);
    const body = t(locale, `n.${n.key}.body`, params);
    const rows = await q(
      'INSERT INTO notifications (user_id, category, title, body, url) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [uid, n.category, title, body, n.url ?? null],
    );
    if (settings.push?.[n.category] === false) continue;
    await sendToUser(uid, { id: rows[0].id, title, body, url: n.url ?? '/', category: n.category, tag: `azzurro-${n.category}` });
  }
}

/** Notifica senza bloccare la richiesta. */
export function notifyLater(userIds: string[], n: Notice): void {
  if (!userIds.length) return;
  setImmediate(() => {
    notify(userIds, n).catch((e) => {
      if (!config.quiet) console.warn('[push] notifica non riuscita:', e);
    });
  });
}
