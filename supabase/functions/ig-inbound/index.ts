// CeasAI CRM — ig-inbound edge function (PUBLIC, no JWT)
// Receives inbound Instagram keyword leads from ManyChat's "External Request"
// action and drops them into the CRM as WARM inbound leads.
//
// This is the compliant inbound play: a person comments/DMs a keyword on IG,
// ManyChat auto-replies, and posts the lead here. These are warmer and higher
// priority than cold outreach, so they land with status = 'Replied'.
//
// Deploy in the Supabase Dashboard -> Edge Functions -> Deploy new function.
//   Name: ig-inbound      Verify JWT: OFF (ManyChat can't send a Supabase JWT)
// Live URL: https://dxctcajmleurhwhbnqyj.supabase.co/functions/v1/ig-inbound
//
// Expected JSON body (all strings): {
//   "instagram_username": "thehandle",   // required
//   "name": "Jane Doe",                   // optional
//   "keyword": "COACH",                   // optional
//   "timestamp": "2026-07-10T04:00:00Z"   // optional (ISO); defaults to now
// }
// Malformed posts (no username) are ignored with a 200 so ManyChat won't retry-storm.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cleanHandle = (v: unknown) =>
  String(v ?? "").trim()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ ok: true, ignored: "bad_json" }); }

  const handle = cleanHandle(body.instagram_username ?? body.username ?? body.ig_username);
  if (!handle) return json({ ok: true, ignored: "no_username" });   // ignore malformed, don't error

  const name = (typeof body.name === "string" ? body.name.trim() : "") || "";
  const keyword = (typeof body.keyword === "string" ? body.keyword.trim() : "") || "";
  let ts: string;
  try { ts = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString(); }
  catch (_) { ts = new Date().toISOString(); }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Single-tenant: attribute to the owner's org (first profile created).
  const { data: prof } = await admin.from("profiles")
    .select("org_id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  const orgId = prof?.org_id;
  if (!orgId) return json({ ok: false, error: "no org" }, 500);

  const source = keyword ? `IG keyword: ${keyword}` : "IG keyword";
  const first = name ? name.split(/\s+/)[0] : "";
  const last = name ? name.split(/\s+/).slice(1).join(" ") : "";

  // Dedupe by instagram handle within the org (idempotent).
  const { data: existing } = await admin.from("contacts")
    .select("id").eq("org_id", orgId).ilike("instagram", handle).limit(1).maybeSingle();

  if (existing) {
    await admin.from("contacts").update({
      status: "Replied", source, last_reply_at: ts, last_contacted_at: ts, updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return json({ ok: true, action: "updated", id: existing.id, handle });
  }

  const { data: ins, error } = await admin.from("contacts").insert({
    org_id: orgId, first_name: first, last_name: last,
    company: name || "@" + handle, instagram: handle,
    status: "Replied", source, business_type: "Other",
    tags: ["inbound", "instagram", keyword].filter(Boolean),
    last_reply_at: ts, last_contacted_at: ts,
  }).select("id").maybeSingle();

  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, action: "created", id: ins?.id, handle });
});
