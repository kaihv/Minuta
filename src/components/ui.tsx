import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";
import type { MeetingStatus } from "@/lib/api";
import { STATUS_LABEL } from "@/lib/format";

// Piezas básicas de la interfaz. Solo usan colores del tema (src/theme/theme.css):
// cambiando el tema cambian todas.

type Variant = "primary" | "secondary" | "ghost" | "danger" | "rec";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  secondary: "bg-surface text-foreground border border-input shadow-sm hover:bg-muted",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-muted",
  danger: "bg-surface text-danger border border-input hover:border-danger/50 hover:bg-danger/5",
  rec: "bg-danger text-white shadow-sm hover:bg-danger/90",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: "sm" | "md" }
>(({ variant = "primary", loading, size = "md", className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={clsx(BASE, size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4", VARIANTS[variant], className)}
    {...rest}
  >
    {loading && <Loader2 className="animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = "Button";

/** Enlace con aspecto de botón (para navegar, no para acciones). */
export function LinkButton({ variant = "primary", className, ...rest }: LinkProps & { variant?: Variant }) {
  return <Link className={clsx(BASE, "h-10 px-4", VARIANTS[variant], className)} {...rest} />;
}

const FIELD =
  "w-full rounded-md border border-input bg-surface text-foreground placeholder:text-muted-foreground/70 transition-colors focus:border-primary disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={clsx(FIELD, "h-10 px-3", className)} {...rest} />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={clsx(FIELD, "px-3 py-2", className)} {...rest} />
));
Textarea.displayName = "Textarea";

export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx(FIELD, "h-10 w-auto px-3 pr-8", className)} {...rest} />;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span className={clsx("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  );
}

/** Elegir una opción entre pocas (claro / oscuro / sistema). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-input bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "inline-flex h-8 items-center gap-1.5 rounded-[calc(var(--radius)-4px)] px-3 text-sm font-medium transition-colors [&_svg]:size-4",
            value === o.value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Tarjeta: el contenedor de la app. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx("rounded-xl border border-border bg-surface shadow-card", className)}>{children}</section>;
}

/** Título de una tarjeta con descripción opcional. */
export function CardHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2>{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

const STATUS_TONE: Record<MeetingStatus, string> = {
  recording: "bg-danger/10 text-danger",
  completed: "bg-success/10 text-success",
  failed: "bg-danger/10 text-danger",
  processing: "bg-warning/10 text-warning",
  scheduled: "bg-primary/10 text-primary",
  not_recorded: "bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: MeetingStatus }) {
  return (
    <span className={clsx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap", STATUS_TONE[status])}>
      <span className={clsx("h-1.5 w-1.5 rounded-full bg-current", status === "recording" && "rec-dot")} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Spinner({ label = "Cargando" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

/** Pantalla vacía: dice qué falta y qué hacer. */
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-5">{icon}</div>
      <h2 className="mt-4">{title}</h2>
      {children && <div className="mt-2 max-w-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
