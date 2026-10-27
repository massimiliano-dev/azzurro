import type { NextConfig } from 'next';

const API = (process.env.AZZURRO_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    // Il portale usa direttamente le API emulate (ARM, Microsoft Graph) e gli endpoint del portale.
    return [
      { source: '/api/arm/:path*', destination: `${API}/:path*` },
      { source: '/api/graph/:path*', destination: `${API}/v1.0/:path*` },
      { source: '/api/portal/:path*', destination: `${API}/_portal/:path*` },
    ];
  },
  async headers() {
    return [
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }, { key: 'Service-Worker-Allowed', value: '/' }, { key: 'Content-Type', value: 'application/javascript; charset=utf-8' }] },
      { source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'X-Frame-Options', value: 'DENY' }] },
    ];
  },
};

export default nextConfig;
