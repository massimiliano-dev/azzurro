import * as jose from 'jose';
import webpush from 'web-push';
import { q } from '../db/pool.ts';

interface StoredSigning { kid: string; priv: jose.JWK; pub: jose.JWK }

type Key = Awaited<ReturnType<typeof jose.importJWK>>;

let signing: { kid: string; privateKey: Key; publicKey: Key; publicJwk: jose.JWK } | undefined;
let vapid: { publicKey: string; privateKey: string } | undefined;

export async function loadOrCreate<T>(name: string, create: () => Promise<T> | T): Promise<T> {
  const rows = await q('SELECT data FROM keys WHERE name = $1', [name]);
  if (rows[0]) return rows[0].data as T;
  const data = await create();
  await q('INSERT INTO keys (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, JSON.stringify(data)]);
  const again = await q('SELECT data FROM keys WHERE name = $1', [name]);
  return again[0].data as T;
}

export async function initKeys(): Promise<void> {
  const s = await loadOrCreate<StoredSigning>('signing', async () => {
    const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true, modulusLength: 2048 });
    const priv = await jose.exportJWK(privateKey);
    const pub = await jose.exportJWK(publicKey);
    const kid = await jose.calculateJwkThumbprint(pub);
    return { kid, priv, pub };
  });
  signing = {
    kid: s.kid,
    privateKey: await jose.importJWK(s.priv, 'RS256'),
    publicKey: await jose.importJWK(s.pub, 'RS256'),
    publicJwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid: s.kid, x5t: s.kid, n: s.pub.n, e: s.pub.e },
  };
  vapid = await loadOrCreate('vapid', () => webpush.generateVAPIDKeys());
}

export function signingKeys() {
  if (!signing) throw new Error('Chiavi non inizializzate');
  return signing;
}

export function vapidKeys() {
  if (!vapid) throw new Error('Chiavi VAPID non inizializzate');
  return vapid;
}

export function jwks() {
  return { keys: [signingKeys().publicJwk] };
}
