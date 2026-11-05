import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic, Square, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button, Field, Input, Card } from "@/components/ui";
import { callFn } from "@/lib/api";
import { audioExtension, clock } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { useAppInfo, useAuth } from "@/hooks/useAuth";

export default function Grabar() {
  const info = useAppInfo();
  return (
    <div className="space-y-10">
      <div>
        <h1>Grabar una reunión</h1>
        <p className="mt-1 text-muted-foreground">Para videollamadas que no están en tu calendario, o reuniones en persona.</p>
      </div>
      <SendBot />
      {info.data?.inPerson ? (
        <InPerson />
      ) : (
        info.isSuccess && (
          <p className="text-sm text-muted-foreground">
            Grabar reuniones presenciales se activa con DEEPGRAM_API_KEY (ver LEEME).
          </p>
        )
      )}
    </div>
  );
}

function SendBot() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const send = useMutation({
    mutationFn: () => callFn<{ meetingId: string }>("recall-bot", { action: "create_bot", meetingUrl: url.trim(), title: title.trim() }),
    onSuccess: (r) => {
      toast.success("El bot va en camino. Déjalo entrar si hay sala de espera.");
      qc.invalidateQueries({ queryKey: ["meetings"] });
      navigate(`/reunion/${r.meetingId}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-5">
      <h2>Mandar el bot a una videollamada</h2>
      <p className="mt-1 text-sm text-muted-foreground">Google Meet, Zoom, Teams o Webex. Entra en menos de un minuto.</p>
      <form
        className="mt-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <Field label="Enlace de la reunión" htmlFor="url">
          <Input id="url" required inputMode="url" placeholder="https://meet.google.com/abc-defg-hij" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Título (opcional)" htmlFor="titulo">
          <Input id="titulo" placeholder="Reunión con proveedor" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Button type="submit" loading={send.isPending}>
          Mandar el bot
        </Button>
      </form>
    </Card>
  );
}

function pickMime(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return options.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

function InPerson() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<"idle" | "recording" | "uploading">("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const meetingId = useRef<string | null>(null);
  const started = useRef(0);

  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => setElapsed(Date.now() - started.current), 1000);
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      clearInterval(t);
      window.removeEventListener("beforeunload", warn);
    };
  }, [phase]);

  async function createMeeting(status: "recording" | "processing"): Promise<string> {
    const { data, error } = await supabase
      .from("meetings")
      .insert({
        user_id: session!.user.id,
        title: title.trim() || "Reunión presencial",
        meeting_type: "presencial",
        status,
        scheduled_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) throw new Error("No se pudo crear la reunión");
    return data.id as string;
  }

  async function uploadAndTranscribe(id: string, blob: Blob, ext: string) {
    setPhase("uploading");
    const fileName = `audio.${ext}`;
    const { error } = await supabase.storage
      .from("meeting-recordings")
      .upload(`${session!.user.id}/${id}/${fileName}`, blob, {
        // Sin parámetros (";codecs=opus"): el bucket solo acepta tipos de audio.
        contentType: (blob.type || `audio/${ext}`).split(";")[0],
        upsert: false,
      });
    if (error) throw new Error(`No se pudo subir el audio: ${error.message}`);
    await callFn("transcribe-audio", { meetingId: id, fileName });
    qc.invalidateQueries({ queryKey: ["meetings"] });
    toast.success("Audio subido. La transcripción estará en unos minutos.");
    navigate(`/reunion/${id}`);
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      meetingId.current = await createMeeting("recording");
      rec.start(10_000);
      recorder.current = rec;
      started.current = Date.now();
      setElapsed(0);
      setPhase("recording");
    } catch (e) {
      toast.error(e instanceof DOMException ? "Permite el uso del micrófono en el navegador para grabar." : (e as Error).message);
    }
  }

  async function stop() {
    const rec = recorder.current;
    if (!rec || !meetingId.current) return;
    const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    await done;
    const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
    const ext = audioExtension(blob.type) ?? "webm";
    try {
      await uploadAndTranscribe(meetingId.current, blob, ext);
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("idle");
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const ext = audioExtension(file.type, file.name);
    if (!ext) return toast.error("Sube un audio: mp3, m4a, mp4, wav, ogg o webm.");
    if (file.size > 500 * 1024 * 1024) return toast.error("El archivo pesa más de 500 MB.");
    try {
      const id = await createMeeting("processing");
      await uploadAndTranscribe(id, file, ext);
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("idle");
    }
  }

  return (
    <Card className="p-5">
      <h2>Reunión presencial</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Graba con el micrófono de este equipo o sube un audio. Avisa a los presentes que estás grabando.
      </p>
      <div className="mt-5 space-y-4">
        <Field label="Título (opcional)" htmlFor="titulo-p">
          <Input id="titulo-p" placeholder="Reunión de planta" value={title} onChange={(e) => setTitle(e.target.value)} disabled={phase !== "idle"} />
        </Field>

        {phase === "recording" ? (
          <div className="flex flex-wrap items-center gap-4">
            <span className="num inline-flex items-center gap-2 text-lg font-semibold text-danger" aria-live="polite">
              <span className="rec-dot h-2.5 w-2.5 rounded-full bg-danger" aria-hidden /> {clock(elapsed)}
            </span>
            <Button variant="primary" onClick={stop}>
              <Square aria-hidden /> Terminar y transcribir
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="rec" onClick={start} loading={phase === "uploading"}>
              <Mic aria-hidden /> Empezar a grabar
            </Button>
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-4 font-medium hover:border-primary/60">
              <Upload className="size-4" aria-hidden /> Subir audio
              <input type="file" accept="audio/*,video/mp4" className="sr-only" disabled={phase !== "idle"} onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          </div>
        )}
        {phase === "recording" && (
          <p className="text-sm text-muted-foreground">No cierres esta pestaña ni bloquees el equipo hasta terminar.</p>
        )}
      </div>
    </Card>
  );
}
