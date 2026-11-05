-- Minuta: esquema inicial completo. Se aplica una vez sobre un proyecto de
-- Supabase vacío (supabase db push, o pegarlo en el SQL Editor).
--
-- Principios de seguridad:
--   * RLS en todas las tablas. Una persona ve sus reuniones, las que le
--     compartieron y, si es admin, todas.
--   * Los tokens de Google (calendar_connections) no se pueden leer desde la
--     app: solo las funciones (llave de servicio) los usan.
--   * Las grabaciones viven en un bucket privado; se ven con enlaces firmados
--     de 1 hora (función get-recording-url).
--   * Admin: los correos de bot_settings.admin_emails (ver supabase/setup.sql),
--     y solo cuando confirman su correo. Si no hay ninguno configurado, el
--     primer usuario con correo confirmado.
--   * Límites diarios por persona para bots e IA (controlan el gasto).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.meeting_status as enum ('scheduled', 'recording', 'processing', 'completed', 'failed', 'not_recorded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.app_role as enum ('admin', 'member');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.app_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

-- Ajustes de toda la instalación (una sola fila, id = 1). Los edita un admin en
-- la pantalla Ajustes.
create table if not exists public.bot_settings (
  id                           integer primary key default 1 check (id = 1),
  bot_name                     text not null default 'Minuta · toma notas',
  bot_image                    text,
  waiting_room_timeout         integer not null default 300,
  noone_joined_timeout         integer not null default 300,
  everyone_left_timeout        integer not null default 30,
  everyone_left_activate_after integer not null default 60,
  excluded_emails              text[] not null default '{}',
  skip_internal_meetings       boolean not null default false,
  internal_domain              text,
  allowed_email_domains        text[] not null default '{}',
  admin_emails                 text[] not null default '{}',
  summary_context              text,
  daily_bot_limit              integer not null default 15 check (daily_bot_limit >= 0),
  daily_ai_limit               integer not null default 60 check (daily_ai_limit >= 0),
  updated_at                   timestamptz not null default now()
);
insert into public.bot_settings (id) values (1) on conflict (id) do nothing;

comment on column public.bot_settings.allowed_email_domains is
  'Si no está vacío, solo pueden crear cuenta correos de estos dominios (ej: {miempresa.cl})';
comment on column public.bot_settings.admin_emails is
  'Correos que quedan como admin al confirmar su cuenta. Se definen en supabase/setup.sql antes del primer ingreso';
comment on column public.bot_settings.daily_bot_limit is
  'Máximo de bots mandados a mano por persona por día (la grabación automática no cuenta)';
comment on column public.bot_settings.daily_ai_limit is
  'Máximo de llamadas a la IA (resumir a mano, preguntas) por persona por día';
comment on column public.bot_settings.summary_context is
  'Texto que se agrega al prompt del resumen: quiénes somos, nombres propios, vocabulario';

create table if not exists public.calendar_connections (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null unique references auth.users(id) on delete cascade,
  provider                   text not null default 'google',
  access_token               text,
  refresh_token              text,
  token_expires_at           timestamptz,
  calendar_id                text,
  is_active                  boolean not null default true,
  auto_record_enabled        boolean not null default true,
  auto_record_minutes_before integer not null default 2 check (auto_record_minutes_before between 0 and 15),
  last_sync_at               timestamptz,
  last_error                 text,
  last_error_at              timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists public.meetings (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  title                   text not null default 'Reunión',
  meeting_url             text,
  meeting_type            text not null default 'virtual' check (meeting_type in ('virtual', 'presencial')),
  status                  public.meeting_status not null default 'scheduled',
  scheduled_at            timestamptz,
  scheduled_end_at        timestamptz,
  calendar_event_id       text,
  calendar_description    text,
  auto_record             boolean not null default false,
  attendees               jsonb not null default '[]'::jsonb,
  recall_bot_id           text,
  recording_url           text,
  duration_minutes        integer,
  not_recorded_reason     text,
  pipeline_error          text,
  transcript_completed_at timestamptz,
  transcript_segments     integer,
  summary                 jsonb,
  summary_status          text check (summary_status in ('running', 'done', 'failed', 'disabled', 'empty')),
  summary_error           text,
  summarized_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_meetings_user_scheduled on public.meetings (user_id, scheduled_at desc);
create index if not exists idx_meetings_recall_bot_id on public.meetings (recall_bot_id) where recall_bot_id is not null;
create index if not exists idx_meetings_status_open on public.meetings (status, scheduled_at)
  where status in ('scheduled', 'recording', 'processing');
create index if not exists idx_meetings_url on public.meetings (meeting_url);
create unique index if not exists uq_meetings_user_calendar_event on public.meetings (user_id, calendar_event_id)
  where calendar_event_id is not null;

create table if not exists public.meeting_assignments (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  assigned_to uuid not null references auth.users(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (meeting_id, assigned_to)
);
create index if not exists idx_meeting_assignments_user on public.meeting_assignments (assigned_to);

create table if not exists public.meeting_exclusions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  calendar_event_id text not null,
  created_at        timestamptz not null default now(),
  unique (user_id, calendar_event_id)
);

create table if not exists public.transcriptions (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references public.meetings(id) on delete cascade,
  speaker_name  text,
  speaker_id    text,
  content       text not null,
  start_time_ms integer not null default 0,
  end_time_ms   integer,
  created_at    timestamptz not null default now()
);
create index if not exists idx_transcriptions_meeting on public.transcriptions (meeting_id, start_time_ms, id);

-- Registro de la tubería: una fila por cosa que debe pasar una sola vez.
-- Ver supabase/functions/_shared/pipeline-events.ts.
create table if not exists public.pipeline_events (
  id          uuid primary key default gen_random_uuid(),
  event_key   text not null unique,
  kind        text not null,
  event_type  text,
  meeting_id  uuid references public.meetings(id) on delete cascade,
  bot_id      text,
  status      text not null default 'processing'
              check (status in ('processing', 'done', 'error', 'skipped', 'retryable')),
  attempts    integer not null default 1,
  detail      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  locked_at   timestamptz,
  finished_at timestamptz
);
create index if not exists idx_pipeline_events_meeting on public.pipeline_events (meeting_id);
create index if not exists idx_pipeline_events_open on public.pipeline_events (status, created_at desc)
  where status in ('processing', 'error', 'retryable');
create index if not exists idx_pipeline_events_kind_created on public.pipeline_events (kind, created_at desc);

-- Uso estimado (minutos de bot, transcripción, tokens de IA) para controlar costos.
create table if not exists public.usage_records (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users(id) on delete set null,
  meeting_id             uuid references public.meetings(id) on delete set null,
  service                text not null,
  period_month           text not null,
  recall_bot_seconds     integer not null default 0,
  recall_cost_usd        numeric(10, 4) not null default 0,
  transcription_seconds  integer not null default 0,
  transcription_cost_usd numeric(10, 4) not null default 0,
  ai_input_tokens        integer not null default 0,
  ai_output_tokens       integer not null default 0,
  created_at             timestamptz not null default now()
);
create index if not exists idx_usage_records_period on public.usage_records (period_month);
-- Un registro de bot y uno de transcripción de Recall por reunión (la tubería
-- puede intentar registrarlo dos veces; el segundo choca y se ignora).
create unique index if not exists uq_usage_recall_bot on public.usage_records (meeting_id)
  where service = 'recall';
create unique index if not exists uq_usage_recall_transcription on public.usage_records (meeting_id)
  where service = 'recall_transcription';

-- Tokens personales para conectar la app a Claude u otras IA (servidor MCP).
-- Solo se guarda el hash; el token se muestra una vez al crearlo.
create table if not exists public.personal_access_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,
  token_prefix text not null,
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_pat_user on public.personal_access_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Funciones
-- ---------------------------------------------------------------------------
-- Con sesión de persona solo responde sobre esa misma persona; las funciones
-- del servidor (llave de servicio, sin auth.uid()) pueden preguntar por cualquiera.
create or replace function public.is_admin(_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (_user_id = auth.uid() or auth.uid() is null)
     and exists (select 1 from public.user_roles where user_id = _user_id and role = 'admin');
$$;

-- Mismas reglas que RLS, con el usuario explícito (la usan RLS y las funciones).
-- Igual que is_admin: con sesión de persona solo responde sobre esa persona.
create or replace function public.can_read_meeting(_meeting_id uuid, _user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select _user_id is not null and (_user_id = auth.uid() or auth.uid() is null) and (
    exists (select 1 from public.meetings m where m.id = _meeting_id and m.user_id = _user_id)
    or exists (select 1 from public.meeting_assignments a where a.meeting_id = _meeting_id and a.assigned_to = _user_id)
    or public.is_admin(_user_id)
  );
$$;

-- Reuniones presenciales que creó la persona en las últimas 24 h (para el tope).
create or replace function public.presenciales_hoy()
returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from public.meetings m
   where m.user_id = auth.uid() and m.meeting_type = 'presencial'
     and m.created_at > now() - interval '1 day';
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_meetings_updated on public.meetings;
create trigger trg_meetings_updated before update on public.meetings
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_bot_settings_updated on public.bot_settings;
create trigger trg_bot_settings_updated before update on public.bot_settings
  for each row execute function public.touch_updated_at();

-- Al crear una cuenta: control de dominio, perfil y rol de member.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  allowed text[];
  domain  text;
begin
  select bs.allowed_email_domains into allowed from public.bot_settings bs where bs.id = 1;
  domain := lower(split_part(coalesce(new.email, ''), '@', 2));
  if coalesce(array_length(allowed, 1), 0) > 0
     and not exists (select 1 from unnest(allowed) d where lower(trim(d)) = domain) then
    raise exception 'Este correo no puede crear cuenta en esta instalación';
  end if;

  insert into public.profiles (user_id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (user_id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'member') on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin SOLO con el correo confirmado (pedir un enlace mágico crea la cuenta
-- antes de confirmar: sin esta regla, un extraño podía adelantarse).
--   * Si bot_settings.admin_emails tiene correos: esos son admin.
--   * Si está vacío: el primer usuario confirmado.
create or replace function public.promote_admin_on_confirm()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  admins text[];
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  select bs.admin_emails into admins from public.bot_settings bs where bs.id = 1;
  if coalesce(array_length(admins, 1), 0) > 0 then
    if exists (select 1 from unnest(admins) a where lower(trim(a)) = lower(new.email)) then
      insert into public.user_roles (user_id, role) values (new.id, 'admin') on conflict do nothing;
    end if;
  elsif not exists (select 1 from public.user_roles where role = 'admin') then
    insert into public.user_roles (user_id, role) values (new.id, 'admin') on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after insert or update of email_confirmed_at on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.promote_admin_on_confirm();

-- Crear un token: devuelve el texto UNA vez; se guarda solo su sha256.
create or replace function public.create_personal_access_token(p_name text, p_expires_days integer default 365)
returns table (id uuid, token text, prefix text, expires_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_token text;
  v_id    uuid;
  v_exp   timestamptz;
begin
  if v_uid is null then raise exception 'Sin sesión'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'El token necesita un nombre'; end if;
  if (select count(*) from public.personal_access_tokens t where t.user_id = v_uid and t.revoked_at is null) >= 10 then
    raise exception 'Máximo 10 tokens activos: revoca alguno';
  end if;
  v_token := 'mn_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := case when p_expires_days is null then null else now() + make_interval(days => least(p_expires_days, 730)) end;
  insert into public.personal_access_tokens (user_id, name, token_hash, token_prefix, expires_at)
  values (v_uid, left(trim(p_name), 80), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), left(v_token, 9), v_exp)
  returning personal_access_tokens.id into v_id;
  return query select v_id, v_token, left(v_token, 9), v_exp;
end;
$$;

create or replace function public.revoke_personal_access_token(p_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Sin sesión'; end if;
  update public.personal_access_tokens set revoked_at = now()
   where id = p_id and user_id = auth.uid() and revoked_at is null;
  return found;
end;
$$;

-- Secreto que pg_cron manda en la cabecera x-cron-secret (ver supabase/cron.sql).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'minuta_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'minuta_cron_secret',
      'Secreto que pg_cron manda en x-cron-secret a auto-record-scheduler'
    );
  end if;
end $$;

create or replace function public.verify_cron_secret(p_secret text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'minuta_cron_secret' and s.decrypted_secret = p_secret
  );
$$;

revoke all on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;
revoke all on function public.can_read_meeting(uuid, uuid) from public, anon;
grant execute on function public.can_read_meeting(uuid, uuid) to authenticated, service_role;
revoke all on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.promote_admin_on_confirm() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.presenciales_hoy() from public, anon;
revoke all on function public.create_personal_access_token(text, integer) from public, anon;
grant execute on function public.create_personal_access_token(text, integer) to authenticated;
revoke all on function public.revoke_personal_access_token(uuid) from public, anon;
grant execute on function public.revoke_personal_access_token(uuid) to authenticated;
grant execute on function public.presenciales_hoy() to authenticated;

-- ---------------------------------------------------------------------------
-- Permisos y RLS
-- ---------------------------------------------------------------------------
-- La llave anónima (pública) no lee ni escribe nada, tampoco en tablas futuras.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from anon;

alter table public.profiles             enable row level security;
alter table public.user_roles           enable row level security;
alter table public.bot_settings         enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.meetings             enable row level security;
alter table public.meeting_assignments  enable row level security;
alter table public.meeting_exclusions   enable row level security;
alter table public.transcriptions       enable row level security;
alter table public.pipeline_events      enable row level security;
alter table public.usage_records        enable row level security;
alter table public.personal_access_tokens enable row level security;

-- Por defecto, las personas solo leen. Lo que pueden escribir se abre abajo,
-- columna por columna. Todo lo demás lo escriben las funciones.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;

-- profiles
create policy "Ver mi perfil o, si soy admin, todos" on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin((select auth.uid()))));
create policy "Editar mi nombre" on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update (full_name) on public.profiles to authenticated;

-- user_roles
create policy "Ver mi rol o, si soy admin, todos" on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin((select auth.uid()))));
create policy "Admins cambian roles" on public.user_roles for all to authenticated
  using ((select public.is_admin((select auth.uid())))) with check ((select public.is_admin((select auth.uid()))));
grant insert, update, delete on public.user_roles to authenticated;

-- bot_settings
create policy "Todos leen los ajustes" on public.bot_settings for select to authenticated using (true);
create policy "Admins editan los ajustes" on public.bot_settings for update to authenticated
  using ((select public.is_admin((select auth.uid())))) with check ((select public.is_admin((select auth.uid()))));
grant update (bot_name, bot_image, excluded_emails, skip_internal_meetings, internal_domain,
              allowed_email_domains, admin_emails, summary_context, waiting_room_timeout, noone_joined_timeout,
              daily_bot_limit, daily_ai_limit)
  on public.bot_settings to authenticated;

-- calendar_connections: sin acceso a los tokens.
revoke select on public.calendar_connections from authenticated;
grant select (id, user_id, provider, calendar_id, is_active, auto_record_enabled, auto_record_minutes_before,
              last_sync_at, last_error, last_error_at, created_at, updated_at)
  on public.calendar_connections to authenticated;
grant update (auto_record_enabled, auto_record_minutes_before) on public.calendar_connections to authenticated;
create policy "Ver mi conexión de calendario" on public.calendar_connections for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Cambiar mi grabación automática" on public.calendar_connections for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- meetings
create policy "Ver reuniones propias, compartidas o todas si soy admin" on public.meetings for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.meeting_assignments a where a.meeting_id = meetings.id and a.assigned_to = (select auth.uid()))
    or (select public.is_admin((select auth.uid())))
  );
