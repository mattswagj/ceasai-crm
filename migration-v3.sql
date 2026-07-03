-- ============================================================
-- CeasAI CRM — Migration v3
-- Adds: lead pipeline stages, follow-up tracking columns,
--       bulk email (campaigns), suppression/unsubscribe,
--       email send-log (email_events), + RLS.
-- 100% idempotent & non-destructive. Safe to re-run.
-- Run in Supabase Dashboard -> SQL Editor (NOT the MCP).
-- ============================================================

-- ---------- 1. Lead pipeline stage vocabulary ----------
-- Reuse contacts.status as the pipeline stage.
-- New -> Contacted -> Replied -> Meeting -> Proposal -> Won -> Lost
-- Migrate legacy values without wiping anything.
update public.contacts set status = 'Replied' where status = 'Qualified';
update public.contacts set status = 'Won'     where status = 'Customer';

-- ---------- 2. Follow-up / response tracking columns ----------
alter table public.contacts add column if not exists last_contacted_at timestamptz;
alter table public.contacts add column if not exists next_followup_at  date;
alter table public.contacts add column if not exists last_reply_at      timestamptz;

-- ---------- 3. Email / compliance columns on contacts ----------
alter table public.contacts add column if not exists unsubscribed      boolean not null default false;
alter table public.contacts add column if not exists unsubscribed_at   timestamptz;
alter table public.contacts add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
alter table public.contacts add column if not exists email_status      text;   -- valid / invalid / bounced (null = unknown)
alter table public.contacts add column if not exists last_emailed_at   timestamptz;
alter table public.contacts add column if not exists email_confidence  int;    -- Hunter score 0-100
alter table public.contacts add column if not exists email_source      text;   -- hunter / manual / import

create unique index if not exists contacts_unsub_token_idx on public.contacts(unsubscribe_token);

-- ---------- 3b. Enrichment cache (avoid re-spending Hunter credits per domain) ----------
create table if not exists public.enrichment_cache (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  cache_key   text not null,          -- e.g. 'domain:acme.com' or 'find:acme.com|jane|doe'
  domain      text,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create unique index if not exists enrichment_cache_key_idx on public.enrichment_cache(org_id, cache_key);

-- Hunter key readiness flag (flipped true once the secret is set server-side)
alter table public.orgs add column if not exists enrich_provider text; -- 'hunter' | null

-- ---------- 4. Campaigns (a batch/bulk send) ----------
create table if not exists public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  owner_id     uuid references auth.users(id) on delete set null,
  name         text not null default 'Untitled campaign',
  subject      text,
  body         text,
  template_id  uuid references public.templates(id) on delete set null,
  status       text not null default 'draft',  -- draft / queued / sending / sent / partial
  total        int  not null default 0,
  sent_count   int  not null default 0,
  failed_count int  not null default 0,
  daily_cap    int  not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists campaigns_org_idx on public.campaigns(org_id);

-- ---------- 5. Email send-log (one row per recipient per send) ----------
create table if not exists public.email_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  campaign_id  uuid references public.campaigns(id) on delete set null,
  contact_id   uuid references public.contacts(id) on delete set null,
  to_email     text,
  subject      text,
  template_id  uuid references public.templates(id) on delete set null,
  status       text not null default 'queued', -- queued / sent / failed / bounced / opened / replied
  provider     text,                            -- e.g. 'resend'
  provider_id  text,                            -- Resend message id
  error        text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  opened_at    timestamptz,
  replied_at   timestamptz
);
create index if not exists email_events_org_idx      on public.email_events(org_id);
create index if not exists email_events_campaign_idx on public.email_events(campaign_id);
create index if not exists email_events_contact_idx  on public.email_events(contact_id);

-- ---------- 6. Org-level sending settings (provider / from / address) ----------
alter table public.orgs add column if not exists from_name       text;
alter table public.orgs add column if not exists from_email      text;   -- must be on a Resend-verified domain
alter table public.orgs add column if not exists reply_to        text;
alter table public.orgs add column if not exists mailing_address text;   -- physical address (CAN-SPAM compliance)
alter table public.orgs add column if not exists email_provider  text;   -- 'resend' | null
alter table public.orgs add column if not exists daily_cap       int not null default 100;
alter table public.orgs add column if not exists provider_ready  boolean not null default false; -- flipped true when key is set server-side

-- ---------- 7. Enable RLS on new tables ----------
alter table public.campaigns        enable row level security;
alter table public.email_events     enable row level security;
alter table public.enrichment_cache enable row level security;

-- Org-scoped access for authenticated members
do $$
declare t text;
begin
  foreach t in array array['campaigns','email_events','enrichment_cache']
  loop
    execute format('drop policy if exists "org members all %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "org members all %1$s" on public.%1$s
        for all to authenticated
        using (org_id = public.current_org_id())
        with check (org_id = public.current_org_id());
    $f$, t);
  end loop;
end$$;

-- ---------- 8. Grants ----------
revoke all on public.campaigns, public.email_events, public.enrichment_cache from anon;
grant select, insert, update, delete on public.campaigns, public.email_events, public.enrichment_cache to authenticated;

-- done.
