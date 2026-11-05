import { adminClient, gateMeeting, pathBelongsToMeeting, recordingPath } from "../_shared/auth.ts";
import { jsonResponse, preflight } from "../_shared/http.ts";
import { RECORDINGS_BUCKET } from "../_shared/recording-storage.ts";

// Enlace firmado (1 hora) para ver o descargar la grabación de una reunión.
// El bucket es privado: sin este enlace nadie puede abrir los archivos.

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const gate = await gateMeeting(req);
  if (gate.response) return gate.response;
  const meeting = gate.meeting!;
  const db = adminClient();
  const { data } = await db.from("meetings").select("recording_url").eq("id", meeting.id).single();
  if (!data?.recording_url) return jsonResponse({ error: "Esta reunión no tiene grabación" }, 404);

  // Solo se firma una ruta dentro de la carpeta de ESTA reunión.
  const fromUrl = recordingPath(data.recording_url);
  if (!pathBelongsToMeeting(fromUrl, meeting)) {
    // Copia propia pendiente: el enlace temporal de Recall (vence en 7 días) sirve mientras tanto.
    if (/^https:\/\/[a-z0-9.-]*recall\.ai\//i.test(data.recording_url) || /amazonaws\.com\//i.test(data.recording_url)) {
      return jsonResponse({ signedUrl: data.recording_url, temporary: true });
    }
    return jsonResponse({ error: "La grabación no está disponible" }, 404);
  }
  const { data: signed, error } = await db.storage.from(RECORDINGS_BUCKET).createSignedUrl(fromUrl!, 3600);
  if (error || !signed?.signedUrl) return jsonResponse({ error: "No se pudo firmar el enlace" }, 500);
  return jsonResponse({ signedUrl: signed.signedUrl, expiresIn: 3600 });
});
