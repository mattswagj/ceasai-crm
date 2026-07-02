# CeasAI CRM

A complete, self-serve CRM & outreach platform built as a **no-build static site** on the
GitHub + Vercel + Supabase stack. One `index.html` (markup + vanilla JS) talks to Supabase
directly from the browser; **Row Level Security is the security boundary**.

**Live app:** https://ceasai-crm.vercel.app  *(see final report for the exact deployed URL)*

---

## Features

- **Dashboard** — total leads, open pipeline value, won revenue, conversion rate, tasks due/overdue, deals-by-stage bar chart, leads-by-status donut, and a recent-activity feed.
- **Contacts / Leads** — name, email, phone, company, title, status (New / Contacted / Qualified / Customer / Lost), source, tags, owner, notes. Add / edit / delete, live search, status filter, sortable columns, and a detail drawer with a full activity timeline.
- **Companies / Accounts** — name, website, industry, size, notes; linked contacts and rolled-up deal value.
- **Deals / Opportunities** — a drag-and-drop **Kanban board** across New → Contacted → Qualified → Proposal → Won → Lost, with deal value, expected close date, and linked contact/company. Stage moves are logged to the timeline.
- **Tasks** — calls, emails, meetings, follow-ups and to-dos with due dates and done state; filters for Open / Today / Overdue / Done / All, with overdue highlighting.
- **Outreach** — log email/call/text/meeting per contact, reusable message **templates**, one-click follow-up task creation, and a recent-outreach feed.
- **Notes & activity timeline** per contact and per deal.
- **Tags** on contacts, **CSV import** (with company auto-creation) and **CSV export** of contacts.
- **Auth** — Supabase email/password login & signup. Every new signup automatically gets its own isolated workspace (org).
- Clean, responsive dark + gold UI that works on phones (collapsible nav).

## Architecture

```
index.html            ← the entire app (markup + inline vanilla JS + Supabase calls)
manifest.json         ← PWA manifest
sw.js                 ← service worker (offline app-shell cache; not registered by default)
supabase-schema.sql   ← source of truth: tables + RLS policies + signup trigger
README.md
```

No build step, no framework, no bundler. Vercel serves the files as-is (framework preset **Other**).

## Data model & security

Multi-tenant by **org**. Tables: `orgs`, `profiles`, `companies`, `contacts`, `deals`, `tasks`,
`activities`, `templates`, `saved_filters`.

- **RLS is enabled on every table.** There are **no `anon` policies**, so the public/anon key
  (which ships in the browser, by design) cannot read or write any CRM data. A logged-out user gets nothing.
- Authenticated users can only see/modify rows where `org_id = current_org_id()` — their own workspace.
- `profiles` rows are readable/updatable only by their owner (`id = auth.uid()`).
- On signup, a `SECURITY DEFINER` trigger auto-creates an org + profile for the new user.
- Only the **publishable/anon** key is in the client. The service_role key is **never** in the repo or browser.

## Setup / redeploy

1. **Supabase:** run `supabase-schema.sql` in the SQL Editor (idempotent — safe to re-run).
   In Authentication → Sign In / Providers, email/password is enabled and *Confirm email* is turned
   **off** so signup + login work immediately.
2. **GitHub:** this repo. Pushing to `main` auto-deploys.
3. **Vercel:** New Project → Import this repo → Framework **Other**, no build command, output = repo root.
   Deployment Protection is **off** so the URL is reachable; the app itself is gated by Supabase Auth.

To point at a different Supabase project, edit `SUPABASE_URL` and `SUPABASE_ANON_KEY` near the top of
the inline `<script>` in `index.html`, commit, and push.

## Credentials

The Supabase URL and publishable (anon) key are in `index.html`. This is safe **only** because of RLS —
the anon key grants no access to data without an authenticated session in a matching org.
The owner login credentials are delivered separately in the build report, not committed to the repo.
