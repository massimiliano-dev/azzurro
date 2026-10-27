import { recordEvent } from '../events.ts';
import { uuid, nowIso } from '../ids.ts';
import { q } from '../db/pool.ts';
import { notifyLater } from '../push.ts';

const lastFailureNotice = new Map<string, number>();

export interface SignInInput {
  user?: any | null;
  upn?: string;
  sp?: any | null;
  appId?: string;
  appName?: string;
  resourceId?: string;
  resourceName?: string;
  ip?: string;
  userAgent?: string;
  interactive: boolean;
  errorCode?: number;
  failureReason?: string;
}

function deviceDetail(ua?: string) {
  const u = ua ?? '';
  const browser = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : /python|azure-cli|msal/i.test(u) ? 'MSAL' : u ? 'Other' : '';
  const os = /Mac OS X|Macintosh/.test(u) ? 'MacOs' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'Ios' : '';
  return { deviceId: '', displayName: '', operatingSystem: os, browser, isCompliant: false, isManaged: false, trustType: '' };
}

export async function recordSignIn(s: SignInInput): Promise<void> {
  const ok = !s.errorCode;
  const data = {
    id: uuid(),
    createdDateTime: nowIso(),
    userDisplayName: s.user?.displayName ?? s.sp?.displayName ?? null,
    userPrincipalName: s.user?.userPrincipalName ?? s.upn ?? null,
    userId: s.user?.id ?? null,
    servicePrincipalId: s.sp?.id ?? null,
    servicePrincipalName: s.sp?.displayName ?? null,
    signInType: s.sp && !s.user ? 'servicePrincipal' : s.interactive ? 'interactiveUser' : 'nonInteractiveUser',
    appId: s.appId ?? null,
    appDisplayName: s.appName ?? null,
    ipAddress: s.ip ?? '127.0.0.1',
    clientAppUsed: s.interactive ? 'Browser' : 'Mobile Apps and Desktop clients',
    correlationId: uuid(),
    conditionalAccessStatus: 'notApplied',
    isInteractive: s.interactive,
    riskDetail: 'none',
    riskLevelAggregated: 'none',
    riskLevelDuringSignIn: 'none',
    riskState: 'none',
    riskEventTypes_v2: [],
    resourceDisplayName: s.resourceName ?? null,
    resourceId: s.resourceId ?? null,
    status: { errorCode: s.errorCode ?? 0, failureReason: ok ? null : s.failureReason ?? 'Other.', additionalDetails: null },
    deviceDetail: deviceDetail(s.userAgent),
    location: { city: '', state: '', countryOrRegion: '', geoCoordinates: null },
    appliedConditionalAccessPolicies: [],
  };
  await recordEvent('signin', data, { actorId: s.user?.id ?? s.sp?.id ?? null });
  if (!ok && s.user?.id && s.interactive) {
    const last = lastFailureNotice.get(s.user.id) ?? 0;
    if (Date.now() - last > 15 * 60 * 1000) {
      lastFailureNotice.set(s.user.id, Date.now());
      notifyLater([s.user.id], { category: 'security', key: 'signInFailed', params: { upn: s.user.userPrincipalName, ip: s.ip ?? '127.0.0.1' }, url: '/entra/logs' });
    }
  }
  if (ok && s.user?.id) {
    await q(`UPDATE objects SET data = jsonb_set(data, '{signInActivity}', $2::jsonb) WHERE collection = 'user' AND id = $1`, [
      s.user.id,
      JSON.stringify({ lastSignInDateTime: data.createdDateTime, lastSignInRequestId: data.id, lastNonInteractiveSignInDateTime: s.interactive ? s.user?.signInActivity?.lastNonInteractiveSignInDateTime ?? null : data.createdDateTime }),
    ]);
  }
}
