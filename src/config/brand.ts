// ============================================================
//  MARCA DE MINUTA: nombre, textos y color de fábrica.
// ============================================================
// Para convertir Minuta en la herramienta de tu empresa, cambia esto.
// Los colores en detalle están en src/theme/theme.css.

export const BRAND = {
  /** Nombre que se ve en la barra, la pestaña del navegador y el ingreso. */
  name: "Minuta",
  /** Frase corta bajo el nombre en la pantalla de ingreso. */
  tagline: "Graba tus reuniones, las transcribe y deja el resumen listo.",
  /** Paleta de color de fábrica (ver COLOR_OPTIONS). */
  defaultColor: "azul" as ColorName,
  /**
   * Logo propio: pon tu archivo en /public (ej. /logo.svg) y escribe la ruta.
   * Vacío = se usa el logo de Minuta (que toma el color de marca solo).
   */
  logoUrl: "",
};

/** Paletas disponibles en Ajustes. Cada una existe en src/theme/theme.css. */
export const COLOR_OPTIONS = [
  { id: "azul", label: "Azul", swatch: "hsl(221 83% 53%)" },
  { id: "verde", label: "Verde", swatch: "hsl(160 84% 30%)" },
  { id: "violeta", label: "Violeta", swatch: "hsl(262 70% 55%)" },
  { id: "naranjo", label: "Naranjo", swatch: "hsl(22 92% 46%)" },
  { id: "rojo", label: "Rojo", swatch: "hsl(350 75% 46%)" },
  { id: "grafito", label: "Grafito", swatch: "hsl(222 47% 14%)" },
] as const;

export type ColorName = (typeof COLOR_OPTIONS)[number]["id"];
