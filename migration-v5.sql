-- ============================================================
-- CeasAI CRM — Migration v5 (Simplify + Mindbody segmentation)
-- Adds the columns the simplified app needs:
--   contacts.company        (business name, so the SMTP edge fn personalizes {{business}})
--   contacts.business_type  (clean fitness/wellness segment tag)
--   contacts.state          (segment by state)
--   contacts.instagram      (IG handle for the DM Center)
--   contacts.website        (source link)
--   orgs.responses_count    (simple manual "Responses received" counter)
-- 100% idempotent & non-destructive. Safe to re-run.
-- Run in Supabase Dashboard -> SQL Editor (NOT the MCP).
-- ============================================================

alter table public.contacts add column if not exists company       text;
alter table public.contacts add column if not exists business_type text;
alter table public.contacts add column if not exists state         text;
alter table public.contacts add column if not exists instagram     text;
alter table public.contacts add column if not exists website       text;

create index if not exists contacts_biztype_idx on public.contacts(org_id, business_type);
create index if not exists contacts_state_idx   on public.contacts(org_id, state);
create index if not exists contacts_source_idx  on public.contacts(org_id, source);

alter table public.orgs add column if not exists responses_count int not null default 0;

-- done.