-- Las reuniones presenciales las crea la app; las virtuales, las funciones.
-- Con tope de 30 al día por persona.
create policy "Crear mis reuniones presenciales" on public.meetings for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and meeting_type = 'presencial'
    and status in ('recording', 'processing')
    and public.presenciales_hoy() < 30
  );
grant insert (user_id, title, meeting_type, status, scheduled_at) on public.meetings to authenticated;
create policy "Renombrar mis reuniones" on public.meetings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant update (title) on public.meetings to authenticated;
create policy "Borrar mis reuniones (o cualquiera si soy admin)" on public.meetings for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin((select auth.uid()))));
grant delete on public.meetings to authenticated;

-- meeting_assignments
create policy "Ver con quién se compartió" on public.meeting_assignments for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.can_read_meeting(meeting_id, (select auth.uid()))));

-- meeting_exclusions
create policy "Ver mis eventos excluidos" on public.meeting_exclusions for select to authenticated
  using (user_id = (select auth.uid()));

-- transcriptions
create policy "Ver la transcripción de reuniones que puedo ver" on public.transcriptions for select to authenticated
  using ((select public.can_read_meeting(meeting_id, (select auth.uid()))));

-- personal_access_tokens: cada persona ve los suyos, nunca el hash.
revoke select on public.personal_access_tokens from authenticated;
grant select (id, name, token_prefix, last_used_at, expires_at, revoked_at, created_at) on public.personal_access_tokens to authenticated;
create policy "Ver mis tokens" on public.personal_access_tokens for select to authenticated
  using (user_id = (select auth.uid()));

-- pipeline_events y usage_records: solo admins (para diagnosticar y ver costos).
create policy "Admins ven la tubería" on public.pipeline_events for select to authenticated
  using ((select public.is_admin((select auth.uid()))));
create policy "Admins ven el uso" on public.usage_records for select to authenticated
  using ((select public.is_admin((select auth.uid()))));

-- ---------------------------------------------------------------------------
-- Storage: grabaciones (bucket privado)
-- Ruta: {dueño}/{reunión}/recording.mp4 (bot) o audio.<ext> (presencial)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meeting-recordings', 'meeting-recordings', false, 524288000,
        array['audio/*', 'video/mp4', 'video/webm'])
on conflict (id) do update set public = false, allowed_mime_types = excluded.allowed_mime_types;

-- La app solo SUBE el audio de sus reuniones presenciales. Leer siempre es con
-- enlace firmado desde una función.
create policy "Subir audio de mis reuniones presenciales" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'meeting-recordings'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/audio\.(webm|ogg|mp3|m4a|mp4|wav)$'
    and exists (
      select 1 from public.meetings m
       where m.id::text = (storage.foldername(name))[2]
         and m.user_id = (select auth.uid())
         and m.meeting_type = 'presencial'
    )
  );
