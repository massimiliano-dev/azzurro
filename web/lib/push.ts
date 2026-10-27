'use client';

import { portal } from './api';

export type PushState = 'unsupported' | 'denied' | 'default' | 'subscribed' | 'unsubscribed';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) return 'subscribed';
  return Notification.permission === 'granted' ? 'unsubscribed' : 'default';
}

export async function subscribePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'default';
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const { publicKey } = await portal.get<{ publicKey: string }>('/push/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await portal.post('/push/subscribe', { subscription: sub.toJSON() });
  return 'subscribed';
}

/**
 * A ogni apertura del portale: se le notifiche sono consentite, l'iscrizione di questo browser
 * viene (ri)associata all'utente connesso. Senza, dopo un cambio di account (login locale →
 * Microsoft) le notifiche desktop finivano all'altro utente; se la chiave VAPID del server è
 * cambiata (database ricreato) l'iscrizione vecchia non riceve più nulla e va rifatta.
 */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  const { publicKey } = await portal.get<{ publicKey: string }>('/push/vapid');
  const key = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && current && (current.length !== key.length || current.some((b, i) => b !== key[i]))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await portal.post('/push/subscribe', { subscription: sub.toJSON() }, { noRedirect: true });
}

export async function unsubscribePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await portal.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'unsubscribed';
}
