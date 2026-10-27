import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const uuid = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_CHARS = ALNUM + '_-.~';

function pick(chars: string, n: number): string {
  const buf = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[buf[i] % chars.length];
  return out;
}

/** Segreto client nel formato Entra ID (40 caratteri, con il marcatore "Q~"). */
export function clientSecret(): string {
  return pick(ALNUM, 3) + pick('0123456789', 1) + 'Q~' + pick(SECRET_CHARS, 34);
}

/** Chiave stile storage/cosmos (base64, 64 byte). */
export function accountKey(bytes = 64): string {
  return randomBytes(bytes).toString('base64');
}

export function userCode(): string {
  return pick('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 9);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Complessità password stile Entra: >= 8 caratteri e 3 categorie su 4. */
export function passwordIsComplex(pw: string): boolean {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 256) return false;
  const cats = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return cats >= 3;
}

export function generatePassword(): string {
  for (;;) {
    const pw = pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 3) + pick('abcdefghijkmnopqrstuvwxyz', 4) + pick('23456789', 3) + pick('!#$%&*?', 1) + pick(ALNUM, 3);
    if (passwordIsComplex(pw)) return pw;
  }
}

export function isGuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** UUID v5 (SHA-1) deterministico. */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** Hash deterministico a 13 caratteri base32, come uniqueString() dei template ARM. */
export function uniqueString(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('-')).digest();
  let bits = 0n;
  for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(h[i]);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out += B32[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}

export function deterministicIp(seed: string, prefix = '20'): string {
  const h = createHash('sha256').update(seed).digest();
  return `${prefix}.${h[0] % 250 + 1}.${h[1]}.${h[2] % 250 + 1}`;
}
