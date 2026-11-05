# Minuta

> Open-source meeting note taker: a Recall.ai bot joins your calls, Supabase stores the transcript, and AI (optional) writes the minutes. Docs in Spanish.

Toma notas de tus reuniones. Un bot entra a tus videollamadas (Google Meet, Zoom, Teams, Webex), las graba, las transcribe y, si quieres, deja un resumen con los compromisos. También graba reuniones presenciales desde el teléfono o el computador.

Es software libre (licencia MIT) y corre en **tus propias cuentas**: tu base de datos en Supabase, tu cuenta de Recall.ai, tu Google. Nadie más ve tus reuniones.

## Qué hace

- **Grabación automática:** conectas tu Google Calendar y el bot entra solo a las videollamadas con otras personas. Puedes apagarlo para un evento puntual.
- **Grabación a mano:** pegas el enlace de una videollamada y el bot entra en menos de un minuto.
- **Reuniones presenciales:** grabas con el micrófono o subes un audio (opcional, con Deepgram).
- **Transcripción** con quién dijo qué y en qué minuto. Se descarga en `.txt`.
- **Resumen con IA** (opcional): puntos clave, compromisos con responsable y fecha, decisiones. Y un chat para preguntarle a la reunión.
- **Aviso a otras herramientas** (opcional): cuando una reunión queda lista, manda los datos a la URL que quieras (un CRM, Zapier, Make, n8n, una planilla).
- **Conectada a tu IA (MCP):** Claude, Cursor u otra IA pueden buscar tus reuniones, leer resúmenes y mandar el bot. Cada persona crea su token en Ajustes y copia la configuración lista.
- **Modo claro y oscuro, colores a elección:** y cambiar la marca completa es editar dos archivos.
- **Equipo:** cada persona ve sus reuniones; si dos del equipo están en la misma llamada, va un solo bot y ambas la ven. El admin ve todo.

## Cómo funciona

```
 Google Calendar ──(cada 5 min)──► auto-record-scheduler ──► Recall.ai manda el bot
                                                                     │
 App: "Mandar el bot" ──► recall-bot ───────────────────────────────┘
                                                                     │ graba
                                                                     ▼
 Recall avisa ──► recall-webhook ──► guarda transcripción y video (Supabase)
                                        │
                                        ▼
                         analyze-meeting (IA, opcional) ──► resumen
                                        │
                                        ▼
                         send-webhook (opcional) ──► tu CRM / Zapier / etc.

 Presencial: la app graba el audio ──► Storage ──► transcribe-audio (Deepgram) ──► mismo camino
```

Todo lo que puede fallar (Recall atrasado, Google sin responder, la IA caída) queda anotado y se reintenta solo cada 5 minutos. Ninguna reunión se procesa dos veces.

## Qué necesitas

