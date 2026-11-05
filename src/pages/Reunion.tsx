import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, Copy, Download, Film, Pencil, RefreshCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button, Input, Card, Spinner, StatusBadge } from "@/components/ui";
import { callFn, fetchTranscript, MEETING_COLUMNS, type Meeting, type Turn } from "@/lib/api";
import { clock, dueDate, groupTurns, IN_PROGRESS, notRecordedText, transcriptText, when } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { useAppInfo, useAuth, useIsAdmin } from "@/hooks/useAuth";

type Tab = "resumen" | "transcripcion" | "preguntar";

export default function Reunion() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { session } = useAuth();
  const isAdmin = useIsAdmin();
  const info = useAppInfo();
  const [tab, setTab] = useState<Tab>("resumen");

  const meeting = useQuery({
    queryKey: ["meeting", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("meetings").select(MEETING_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw error;
      return data as unknown as Meeting | null;
    },
    refetchInterval: (q) => {
      const m = q.state.data;
      return m && (IN_PROGRESS.includes(m.status) || m.summary_status === "running") ? 8_000 : false;
    },
  });
  const m = meeting.data;

  const transcript = useQuery({
    queryKey: ["transcript", id],
    enabled: m?.status === "completed",
    queryFn: () => fetchTranscript(id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["meeting", id] });
    qc.invalidateQueries({ queryKey: ["transcript", id] });
    qc.invalidateQueries({ queryKey: ["meetings"] });
  };

  const botAction = useMutation({
    mutationFn: (action: "stop_recording" | "cancel_bot" | "refresh") => callFn("recall-bot", { action, meetingId: id }),
    onSuccess: (_d, action) => {
      toast.success(action === "stop_recording" ? "El bot salió de la llamada" : action === "cancel_bot" ? "Bot cancelado" : "Revisado");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resummarize = useMutation({
    mutationFn: () => callFn("analyze-meeting", { meetingId: id }),
    onSuccess: () => {
      toast.success("Resumen listo");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("meetings").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reunión borrada");
      qc.invalidateQueries({ queryKey: ["meetings"] });
      navigate("/");
    },
    onError: () => toast.error("No se pudo borrar"),
  });

  const rename = useMutation({
    mutationFn: async (title: string) => {
      const { error } = await supabase.from("meetings").update({ title }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: () => toast.error("No se pudo renombrar"),
  });

  if (meeting.isLoading) return <Spinner />;
  if (!m) {
    return (
      <div>
        <BackLink />
        <h1 className="mt-6">No encontramos esta reunión</h1>
        <p className="mt-2 text-muted-foreground">Puede que la hayan borrado o que no esté compartida contigo.</p>
      </div>
    );
  }

  const isOwner = m.user_id === session?.user.id;
  const canEdit = isOwner || isAdmin;
  const hasAi = !!info.data?.ai;

  return (
    <div>
      <BackLink />
      <Header meeting={m} canEdit={canEdit} onRename={(t) => rename.mutate(t)} />

      <StatusPanel meeting={m} canEdit={canEdit} busy={botAction.isPending} onAction={(a) => botAction.mutate(a)} />

      {m.recording_url && <Recording meetingId={m.id} presencial={m.meeting_type === "presencial"} />}

      {m.status === "completed" && (
        <>
          <div className="mt-8 flex gap-1 border-b border-border" role="tablist">
            {(["resumen", "transcripcion", ...(hasAi ? ["preguntar"] : [])] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={clsx(
                  "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                  tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t === "resumen" ? "Resumen" : t === "transcripcion" ? "Transcripción" : "Preguntar"}
              </button>
            ))}
          </div>

          {tab === "resumen" && (
            <SummaryView meeting={m} hasAi={hasAi} canEdit={canEdit} busy={resummarize.isPending} onResummarize={() => resummarize.mutate()} />
          )}
          {tab === "transcripcion" && <TranscriptView meeting={m} turns={transcript.data} loading={transcript.isLoading} />}
          {tab === "preguntar" && <Ask meetingId={m.id} />}
        </>
      )}

      {canEdit && (
        <div className="mt-16 border-t border-border pt-6">
          <Button
            variant="danger"
            size="sm"
            loading={remove.isPending}
            onClick={() => {
              if (confirm("¿Borrar esta reunión con su transcripción y resumen? No se puede deshacer.")) remove.mutate();
            }}
          >
            <Trash2 aria-hidden /> Borrar reunión
          </Button>
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ChevronLeft className="size-4" aria-hidden /> Reuniones
    </Link>
  );
}

function Header({ meeting: m, canEdit, onRename }: { meeting: Meeting; canEdit: boolean; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const attendees = (m.attendees ?? []).map((a) => a.name || a.email).filter(Boolean);

  return (
    <div className="mt-4">
      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) onRename(title.trim());
            setEditing(false);
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Título" />
          <Button type="submit">Guardar</Button>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <h1 className="min-w-0 break-words">{m.title}</h1>
          {canEdit && (
            <button onClick={() => setEditing(true)} className="mt-1.5 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Renombrar">
              <Pencil className="size-4" />
            </button>
          )}
        </div>
      )}
      <div className="num mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <StatusBadge status={m.status} />
        <span>{when(m.scheduled_at ?? m.created_at)}</span>
        {m.duration_minutes ? <span>{m.duration_minutes} min</span> : null}
        {m.meeting_type === "presencial" ? <span>Presencial</span> : m.auto_record ? <span>Desde el calendario</span> : null}
      </div>
      {attendees.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Con {attendees.slice(0, 6).join(", ")}{attendees.length > 6 ? ` y ${attendees.length - 6} más` : ""}</p>}
    </div>
  );
}

function StatusPanel({
  meeting: m,
  canEdit,
  busy,
  onAction,
}: {
  meeting: Meeting;
  canEdit: boolean;
  busy: boolean;
  onAction: (a: "stop_recording" | "cancel_bot" | "refresh") => void;
}) {
  let text: string | null = null;
  let actions: React.ReactNode = null;
  if (m.status === "scheduled" && m.recall_bot_id) {
    text = "El bot está entrando a la llamada. Si hay sala de espera, déjalo pasar.";
    if (canEdit) actions = <Button variant="secondary" size="sm" loading={busy} onClick={() => onAction("cancel_bot")}>Cancelar bot</Button>;
  } else if (m.status === "scheduled") {
    text = "El bot entrará un par de minutos antes de que empiece.";
  } else if (m.status === "recording") {
    text = m.meeting_type === "presencial" ? "Grabando en el teléfono o computador de quien la inició." : "El bot está grabando la llamada.";
    if (canEdit && m.recall_bot_id) actions = <Button variant="rec" size="sm" loading={busy} onClick={() => onAction("stop_recording")}>Sacar al bot y terminar</Button>;
  } else if (m.status === "processing") {
    text = "Procesando la grabación. La transcripción suele estar en unos minutos.";
    if (canEdit && m.recall_bot_id) actions = <Button variant="secondary" size="sm" loading={busy} onClick={() => onAction("refresh")}><RefreshCw aria-hidden /> Revisar ahora</Button>;
  } else if (m.status === "not_recorded") {
    text = notRecordedText(m.not_recorded_reason);
  } else if (m.status === "failed") {
    text = m.pipeline_error ? `No se pudo procesar: ${m.pipeline_error}` : notRecordedText(m.not_recorded_reason);
    if (canEdit && m.recall_bot_id) actions = <Button variant="secondary" size="sm" loading={busy} onClick={() => onAction("refresh")}><RefreshCw aria-hidden /> Reintentar</Button>;
  } else if (m.status === "completed" && m.pipeline_error) {
    text = m.pipeline_error.startsWith("transcript")
      ? "La grabación quedó, pero no se pudo transcribir."
      : m.pipeline_error === "audio_sin_voz" ? "El audio no tenía voz que transcribir." : `Aviso: ${m.pipeline_error}`;
  }
  if (!text) return null;
  return (
    <div className={clsx("mt-6 flex flex-wrap items-center gap-3 rounded-md border bg-surface p-4", m.status === "recording" ? "border-danger/40" : "border-border")}>
      <p className="flex-1 min-w-[14rem]">{text}</p>
      {actions}
    </div>
  );
}

function Recording({ meetingId, presencial }: { meetingId: string; presencial: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const r = await callFn<{ signedUrl: string }>("get-recording-url", { meetingId });
      setUrl(r.signedUrl);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (url) {
    return presencial ? (
      <audio src={url} controls className="mt-6 w-full" />
    ) : (
      <video src={url} controls className="mt-6 w-full rounded-xl border border-border bg-black" />
    );
  }
  return (
    <Button variant="secondary" size="sm" className="mt-6" loading={busy} onClick={load}>
      <Film aria-hidden /> {presencial ? "Escuchar grabación" : "Ver grabación"}
    </Button>
  );
}

function SummaryView({
  meeting: m,
  hasAi,
  canEdit,
  busy,
  onResummarize,
}: {
  meeting: Meeting;
  hasAi: boolean;
  canEdit: boolean;
  busy: boolean;
  onResummarize: () => void;
}) {
  const s = m.summary;
  const again = hasAi && canEdit && (
    <Button variant="ghost" size="sm" className="-ml-3" loading={busy} onClick={onResummarize}>
      <RefreshCw aria-hidden /> {s ? "Volver a resumir" : "Resumir"}
    </Button>
  );

  if (!s) {
    let msg = "Esta reunión todavía no tiene resumen.";
    if (m.summary_status === "running") msg = "Escribiendo el resumen…";
    else if (m.summary_status === "disabled" || !hasAi) msg = "La IA está apagada en esta instalación: hay transcripción, pero no resumen. Se enciende con AI_PROVIDER y AI_API_KEY (ver LEEME).";
    else if (m.summary_status === "failed") msg = `La IA no pudo resumir${m.summary_error ? `: ${m.summary_error}` : "."}`;
    else if (m.summary_status === "empty") msg = "No hubo conversación que resumir.";
    return (
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground">{msg}</p>
        {m.summary_status !== "running" && again}
      </div>
    );
  }

  const bullets = s.executive_summary.split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);
  return (
    <div className="mt-6 space-y-8">
      <Bullets items={bullets} className="max-w-[72ch]" />

      <section>
        <h2>Compromisos</h2>
        {s.action_items.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No quedaron compromisos.</p>
        ) : (
          <Card className="mt-3">
            <ul className="divide-y divide-border">
              {s.action_items.map((a, i) => (
                <li key={i} className="grid gap-1 px-4 py-3 sm:grid-cols-[1fr_10rem_7rem] sm:gap-4">
                  <span>{a.task}</span>
                  <span className="flex gap-3 text-sm text-muted-foreground sm:contents sm:text-[15px]">
                    <span>{a.assignee ?? "Sin responsable"}</span>
                    <span className="num">{dueDate(a.due_date)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {s.decisions.length > 0 && (
        <section>
          <h2>Decisiones</h2>
          <Bullets items={s.decisions} className="mt-3" />
        </section>
      )}

      {s.topics.length > 0 && <p className="text-sm text-muted-foreground">Temas: {s.topics.join(", ")}</p>}
      <div>{again}</div>
    </div>
  );
}

function Bullets({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={clsx("space-y-2", className)}>
      {items.map((b, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
          <span>{b}</span>
        </li>
      ))}
    </ul>
  );
}

function TranscriptView({ meeting, turns, loading }: { meeting: Meeting; turns?: Turn[]; loading: boolean }) {
  if (loading) return <Spinner label="Cargando transcripción" />;
  if (!turns || turns.length === 0) return <p className="mt-6 text-muted-foreground">No hay transcripción.</p>;
  const text = transcriptText(meeting, turns);

  function download() {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${meeting.title.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 60) || "reunion"}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mt-6">
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={download}>
          <Download aria-hidden /> Descargar .txt
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Transcripción copiada"))}
        >
          <Copy aria-hidden /> Copiar
        </Button>
      </div>
      {/* El acta: los minutos van al margen, el texto se lee como un documento. */}
      <ol className="mt-6 space-y-5">
        {groupTurns(turns).map((g, i) => (
          <li key={i} className="grid grid-cols-[3.5rem_1fr] gap-3 sm:grid-cols-[4.5rem_1fr] sm:gap-5">
            <span className="num pt-0.5 text-right text-sm text-muted-foreground">{clock(g.start)}</span>
            <div className="max-w-[68ch] border-l border-border pl-4">
              <p className="text-sm font-semibold">{g.speaker}</p>
              <p className="mt-0.5">{g.parts.join(" ")}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Ask({ meetingId }: { meetingId: string }) {
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [q, setQ] = useState("");
  const ask = useMutation({
    mutationFn: (next: typeof messages) => callFn<{ answer: string }>("meeting-chat", { meetingId, messages: next }),
    onSuccess: (r) => setMessages((prev) => [...prev, { role: "assistant", content: r.answer }]),
    onError: (e: Error) => toast.error(e.message),
  });

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (!text || ask.isPending) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setQ("");
    ask.mutate(next);
  }

  return (
    <div className="mt-6">
      {messages.length === 0 && (
        <p className="text-muted-foreground">Pregunta lo que necesites de esta reunión. Por ejemplo: ¿qué precio se acordó?, ¿quién quedó a cargo del envío?</p>
      )}
      <div className="space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={clsx("max-w-[68ch] whitespace-pre-wrap", msg.role === "user" ? "font-medium" : "border-l-2 border-primary pl-4")}>
            {msg.content}
          </div>
        ))}
        {ask.isPending && <Spinner label="Pensando" />}
      </div>
      <form onSubmit={send} className="mt-6 flex gap-2">
        <label htmlFor="pregunta" className="sr-only">Pregunta</label>
        <Input id="pregunta" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe tu pregunta" maxLength={2000} />
        <Button type="submit" disabled={!q.trim()} aria-label="Preguntar">
          <Send aria-hidden />
        </Button>
      </form>
    </div>
  );
}
