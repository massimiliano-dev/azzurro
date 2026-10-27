import { Suspense } from 'react';
import { SessionProvider } from '@/lib/session';
import { Shell } from '@/components/shell';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Shell>
        <Suspense fallback={<div className="spinner" />}>{children}</Suspense>
      </Shell>
    </SessionProvider>
  );
}
