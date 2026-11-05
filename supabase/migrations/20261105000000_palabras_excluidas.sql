-- Exclusión por palabras: un evento cuyo título, ubicación o descripción contenga
-- alguna de estas palabras nunca se graba (sin tildes ni mayúsculas). Sirve para
-- citas sin correo de la otra persona, y para saltar una reunión puntual con «[no grabar]».

alter table public.bot_settings
  add column if not exists excluded_keywords text[] not null default '{"[no grabar]"}';

comment on column public.bot_settings.excluded_keywords is
  'Palabras que excluyen un evento de la grabación automática si aparecen en el título, la ubicación o la descripción';

grant update (excluded_keywords) on public.bot_settings to authenticated;
