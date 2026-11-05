// Valida la migración de Minuta en PGlite con stubs mínimos de Supabase
// (auth, storage, vault, roles) y prueba las reglas de RLS.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const migrationPath = process.argv[2] ?? new URL("../migrations/20261104000000_esquema_inicial.sql", import.meta.url).pathname;
let sql = readFileSync(migrationPath, "utf8");
// Extensiones que PGlite no trae (en Supabase existen).
sql = sql.replace(/create extension if not exists (pgcrypto|pg_net|pg_cron)[^;]*;/g, "");

const db = new PGlite();
const stubs = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage; create schema vault; create schema extensions;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
create function extensions.gen_random_bytes(n int) returns bytea language sql as $$ select substring(decode(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 'hex') from 1 for n) $$;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant insert, select on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
grant execute on function storage.foldername(text) to authenticated;
create table vault.secrets (name text primary key, secret text, description text);
create function vault.create_secret(s text, n text, d text) returns uuid language sql as $$ insert into vault.secrets values (n, s, d); select gen_random_uuid() $$;
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
-- Lo que Supabase hace por defecto con las tablas nuevas de public:
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;
await db.exec(stubs);
await db.exec(sql);
// Simula los grants por defecto de Supabase para tablas creadas por la migración
// (Supabase da ALL a anon/authenticated y la migración los recorta). Acá se aplica
// en el orden real: primero el grant por defecto y luego se re-ejecuta el recorte.
console.log("migración aplicada OK");

let fails = 0;
const check = async (label, fn) => {
  try { await fn(); console.log("  ok ", label); }
  catch (e) { fails++; console.log("  FALLA", label, "->", e.message); }
};
const as = async (uid, q, params) => {
  await db.exec(`reset role; select set_config('test.uid', '${uid ?? ""}', false); set role ${uid ? "authenticated" : "anon"};`);
  try { return await db.query(q, params); } finally { await db.exec("reset role;"); }
};
const expectError = async (p, re) => {
  try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error("error inesperado: " + e.message); return; }
  throw new Error("se esperaba error");
};

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const X = "44444444-4444-4444-8444-444444444444";
await check("una cuenta sin confirmar no queda admin aunque sea la primera", async () => {
  await db.exec(`insert into auth.users (id, email) values ('${X}', 'extrano@otro.example')`);
  const r = await db.query(`select role from public.user_roles where user_id = '${X}'`);
  if (r.rows.map((x) => x.role).join() !== "member") throw new Error(JSON.stringify(r.rows));
  await db.exec(`delete from auth.users where id = '${X}'`);
  await db.exec(`delete from public.user_roles where user_id = '${X}'`);
  await db.exec(`delete from public.profiles where user_id = '${X}'`);
});

await db.exec(`insert into auth.users (id, email) values ('${A}', 'Admin@MiEmpresa.example'), ('${B}', 'b@miempresa.example'), ('${C}', 'c@miempresa.example')`);
// A confirma su correo primero: queda admin. B y C confirman después.
await db.exec(`update auth.users set email_confirmed_at = now() where id = '${A}'`);
await db.exec(`update auth.users set email_confirmed_at = now() where id in ('${B}', '${C}')`);

await check("admin_emails: solo esos correos quedan admin al confirmar", async () => {
  const Y = "55555555-5555-4555-8555-555555555555";
  const Z = "66666666-6666-4666-8666-666666666666";
  await db.exec(`update public.bot_settings set admin_emails = '{jefa@miempresa.example}'`);
  await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${Y}', 'Jefa@MiEmpresa.example', now()), ('${Z}', 'otro@miempresa.example', now())`);
  const r = await db.query(`select user_id, role from public.user_roles where user_id in ('${Y}', '${Z}') and role = 'admin'`);
  if (r.rows.length !== 1 || r.rows[0].user_id !== Y) throw new Error(JSON.stringify(r.rows));
  await db.exec(`update public.bot_settings set admin_emails = '{}'`);
  await db.exec(`delete from auth.users where id in ('${Y}', '${Z}')`);
  await db.exec(`delete from public.user_roles where user_id in ('${Y}', '${Z}')`);
  await db.exec(`delete from public.profiles where user_id in ('${Y}', '${Z}')`);
});

await check("primer usuario confirmado admin, el resto member, perfil en minúsculas", async () => {
  const r = await db.query(`select p.email, bool_or(r.role = 'admin') admin from public.profiles p join public.user_roles r using (user_id) group by p.email order by p.email`);
  const got = r.rows.map((x) => `${x.email}:${x.admin ? "admin" : "member"}`).join(",");
  if (got !== "admin@miempresa.example:admin,b@miempresa.example:member,c@miempresa.example:member") throw new Error(got);
});

