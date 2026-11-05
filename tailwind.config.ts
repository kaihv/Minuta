import type { Config } from "tailwindcss";

// Los colores NO se definen aquí: viven en src/theme/theme.css como variables.
// Este archivo solo les da nombre para usarlos en las clases (bg-primary, etc.).
const color = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["var(--font-sans)"] },
      colors: {
        background: color("background"),
        foreground: color("foreground"),
        surface: color("surface"),
        muted: { DEFAULT: color("muted"), foreground: color("muted-foreground") },
        border: color("border"),
        input: color("input"),
        ring: color("ring"),
        primary: { DEFAULT: color("primary"), foreground: color("primary-foreground") },
        success: color("success"),
        warning: color("warning"),
        danger: color("danger"),
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
      },
      boxShadow: { card: "var(--shadow-card)" },
      maxWidth: { page: "60rem" },
    },
  },
  plugins: [],
} satisfies Config;
