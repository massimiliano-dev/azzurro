import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import '@fontsource-variable/saira/standard.css';
import '@fontsource-variable/saira/standard-italic.css';
import '@fontsource-variable/martian-mono/standard.css';
import './globals.css';
import { Providers, type Theme } from '@/components/providers';
import type { Locale } from '@/i18n';

export const metadata: Metadata = {
  title: 'Azzurro',
  description: 'Portale dell\'emulatore locale di Azure: risorse, identità e applicazioni.',
  applicationName: 'Azzurro',
  appleWebApp: { capable: true, title: 'Azzurro', statusBarStyle: 'default' },
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' }], shortcut: '/favicon.ico', apple: '/icons/apple-touch-icon.png' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b1d51',
};

const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )azzurro_theme=([^;]+)/);var t=m?m[1]:'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const c = await cookies();
  const h = await headers();
  const saved = c.get('azzurro_locale')?.value;
  const locale: Locale = saved === 'en' || saved === 'it' ? saved : (h.get('accept-language') ?? '').toLowerCase().startsWith('en') ? 'en' : 'it';
  const t = c.get('azzurro_theme')?.value;
  const theme: Theme = t === 'light' || t === 'dark' ? t : 'system';
  return (
    <html lang={locale} data-theme={theme === 'system' ? undefined : theme} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers locale={locale} theme={theme}>{children}</Providers>
      </body>
    </html>
  );
}
