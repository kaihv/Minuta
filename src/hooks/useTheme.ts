import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { BRAND, COLOR_OPTIONS, type ColorName } from "@/config/brand";

// Modo (claro/oscuro/sistema) y color de marca de cada persona. Se guardan en
// este navegador; si no se puede guardar (modo privado) la app funciona igual.

export type Mode = "light" | "dark" | "system";
const MODE_KEY = "minuta-modo";
const COLOR_KEY = "minuta-color";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: solo dura esta visita */
  }
}

function isColor(v: string | null): v is ColorName {
  return !!v && COLOR_OPTIONS.some((c) => c.id === v);
}

/** Aplica modo y color al <html>. Se llama al cargar y al cambiar. */
export function applyTheme(mode: Mode, color: ColorName) {
  const root = document.documentElement;
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  root.dataset.color = color;
}

function useThemeState() {
  const [mode, setModeState] = useState<Mode>(() => {
    const m = read(MODE_KEY);
    return m === "light" || m === "dark" || m === "system" ? m : "system";
  });
  const [color, setColorState] = useState<ColorName>(() => {
    const c = read(COLOR_KEY);
    return isColor(c) ? c : BRAND.defaultColor;
  });

  useEffect(() => {
    applyTheme(mode, color);
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system", color);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, color]);

  const setMode = useCallback((m: Mode) => {
    write(MODE_KEY, m);
    setModeState(m);
  }, []);
  const setColor = useCallback((c: ColorName) => {
    write(COLOR_KEY, c);
    setColorState(c);
  }, []);

  return { mode, setMode, color, setColor };
}

type ThemeState = ReturnType<typeof useThemeState>;
const ThemeContext = createContext<ThemeState | null>(null);

/** Envuelve la app una vez (App.tsx); todos los useTheme() comparten estado. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: useThemeState() }, children);
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme fuera de ThemeProvider");
  return ctx;
}
