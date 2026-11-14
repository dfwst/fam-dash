// The rlyfe logo. The wordmark's dark lettering would vanish in dark mode,
// so the browser swaps in a light-lettered copy when the phone/PC is in dark mode.
export default function Logo({ height = 24, className }: { height?: number; className?: string }) {
  const width = Math.round(height * (964 / 299)); // keep the artwork's proportions
  return (
    <picture className={className}>
      <source srcSet="/logo-dark.svg" media="(prefers-color-scheme: dark)" />
      <img src="/logo.svg" alt="rlyfe" width={width} height={height} style={{ display: 'block' }} />
    </picture>
  );
}