| Servicio | Para qué | ¿Obligatorio? | Costo aproximado |
|---|---|---|---|
| [Supabase](https://supabase.com) | Base de datos, usuarios, archivos y funciones | Sí | Plan gratis alcanza para empezar |
| [Recall.ai](https://www.recall.ai) | El bot que entra a las videollamadas y transcribe | Sí (para videollamadas) | Se paga por hora de bot; revisa su página de precios |
| [Google Cloud](https://console.cloud.google.com) | Entrar con Google y leer el calendario | Sí (para grabación automática) | Gratis |
| IA: Gemini, OpenAI o Claude (Anthropic) | Resumen y chat | No | Centavos por reunión |
| [Deepgram](https://deepgram.com) | Transcribir reuniones presenciales | No | Se paga por minuto de audio |
| Vercel o Netlify | Publicar la app en internet | Para usarla fuera de tu computador | Plan gratis alcanza |

Herramientas en tu computador: [Node.js 20+](https://nodejs.org) y la [CLI de Supabase](https://supabase.com/docs/guides/cli).

## Instalación paso a paso

Toma alrededor de una hora la primera vez. Si usas un agente de IA (Claude Code u otro), abre esta carpeta con él y pídele: *"Ayúdame a instalar Minuta siguiendo el README"*. El archivo `CLAUDE.md` le explica todo. **Nunca le pegues llaves en el chat:** los secretos se cargan con `supabase secrets set` (paso 5), que corres tú.

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com). Anota la **referencia del proyecto** (Settings, General, Reference ID; algo como `abcdefghijklmnop`).
2. En esta carpeta:
   ```sh
   npm install
   npx supabase login
   npx supabase link --project-ref TU_PROJECT_REF
   npx supabase db push
   ```
   Eso crea las tablas, las reglas de seguridad y el lugar donde se guardan las grabaciones.
3. **Antes de que nadie entre:** abre `supabase/setup.sql`, pon el dominio de tu empresa y tu correo, y córrelo en el **SQL Editor** de Supabase. Así solo tu equipo puede crear cuenta y tú quedas como admin.
4. En **Authentication, Sign In / Providers, Email**, deja activado *Confirm email* (viene así). Nadie queda admin sin confirmar su correo.

### 2. Google (entrar con Google y leer el calendario)

1. En [Google Cloud Console](https://console.cloud.google.com) crea un proyecto.
2. **APIs y servicios, Biblioteca:** activa **Google Calendar API**.
3. **Pantalla de consentimiento de OAuth:** si tu empresa usa Google Workspace, elige **Interno** (solo gente de tu dominio, sin revisión de Google). Agrega el permiso `.../auth/calendar.readonly`.
4. **Credenciales, Crear credenciales, ID de cliente de OAuth, Aplicación web.** En *URI de redireccionamiento autorizados* agrega las dos:
   ```
   https://TU_PROJECT_REF.supabase.co/auth/v1/callback
   https://TU_PROJECT_REF.supabase.co/functions/v1/google-calendar?action=callback
   ```
5. Copia el **ID de cliente** y el **secreto del cliente**.
6. En Supabase: **Authentication, Providers, Google**: actívalo y pega el mismo ID y secreto.

### 3. Recall.ai (el bot)

1. Crea una cuenta en [recall.ai](https://www.recall.ai) y una **API key**. Fíjate en la **región** de tu cuenta (por ejemplo `us-west-2` o `us-east-1`).
2. En el panel de Recall, **Webhooks**, agrega un destino:
   ```
   https://TU_PROJECT_REF.supabase.co/functions/v1/recall-webhook
   ```
   con los eventos de bot (`bot.*`), grabación (`recording.*`) y transcripción (`transcript.*`).
3. Copia el **secreto de firma** de ese webhook (empieza con `whsec_`).

### 4. IA (opcional)

Elige un proveedor y crea una llave: [Google AI Studio](https://aistudio.google.com) (Gemini), [OpenAI](https://platform.openai.com) o [Anthropic](https://console.anthropic.com) (Claude). Sin IA la app igual graba y transcribe; solo no habrá resumen ni chat.

### 5. Secretos de las funciones

Corre esto en tu terminal con tus datos (no los guardes en ningún archivo):

```sh
npx supabase secrets set \
  RECALL_API_KEY=tu_llave_de_recall \
  RECALL_API_REGION=us-west-2 \
  RECALL_WEBHOOK_SECRET=whsec_xxx \
  GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=xxx \
  APP_URL=http://localhost:8080 \
  TRANSCRIPT_LANGUAGE=es \
  BOT_JOIN_MESSAGE="Hola, soy el asistente de notas. Esta reunión se está grabando para dejar un resumen."
```

Opcionales:

```sh
# IA (elige uno: gemini, openai o anthropic)
npx supabase secrets set AI_PROVIDER=anthropic AI_API_KEY=tu_llave AI_MODEL=nombre-del-modelo
# Reuniones presenciales
npx supabase secrets set DEEPGRAM_API_KEY=tu_llave
# Aviso a otras herramientas cuando una reunión queda lista
npx supabase secrets set OUTGOING_WEBHOOK_URL=https://... OUTGOING_WEBHOOK_SECRET=algo_largo_y_aleatorio
# Enlaces a la app en las respuestas del MCP y del webhook (pon la URL final cuando la publiques)
npx supabase secrets set APP_URL=https://notas.miempresa.cl
```

Los nombres de modelos cambian seguido: conviene poner `AI_MODEL` con uno vigente de tu proveedor.

### 6. Publicar las funciones y activar la grabación automática

```sh
npx supabase functions deploy
```

Después abre `supabase/cron.sql`, reemplaza `TU_PROJECT_REF` y córrelo en el **SQL Editor** de Supabase. Desde ahí, cada 5 minutos se revisan los calendarios.

### 7. La app

```sh
cp .env.example .env
# completa VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY (Supabase, Settings, API)
npm run dev
```

Abre <http://localhost:8080> y entra con el correo que pusiste en `setup.sql`: quedas como admin. Ve a **Ajustes** y:

- en *Contexto de la empresa* escribe a qué se dedican y los nombres de clientes y productos: los resúmenes mejoran mucho;
- revisa los *límites diarios* de bots e IA por persona (controlan el gasto);
- conecta tu Google Calendar.

### 8. Publicarla en internet

1. Sube la carpeta a un repositorio **privado** de GitHub y conéctalo a [Vercel](https://vercel.com) o [Netlify](https://netlify.com). Configura las dos variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`. Comando de build: `npm run build`; carpeta: `dist`. Las reglas de rutas ya vienen en `vercel.json` y `public/_redirects`.
2. Con la URL final (ej. `https://notas.miempresa.cl`):
   - `npx supabase secrets set APP_URL=https://notas.miempresa.cl`
   - Supabase, **Authentication, URL Configuration**: *Site URL* = esa URL, y agrégala a *Redirect URLs*.

## Probar que todo funciona

1. **Ajustes, Qué está encendido:** debe marcar Recall y Google Calendar.
2. **Grabar:** pega el enlace de una videollamada tuya de prueba y deja entrar al bot. Habla un minuto, sácalo con *Sacar al bot y terminar*. En unos minutos aparece la transcripción (y el resumen si hay IA).
3. **Calendario:** crea un evento con Meet, invitando a otra persona, que empiece en 10 minutos. En *Ajustes, Próximos 7 días* debe aparecer como que se graba.

Si algo no pasa, en el SQL Editor:

```sql
select event_key, status, attempts, error, created_at
from pipeline_events order by created_at desc limit 20;
```

Los registros de cada función están en Supabase, **Edge Functions, Logs**.

## Conectarla a Claude u otra IA (MCP)

Minuta trae un servidor [MCP](https://modelcontextprotocol.io) listo: no hay que instalar nada aparte.

1. En la app: **Ajustes, Conectar con Claude u otra IA, Crear token**.
2. Elige dónde lo usarás (Claude Code, Claude Desktop o Cursor) y aprieta **Copiar configuración**. Para Claude Code es un comando que se pega en la terminal; para los otros, un bloque que se pega en su archivo de configuración.
3. Pregúntale a tu IA, por ejemplo: *"¿Qué compromisos quedaron esta semana?"*, *"Resume la reunión con Distribuidora Sur"* o *"Manda el bot a https://meet.google.com/..."*.

Herramientas: `buscar_reuniones`, `ver_reunion`, `leer_transcripcion`, `compromisos_pendientes` y `mandar_bot`. La IA ve exactamente lo mismo que la persona dueña del token. Los tokens vencen al año y se revocan en el mismo lugar.

Cualquier otro cliente MCP: URL `https://TU_PROJECT_REF.supabase.co/functions/v1/mcp` con la cabecera `Authorization: Bearer <token>`. (El conector de claude.ai web pide OAuth, que esta versión no trae: usa Claude Desktop o Claude Code.)

## Cambiar colores, marca y logo

Todo el look sale de dos archivos; los componentes nunca tienen colores escritos a mano.

| Qué | Dónde |
|---|---|
| Nombre, frase de bienvenida, color de fábrica, logo propio | `src/config/brand.ts` |
| Todos los colores (claro y oscuro), letra y redondeo | `src/theme/theme.css` |
| Agregar una paleta nueva para elegir en Ajustes | Un bloque `[data-color="..."]` en `theme.css` y una línea en `COLOR_OPTIONS` de `brand.ts` |
| Logo propio | Pon el archivo en `public/` (ej. `public/logo.svg`) y su ruta en `logoUrl` de `brand.ts`. También reemplaza `public/favicon.svg` |

Ejemplo: para usar el azul de tu empresa `#0B5FFF`, conviértelo a HSL (cualquier conversor "hex to hsl": `219 100% 52%`) y ponlo en `--primary` dentro de `:root` en `theme.css`.

Cada persona puede elegir además modo claro, oscuro o del sistema, y una de las paletas, en **Ajustes, Apariencia** (se guarda en su navegador).

## Adaptarla

| Quiero... | Dónde |
|---|---|
| Sin IA | No configures `AI_PROVIDER`. Graba y transcribe igual. |
| Cambiar el proveedor de IA | `AI_PROVIDER` y `AI_API_KEY`. El código está en `supabase/functions/_shared/ai.ts`. |
| Cambiar cómo resume | El prompt está en `supabase/functions/_shared/summary.ts`. Para lo propio de la empresa basta con *Ajustes, Contexto de la empresa*. |
| Mandar las reuniones a mi CRM u otra herramienta | `OUTGOING_WEBHOOK_URL`. Formato y firma en `supabase/functions/_shared/outgoing-webhook.ts`. |
| No grabar ciertas reuniones | *Ajustes*: reuniones internas, correos excluidos, o apagar un evento puntual. Las invitaciones de afuera que no aceptaste no se graban. Reglas en `_shared/calendar-filter.ts`. |
| Controlar el gasto | *Ajustes*: bots a mano y usos de IA por persona al día. El detalle de uso está en la tabla `usage_records`. |
| Otro idioma | `TRANSCRIPT_LANGUAGE` (ej. `en`, `pt`). |
| Cambiar colores o nombre | Ver "Cambiar colores, marca y logo" arriba. El nombre del bot en la llamada, en *Ajustes*. |

## Pruebas

```sh
npm test               # formato en la app
npm run test:db        # reglas de seguridad de la base (RLS), sin necesitar Supabase
npm run test:functions # tubería de grabación, IA, firmas (requiere Deno)
npm run check:secrets  # que no haya llaves en el código
```

## Seguridad y privacidad

Lee [SEGURIDAD.md](SEGURIDAD.md). En corto: grabar personas exige avisarles (en Chile, la Ley 21.719 de datos personales). Por eso el bot puede saludar en el chat avisando que graba (`BOT_JOIN_MESSAGE`) y lleva un nombre visible. Las grabaciones viven en un espacio privado de tu Supabase y solo se abren con enlaces que vencen en una hora.

## Origen

Minuta nace de BB8, el sistema interno de grabación de reuniones de [Makana](https://www.makana.cl). Esta versión deja solo el núcleo general (grabación, transcripción y resumen) y no incluye nada propio de Makana.

## Licencia

MIT. Ver [LICENSE](LICENSE).
