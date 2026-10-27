/** Marchio Azzurro: una «A» aperta come una Λ, la traversa è un blocco ocra: una richiesta in transito. */
export function Logo({ size = 28, inverse = false }: { size?: number; inverse?: boolean }) {
  const ground = inverse ? '#ffffff' : '#0b3fbf';
  const glyph = inverse ? '#0b3fbf' : '#ffffff';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="3" fill={ground} />
      <path d="M6.5 25.5 14 6.5h4l7.5 19h-4.3L16 11.9 10.8 25.5z" fill={glyph} />
      <rect x="12.6" y="17.6" width="6.8" height="3.6" fill="#e8a917" />
    </svg>
  );
}
