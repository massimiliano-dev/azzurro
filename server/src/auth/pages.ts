import { escapeHtml as h } from '../http.ts';
import { t, type Locale } from '../i18n.ts';

const LOGO = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="3" fill="#0B3FBF"/><path d="M6.5 25.5 14 6.5h4l7.5 19h-4.3L16 11.9 10.8 25.5z" fill="#fff"/><rect x="12.6" y="17.6" width="6.8" height="3.6" fill="#E8A917"/></svg>`;

const CSS = `
:root{--blue:#0b3fbf;--blue-d:#072a86;--ink:#121417;--muted:#5c6779;--line:#d9dfe9;--bg:#0b3fbf;--err:#d93a22;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg);font:15px/1.5 "Archivo",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);padding:24px 16px}
.card{width:100%;max-width:420px;background:#fff;border:1px solid var(--line);border-radius:4px;padding:36px 36px 28px;box-shadow:0 18px 50px -12px rgba(0,10,40,.45)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.2px;margin-bottom:22px}
h1{font-size:22px;font-weight:600;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 22px}
label{display:block;font-size:13px;font-weight:500;margin:14px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:3px;background:#fff;color:var(--ink)}
input:focus{outline:2px solid rgba(11,92,255,.25);border-color:var(--blue)}
button{margin-top:22px;width:100%;font:inherit;font-weight:600;padding:11px 14px;border-radius:3px;border:0;background:var(--blue);color:#fff;cursor:pointer}
button:hover{background:var(--blue-d)}
.ghost{background:#fff;color:var(--blue);border:1px solid var(--line);margin-top:10px}
.ghost:hover{background:#f3f7ff}
.err{background:#fdf0ef;color:var(--err);border:1px solid #f5c9c4;border-radius:8px;padding:10px 12px;font-size:14px;margin:0 0 6px}
.info{background:#eef4ff;border:1px solid #cfe0ff;border-radius:8px;padding:10px 12px;font-size:14px;margin:0 0 6px}
.who{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.avatar{width:32px;height:32px;border-radius:50%;background:#dbe8ff;color:var(--blue);display:grid;place-items:center;font-weight:600}
.foot{margin-top:18px;font-size:12px;color:rgba(225,233,255,.85);display:flex;justify-content:space-between;gap:12px;width:100%;max-width:420px}
.foot a{color:#fff}
.code{font-family:"IBM Plex Mono",ui-monospace,monospace;letter-spacing:2px;text-transform:uppercase}
`;

export interface PageOpts {
  locale: Locale;
  title: string;
  subtitle?: string;
  body: string;
  langHref?: string;
}

export function page(o: PageOpts): string {
  return `<!doctype html><html lang="${o.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(o.title)} · Azzurro</title><style>${CSS}</style></head>
<body><main class="card"><div class="brand">${LOGO}<span style="font-weight:800;font-stretch:75%;letter-spacing:-.02em;font-size:20px">azzurro</span></div><h1>${h(o.title)}</h1>${o.subtitle ? `<p class="sub">${h(o.subtitle)}</p>` : ''}${o.body}</main>
<div class="foot"><span>${h(t(o.locale, 'l.footer'))}</span>${o.langHref ? `<a href="${h(o.langHref)}">${h(t(o.locale, 'l.lang'))}</a>` : ''}</div></body></html>`;
}

export function hidden(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`)
    .join('');
}

export function loginForm(o: { locale: Locale; action: string; fields: Record<string, string | undefined>; appName?: string; error?: string; loginHint?: string; langHref?: string }): string {
  const L = o.locale;
  return page({
    locale: L,
    title: t(L, 'l.title'),
    subtitle: o.appName ? t(L, 'l.continueTo', { app: o.appName }) : t(L, 'l.subtitle'),
    langHref: o.langHref,
    body: `${o.error ? `<p class="err" role="alert">${h(o.error)}</p>` : ''}
<form method="post" action="${h(o.action)}">${hidden({ ...o.fields, action: 'login' })}
<label for="login">${h(t(L, 'l.username'))}</label><input id="login" name="login" type="email" autocomplete="username" required autofocus value="${h(o.loginHint ?? '')}">
<label for="passwd">${h(t(L, 'l.password'))}</label><input id="passwd" name="passwd" type="password" autocomplete="current-password" required>
<button type="submit">${h(t(L, 'l.signin'))}</button></form>`,
  });
}

export function changePasswordForm(o: { locale: Locale; action: string; fields: Record<string, string | undefined>; error?: string; langHref?: string }): string {
  const L = o.locale;
  return page({
    locale: L,
    title: t(L, 'l.update'),
    langHref: o.langHref,
    body: `<p class="info">${h(t(L, 'l.mustChange'))}</p>${o.error ? `<p class="err" role="alert">${h(o.error)}</p>` : ''}
<form method="post" action="${h(o.action)}">${hidden({ ...o.fields, action: 'changepw' })}
<label for="newpw">${h(t(L, 'l.newPassword'))}</label><input id="newpw" name="newpw" type="password" autocomplete="new-password" required autofocus>
<label for="newpw2">${h(t(L, 'l.confirmPassword'))}</label><input id="newpw2" name="newpw2" type="password" autocomplete="new-password" required>
<button type="submit">${h(t(L, 'l.update'))}</button></form>`,
  });
}

export function deviceForm(o: { locale: Locale; code?: string; error?: string; sessionUser?: { displayName: string; userPrincipalName: string }; langHref?: string }): string {
  const L = o.locale;
  const who = o.sessionUser
    ? `<div class="who"><span class="avatar">${h(o.sessionUser.displayName.slice(0, 1).toUpperCase())}</span><div><div>${h(o.sessionUser.displayName)}</div><div style="color:var(--muted);font-size:13px">${h(o.sessionUser.userPrincipalName)}</div></div></div>`
    : `<label for="login">${h(t(L, 'l.username'))}</label><input id="login" name="login" type="email" autocomplete="username" required>
<label for="passwd">${h(t(L, 'l.password'))}</label><input id="passwd" name="passwd" type="password" autocomplete="current-password" required>`;
  return page({
    locale: L,
    title: t(L, 'l.deviceTitle'),
    subtitle: t(L, 'l.deviceSubtitle'),
    langHref: o.langHref,
    body: `${o.error ? `<p class="err" role="alert">${h(o.error)}</p>` : ''}
<form method="post" action="/devicelogin">${hidden({ action: 'login', ui_locales: L })}
<label for="otc">${h(t(L, 'l.code'))}</label><input id="otc" name="otc" class="code" required autofocus autocomplete="one-time-code" value="${h(o.code ?? '')}">
${who}<button type="submit">${h(t(L, 'l.next'))}</button></form>`,
  });
}

export function messagePage(locale: Locale, title: string, text: string, langHref?: string): string {
  return page({ locale, title, body: `<p class="sub" style="margin:0">${h(text)}</p>`, langHref });
}

export function formPost(action: string, fields: Record<string, string | undefined>): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>…</title></head><body onload="document.forms[0].submit()"><form method="post" action="${h(action)}">${hidden(fields)}<noscript><button type="submit">Continue</button></noscript></form></body></html>`;
}
