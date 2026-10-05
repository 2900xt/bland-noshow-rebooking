// Thin Bland API client. The key lives in the val's environment (BLAND_API_KEY), never in code or the browser.
const API = "https://api.bland.ai/v1";

export const env = (k: string) => Deno.env.get(k) ?? "";

export async function bland(method: string, path: string, body?: unknown, timeoutMs = 8000): Promise<any> {
  const key = env("BLAND_API_KEY");
  if (!key) throw new Error("BLAND_API_KEY is not set on the val");
  const res = await fetch(API + path, {
    method,
    headers: { authorization: key, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Bland ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// Per-call event timeline (node transitions, webhooks, LLM/TTS latency, extraction). Works mid-call too.
export async function callEvents(callId: string) {
  const d = await bland("GET", `/pathway_calls/${callId}?v=2`);
  return (Array.isArray(d) ? d : d?.data ?? []) as any[];
}

export async function callDetails(callId: string) {
  return await bland("GET", `/calls/${callId}`);
}

export async function pathway(id: string) {
  const d = await bland("GET", `/pathway/${id}`);
  return d?.data ?? d;
}

export async function pathwayVersions(id: string) {
  const d = await bland("GET", `/pathway/${id}/versions`);
  return (Array.isArray(d) ? d : d?.data ?? []) as any[];
}

// HMAC-SHA256 of the raw body, compared to X-Webhook-Signature (only enforced when BLAND_WEBHOOK_SECRET is set).
export async function verifySignature(raw: string, sig: string | null): Promise<"verified" | "invalid" | "unsigned"> {
  const secret = env("BLAND_WEBHOOK_SECRET");
  if (!secret || !sig) return "unsigned";
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === sig.trim().toLowerCase() ? "verified" : "invalid";
}
