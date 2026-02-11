-- Helper RPC to set required Vault secrets (service_role only).
-- This avoids manual Dashboard steps while keeping secrets out of migrations.

create or replace function public.dexswipe_set_vault_secrets(project_url text, cron_secret text)
returns jsonb
language plpgsql
security definer
as $$
declare
  existing_project_id uuid;
  existing_cron_id uuid;
begin
  if project_url is null or length(project_url) = 0 then
    raise exception 'project_url is required';
  end if;
  if cron_secret is null or length(cron_secret) = 0 then
    raise exception 'cron_secret is required';
  end if;

  select id into existing_project_id from vault.secrets where name = 'project_url' limit 1;
  if existing_project_id is null then
    perform vault.create_secret(project_url, 'project_url', 'DexSwipe: project base URL');
  else
    perform vault.update_secret(existing_project_id, project_url, 'project_url', 'DexSwipe: project base URL');
  end if;

  select id into existing_cron_id from vault.secrets where name = 'dexswipe_cron_secret' limit 1;
  if existing_cron_id is null then
    perform vault.create_secret(cron_secret, 'dexswipe_cron_secret', 'DexSwipe: x-cron-secret header');
  else
    perform vault.update_secret(existing_cron_id, cron_secret, 'dexswipe_cron_secret', 'DexSwipe: x-cron-secret header');
  end if;

  return jsonb_build_object(
    'ok', true,
    'set', jsonb_build_object(
      'project_url', true,
      'dexswipe_cron_secret', true
    )
  );
end;
$$;

revoke all on function public.dexswipe_set_vault_secrets(text, text) from public;
grant execute on function public.dexswipe_set_vault_secrets(text, text) to service_role;

