// CeasAI CRM — unsubscribe edge function (PUBLIC, no auth)
// One-click unsubscribe for CAN-SPAM / List-Unsubscribe compliance.
// GET  /functions/v1/unsubscribe?token=<uuid>   -> confirmation page + suppress
// POST /functions/v1/unsubscribe?token=<uuid>   -> one-click (List-Unsubscribe-Post)
//
// Deploy:  supabase functions deploy unsubscribe --no-verify-jwt
// (must be public so recipients can click it without logging in)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function page(title: string, msg: string, ok = true) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#0e0f13;color:#e8eaf0;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px">
<div style="max-width:440px;text-align:center;background:#151821;border:1px solid #2a2f3d;border-radius:16px;padding:34px">
<div style="font-size:40px;margin-bottom:10px">${ok ? "✓" : "⚠"}</div>
<h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
<p style="color:#9aa2b1;font-size:14px;line-height:1.5;margin:0">${msg}</p>
</div></body></html>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const html = (b: string, s = 200) =>
    new Response(b, { status: s, headers: { "Content-Type": "text/html; charset=utf-8" } });

  if (!token) return html(page("Invalid link", "This unsubscribe link is missing its token.", false), 400);

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: contact } = await admin.from("contacts")
      .select("id,email,unsubscribed").eq("unsubscribe_token", token).maybeSingle();

    if (!contact) return html(page("Link not found", "We couldn't find this subscription. It may have already been removed.", false), 404);

    if (!contact.unsubscribed) {
      await admin.from("contacts").update({ unsubscribed: true, unsubscribed_at: new Date().toISOString() }).eq("id", contact.id);
      await admin.from("email_events").insert({
        org_id: (contact as any).org_id, contact_id: contact.id, to_email: contact.email,
        subject: "Unsubscribe", status: "replied", provider: "system",
      }).then(() => {}, () => {}); // best-effort log
    }

    // For one-click POST, a 200 is all that's required.
    if (req.method === "POST") return new Response("ok", { status: 200 });
    return html(page("You're unsubscribed", `${contact.email || "This address"} has been removed and will not receive further emails from us.`));
  } catch (e) {
    return html(page("Something went wrong", "Please try again later.", false), 500);
  }
});
