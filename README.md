# CeasAI Outreach

A dead-simple, **100% free-tier** outreach system for booking meetings with fitness & wellness businesses.
Live: **https://ceasai-crm.vercel.app**

Not an agency CRM — it exists to answer one question: **is this working?**

## Surface (5 tabs)
- **Home** — 3 headline numbers (IG DMs sent · Emails sent · Responses), **Meetings booked** (the goal), needs-attention alerts, setup checklist, and *What's working* reporting.
- **Leads** — business-type segments from the Mindbody import, search, filters (type / state / has-email / warm), CSV export, tap any lead to **edit & enrich** (add email, phone, IG handle).
- **Outreach** — all channels in one place: **Follow-ups · Email · Instagram · LinkedIn · Call** (+ a locked SMS tab that only explains the cost).
- **Accounts** — add & rotate the sending account per channel; booking link.
- **Settings** — sending identity, follow-up sequence, message templates, cost table.

## Channels
| Channel | How it works | Cost |
|---|---|---|
| **Email** | One-click mass send to a segment via Gmail SMTP (`send-campaign` edge fn). Personalized (`{{title}}`, `{{city}}`, `{{booking}}`), paced, daily cap, suppression, unsubscribe + address auto-appended (CAN-SPAM). | **Free** |
| **Instagram** | Generates a personalized DM per lead → copy → open IG → you send → log it. | **Free** |
| **LinkedIn** | Same pattern (LinkedIn prohibits automation). | **Free** |
| **Call** | Manual logging (connected / no answer / booked). | **Free** |
| **SMS** | ❌ **Not built.** Costs money + real TCPA exposure. Hooks left in place. | ~$5–15/mo + per-msg |
| **WhatsApp** | ❌ **Not built.** Billed per 24h conversation. | per-conversation |

**Why no "mass DM" button:** Instagram has **no official API for cold/mass DMs** (the Graph API only allows messaging inside a 24h window after the user messages you). Automation tools that do it violate ToS and risk bans. The queue is the ban-safe way that actually works.

## Follow-up sequences (free automation)
Configure steps in Settings (default: Day 0 email → Day 3 email → Day 7 IG DM). Leads that got a first touch and haven't replied surface in the **Follow-ups** queue when the next step is due. **You press send** — nothing fires on its own. A true auto-sender needs a paid scheduler; this stays free and ban-safe.

## Data model — no schema migration needed
Runs entirely on the existing tables. Structured fields are encoded so **no DDL is required**:
- business name → `contacts.title` (so the SMTP edge fn can merge `{{title}}`)
- business type / state / IG handle → prefixed tags in `contacts.tags[]`: `biz:Gym`, `st:GA`, `ig:handle`
- every outbound touch, reply and meeting → `email_events` (`channel`, `status`)
- accounts, templates, sequence, booking link → localStorage

`migration-v5.sql` is **optional** (two indexes only).

## Inbound Instagram keyword leads (ManyChat)
`supabase/functions/ig-inbound/index.ts` — **needs to be deployed once by the project owner**:

> Supabase Dashboard → Edge Functions → *Deploy a new function* → name **`ig-inbound`** → **Verify JWT: OFF** → paste the file → Deploy.

Live URL for ManyChat's *External Request* action:
```
https://dxctcajmleurhwhbnqyj.supabase.co/functions/v1/ig-inbound
```
POST JSON (only `instagram_username` required):
```json
{ "instagram_username": "thehandle", "name": "Jane Doe", "keyword": "COACH", "timestamp": "2026-07-11T04:00:00Z" }
```
Lands as a **warm** lead (status `Replied`, source `IG keyword: <keyword>`), deduped by handle, idempotent, ignores malformed posts. Surfaces on Home + the "warm" filter.

> The endpoint is free. **ManyChat** is what actually fires the IG auto-replies — free tier 25 contacts, then ~$14–29/mo. That subscription is the owner's call.

## Costs
Everything running today is **$0**: Supabase free · Vercel free · Gmail SMTP · Calendly free tier.
Paid and deliberately **not built**: SMS (Twilio), WhatsApp Business API. See the cost table in Settings.

⚠️ **Multi-account email:** you can rotate senders, but stacking free Gmail accounts to dodge sending limits **hurts deliverability and risks bans**. The durable path is real domains with proper warm-up.

## Tests
No dependencies, no cost:
```bash
bash test/run.sh   # 25 tests
```

## Stack
Static `index.html` + supabase-js in the browser → Vercel. RLS is the security boundary (the anon key is public).
