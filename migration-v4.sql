-- ============================================================
-- CeasAI CRM -> Outreach OS - Migration v4 (Phase 4: email on ProtiqAI SMTP)
-- Adds: SMTP provider vocab, {{city}} merge field, and richer send-log
--       columns (channel, retry_needed, completed_by, personalization).
-- 100% idempotent & non-destructive. Safe to re-run.
-- Run in Supabase Dashboard -> SQL Editor (NOT the MCP).
-- Requires migration-v3.sql to have been applied first.
-- ============================================================

-- ---------- 1. City on contacts (personalization merge field) ----------
alter table public.contacts add column if not exists city text;

-- ---------- 2. Richer email send-log (per the Phase-4 logging spec) ----------
-- business is derivable via contact_id -> company; channel/date/time/template
-- /personalization/success/failure/reason/retry-needed/completed-by are logged.
alter table public.email_events add column if not exists channel         text not null default 'email'; -- email / instagram_dm / ...
alter table public.email_events add column if not exists retry_needed    boolean not null default false;
alter table public.email_events add column if not exists completed_by    text;   -- 'edge:send-campaign' / user email / 'auto'
alter table public.email_events add column if not exists personalization jsonb;   -- merge-field snapshot used for the send

create index if not exists email_events_status_idx  on public.email_events(org_id, status);
create index if not exists email_events_sentat_idx  on public.email_events(org_id, sent_at);

-- ---------- 3. Provider vocabulary: Resend -> SMTP (ProtiqAI) ----------
-- orgs.email_provider is a free-text flag set by the owner in Settings.
-- Re-point any legacy 'resend' value to 'smtp' so existing orgs keep working.
update public.orgs set email_provider = 'smtp' where email_provider = 'resend';

-- (No schema change needed for orgs: from_name / from_email / reply_to /
--  mailing_address / daily_cap / email_provider already exist from v3.
--  SMTP host/port/user/pass/from live ONLY as Supabase secrets, never in the DB.)

-- done.
