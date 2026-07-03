// CeasAI CRM — send-campaign edge function
// Sends a bulk/personalized email batch via Resend.
// SECURITY: RESEND_API_KEY lives ONLY as a Supabase secret (never in the client).
// COMPLIANCE: every message gets a one-click unsubscribe link + physical mailing
// address, suppression is enforced (unsubscribed / bounced are skipped), and every
// send is written to email_events. Respects a daily cap and paces sends.
//
// Deploy:  supabase functions deploy send-campaign
// Secret:  supabase secrets set RESEND_API_KEY=re_xxx
//
// Request JSON: { campaign_id?, contact_ids:[], subject, body, template_id?, test_to? }
// Auth: requires the caller's Supabase JWT (Authorization: Bearer <access_token>).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function mrgCtx(c: any) {
  return { first_name: c.first_name, last_name: c.last_name, title: c.title, email: c.email,
    company: c.company_name || c.company || "" };
}
function merge(tpl: string, c: Record<string, unknown>): string {
  const first = (c.first_name as string) || "there";
  const map: Record<string, string> = {
    first_name: first, first, last_name: (c.last_name as string) || "",
    name: `${c.first_name || ""} ${c.last_name || ""}`.trim() || "there",
    company: (c.company as string) || "your business",
    title: (c.title as string) || "", email: (c.email as string) || "",
  };
  return String(tpl || "").replace(/\{\{?\s*(\w+)\s*\}?\}/g, (m, k) => (map[k] != null ? map[k] : m));
}

async function sendOne(to: string, c: any, subjTpl: string, bodyTpl: string, org: any, token?: string) {
  const ctx = mrgCtx(c);
  const subject = merge(subjTpl, ctx);
  const bodyText = merge(bodyTpl, ctx);
  const unsubUrl = token
    ? `${SUPABASE_URL}/functions/v1/unsubscribe?token=${token}`
    : `${SUPABASE_URL}/functions/v1/unsubscribe`;
  const addr = org?.mailing_address || "";
  const bodyHtml =
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    esc(bodyText).replace(/\n/g, "<br>") +
    `</div>` +
    `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px">` +
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:12px;color:#888">` +
    esc(org?.from_name || org?.name || "CeasAI") +
    (addr ? `<br>${esc(addr)}` : "") +
    `<br>You're receiving this because we thought it was relevant to your business. ` +
    `<a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.` +
    `</div>`;
  const textFooter = `\n\n—\n${org?.from_name || org?.name || "CeasAI"}${addr ? `\n${addr}` : ""}\nUnsubscribe: ${unsubUrl}`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${org?.from_name || "CeasAI"} <${org?.from_email}>`,
        to: [to],
        reply_to: org?.reply_to || undefined,
        subject,
        html: bodyHtml,
        text: bodyText + textFooter,
        headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    });
    const jr = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: jr?.message || `HTTP ${resp.status}` };
    return { ok: true, id: jr?.id };
  } catch (e) {
    return { ok: false, error: String((e as any)?.message || e) };
  }
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

    const providerReady = !!(RESEND_API_KEY && org?.from_email);
    const payload = await req.json().catch(() => ({}));
    const { campaign_id = null, contact_ids = [], subject = "", body = "", template_id = null, test_to = null } = payload;

    if (!providerReady) {
      return json({
        ok: false, reason: "no_provider", provider_ready: false,
        missing: { resend_key: !RESEND_API_KEY, from_email: !org?.from_email },
        message: "Email provider not configured. Set RESEND_API_KEY secret and from address in Settings.",
      });
    }
    if (!org?.mailing_address) {
      return json({ ok: false, reason: "no_address",
        message: "Add a physical mailing address in Settings before sending (legally required)." });
    }

    const dailyCap = Number(org?.daily_cap || 100);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const { count: sentToday } = await admin.from("email_events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "sent").gte("sent_at", startOfDay.toISOString());
    let remaining = Math.max(0, dailyCap - (sentToday || 0));

    // Test send (single, ignores cap)
    if (test_to) {
      const r = await sendOne(test_to, { first_name: "there" }, subject, body, org);
      return json({ ok: r.ok, test: true, result: r });
    }

    const ids = contact_ids.length ? contact_ids : ["00000000-0000-0000-0000-000000000000"];
    const { data: contacts } = await admin.from("contacts").select("*").eq("org_id", orgId).in("id", ids);
    const eligible = (contacts || []).filter((c: any) =>
      c.email && !c.unsubscribed && c.email_status !== "bounced" && c.email_status !== "invalid");
    const skipped = (contacts || []).length - eligible.length;

    if (campaign_id) await admin.from("campaigns")
      .update({ status: "sending", total: eligible.length, updated_at: new Date().toISOString() }).eq("id", campaign_id);

    let sent = 0, failed = 0, capped = 0;
    for (const c of eligible) {
      if (remaining <= 0) { capped++; continue; }
      const r = await sendOne(c.email, c, subject, body, org, c.unsubscribe_token);
      const now = new Date().toISOString();
      await admin.from("email_events").insert({
        org_id: orgId, campaign_id, contact_id: c.id, to_email: c.email,
        subject: merge(subject, mrgCtx(c)), template_id,
        status: r.ok ? "sent" : "failed", provider: "resend",
        provider_id: r.id || null, error: r.error || null, sent_at: r.ok ? now : null,
      });
      if (r.ok) { sent++; remaining--; await admin.from("contacts").update({ last_emailed_at: now, last_contacted_at: now }).eq("id", c.id); }
      else { failed++; }
      await sleep(600);
    }

    if (campaign_id) await admin.from("campaigns").update({
      status: capped ? "partial" : "sent", sent_count: sent, failed_count: failed, updated_at: new Date().toISOString(),
    }).eq("id", campaign_id);

    return json({ ok: true, provider_ready: true, sent, failed, skipped_suppressed: skipped, capped_over_daily_limit: capped, daily_cap: dailyCap });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});
