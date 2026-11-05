import { CalendarCheck, FileText, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Wordmark } from "@/components/Logo";
import { Button, Card, Field, Input } from "@/components/ui";
import { BRAND } from "@/config/brand";
import { supabase } from "@/lib/supabase";

const POINTS = [
  { icon: CalendarCheck, text: "El bot entra solo a las videollamadas de tu calendario." },
  { icon: FileText, text: "Transcripción con quién dijo qué y en qué minuto." },
  { icon: Sparkles, text: "Resumen y compromisos listos al terminar." },
];

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<"google" | "email" | null>(null);

  async function google() {
    setBusy("google");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      toast.error("No se pudo entrar con Google. Revisa que el proveedor Google esté activo en Supabase.");
      setBusy(null);
    }
  }

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy("email");
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } });
    setBusy(null);
    if (error) toast.error(/crear cuenta|database error/i.test(error.message) ? "Este correo no puede crear cuenta aquí." : error.message);
    else setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="grid w-full max-w-4xl items-center gap-10 md:grid-cols-[1fr_24rem]">
        <div className="hidden md:block">
          <Wordmark className="text-xl" />
          <h1 className="mt-8 max-w-md text-[2.25rem]">Cada reunión, con su minuta lista.</h1>
          <p className="mt-3 max-w-md text-muted-foreground">{BRAND.tagline}</p>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <Card className="p-6 sm:p-8">
          <Wordmark className="text-lg md:hidden" />
          <h2 className="mt-6 md:mt-0">Entra a tu cuenta</h2>
          <p className="mt-1 text-sm text-muted-foreground">Con la cuenta de tu empresa.</p>

          <Button className="mt-6 w-full" onClick={google} loading={busy === "google"}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path fill="currentColor" d="M21.35 11.1H12v2.9h5.35c-.25 1.5-1.7 4.4-5.35 4.4-3.2 0-5.85-2.65-5.85-5.9S8.8 6.6 12 6.6c1.85 0 3.05.8 3.75 1.45l2.55-2.45C16.65 4.05 14.55 3 12 3 6.95 3 2.9 7.05 2.9 12.1S6.95 21.2 12 21.2c5.25 0 8.7-3.7 8.7-8.9 0-.6-.05-1-.15-1.2z" />
            </svg>
            Entrar con Google
          </Button>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> o con un enlace al correo <span className="h-px flex-1 bg-border" />
          </div>

          {sent ? (
            <p className="rounded-md bg-primary/10 p-4 text-sm">
              Te mandamos un enlace a <strong>{email}</strong>. Ábrelo en este mismo navegador.
            </p>
          ) : (
            <form onSubmit={magicLink} className="space-y-4">
              <Field label="Correo" htmlFor="email">
                <Input id="email" type="email" required autoComplete="email" placeholder="nombre@empresa.cl" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Button type="submit" variant="secondary" className="w-full" loading={busy === "email"}>
                Mandarme el enlace
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