await check("dominios permitidos bloquean otros correos", async () => {
  await db.exec(`update public.bot_settings set allowed_email_domains = '{miempresa.example}'`);
  await expectError(db.exec(`insert into auth.users (email) values ('x@gmail.com')`), /no puede crear cuenta/);
  await db.exec(`insert into auth.users (email) values ('d@MIEMPRESA.example')`);
  await db.exec(`update public.bot_settings set allowed_email_domains = '{}'`);
});

const M_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M_C = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
await db.exec(`insert into public.meetings (id, user_id, title) values ('${M_B}', '${B}', 'de B'), ('${M_C}', '${C}', 'de C')`);
await db.exec(`insert into public.transcriptions (meeting_id, content) values ('${M_B}', 'hola B'), ('${M_C}', 'hola C')`);

await check("cada persona ve solo sus reuniones; admin ve todas", async () => {
  const b = await as(B, `select title from public.meetings order by title`);
  if (b.rows.map((r) => r.title).join() !== "de B") throw new Error(JSON.stringify(b.rows));
  const a = await as(A, `select count(*)::int n from public.meetings`);
  if (a.rows[0].n !== 2) throw new Error("admin ve " + a.rows[0].n);
  const t = await as(B, `select content from public.transcriptions`);
  if (t.rows.map((r) => r.content).join() !== "hola B") throw new Error(JSON.stringify(t.rows));
});

await check("compartir con meeting_assignments da acceso a reunión y transcripción", async () => {
  await db.exec(`insert into public.meeting_assignments (meeting_id, assigned_to, assigned_by) values ('${M_C}', '${B}', '${C}')`);
  const b = await as(B, `select count(*)::int n from public.meetings`);
  const t = await as(B, `select count(*)::int n from public.transcriptions`);
  if (b.rows[0].n !== 2 || t.rows[0].n !== 2) throw new Error(`${b.rows[0].n}/${t.rows[0].n}`);
  await db.exec(`delete from public.meeting_assignments`);
});

await check("la llave anónima no lee nada", async () => {
  await expectError(as(null, `select * from public.meetings`), /permission denied/);
  await expectError(as(null, `select * from public.bot_settings`), /permission denied/);
});

await db.exec(`insert into public.calendar_connections (user_id, access_token, refresh_token, calendar_id) values ('${B}', 'TOKEN-SECRETO', 'REFRESH-SECRETO', 'b@miempresa.example')`);
await check("los tokens de Google no se pueden leer desde la app", async () => {
  await expectError(as(B, `select access_token from public.calendar_connections`), /permission denied/);
  await expectError(as(B, `select * from public.calendar_connections`), /permission denied/);
  const ok = await as(B, `select calendar_id, auto_record_enabled from public.calendar_connections`);
  if (ok.rows.length !== 1) throw new Error("no ve su conexión");
  const other = await as(C, `select calendar_id from public.calendar_connections`);
  if (other.rows.length !== 0) throw new Error("C ve la conexión de B");
});

await check("puede apagar su grabación automática pero no tocar tokens", async () => {
  await as(B, `update public.calendar_connections set auto_record_enabled = false where user_id = '${B}'`);
  await expectError(as(B, `update public.calendar_connections set refresh_token = 'x'`), /permission denied/);
});

await check("crear reunión presencial sí; virtual o a nombre de otro no", async () => {
  await as(B, `insert into public.meetings (user_id, title, meeting_type, status) values ('${B}', 'Presencial', 'presencial', 'recording')`);
  await expectError(as(B, `insert into public.meetings (user_id, title, meeting_type, status) values ('${B}', 'x', 'virtual', 'recording')`), /row-level security/);
  await expectError(as(B, `insert into public.meetings (user_id, title, meeting_type, status) values ('${C}', 'x', 'presencial', 'recording')`), /row-level security/);
  await expectError(as(B, `insert into public.meetings (user_id, title, meeting_type, status, recall_bot_id) values ('${B}', 'x', 'presencial', 'recording', 'b')`), /permission denied/);
});

await check("renombrar la propia sí; cambiar estado o tocar la de otro no", async () => {
  await as(B, `update public.meetings set title = 'Nuevo' where id = '${M_B}'`);
  await expectError(as(B, `update public.meetings set status = 'completed' where id = '${M_B}'`), /permission denied/);
  const r = await as(B, `update public.meetings set title = 'hack' where id = '${M_C}' returning id`);
  if (r.rows.length !== 0) throw new Error("renombró la de otro");
});

await check("ajustes: todos leen, solo admin edita", async () => {
  await as(B, `select bot_name from public.bot_settings`);
  const r = await as(B, `update public.bot_settings set bot_name = 'x' returning id`);
  if (r.rows.length !== 0) throw new Error("member editó ajustes");
  const a = await as(A, `update public.bot_settings set bot_name = 'Bot de prueba' returning id`);
  if (a.rows.length !== 1) throw new Error("admin no pudo editar");
});

