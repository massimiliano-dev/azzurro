import * as jose from 'jose';
import { signingKeys } from './keys.ts';
import { uuid } from '../ids.ts';

export async function signJwt(claims: Record<string, unknown>, ttlSec: number): Promise<string> {
  const k = signingKeys();
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({ ...claims, iat: now, nbf: now, exp: now + ttlSec, uti: uuid().replace(/-/g, '').slice(0, 22) })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: k.kid, x5t: k.kid })
    .sign(k.privateKey);
}

export async function verifyJwt(token: string): Promise<jose.JWTPayload & Record<string, any>> {
  const { payload } = await jose.jwtVerify(token, signingKeys().publicKey, { algorithms: ['RS256'], clockTolerance: 300 });
  return payload as jose.JWTPayload & Record<string, any>;
}

export function decodeUnverified(token: string): Record<string, any> | null {
  try {
    return jose.decodeJwt(token) as Record<string, any>;
  } catch {
    return null;
  }
}

export function v2Issuer(origin: string, tid: string): string {
  return `${origin}/${tid}/v2.0`;
}

export function v1Issuer(origin: string, tid: string): string {
  return `${origin}/${tid}/`;
}
