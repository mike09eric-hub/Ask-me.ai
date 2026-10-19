import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return json({ error: "Sign in to use Ask Me.ai." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!supabaseUrl || !anonKey) return json({ error: "Supabase function configuration is incomplete." }, 500);
    if (!geminiKey) return json({ error: "AI engine is not configured yet. Add GEMINI_API_KEY in Supabase Edge Function secrets." }, 503);

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData.user) return json({ error: "Your session is invalid or expired. Please sign in again." }, 401);

    const body = await req.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const category = typeof body.category === "string" ? body.category.slice(0, 40) : "ask";
    if (prompt.length < 2) return json({ error: "Enter a question first." }, 400);
    if (prompt.length > 12000) return json({ error: "Your question is too long. Keep it under 12,000 characters." }, 413);

    const model = "gemini-2.5-flash";
    const systemText = "You are Ask Me.ai, a careful academic learning assistant. Explain concepts clearly, show steps for mathematics, help students learn rather than merely copy. Never invent sources, citations, quotations, page numbers, or research findings. If a source cannot be verified, say so. Adapt the answer to the student's level. Support understanding and original work.";
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.55, maxOutputTokens: 2048 },
      }),
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      await supabase.from("usage_logs").insert({
        user_id: userData.user.id, provider: "gemini", model, request_type: category,
        status: "error", error_code: String(payload?.error?.status ?? upstream.status).slice(0, 100),
      });
      return json({ error: "The AI engine could not complete that request. Please try again shortly." }, 502);
    }
    const answer = (payload?.candidates?.[0]?.content?.parts ?? [])
      .map((part: { text?: string }) => part.text ?? "").join("\n").trim();
    if (!answer) return json({ error: "The AI engine returned an empty answer. Please try again." }, 502);
    await supabase.from("usage_logs").insert({
      user_id: userData.user.id, provider: "gemini", model, request_type: category,
      status: "success",
      input_tokens: payload?.usageMetadata?.promptTokenCount ?? null,
      output_tokens: payload?.usageMetadata?.candidatesTokenCount ?? null,
    });
    return json({ answer, model, usage: payload?.usageMetadata ?? null });
  } catch (_error) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});