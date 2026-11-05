import clsx from "clsx";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Card, CardHeader, Segmented } from "@/components/ui";
import { COLOR_OPTIONS } from "@/config/brand";
import { useTheme, type Mode } from "@/hooks/useTheme";

/** Modo claro/oscuro y color de la app. Se guarda en este navegador. */
export function Appearance() {
  const { mode, setMode, color, setColor } = useTheme();
  return (
    <Card className="p-6">
      <CardHeader title="Apariencia" description="Solo cambia cómo la ves tú, en este navegador." />
      <div className="mt-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-medium">Tema</span>
          <Segmented<Mode>
            label="Tema"
            value={mode}
            onChange={setMode}
            options={[
              { value: "light", label: "Claro", icon: <Sun aria-hidden /> },
              { value: "dark", label: "Oscuro", icon: <Moon aria-hidden /> },
              { value: "system", label: "Sistema", icon: <Monitor aria-hidden /> },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-medium">Color</span>
          <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={color === c.id}
                aria-label={c.label}
                title={c.label}
                onClick={() => setColor(c.id)}
                className={clsx(
                  "flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition",
                  color === c.id ? "ring-2 ring-foreground" : "hover:scale-110",
                )}
                style={{ background: c.swatch }}
              >
                {color === c.id && <Check className="size-4 text-white" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
