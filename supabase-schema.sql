-- ============================================================
-- CeasAI CRM — Supabase schema + Row Level Security
-- Stack: static site + supabase-js in the browser.
-- RLS is the ONLY security boundary (the anon key is public).
-- Model: multi-tenant by org. Each signup auto-gets its own org
-- via a trigger. Every CRM row is scoped to an org_id and is only
-- visible/editable by authenticated members of that org.
-- Safe to re-run (idempotent where practical).
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";

-- ---------- Core tenant tables ----------
create table if not exists public.orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'My Company',
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references public.orgs(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'member',
  created_at  timestamptz not null default now()
);
create index if not exists profiles_org_idx on public.profiles(org_id);

-- ---------- CRM tables ----------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  name        text not null,
  website     text,
  industry    text,
  size        text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists companies_org_idx on public.companies(org_id);

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  first_name  text not null default '',
  last_name   text not null default '',
  email       text,
  phone       text,
  company_id  uuid references public.companies(id) on delete set null,
  title       text,
  status      text not null default 'New',   -- New / Contacted / Qualified / Customer / Lost
  source      text,
  tags        text[] not null default '{}',
  owner_id    uuid references auth.users(id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_org_idx on public.contacts(org_id);
create index if not exists contacts_company_idx on public.contacts(company_id);

create table if not exists public.deals (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  title          text not null,
  contact_id     uuid references public.contacts(id) on delete set null,
  company_id     uuid references public.companies(id) on delete set null,
  stage          text not null default 'New', -- New / Contacted / Qualified / Proposal / Won / Lost
  value          numeric not null default 0,
  currency       text not null default 'USD',
  expected_close date,
  notes          text,
  owner_id       uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists deals_org_idx on public.deals(org_id);

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  title       text not null,
  type        text not null default 'todo',  -- call / email / meeting / follow-up / todo
  due_date    date,
  done        boolean not null default false,
  contact_id  uuid references public.contacts(id) on delete set null,
  deal_id     uuid references public.deals(id) on delete set null,
  notes       text,
  owner_id    uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tasks_org_idx on public.tasks(org_id);

-- Outreach + activity timeline (calls, emails, texts, notes, stage changes)
create table if not exists public.activities (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  contact_id  uuid references public.contacts(id) on delete cascade,
  deal_id     uuid references public.deals(id) on delete cascade,
  type        text not null default 'note',  -- note / email / call / text / meeting / stage_change
  direction   text,                          -- outbound / inbound
  subject     text,
  body        text,
  owner_id    uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists activities_org_idx on public.activities(org_id);
create index if not exists activities_contact_idx on public.activities(contact_id);

-- Reusable outreach templates
create table if not exists public.templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  name        text not null,
  channel     text not null default 'email', -- email / call / text
  subject     text,
  body        text,
  created_at  timestamptz not null default now()
);
create index if not exists templates_org_idx on public.templates(org_id);

-- Saved filters / views
create table if not exists public.saved_filters (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  owner_id    uuid references auth.users(id) on delete set null,
  name        text not null,
  entity      text not null default 'contacts',
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists saved_filters_org_idx on public.saved_filters(org_id);

-- ---------- Helper: current user's org (security definer avoids RLS recursion) ----------
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.profiles where id = auth.uid()
$$;

-- ---------- New user -> auto create org + profile ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  org_name   text;
begin
  org_name := coalesce(
    nullif(new.raw_user_meta_data->>'org_name',''),
    initcap(split_part(new.email,'@',1)) || '''s Company'
  );
  insert into public.orgs (name) values (org_name) returning id into new_org_id;
  insert into public.profiles (id, org_id, email, full_name, role)
  values (
    new.id,
    new_org_id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''), new.email),
    'owner'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Enable RLS everywhere ----------
alter table public.orgs           enable row level security;
alter table public.profiles       enable row level security;
alter table public.companies      enable row level security;
alter table public.contacts       enable row level security;
alter table public.deals          enable row level security;
alter table public.tasks          enable row level security;
alter table public.activities     enable row level security;
alter table public.templates      enable row level security;
alter table public.saved_filters  enable row level security;

-- ---------- Policies ----------
-- orgs: members read/update their own org
drop policy if exists "org read own"   on public.orgs;
drop policy if exists "org update own" on public.orgs;
create policy "org read own"   on public.orgs for select to authenticated using (id = public.current_org_id());
create policy "org update own" on public.orgs for update to authenticated using (id = public.current_org_id()) with check (id = public.current_org_id());

-- profiles: user reads/updates own profile row only
drop policy if exists "profile read own"   on public.profiles;
drop policy if exists "profile update own" on public.profiles;
create policy "profile read own"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "profile update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Generic org-scoped full access for authenticated org members.
-- (No anon policies anywhere => the public anon key cannot read/write CRM data.)
do $$
declare t text;
begin
  foreach t in array array['companies','contacts','deals','tasks','activities','templates','saved_filters']
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

-- ---------- Lock down grants: authenticated only, no anon ----------
revoke all on public.orgs, public.profiles, public.companies, public.contacts,
  public.deals, public.tasks, public.activities, public.templates, public.saved_filters
  from anon;

grant select, insert, update, delete on
  public.orgs, public.profiles, public.companies, public.contacts,
  public.deals, public.tasks, public.activities, public.templates, public.saved_filters
  to authenticated;

-- done.
