// CeasAI CRM — enrich-lead edge function (Hunter.io)
// Finds real, verified business emails for leads via Hunter.io.
// SECURITY: HUNTER_API_KEY lives ONLY as a Supabase secret (never in the client).
// CREDIT-SAFE: results are cached per domain (enrichment_cache) so the same domain
// is never looked up twice; calls are paced; remaining quota is returned.
//
// Deploy:  supabase functions deploy enrich-lead
// Secret:  supabase secrets set HUNTER_API_KEY=xxx
//
// Request JSON: { contact_ids: [uuid, ...] }
// Auth: requires the caller's Supabase JWT.

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
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const HUNTER_API_KEY = Deno.env.get("HUNTER_API_KEY") || "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domainFromWebsite(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = url.match(/^https?:\/\//) ? url : "https://" + url;
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch { return null; }
}

async function hunterAccount(): Promise<any> {
  try {
    const r = await fetch(`https://api.hunter.io/v2/account?api_key=${HUNTER_API_KEY}`);
    const j = await r.json();
    return j?.data || null;
  } catch { return null; }
}

// Email Finder: best single email for a named person at a domain (1 request).
async function hunterFind(domain: string, first?: string, last?: string) {
  const p = new URLSearchParams({ domain, api_key: HUNTER_API_KEY });
  if (first) p.set("first_name", first);
  if (last) p.set("last_name", last);
  const r = await fetch(`https://api.hunter.io/v2/email-finder?${p}`);
  const j = await r.json();
  if (!r.ok) return { ok: false, error: j?.errors?.[0]?.details || `HTTP ${r.status}` };
  return { ok: true, email: j?.data?.email || null, score: j?.data?.score ?? null,
    verification: j?.data?.verification?.status || null };
}

// Domain Search: generic best email at a domain when we have no person name.
async function hunterDomain(domain?: string, company?: string) {
  const p = new URLSearchParams({ api_key: HUNTER_API_KEY, limit: "5" });
  if (domain) p.set("domain", domain); else if (company) p.set("company", company);
  const r = await fetch(`https://api.hunter.io/v2/domain-search?${p}`);
  const j = await r.json();
  if (!r.ok) return { ok: false, error: j?.errors?.[0]?.details || `HTTP ${r.status}` };
  const emails = j?.data?.emails || [];
  const best = emails.sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
  return { ok: true, domain: j?.data?.domain || domain,
    email: best?.value || null, score: best?.confidence ?? null,
    first: best?.first_name || "", last: best?.last_name || "" };
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

    if (!HUNTER_API_KEY) return json({ ok: false, reason: "no_provider",
      message: "Hunter not configured. Set HUNTER_API_KEY secret." });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { contact_ids = [] } = await req.json().catch(() => ({}));
    if (!contact_ids.length) return json({ ok: false, error: "no contact_ids" }, 400);

    const { data: contacts } = await admin.from("contacts").select("*")
      .eq("org_id", orgId).in("id", contact_ids.slice(0, 50)); // safety cap per batch
    const { data: companies } = await admin.from("companies").select("id,name,website").eq("org_id", orgId);
    const compById: Record<string, any> = {};
    (companies || []).forEach((c: any) => (compById[c.id] = c));

    const results: any[] = [];
    let credits_used = 0;
    for (const c of (contacts || [])) {
      if (c.email) { results.push({ id: c.id, status: "skipped", reason: "already has email", email: c.email }); continue; }
      const comp = c.company_id ? compById[c.company_id] : null;
      let domain = domainFromWebsite(comp?.website);
      const company = comp?.name || null;
      if (!domain && !company) { results.push({ id: c.id, status: "skipped", reason: "no company/domain" }); continue; }

      const key = domain ? `domain:${domain}` : `company:${(company || "").toLowerCase()}`;
      // Cache check (per domain/company) to avoid re-spending credits.
      const { data: cached } = await admin.from("enrichment_cache").select("payload,domain")
        .eq("org_id", orgId).eq("cache_key", key).maybeSingle();

      let found: any;
      if (cached?.payload?.email) {
        found = cached.payload;
      } else {
        // Prefer person-specific Email Finder when we have a name + domain.
        if (domain && (c.first_name || c.last_name)) {
          const f = await hunterFind(domain, c.first_name, c.last_name);
          credits_used++;
          found = f.ok ? { email: f.email, score: f.score, verification: f.verification, domain } : { error: f.error };
        } else {
          const d = await hunterDomain(domain || undefined, company || undefined);
          credits_used++;
          found = d.ok ? { email: d.email, score: d.score, domain: d.domain } : { error: d.error };
          if (d.ok && d.domain) domain = d.domain;
        }
        // Cache the domain-level payload (best-effort).
        if (found && !found.error) {
          await admin.from("enrichment_cache").upsert(
            { org_id: orgId, cache_key: key, domain, payload: found },
            { onConflict: "org_id,cache_key" }).then(() => {}, () => {});
        }
        await sleep(500); // pace Hunter calls
      }

      if (found?.email) {
        const conf = found.score ?? found.confidence ?? null;
        const status = (conf != null && conf < 50) ? "low_confidence" : "valid";
        await admin.from("contacts").update({
          email: found.email, email_confidence: conf,
          email_status: (found.verification === "invalid") ? "invalid" : "valid",
          email_source: "hunter", updated_at: new Date().toISOString(),
        }).eq("id", c.id);
        results.push({ id: c.id, status: "found", email: found.email, confidence: conf, from_cache: !!cached });
      } else {
        results.push({ id: c.id, status: "not_found", error: found?.error || null, from_cache: !!cached });
      }
    }

    const acct = await hunterAccount();
    const quota = acct ? {
      plan: acct.plan_name,
      searches_used: acct.requests?.searches?.used, searches_available: acct.requests?.searches?.available,
      verifications_used: acct.requests?.verifications?.used, verifications_available: acct.requests?.verifications?.available,
    } : null;

    return json({ ok: true, credits_used, results, quota });
  } catch (e) {
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});
