// CeasAI CRM / Outreach OS — send-campaign edge function (SMTP sender)
// Sends a bulk/personalized email batch through a GENERIC SMTP relay
// (e.g. ProtiqAI SMTP) using denomailer. No Resend, no third-party HTTP API.
//
// SECURITY: SMTP credentials live ONLY as Supabase secrets (never in the client).
//   SMTP_HOST  - e.g. smtp.protiqai.com
//   SMTP_PORT  - 465 (implicit TLS, recommended) or a provider alt port (e.g. 2587).
//                NOTE: Supabase Edge runtime blocks outbound ports 25 & 587.
//                Use 465 (works) or the provider's alternate submission port.
//   SMTP_USER  - SMTP username
//   SMTP_PASS  - SMTP password
//   SMTP_FROM  - (optional) full From, e.g. "CeasAI <matt@ceasai.com>".
//                Falls back to the org's From name/email if unset.
//
// COMPLIANCE: every message gets a visible unsubscribe link + physical mailing
// address, suppression is enforced (unsubscribed / bounced / invalid skipped),
// every send is written to email_events, a daily cap is respected, and sends
// are paced. Never fakes a send: if SMTP is unreachable it reports it honestly.
//
// Deploy:  supabase functions deploy send-campaign
// Secrets: supabase secrets set SMTP_HOST=... SMTP_PORT=465 SMTP_USER=... SMTP_PASS=... SMTP_FROM="CeasAI <matt@ceasai.com>"
//
// Request JSON: { campaign_id?, contact_ids:[], subject, body, template_id?, test_to? }
// Auth: requires the caller's Supabase JWT (Authorization: Bearer <access_token>).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "";
const SMTP_PORT = Number(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const SMTP_FROM = Deno.env.get("SMTP_FROM") || "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function mrgCtx(c: any) {
  return {
    first_name: c.first_name, last_name: c.last_name, title: c.title, email: c.email,
    company: c.company_name || c.company || "", city: c.city || "",
  };
}
function merge(tpl: string, c: Record<string, unknown>): string {
  const first = (c.first_name as string) || "there";
  const company = (c.company as string) || "your business";
  const map: Record<string, string> = {
    first_name: first, first, last_name: (c.last_name as string) || "",
    name: `${c.first_name || ""} ${c.last_name || ""}`.trim() || "there",
    company, business: company,
    city: (c.city as string) || "your area",
    title: (c.title as string) || "", email: (c.email as string) || "",
  };
  return String(tpl || "").replace(/\{\{?\s*(\w+)\s*\}?\}/g, (m, k) => (map[k] != null ? map[k] : m));
}

// implicit TLS for the common secure-SMTP ports; STARTTLS otherwise.
const useImplicitTLS = [465, 2465, 8465].includes(SMTP_PORT);

function fromHeader(org: any): string {
  if (SMTP_FROM) return SMTP_FROM;
  const email = org?.from_email || SMTP_USER;
  const name = org?.from_name || org?.name || "CeasAI";
  return `${name} <${email}>`;
}

function buildBodies(bodyText: string, org: any, unsubUrl: string) {
  const addr = org?.mailing_address || "";
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    esc(bodyText).replace(/\n/g, "<br>") +
    `</div><hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">` +
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:12px;color:#888">` +
    esc(org?.from_name || org?.name || "CeasAI") +
    (addr ? `<br>${esc(addr)}` : "") +
    `<br>You're receiving this because we thought it was relevant to your business. ` +
    `<a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.</div>`;
  const text = bodyText + `\n\n-\n${org?.from_name || org?.name || "CeasAI"}${addr ? `\n${addr}` : ""}\nUnsubscribe: ${unsubUrl}`;
  return { html, text };
}

// Sends via an already-connected denomailer client. Throws on connection loss
// (so the caller can detect an unreachable SMTP relay and stop honestly).
async function sendOne(client: SMTPClient, from: string, to: string, c: any,
  subjTpl: string, bodyTpl: string, org: any, token?: string) {
  const ctx = mrgCtx(c);
  const subject = merge(subjTpl, ctx);
  const bodyText = merge(bodyTpl, ctx);
  const unsubUrl = token
    ? `${SUPABASE_URL}/functions/v1/unsubscribe?token=${token}`
    : `${SUPABASE_URL}/functions/v1/unsubscribe`;
  const { html, text } = buildBodies(bodyText, org, unsubUrl);
  await client.send({
    from, to,
    replyTo: org?.reply_to || undefined,
    subject, content: text, html,
  });
  return { subject };
}

