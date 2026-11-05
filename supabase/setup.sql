-- Primera configuración. Córrelo en el SQL Editor de Supabase DESPUÉS de
-- `supabase db push` y ANTES de que nadie entre a la app.
-- Reemplaza el dominio y el correo por los de tu empresa.

update public.bot_settings set
  -- Solo correos de estos dominios pueden crear cuenta.
  allowed_email_domains = '{miempresa.cl}',
  -- Estos correos quedan como admin cuando confirman su cuenta.
  admin_emails = '{nombre@miempresa.cl}',
  -- Dominio interno (reconoce reuniones internas e invitaciones externas).
  internal_domain = 'miempresa.cl'
where id = 1;

select allowed_email_domains, admin_emails, internal_domain from public.bot_settings;
