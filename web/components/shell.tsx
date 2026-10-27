'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, AppWindow, Bell, Building2, ChevronDown, Download, FileCode2, FolderKanban, Home, KeyRound, LayoutList, LogOut, Menu, PlugZap, Plus, ScrollText, Search, Settings, ShieldCheck, UserCog, Users, UsersRound, Wallet, X, Fingerprint, Coins, Tags, Sparkles, Check, History } from 'lucide-react';
import { portal } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useDebounced } from '@/lib/hooks';
import { useI18n, type Locale, type MessageKey } from '@/i18n';
import { Logo } from './logo';
import { TableSorter } from './tablesort';
import { AssistantDock } from './assistant-dock';
import { syncPush } from '@/lib/push';
import { switchDirectory, useDirectory } from '@/lib/directory';
import { clearHistory, recordVisit, useHistoryList } from '@/lib/history';
import { Avatar } from './ui';
import { usePwa } from './pwa';
import { useTheme, type Theme } from './providers';
import { resourceHref } from '@/lib/arm';
import { RequestStrip } from './trace';

const NAV: { section: MessageKey; items: { href: string; label: MessageKey; icon: typeof Home; exact?: boolean }[] }[] = [
  { section: 'nav.sectionAzure', items: [
    { href: '/', label: 'nav.home', icon: Home, exact: true },
    { href: '/create', label: 'nav.create', icon: Plus },
    { href: '/subscriptions', label: 'nav.subscriptions', icon: Wallet },
    { href: '/resource-groups', label: 'nav.resourceGroups', icon: FolderKanban },
    { href: '/resources', label: 'nav.allResources', icon: LayoutList },
    { href: '/deployments', label: 'nav.deployments', icon: FileCode2 },
    { href: '/iam', label: 'nav.iam', icon: ShieldCheck },
    { href: '/activity', label: 'nav.activity', icon: Activity },
    { href: '/costs', label: 'nav.costs', icon: Coins },
    { href: '/pricing', label: 'nav.pricing', icon: Tags },
  ] },
  { section: 'nav.sectionEntra', items: [
    { href: '/entra', label: 'nav.entra', icon: Building2, exact: true },
    { href: '/entra/users', label: 'nav.users', icon: Users },
    { href: '/entra/groups', label: 'nav.groups', icon: UsersRound },
    { href: '/entra/apps', label: 'nav.apps', icon: AppWindow },
    { href: '/entra/enterprise-apps', label: 'nav.enterpriseApps', icon: Fingerprint },
    { href: '/entra/roles', label: 'nav.roles', icon: UserCog },
    { href: '/entra/logs', label: 'nav.logs', icon: ScrollText },
  ] },
  { section: 'nav.sectionTools', items: [
    { href: '/assistant', label: 'nav.assistant', icon: Sparkles },
    { href: '/notifications', label: 'nav.notifications', icon: Bell },
    { href: '/connect', label: 'nav.connect', icon: PlugZap },
    { href: '/settings', label: 'nav.settings', icon: Settings },
  ] },
];

interface Notif { id: number; ts: string; category: string; title: string; body: string; url: string | null; read: boolean }

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOut]);
}

