import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, CardHeader, Field, Input, Segmented } from "@/components/ui";
import { BRAND } from "@/config/brand";
import { supabase } from "@/lib/supabase";
import { when } from "@/lib/format";

// Conectar Minuta a Claude, Cursor u otra IA con el servidor MCP.
// Cada persona crea su token; se muestra UNA vez y con él la IA ve lo mismo
// que esa persona ve en la app.

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

type Client = "claude-code" | "claude-desktop" | "cursor";

const MCP_URL = `${import.meta.env.VITE_SUPABASE_URL ?? "https://TU_PROJECT_REF.supabase.co"}/functions/v1/mcp`;
const SERVER = BRAND.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "minuta";

export function snippet(client: Client, token: string): string {
  if (client === "claude-code") {
    return `claude mcp add --transport http ${SERVER} ${MCP_URL} --header "Authorization: Bearer ${token}"`;
  }
  if (client === "cursor") {
    return JSON.stringify({ mcpServers: { [SERVER]: { url: MCP_URL, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER]: {
          command: "npx",
          args: ["-y", "mcp-remote", MCP_URL, "--header", `Authorization:Bearer ${token}`],
        },
      },
    },
    null,
    2,
  );
}

const WHERE: Record<Client, string> = {
  "claude-code": "Pégalo en la terminal.",
  "claude-desktop": "Claude Desktop: Ajustes, Desarrollador, Editar configuración. Pégalo en claude_desktop_config.json y reinicia Claude (necesita Node.js).",
  cursor: "Cursor: Settings, MCP, Add new global MCP server. Pégalo en mcp.json.",
};

export function ConnectAI() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [client, setClient] = useState<Client>("claude-code");

  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("personal_access_tokens")
        .select("id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as TokenRow[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("create_personal_access_token", { p_name: name.trim() || "Mi IA", p_expires_days: 365 });
      if (error) throw error;
      return (data as Array<{ token: string }>)[0].token;
    },
    onSuccess: (token) => {
      setFresh(token);
      setName("");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("revoke_personal_access_token", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Token revocado: esa conexión dejó de funcionar");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });

  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("Copiado"));

  return (
    <Card className="p-6">
      <CardHeader
        title="Conectar con Claude u otra IA"
        description="Tu asistente de IA podrá buscar tus reuniones, leer resúmenes y transcripciones, y mandar el bot. Ve solo lo que tú ves."
      />

      {fresh ? (
        <div className="mt-5 space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-medium">Tu token. Cópialo ahora: no se vuelve a mostrar.</p>
          <Segmented<Client>
            label="Dónde lo vas a usar"
            value={client}
            onChange={setClient}
            options={[
              { value: "claude-code", label: "Claude Code" },
              { value: "claude-desktop", label: "Claude Desktop" },
              { value: "cursor", label: "Cursor" },
            ]}
          />
          <p className="text-sm text-muted-foreground">{WHERE[client]}</p>
          <pre className="max-h-64 overflow-auto rounded-md bg-foreground/[0.06] p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
            {snippet(client, fresh)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => copy(snippet(client, fresh))}>
              <Copy aria-hidden /> Copiar configuración
            </Button>
            <Button size="sm" variant="secondary" onClick={() => copy(fresh)}>
              Copiar solo el token
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Listo, ya lo guardé
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Otros clientes: URL <code className="break-all">{MCP_URL}</code> con la cabecera <code>Authorization: Bearer</code> y tu token.
          </p>
        </div>
      ) : (
        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <Field label="Nombre para reconocerlo" htmlFor="tok">
              <Input id="tok" placeholder="Claude en mi notebook" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Button type="submit" loading={create.isPending}>
            <KeyRound aria-hidden /> Crear token
          </Button>
        </form>
      )}

      {tokens.data && tokens.data.length > 0 && (
        <ul className="mt-6 divide-y divide-border rounded-lg border border-border">
          {tokens.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.name}</p>
                <p className="num text-sm text-muted-foreground">
                  {t.token_prefix}… {t.last_used_at ? `Último uso: ${when(t.last_used_at)}` : "Sin usar todavía"}
                  {t.expires_at ? `. Vence: ${when(t.expires_at).split(",")[0]}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Revocar ${t.name}`}
                loading={revoke.isPending && revoke.variables === t.id}
                onClick={() => {
                  if (confirm(`¿Revocar "${t.name}"? La IA que lo use dejará de conectarse.`)) revoke.mutate(t.id);
                }}
              >
                <Trash2 aria-hidden /> Revocar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