await check("is_admin y can_read_meeting no responden sobre otras personas", async () => {
  const a = await as(B, `select public.is_admin('${A}') v`);
  if (a.rows[0].v !== false) throw new Error("B averiguó que A es admin");
  const c = await as(B, `select public.can_read_meeting('${M_C}', '${C}') v`);
  if (c.rows[0].v !== false) throw new Error("B averiguó acceso de C");
  const self = await as(A, `select public.is_admin('${A}') v`);
  if (self.rows[0].v !== true) throw new Error("A no se reconoce admin");
  await expectError(as(null, `select public.is_admin('${A}')`), /permission denied/);
});

await check("un member no se puede hacer admin", async () => {
  await expectError(as(B, `insert into public.user_roles (user_id, role) values ('${B}', 'admin')`), /row-level security/);
});

await check("subir audio solo a la carpeta de su reunión presencial", async () => {
  const pres = (await db.query(`select id from public.meetings where title = 'Presencial'`)).rows[0].id;
  await as(B, `insert into storage.objects (bucket_id, name) values ('meeting-recordings', '${B}/${pres}/audio.webm')`);
  await expectError(as(B, `insert into storage.objects (bucket_id, name) values ('meeting-recordings', '${C}/${pres}/audio.webm')`), /row-level security/);
  await expectError(as(B, `insert into storage.objects (bucket_id, name) values ('meeting-recordings', '${B}/${M_B}/audio.webm')`), /row-level security/);
  await expectError(as(B, `insert into storage.objects (bucket_id, name) values ('meeting-recordings', '${B}/${pres}/otro.exe')`), /row-level security/);
});

await check("tope diario de reuniones presenciales", async () => {
  await db.exec(`insert into public.meetings (user_id, title, meeting_type, status) select '${C}', 'x', 'presencial', 'processing' from generate_series(1, 30)`);
  await expectError(as(C, `insert into public.meetings (user_id, title, meeting_type, status) values ('${C}', 'una más', 'presencial', 'recording')`), /row-level security/);
});

await check("tokens MCP: se crean una vez, se guarda solo el hash, cada uno ve los suyos", async () => {
  const r = await as(B, `select * from public.create_personal_access_token('Claude Code')`);
  const tok = r.rows[0].token;
  if (!/^mn_[0-9a-f]{64}$/.test(tok)) throw new Error("formato " + tok);
  const stored = (await db.query(`select token_hash from public.personal_access_tokens where user_id = '${B}'`)).rows[0].token_hash;
  const { createHash } = await import("node:crypto");
  if (stored !== createHash("sha256").update(tok).digest("hex")) throw new Error("hash distinto al de Deno");
  await expectError(as(B, `select token_hash from public.personal_access_tokens`), /permission denied/);
  const mine = await as(B, `select name from public.personal_access_tokens`);
  const theirs = await as(C, `select name from public.personal_access_tokens`);
  if (mine.rows.length !== 1 || theirs.rows.length !== 0) throw new Error(`${mine.rows.length}/${theirs.rows.length}`);
  const id = r.rows[0].id;
  const notMine = await as(C, `select public.revoke_personal_access_token('${id}') v`);
  if (notMine.rows[0].v !== false) throw new Error("C revocó el token de B");
  const ok = await as(B, `select public.revoke_personal_access_token('${id}') v`);
  if (ok.rows[0].v !== true) throw new Error("B no pudo revocar");
  await expectError(as(null, `select * from public.create_personal_access_token('x')`), /permission denied/);
});

await check("verify_cron_secret: correcto sí, vacío o incorrecto no", async () => {
  const s = (await db.query(`select secret from vault.secrets where name = 'minuta_cron_secret'`)).rows[0].secret;
  const ok = (await db.query(`select public.verify_cron_secret($1) v`, [s])).rows[0].v;
  const bad = (await db.query(`select public.verify_cron_secret('x') v`)).rows[0].v;
  const empty = (await db.query(`select public.verify_cron_secret('') v`)).rows[0].v;
  if (!ok || bad || empty) throw new Error(`${ok}/${bad}/${empty}`);
  await expectError(as(B, `select public.verify_cron_secret('x')`), /permission denied/);
});

await check("uso de Recall: un registro por reunión", async () => {
  await db.exec(`insert into public.usage_records (meeting_id, service, period_month, recall_bot_seconds) values ('${M_B}', 'recall', '2026-11', 60)`);
  await expectError(db.exec(`insert into public.usage_records (meeting_id, service, period_month, recall_bot_seconds) values ('${M_B}', 'recall', '2026-11', 60)`), /duplicate key/);
});

console.log(fails ? `\n${fails} FALLAS` : "\nTodo OK");
process.exit(fails ? 1 : 0);
