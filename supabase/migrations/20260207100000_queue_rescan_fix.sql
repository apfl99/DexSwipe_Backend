-- Fix: allow periodic re-scans.
-- Previously, the worker only dequeued (pending, failed) rows.
-- Completed rows with next_run_at in the past were never re-processed, so last_scanned_at would stop updating.

create or replace function public.dequeue_token_security_scans(batch_size integer default 20)
returns table(chain_id text, token_address text, attempts integer)
language sql
security definer
as $$
  with picked as (
    select q.chain_id, q.token_address
    from public.token_security_scan_queue q
    where q.status in ('pending', 'failed', 'completed')
      and q.next_run_at <= now()
    order by q.next_run_at asc
    limit batch_size
    for update skip locked
  )
  update public.token_security_scan_queue q
  set status = 'processing',
      locked_at = now(),
      updated_at = now(),
      last_error = null
  from picked
  where q.chain_id = picked.chain_id
    and q.token_address = picked.token_address
  returning q.chain_id, q.token_address, q.attempts;
$$;

