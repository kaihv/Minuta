# Seguridad y privacidad

Minuta guarda conversaciones de trabajo: precios, nombres, decisiones. Este documento dice qué protege la instalación tal como viene y qué te toca a ti.

## Dónde están los datos

| Qué | Dónde | Quién lo ve |
|---|---|---|
| Reuniones, transcripciones, resúmenes | Tu base de datos en Supabase | Quien creó la reunión, a quien se le compartió y los admins |
| Video y audio | Bucket privado `meeting-recordings` en tu Supabase | Igual que arriba, con enlaces firmados que vencen en 1 hora |
| Copia temporal del video | Recall.ai | Se borra sola a los 7 días |
| Texto de la reunión al resumir | Tu proveedor de IA (si lo activaste) | Según las condiciones de ese proveedor; revisa que no use tus datos para entrenar |
| Tokens personales del MCP | Tabla `personal_access_tokens` | Solo se guarda su huella (sha256); el token se muestra una vez. Vencen al año y se revocan en Ajustes |
| Tokens de Google Calendar | Tabla `calendar_connections` | Solo las funciones del servidor. La app no puede leerlos (permisos por columna) |

## Lo que ya viene protegido

- **Reglas por fila (RLS) en todas las tablas.** Una persona no puede leer reuniones ajenas aunque conozca el id. Hay pruebas automáticas: `npm run test:db`.
- **Admin solo con correo confirmado** y solo los correos de `admin_emails` (`supabase/setup.sql`). Pedir un enlace mágico no basta para quedar admin.
- **Límites diarios por persona** de bots manuales y usos de IA (*Ajustes*), para que una cuenta no pueda gastar los créditos sin tope. Volver a resumir solo lo puede el dueño de la reunión o un admin.
- **Las personas no escriben campos sensibles.** Desde la app solo se puede crear una reunión presencial propia, renombrar y borrar las propias. Estados, grabaciones y bots los escriben las funciones.
- **La llave pública (anon) no lee nada.** Va en el navegador por diseño; sin sesión no da acceso a ninguna tabla.
- **Webhook de Recall firmado.** Sin `RECALL_WEBHOOK_SECRET` la función rechaza los avisos.
- **OAuth de Google con `state` firmado** que vence en 15 minutos, y solo se acepta la cuenta de Google que coincide con el correo de la persona. Solo lectura del calendario.
- **El cron se autentica** con un secreto guardado en Vault (lo crea la migración; no hay que copiarlo a ningún lado).
- **Prompts protegidos:** la transcripción se trata como dato, no como instrucción, y a los compromisos se les quitan enlaces y correos antes de mandarlos a otras herramientas.
- **Servidor MCP con token personal:** la IA conectada ve solo lo que ve la dueña del token, y `mandar_bot` respeta el mismo tope diario. Si un token se filtra, se revoca en *Ajustes* y deja de funcionar al instante.
- **Webhook de salida** solo a `https` público y firmado con HMAC-SHA256 (cabecera `X-Minuta-Signature`).
- **Encabezados de seguridad** en `vercel.json` y `public/_headers` (CSP, sin iframes). Si usas un dominio propio para Supabase, agrégalo a `connect-src`.
- **Sin secretos en el código.** `npm run check:secrets` lo revisa y corre en cada push (GitHub Actions).

## Lo que te toca antes de usarla en serio

1. **Corre `supabase/setup.sql` antes del primer ingreso** con tu dominio y tu correo de admin. Sin eso, cualquiera con el enlace puede crear una cuenta (no verá reuniones ajenas, pero podría mandar bots dentro de los límites diarios). Si usas Google Workspace, deja la pantalla de consentimiento de Google como **Interna**.
2. **Avisa que grabas.** Configura `BOT_JOIN_MESSAGE` para que el bot lo diga en el chat al entrar, y usa un nombre de bot claro. En reuniones presenciales, avisa en voz alta. En Chile aplica la Ley 21.719 de protección de datos personales; si hay dudas sobre consentimiento, consúltalo con un abogado.
3. **Los secretos solo con `supabase secrets set`.** Nunca en `.env`, en el código ni en un chat. El `.env` del frontend solo lleva la URL y la llave pública.
4. **Repositorio privado** si lo subes a GitHub con tu configuración.
5. **Revisa el uso y los costos:** la tabla `usage_records` registra minutos de bot, de transcripción y tokens de IA por reunión (solo admins la ven).
6. **Activa la verificación en dos pasos** en Supabase, Recall, Google Cloud y tu proveedor de IA.

## Borrar datos

- Borrar una reunión desde la app elimina su transcripción, resumen y registros. El archivo de video o audio queda en Storage: bórralo en Supabase, **Storage, meeting-recordings, {persona}/{reunión}**.
- Para dejar de grabar a alguien: *Ajustes, Nunca grabar reuniones con estos correos*.
- Para borrar todo: elimina el proyecto de Supabase y las grabaciones en Recall.

## Reportar un problema de seguridad

Si encuentras una falla, no la publiques en un issue abierto: escribe a quien mantiene tu copia del repositorio.
