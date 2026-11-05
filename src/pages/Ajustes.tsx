import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Minus } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button, Card, Field, Input, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { callFn } from "@/lib/api";
import { hour, when } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { useAppInfo, useIsAdmin } from "@/hooks/useAuth";
import { Appearance } from "@/components/settings/Appearance";
import { ConnectAI } from "@/components/settings/ConnectAI";

const CALENDAR_ERRORS: Record<string, string> = {
  state: "El enlace de autorización venció. Vuelve a intentarlo.",
  cancelado: "Cancelaste la conexión con Google.",
  sin_codigo: "Google no devolvió la autorización. Vuelve a intentarlo.",
  google: "Google rechazó la conexión. Revisa el Client ID, el secreto y la URL de retorno.",
  cuenta: "Conecta la misma cuenta de Google con la que entras a la app.",
  guardar: "No se pudo guardar la conexión. Vuelve a intentarlo.",
};

export default function Ajustes() {
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    const err = params.get("calendar_error");
    if (err) {
      toast.error(CALENDAR_ERRORS[err] ?? "No se pudo conectar el calendario.");
      params.delete("calendar_error");
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  return (
    <div className="space-y-8">
      <div>
        <h1>Ajustes</h1>
        <p className="mt-1 text-muted-foreground">Tu calendario, tu IA y, si administras, cómo funciona el bot para todos.</p>
      </div>
      <Calendar />
      <ConnectAI />
      <Appearance />
      {isAdmin && <Installation />}
      <Pieces />
    </div>
  );
}

interface Connection {
  is_active: boolean;
  calendar_id: string | null;
  auto_record_enabled: boolean;
  auto_record_minutes_before: number;
  last_error: string | null;
}

interface UpcomingEvent {
  id: string;
  title: string;
  start: string;
  willRecord: boolean;
  reason: string | null;
  excludedByUser: boolean;
}

const SKIP_TEXT: Record<string, string> = {
  no_video_link: "sin videollamada",
  no_other_attendees: "solo tú",
  declined: "la rechazaste",
  everyone_declined: "nadie más va",
  in_person: "presencial",
  not_a_meeting: "no es reunión",
  excluded_email: "invitado excluido",
  internal_disabled_by_admin: "interna",
  external_not_accepted: "invitación externa sin aceptar",
  excluded_by_user: "la excluiste",
};

function Calendar() {
  const qc = useQueryClient();
  const info = useAppInfo();
  const conn = useQuery({
    queryKey: ["calendar-connection"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("calendar_connections")
        .select("is_active, calendar_id, auto_record_enabled, auto_record_minutes_before, last_error")
        .maybeSingle();
      if (error) throw error;
      return data as Connection | null;
    },
  });
  const connected = !!conn.data?.is_active;

  const events = useQuery({
    queryKey: ["calendar-events"],
    enabled: connected,
    queryFn: () => callFn<{ connected: boolean; events: UpcomingEvent[]; error?: string }>("google-calendar", { action: "get_events" }),
  });

  const connect = useMutation({
    mutationFn: () => callFn<{ authUrl: string }>("google-calendar", { action: "get_auth_url", redirectUrl: `${window.location.origin}/ajustes` }),
    onSuccess: (r) => (window.location.href = r.authUrl),
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnect = useMutation({
    mutationFn: () => callFn("google-calendar", { action: "disconnect" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar-connection"] }),
  });

  const update = useMutation({
    mutationFn: async (patch: Partial<Connection>) => {
      const { error } = await supabase.from("calendar_connections").update(patch).eq("is_active", true);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar-connection"] }),
    onError: () => toast.error("No se pudo guardar"),
  });

  const exclude = useMutation({
    mutationFn: (v: { eventId: string; exclude: boolean }) => callFn("google-calendar", { action: "exclude_event", ...v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar-events"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  if (conn.isLoading) return <Spinner />;

  return (
    <Card className="p-6">
      <h2>Tu Google Calendar</h2>
      {info.data && !info.data.googleCalendar ? (
        <p className="mt-2 text-muted-foreground">Falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en las funciones (ver LEEME).</p>
      ) : !connected ? (
        <>
          <p className="mt-2 text-muted-foreground">Con el calendario conectado, el bot entra solo a tus videollamadas con otras personas. Solo lee tu calendario: no crea ni cambia eventos.</p>
          <Button className="mt-4" loading={connect.isPending} onClick={() => connect.mutate()}>
            Conectar Google Calendar
          </Button>
        </>
      ) : (
        <div className="mt-4 space-y-5">
          <p className="text-sm text-muted-foreground">Conectado como {conn.data?.calendar_id}</p>
          {conn.data?.last_error && (
            <p className="rounded-md border border-danger/40 p-3 text-sm">
              Google dejó de dar acceso al calendario ({conn.data.last_error}). Desconecta y vuelve a conectar.
            </p>
          )}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">Grabar automáticamente</p>
              <p className="text-sm text-muted-foreground">El bot entra a las videollamadas de tu calendario.</p>
            </div>
            <Switch label="Grabar automáticamente" checked={!!conn.data?.auto_record_enabled} onChange={(v) => update.mutate({ auto_record_enabled: v })} />
          </div>
          <Field label="Minutos antes de la hora en que entra el bot" htmlFor="antes">
            <Select
              id="antes"
              value={conn.data?.auto_record_minutes_before ?? 2}
              onChange={(e) => update.mutate({ auto_record_minutes_before: Number(e.target.value) })}
            >
              {[0, 1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 0 ? "A la hora" : `${n} min`}</option>)}
            </Select>
          </Field>

          <div>
            <p className="font-medium">Próximos 7 días</p>
            {events.isLoading && <Spinner label="Leyendo tu calendario" />}
            {events.data?.events.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No hay reuniones en los próximos 7 días.</p>}
            {events.data && events.data.events.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                {events.data.events.map((e) => {
                  const recordable = e.willRecord || e.excludedByUser;
                  return (
                    <li key={e.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{e.title}</p>
                        <p className="num text-sm text-muted-foreground">
                          {when(e.start).split(",")[0]}, {hour(e.start)}
                          {!e.willRecord && e.reason ? `. No se graba: ${SKIP_TEXT[e.reason] ?? e.reason}` : ""}
                        </p>
                      </div>
                      {recordable && (
                        <Switch
                          label={`Grabar ${e.title}`}
                          checked={e.willRecord}
                          disabled={exclude.isPending}
                          onChange={(v) => exclude.mutate({ eventId: e.id, exclude: !v })}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Button variant="ghost" size="sm" className="-ml-3" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Desconectar calendario
          </Button>
        </div>
      )}
    </Card>
  );
}

interface Settings {
  bot_name: string;
  internal_domain: string | null;
  skip_internal_meetings: boolean;
  excluded_emails: string[];
  allowed_email_domains: string[];
  admin_emails: string[];
  summary_context: string | null;
  daily_bot_limit: number;
  daily_ai_limit: number;
}

const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

function Installation() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["bot-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bot_settings")
        .select("bot_name, internal_domain, skip_internal_meetings, excluded_emails, allowed_email_domains, admin_emails, summary_context, daily_bot_limit, daily_ai_limit")
        .eq("id", 1)
        .single();
      if (error) throw error;
      return data as Settings;
    },
  });
  const [form, setForm] = useState<{
    bot_name: string;
    internal_domain: string;
    skip: boolean;
    excluded: string;
    allowed: string;
    admins: string;
    context: string;
    botLimit: number;
    aiLimit: number;
  } | null>(null);

  useEffect(() => {
    const s = settings.data;
    if (s && !form) {
      setForm({
        bot_name: s.bot_name,
        internal_domain: s.internal_domain ?? "",
        skip: s.skip_internal_meetings,
        excluded: s.excluded_emails.join(", "),
        allowed: s.allowed_email_domains.join(", "),
        admins: s.admin_emails.join(", "),
        context: s.summary_context ?? "",
        botLimit: s.daily_bot_limit,
        aiLimit: s.daily_ai_limit,
      });
    }
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: async () => {
      const f = form!;
      const { error } = await supabase
        .from("bot_settings")
        .update({
          bot_name: f.bot_name.trim() || "Minuta · toma notas",
          internal_domain: f.internal_domain.trim().toLowerCase().replace(/^@/, "") || null,
          skip_internal_meetings: f.skip,
          excluded_emails: list(f.excluded),
          allowed_email_domains: list(f.allowed).map((d) => d.replace(/^@/, "")),
          admin_emails: list(f.admins),
          summary_context: f.context.trim() || null,
          daily_bot_limit: Math.max(0, Math.round(f.botLimit)),
          daily_ai_limit: Math.max(0, Math.round(f.aiLimit)),
        })
        .eq("id", 1);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Ajustes guardados");
      qc.invalidateQueries({ queryKey: ["bot-settings"] });
    },
    onError: () => toast.error("No se pudieron guardar los ajustes"),
  });

  if (!form) return <Spinner />;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  return (
    <Card className="p-6">
      <h2>Para todo el equipo</h2>
      <p className="mt-1 text-sm text-muted-foreground">Solo lo ven quienes administran.</p>
      <form
        className="mt-5 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Nombre del bot en la llamada" htmlFor="bot">
          <Input id="bot" value={form.bot_name} onChange={(e) => set({ bot_name: e.target.value })} maxLength={80} />
        </Field>
        <Field
          label="Contexto de la empresa para el resumen"
          htmlFor="ctx"
          hint="Quiénes son, a qué se dedican y nombres que el dictado suele escribir mal (clientes, productos). Mejora mucho los resúmenes."
        >
          <Textarea id="ctx" rows={4} value={form.context} onChange={(e) => set({ context: e.target.value })} maxLength={3000} />
        </Field>
        <Field label="Dominio de la empresa" htmlFor="dom" hint="Ej: miempresa.cl. Sirve para reconocer reuniones internas.">
          <Input id="dom" value={form.internal_domain} onChange={(e) => set({ internal_domain: e.target.value })} />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">No grabar reuniones internas</p>
            <p className="text-sm text-muted-foreground">Cuando todos los invitados son del dominio de la empresa.</p>
          </div>
          <Switch label="No grabar reuniones internas" checked={form.skip} onChange={(v) => set({ skip: v })} />
        </div>
        <Field label="Nunca grabar reuniones con estos correos" htmlFor="exc" hint="Separados por coma.">
          <Input id="exc" value={form.excluded} onChange={(e) => set({ excluded: e.target.value })} />
        </Field>
        <Field
          label="Quién puede crear cuenta"
          htmlFor="allow"
          hint="Dominios separados por coma (ej: miempresa.cl). Vacío = cualquiera con el enlace. Recomendado completarlo."
        >
          <Input id="allow" value={form.allowed} onChange={(e) => set({ allowed: e.target.value })} />
        </Field>
        <Field
          label="Correos que administran"
          htmlFor="admins"
          hint="Quedan como admin al confirmar su cuenta. Para quitarle el rol a alguien, sácalo de aquí y del rol en Supabase."
        >
          <Input id="admins" value={form.admins} onChange={(e) => set({ admins: e.target.value })} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Bots a mano por persona al día" htmlFor="botlim" hint="Controla el gasto en Recall. La grabación del calendario no cuenta.">
            <Input id="botlim" type="number" min={0} value={form.botLimit} onChange={(e) => set({ botLimit: Number(e.target.value) })} />
          </Field>
          <Field label="Usos de IA por persona al día" htmlFor="ailim" hint="Preguntas y resúmenes a mano. El resumen automático no cuenta.">
            <Input id="ailim" type="number" min={0} value={form.aiLimit} onChange={(e) => set({ aiLimit: Number(e.target.value) })} />
          </Field>
        </div>
        <Button type="submit" loading={save.isPending}>
          Guardar ajustes
        </Button>
      </form>
    </Card>
  );
}

function Pieces() {
  const info = useAppInfo();
  if (!info.data) return null;
  const d = info.data;
  const rows: Array<[string, boolean, string]> = [
    ["Grabar videollamadas (Recall.ai)", d.recall, d.recall ? "Configurado" : "Falta RECALL_API_KEY"],
    ["Google Calendar", d.googleCalendar, d.googleCalendar ? "Configurado" : "Falta GOOGLE_CLIENT_ID / SECRET"],
    ["Resumen y preguntas con IA", !!d.ai, d.ai ? `${d.ai.provider} (${d.ai.model})` : "Apagado (AI_PROVIDER)"],
    ["Reuniones presenciales (Deepgram)", d.inPerson, d.inPerson ? "Configurado" : "Apagado (DEEPGRAM_API_KEY)"],
    ["Aviso a otras herramientas (webhook)", d.outgoingWebhook, d.outgoingWebhook ? "Configurado" : "Apagado (OUTGOING_WEBHOOK_URL)"],
  ];
  return (
    <section>
      <h2>Qué está encendido</h2>
      <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-surface">
        {rows.map(([name, on, detail]) => (
          <li key={name} className="flex items-center gap-3 px-4 py-2.5">
            {on ? <Check className="size-4 text-success" aria-label="Encendido" /> : <Minus className="size-4 text-muted-foreground" aria-label="Apagado" />}
            <span className="flex-1">{name}</span>
            <span className={clsx("text-sm", on ? "text-muted-foreground" : "text-muted-foreground/80")}>{detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
