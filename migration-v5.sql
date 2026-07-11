-- ============================================================
-- CeasAI CRM — Migration v5  (OPTIONAL — the app does NOT require it)
-- The simplified app runs entirely on the EXISTING schema (v1+v3+v4).
-- Business name -> contacts.title; business_type/state/instagram are
-- encoded as prefixed tags (biz: / st: / ig:) in contacts.tags[].
-- These indexes just make big-segment filtering a little faster.
-- 100% idempotent & non-destructive. Run in the Dashboard SQL editor if desired.
-- ============================================================
create index if not exists contacts_source_idx on public.contacts(org_id, source);
create index if not exists contacts_tags_gin   on public.contacts using gin (tags);
-- done.