function GlobalSearch() {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<{ kind: string; id: string; name: string; subtitle: string }[]>([]);
  const [expanded, setExpanded] = useState(false);
  const dq = useDebounced(q, 180);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useOutside(ref, () => { setOpen(false); setExpanded(false); });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => {
    if (dq.trim().length < 2) {
      setResults([]);
      return;
    }
    portal.get<{ value: any[] }>(`/search?q=${encodeURIComponent(dq)}`).then((r) => { setResults(r.value); setActive(0); }).catch(() => setResults([]));
  }, [dq]);
  const href = (r: { kind: string; id: string }) =>
    r.kind === 'application' ? `/entra/apps/${r.id}` : r.kind === 'user' ? `/entra/users/${r.id}` : r.kind === 'group' ? `/entra/groups/${r.id}` : r.kind === 'subscription' ? `/subscriptions/${r.id}` : resourceHref(r.id);
  const go = (r: { kind: string; id: string }) => {
    setOpen(false);
    setQ('');
    router.push(href(r));
  };
  return (
    <div className={`search ${expanded ? 'expanded' : ''}`} ref={ref}>
      <button type="button" className="btn ghost icon search-toggle" aria-label={t('common.search')} onClick={() => { setExpanded(true); setTimeout(() => input.current?.focus(), 0); }}><Search size={18} /></button>
      <Search size={16} aria-hidden />
      <input
        ref={input}
        type="search"
        placeholder={t('shell.searchPlaceholder')}
        aria-label={t('common.search')}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && results[active]) go(results[active]);
          if (e.key === 'Escape') { setOpen(false); setExpanded(false); input.current?.blur(); }
        }}
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results" role="listbox">
          {results.length ? results.map((r, i) => (
            <Link key={`${r.kind}-${r.id}`} href={href(r)} className={`search-item ${i === active ? 'active' : ''}`} onClick={() => { setOpen(false); setQ(''); }} role="option" aria-selected={i === active}>
              <span className="badge">{t(`shell.kind.${r.kind}` as MessageKey)}</span>
              <span style={{ minWidth: 0 }}>
                <div>{r.name}</div>
                <div className="meta">{r.subtitle}</div>
              </span>
            </Link>
          )) : <div className="muted" style={{ padding: 12 }}>{t('common.noResults')}</div>}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { t, fmtRelative } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ unread: number; value: Notif[] }>({ unread: 0, value: [] });
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const load = useCallback(() => portal.get<{ unread: number; value: Notif[] }>('/notifications?limit=8').then(setData).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    const onMsg = (e: MessageEvent) => e.data?.type === 'azzurro:notification' && load();
    navigator.serviceWorker?.addEventListener('message', onMsg);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); navigator.serviceWorker?.removeEventListener('message', onMsg); window.removeEventListener('focus', onFocus); };
  }, [load]);
  useEffect(() => {
    if ('setAppBadge' in navigator) {
      if (data.unread) (navigator as any).setAppBadge(data.unread).catch(() => undefined);
      else (navigator as any).clearAppBadge?.().catch(() => undefined);
    }
  }, [data.unread]);
  const openItem = async (n: Notif) => {
    setOpen(false);
    if (!n.read) await portal.post('/notifications/read', { ids: [n.id] }).catch(() => undefined);
    void load();
    if (n.url) router.push(n.url);
  };
  return (
    <div className="menu" ref={ref}>
      <button className="btn ghost icon" aria-label={t('shell.notifications')} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(); }}>
        <Bell size={18} />
        {data.unread > 0 && <span className="count-badge">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="dropdown notif-panel">
          <div className="spread" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <strong>{t('shell.notifications')}</strong>
            {data.unread > 0 && <button className="link-btn small" onClick={async () => { await portal.post('/notifications/read', {}); void load(); }}>{t('shell.markAllRead')}</button>}
          </div>
          <div className="notif-list">
            {data.value.length ? data.value.map((n) => (
              <a key={n.id} href={n.url ?? '#'} className={`notif-item ${n.read ? '' : 'unread'}`} onClick={(e) => { e.preventDefault(); void openItem(n); }}>
                <span className="dot" aria-hidden />
                <span>
                  <div className="title">{n.title}</div>
                  <div className="body">{n.body}</div>
                  <div className="when">{fmtRelative(n.ts)}</div>
                </span>
              </a>
            )) : <div className="empty" style={{ padding: 28 }}>{t('shell.noNotifications')}</div>}
          </div>
          <div style={{ padding: 10, textAlign: 'center' }}>
            <Link href="/notifications" onClick={() => setOpen(false)}>{t('shell.seeAll')}</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function NavHistory() {
  const { t, fmtRelative } = useI18n();
  const pathname = usePathname();
  const list = useHistoryList();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  // la pagina imposta il proprio titolo dopo il caricamento: si registra quando è pronto
  useEffect(() => {
    const url = location.pathname + location.search;
    const id = setTimeout(() => recordVisit(url, document.title), 900);
    return () => clearTimeout(id);
  }, [pathname]);
  useEffect(() => {
    // stessa pagina con parametri diversi (es. un'altra risorsa): il titolo cambia, si registra
    let tm: ReturnType<typeof setTimeout> | undefined;
    const rec = () => { clearTimeout(tm); tm = setTimeout(() => recordVisit(location.pathname + location.search, document.title), 500); };
    const obs = new MutationObserver(rec);
    obs.observe(document.head, { subtree: true, childList: true, characterData: true });
    window.addEventListener('popstate', rec);
    return () => { obs.disconnect(); clearTimeout(tm); window.removeEventListener('popstate', rec); };
  }, []);
  return (
    <div className="menu" ref={ref}>
      <button className="btn ghost icon" aria-label={t('hist.title')} title={t('hist.title')} aria-expanded={open} onClick={() => setOpen(!open)}><History size={18} /></button>
      {open && (
        <div className="dropdown hist-panel">
          <div className="dropdown-header spread"><strong>{t('hist.title')}</strong>{list.length > 0 && <button className="link-btn small" onClick={() => clearHistory()}>{t('hist.clear')}</button>}</div>
          {list.length === 0 ? <p className="small muted" style={{ padding: 12 }}>{t('hist.empty')}</p> : (
            <div className="hist-list">
              {list.map((v, i) => (
                <Link key={`${v.url}-${v.at}`} href={v.url} className={`dropdown-item hist-item ${i === 0 ? 'on' : ''}`} onClick={() => setOpen(false)}>
                  <span className="hist-dot" aria-hidden />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="hist-t">{v.title}</span>
                    <span className="small muted hist-u">{decodeURIComponent(v.url).replace(/^\/resource\?id=/, '').slice(0, 90)}</span>
                  </span>
                  <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{i === 0 ? t('hist.here') : fmtRelative(new Date(v.at).toISOString())}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveClock() {
  const { locale } = useI18n();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return <span className="dir-clock" aria-hidden>{now ? now.toLocaleTimeString(locale === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '--:--'}</span>;
}

function DirectorySwitcher() {
  const { t } = useI18n();
  const { state, active, real } = useDirectory();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  useEffect(() => {
    // ritorno dalla pagina di consenso Microsoft: completa il cambio di directory
    const dir = new URLSearchParams(location.search).get('directory');
    if (dir) void switchDirectory(dir).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.directory = real ? 'azure' : 'local';
  }, [real]);
  if (!state || (!state.microsoft && state.value.length < 2)) return null;
  const pick = async (id: string) => {
    if (id === state.active) { setOpen(false); return; }
    setBusy(id);
    setErr(null);
    try { await switchDirectory(id); } catch (e: any) { setErr(e.code === 'app_not_multitenant' ? t('dir.notMultitenant') : e.message); setBusy(null); }
  };
  return (
    <div className="menu dir-switch" ref={ref}>
      <button className={`btn ghost dir-btn ${real ? 'real' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title={t('dir.title')}>
        <span className="dir-stamp">{real ? t('dir.azure') : t('dir.local')}</span>
        <span className="dir-name">{active?.name ?? '…'}</span>
        <LiveClock />
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="dropdown dir-panel" style={{ minWidth: 320 }}>
          <div className="dropdown-header"><strong>{t('dir.title')}</strong><div className="small muted">{t('dir.hint')}</div></div>
          {state.value.map((d) => (
            <button key={d.tenantId} className={`dropdown-item dir-item ${d.tenantId === state.active ? 'on' : ''}`} disabled={!!busy} onClick={() => void pick(d.tenantId)}>
              <span className={`dir-dot ${d.kind}`} aria-hidden />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="dir-n">{d.name}</span>
                <span className="small muted mono">{d.kind === 'local' ? t('dir.localSub') : d.domain ?? d.tenantId}</span>
              </span>
              {busy === d.tenantId ? <span className="small muted">…</span> : d.tenantId === state.active ? <Check size={15} aria-hidden /> : null}
            </button>
          ))}
          {real && state.status && !state.status.graph && (
            <a className="dropdown-item" href={`/api/portal/auth/connect?tenant=${state.active}&resource=graph`}><KeyRound size={16} />{t('dir.connectGraph')}</a>
          )}
          {err && <div className="small bad-text" style={{ padding: '6px 10px' }}>{err}</div>}
          <div className="dropdown-sep" />
          <div className="small muted" style={{ padding: '4px 10px 6px' }}>{real ? t('dir.realNote') : t('dir.localNote')}</div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const { session, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false));
  const changeLocale = (l: Locale) => {
    setLocale(l);
    void portal.put('/settings', { locale: l }).catch(() => undefined);
  };
  const changeTheme = (th: Theme) => {
    setTheme(th);
    void portal.put('/settings', { theme: th }).catch(() => undefined);
  };
  return (
    <div className="menu" ref={ref}>
      <button className="btn ghost" style={{ paddingLeft: 6 }} aria-expanded={open} onClick={() => setOpen(!open)} aria-label={session?.user.displayName ?? ''}>
        <Avatar name={session?.user.displayName} size="sm" />
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="dropdown" style={{ minWidth: 280 }}>
          <div className="dropdown-header row">
            <Avatar name={session?.user.displayName} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{session?.user.displayName}</div>
              <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{session?.user.userPrincipalName}</div>
              <div className="small muted">{session?.tenant.displayName}</div>
            </div>
          </div>
          <div className="spread" style={{ padding: '6px 10px' }}>
            <span className="small muted">{t('shell.language')}</span>
            <div className="seg">
              {(['it', 'en'] as Locale[]).map((l) => <button key={l} className={locale === l ? 'on' : ''} onClick={() => changeLocale(l)}>{l === 'it' ? 'Italiano' : 'English'}</button>)}
            </div>
          </div>
          <div className="spread" style={{ padding: '6px 10px' }}>
            <span className="small muted">{t('shell.theme')}</span>
            <div className="seg">
              {(['system', 'light', 'dark'] as Theme[]).map((th) => <button key={th} className={theme === th ? 'on' : ''} onClick={() => changeTheme(th)}>{t(th === 'system' ? 'shell.themeSystem' : th === 'light' ? 'shell.themeLight' : 'shell.themeDark')}</button>)}
            </div>
          </div>
          <div className="dropdown-sep" />
          <Link className="dropdown-item" href={session ? `/entra/users/${session.user.id}` : '#'} onClick={() => setOpen(false)}><UserCog size={16} />{t('shell.profile')}</Link>
          <Link className="dropdown-item" href="/settings" onClick={() => setOpen(false)}><Settings size={16} />{t('nav.settings')}</Link>
          <Link className="dropdown-item" href="/connect" onClick={() => setOpen(false)}><KeyRound size={16} />{t('nav.connect')}</Link>
          <div className="dropdown-sep" />
          <button className="dropdown-item" onClick={() => void signOut()}><LogOut size={16} />{t('shell.signOut')}</button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  // iscrizione push di questo browser sempre legata all'utente connesso
  useEffect(() => { void syncPush().catch((e) => console.warn('[push] sincronizzazione non riuscita', e)); }, []);
  const { t } = useI18n();
  const pathname = usePathname();
  const { session } = useSession();
  const [menu, setMenu] = useState(false);
  const { canInstall, install, online } = usePwa();
  useEffect(() => setMenu(false), [pathname]);
  const isActive = (href: string, exact?: boolean) => (exact ? pathname === href : pathname === href || pathname.startsWith(href + '/') || (href === '/resources' && pathname === '/resource') || (href === '/deployments' && (pathname === '/deployment' || pathname === '/deploy')));
  return (
    <div className="app">
      <a href="#main" className="skip">{t('shell.skip')}</a>
      <nav className={`rail ${menu ? 'open' : ''}`} aria-label="main">
        <Link href="/" className="rail-brand"><Logo inverse /><span className="logotype">azzurro</span></Link>
        <div className="rail-nav">
          {NAV.map((s) => (
            <div className="nav-section" key={s.section}>
              <div className="nav-title">{t(s.section)}</div>
              {s.items.map((i) => (
                <Link key={i.href} href={i.href} className={`nav-link ${isActive(i.href, i.exact) ? 'active' : ''}`} aria-current={isActive(i.href, i.exact) ? 'page' : undefined}>
                  <i.icon size={17} aria-hidden />
                  <span>{t(i.label)}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
        {session && <div className="rail-foot"><span>{session.tenant.displayName}</span><span className="num">{session.tenant.defaultDomain}</span></div>}
      </nav>
      <div className={`scrim ${menu ? 'open' : ''}`} onClick={() => setMenu(false)} />
      <header className="topbar">
        <button className="btn ghost icon menu-btn" aria-label={t('shell.menu')} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X size={18} /> : <Menu size={18} />}</button>
        <Link href="/" className="brand"><Logo inverse size={24} /><span className="logotype">azzurro</span></Link>
        <GlobalSearch />
        <div className="topbar-actions">
          {canInstall && <button className="btn ghost sm" onClick={() => void install()}><Download size={15} /><span className="install-label">{t('shell.install')}</span></button>}
          <NavHistory />
          <DirectorySwitcher />
          <Notifications />
          <UserMenu />
        </div>
      </header>
      <main className="main" id="main">
        {!online && <div className="offline-bar" role="status">{t('shell.offline')}</div>}
        <div className="main-inner page-enter" key={pathname}>{children}</div>
      </main>
      <RequestStrip />
      <TableSorter />
      <AssistantDock />
    </div>
  );
}
