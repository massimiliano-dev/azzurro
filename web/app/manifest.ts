import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Azzurro',
    short_name: 'Azzurro',
    description: 'Portale per l\'emulatore locale di Azure: risorse, identità e applicazioni.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    orientation: 'any',
    background_color: '#eef1f6',
    theme_color: '#0b1d51',
    lang: 'it',
    categories: ['developer', 'productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Crea una risorsa', short_name: 'Crea', url: '/create', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Registrazioni app', short_name: 'App', url: '/entra/apps', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Notifiche', short_name: 'Notifiche', url: '/notifications', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
