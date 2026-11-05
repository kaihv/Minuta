import clsx from "clsx";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { Wordmark } from "@/components/Logo";
import { useAuth } from "@/hooks/useAuth";
import { useTheme, type Mode } from "@/hooks/useTheme";
import { supabase } from "@/lib/supabase";

const NAV = [
  { to: "/", label: "Reuniones", end: true },
  { to: "/grabar", label: "Grabar" },
  { to: "/ajustes", label: "Ajustes" },
];

const NEXT_MODE: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };
const MODE_LABEL: Record<Mode, string> = { system: "Tema del sistema", light: "Tema claro", dark: "Tema oscuro" };

function ModeButton() {
  const { mode, setMode } = useTheme();
  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  return (
    <button
      onClick={() => setMode(NEXT_MODE[mode])}
      className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={`${MODE_LABEL[mode]}. Cambiar`}
      title={MODE_LABEL[mode]}
    >
      <Icon className="size-4" />
    </button>
  );
}

export default function Layout() {
  const { session } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-page items-center gap-3 px-4 sm:gap-6">
          <NavLink to="/" aria-label="Inicio">
            <Wordmark compact />
          </NavLink>
          <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Principal">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  clsx(
                    "rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors sm:px-3",
                    isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 hidden text-sm text-muted-foreground md:inline">{session?.user.email}</span>
            <ModeButton />
            <button
              onClick={() => supabase.auth.signOut()}
              className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-page px-4 py-8 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}
