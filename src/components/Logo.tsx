import clsx from "clsx";
import { BRAND } from "@/config/brand";

/** Logo de la marca. Toma el color principal del tema; o usa BRAND.logoUrl. */
export function LogoMark({ className }: { className?: string }) {
  if (BRAND.logoUrl) return <img src={BRAND.logoUrl} alt="" className={clsx("h-7 w-7 rounded-md object-contain", className)} />;
  return (
    <svg viewBox="0 0 32 32" className={clsx("h-7 w-7 text-primary", className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path d="M9.5 10h13M9.5 16h13M9.5 22h7" stroke="hsl(var(--primary-foreground))" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22.5" cy="22" r="3" fill="hsl(var(--danger))" stroke="hsl(var(--primary-foreground))" strokeWidth="1.5" />
    </svg>
  );
}

export function Wordmark({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={clsx("inline-flex items-center gap-2.5 font-semibold tracking-tight", className)}>
      <LogoMark />
      <span className={clsx(compact && "hidden sm:inline")}>{BRAND.name}</span>
    </span>
  );
}
