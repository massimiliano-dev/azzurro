'use client';

import { useI18n } from '@/i18n';

/** Testi delle schede di servizio: italiano e inglese affiancati nel punto in cui servono. */
export function useL() {
  const { locale } = useI18n();
  return (it: string, en: string) => (locale === 'it' ? it : en);
}

export const WEB_API = '2023-12-01';