// Guard against a blocked/hung port: fail fast instead of hanging the function.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return json({ ok: false, error: "missing auth" }, 401);

    const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ ok: false, error: "unauthorized" }, 401);

    const { data: profile } = await asUser.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
    const orgId = profile?.org_id;
    if (!orgId) return json({ ok: false, error: "no org" }, 403);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: org } = await admin.from("orgs").select("*").eq("id", orgId).maybeSingle();

    const providerReady = !!(SMTP_HOST && SMTP_USER && SMTP_PASS && (SMTP_FROM || org?.from_email));
    const payload = await req.json().catch(() => ({}));
    const { campaign_id = null, contact_ids = [], subject = "", body = "", template_id = null, test_to = null } = payload;

    if (!providerReady) {
      return json({
        ok: false, reason: "no_provider", provider_ready: false,
        missing: { smtp_host: !SMTP_HOST, smtp_user: !SMTP_USER, smtp_pass: !SMTP_PASS, from: !(SMTP_FROM || org?.from_email) },
        message: "ProtiqAI SMTP not configured. Set SMTP_HOST/PORT/USER/PASS/FROM as Supabase secrets and a From address in Settings.",
      });
    }
    if (!org?.mailing_address) {
      return json({ ok: false, reason: "no_address",
        message: "Add a physical mailing address in Settings before sending (legally required)." });
    }

    // Open one SMTP connection for the whole batch.
    const client = new SMTPClient({
      connection: {
        hostname: SMTP_HOST, port: SMTP_PORT, tls: useImplicitTLS,
        auth: { username: SMTP_USER, password: SMTP_PASS },
      },
    });
    const from = fromHeader(org);

    // Test send (single, ignores cap). Also serves as a connectivity check.
    if (test_to) {
      try {
        await withTimeout(sendOne(client, from, test_to, { first_name: "there" }, subject || "Test from CeasAI",
          body || "This is a test send from your Outreach OS SMTP connection.", org), 20000, "SMTP test send");
        await client.close().catch(() => {});
        return json({ ok: true, test: true });
      } catch (e) {
        await client.close().catch(() => {});
        return json({ ok: false, test: true, reason: "smtp_connect_failed", error: String((e as any)?.message || e),
          hint: `Could not send via ${SMTP_HOST}:${SMTP_PORT}. On Supabase Edge, ports 25 & 587 are blocked - use 465 or the provider's alt port.` });
      }
    }

    const dailyCap = Number(org?.daily_cap || 100);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const { count: sentToday } = await admin.from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "sent").gte("sent_at", startOfDay.toISOString());
    let remaining = Math.max(0, dailyCap - (sentToday || 0));

    const ids = contact_ids.length ? contact_ids : ["00000000-0000-0000-0000-000000000000"];
    const { data: contacts } = await admin.from("contacts").select("*").eq("org_id", orgId).in("id", ids);
    let eligible = (contacts || []).filter((c: any) =>
      c.email && !c.unsubscribed && c.email_status !== "bounced" && c.email_status !== "invalid");
    const suppressed = (contacts || []).length - eligible.length;

    // Dedupe safety net: one email per business (company) per day.
    const { data: sentTodayRows } = await admin.from("email_events")
      .select("contact_id").eq("org_id", orgId).eq("status", "sent").gte("sent_at", startOfDay.toISOString());
    const emailedCompaniesToday = new Set<string>();
    for (const r of (sentTodayRows || [])) {
      const cid = (r as any).contact_id;
      if (!cid) continue;
      const { data: cc } = await admin.from("contacts").select("company_id").eq("id", cid).maybeSingle();
      if (cc?.company_id) emailedCompaniesToday.add(cc.company_id);
    }
    const seenCompany = new Set<string>();
    eligible = eligible.filter((c: any) => {
      const comp = c.company_id || `__nc_${c.id}`;
      if (c.company_id && emailedCompaniesToday.has(c.company_id)) return false; // already emailed today
      if (seenCompany.has(comp)) return false;                                   // dup within this batch
      seenCompany.add(comp);
      return true;
    });

    if (campaign_id) await admin.from("campaigns")
      .update({ status: "sending", total: eligible.length, updated_at: new Date().toISOString() }).eq("id", campaign_id);

    let sent = 0, failed = 0, capped = 0;
    let connectionDead = false, connectError = "";
    for (const c of eligible) {
      if (remaining <= 0) { capped++; continue; }
      const now = new Date().toISOString();
      let ok = false, errMsg: string | null = null, subjOut = merge(subject, mrgCtx(c));
      try {
        const r = await withTimeout(sendOne(client, from, c.email, c, subject, body, org, c.unsubscribe_token),
          sent === 0 ? 20000 : 30000, "SMTP send");
        ok = true; subjOut = r.subject;
      } catch (e) {
        errMsg = String((e as any)?.message || e);
        if (sent === 0 && /timed out|connect|refused|closed|tls|handshake|econn|dns|resolve/i.test(errMsg)) {
          connectionDead = true; connectError = errMsg;
        }
      }
      await admin.from("email_events").insert({
        org_id: orgId, campaign_id, contact_id: c.id, to_email: c.email,
        subject: subjOut, template_id, channel: "email",
        status: ok ? "sent" : "failed", provider: "smtp",
        error: errMsg, retry_needed: ok ? false : true, completed_by: "edge:send-campaign",
        personalization: mrgCtx(c), sent_at: ok ? now : null,
      });
      if (ok) { sent++; remaining--; await admin.from("contacts").update({ last_emailed_at: now, last_contacted_at: now }).eq("id", c.id); }
      else { failed++; }
      if (connectionDead) break; // don't hammer a dead relay
      await sleep(600);
    }
    await client.close().catch(() => {});

    if (campaign_id) await admin.from("campaigns").update({
      status: connectionDead ? "partial" : (capped ? "partial" : "sent"),
      sent_count: sent, failed_count: failed, updated_at: new Date().toISOString(),
    }).eq("id", campaign_id);

    if (connectionDead && sent === 0) {
      return json({ ok: false, reason: "smtp_connect_failed", sent, failed, error: connectError,
        hint: `Could not reach ${SMTP_HOST}:${SMTP_PORT}. On Supabase Edge, ports 25 & 587 are blocked - use 465 or the provider's alternate submission port.` });
    }
    return json({ ok: true, provider_ready: true, sent, failed, skipped_suppressed: suppressed,
      capped_over_daily_limit: capped, daily_cap: dailyCap });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});
