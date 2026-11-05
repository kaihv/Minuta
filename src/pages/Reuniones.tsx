import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Mic, Search, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, EmptyState, Input, LinkButton, Spinner, StatusBadge } from "@/components/ui";
import { MEETING_COLUMNS, type Meeting } from "@/lib/api";
import { IN_PROGRESS, when } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";

export default function Reuniones() {
  const { session } = useAuth();
  const [q, setQ] = useState("");

  const meetings = useQuery({
    queryKey: ["meetings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meetings")
        .select(MEETING_COLUMNS)
        .order("scheduled_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as unknown as Meeting[];
    },
    refetchInterval: (query) =>
      (query.state.data ?? []).some((m) => IN_PROGRESS.includes(m.status) && m.recall_bot_id) ? 10_000 : false,
  });

  const calendar = useQuery({
    queryKey: ["calendar-connection"],
    queryFn: async () => {
      const { data } = await supabase.from("calendar_connections").select("is_active, auto_record_enabled").maybeSingle();
      return data;
    },
  });

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = meetings.data ?? [];
    return term ? all.filter((m) => m.title.toLowerCase().includes(term)) : all;
  }, [meetings.data, q]);

  const live = list.filter((m) => m.status === "recording");
  const rest = list.filter((m) => m.status !== "recording");

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>Reuniones</h1>
          <p className="mt-1 text-muted-foreground">Grabadas, en curso y por venir.</p>
        </div>
        <LinkButton to="/grabar">Grabar una reunión</LinkButton>
      </div>

      {calendar.isSuccess && !calendar.data?.is_active && (
        <p className="mt-6 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>
            Conecta tu Google Calendar y el bot entrará solo a tus videollamadas.{" "}
            <Link to="/ajustes" className="font-medium underline underline-offset-2">
              Conectar calendario
            </Link>
          </span>
        </p>
      )}

      <div className="mt-6">
        <label htmlFor="buscar" className="sr-only">
          Buscar por título
        </label>
        <Input id="buscar" placeholder="Buscar por título" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {meetings.isLoading && <Spinner />}
      {meetings.isError && <p className="mt-6 text-danger">No se pudieron cargar las reuniones. Recarga la página.</p>}

      {live.length > 0 && (
        <Card className="mt-6 border-danger/40">
          <MeetingRows items={live} me={session?.user.id} />
        </Card>
      )}

      {meetings.isSuccess && rest.length > 0 && (
        <Card className="mt-6">
          <MeetingRows items={rest} me={session?.user.id} />
        </Card>
      )}

      {meetings.isSuccess && list.length === 0 && (
        <Card className="mt-6">
          {q ? (
            <EmptyState icon={<Search />} title="Ninguna reunión con ese título">
              Prueba con otra palabra.
            </EmptyState>
          ) : (
            <EmptyState icon={<Mic />} title="Todavía no hay reuniones">
              <p>Pega el enlace de una videollamada o conecta tu calendario para que el bot entre solo.</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <LinkButton to="/grabar">Grabar una reunión</LinkButton>
                <LinkButton to="/ajustes" variant="secondary">Conectar calendario</LinkButton>
              </div>
            </EmptyState>
          )}
        </Card>
      )}
    </div>
  );
}

function MeetingRows({ items, me }: { items: Meeting[]; me?: string }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((m) => (
        <li key={m.id}>
          <Link to={`/reunion/${m.id}`} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/60">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{m.title}</p>
              <p className="num mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                <span>{when(m.scheduled_at ?? m.created_at)}</span>
                {m.duration_minutes ? <span>{m.duration_minutes} min</span> : null}
                {m.meeting_type === "presencial" && <span>Presencial</span>}
                {me && m.user_id !== me && (
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3.5" aria-hidden /> Compartida
                  </span>
                )}
              </p>
            </div>
            <StatusBadge status={m.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
