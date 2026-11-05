-- Grabación automática: pg_cron llama a auto-record-scheduler cada 5 minutos.
-- Se corre UNA vez en el SQL Editor de Supabase, DESPUÉS de aplicar la
-- migración y desplegar las funciones. Reemplaza TU_PROJECT_REF.
--
-- El secreto x-cron-secret lo creó la migración en Vault (minuta_cron_secret):
-- no hay que copiar ninguna llave a este archivo.

select cron.schedule(
  'minuta-auto-record',
  '*/5 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://TU_PROJECT_REF.supabase.co/functions/v1/auto-record-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'minuta_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  ) as request_id;
  $cmd$
);

-- Para ver que corre (pasados 5 minutos):
--   select status, detail->'bots_created' bots, detail->'skipped' saltados, error
--   from pipeline_events where kind = 'scheduler' order by created_at desc limit 5;
--
-- Para pausarlo:
--   select cron.unschedule('minuta-auto-record');
