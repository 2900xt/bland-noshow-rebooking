// Pure scheduling / parsing / classification logic. No I/O, so it is easy to reason about and test.

export const TZ = "America/New_York";
export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// ---------------------------------------------------------------- time zones
export type Parts = { y: number; m: number; d: number; h: number; mi: number; wd: number };

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
  hour: "numeric", minute: "numeric", second: "numeric", weekday: "long", hour12: false,
});

export function parts(date: Date | number, _tz = TZ): Parts {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(date))) p[x.type] = x.value;
  return {
    y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute,
    wd: WEEKDAYS.indexOf(p.weekday.toLowerCase()),
  };
}

// Wall-clock time in New York -> UTC instant (handles DST by measuring the offset at that instant).
export function zoned(y: number, m: number, d: number, h = 0, mi = 0): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = parts(guess);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return new Date(guess - (asUtc - guess));
}

const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function clock(h: number, mi: number) {
  const hh = h % 12 || 12;
  return `${hh}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// "Tuesday, October 13th at 9:30 AM", the form the agent reads aloud and the patient repeats back.
export function slotLabel(start: string | Date) {
  const p = parts(new Date(start));
  return `${cap(WEEKDAYS[p.wd])}, ${cap(MONTHS[p.m - 1])} ${ord(p.d)} at ${clock(p.h, p.mi)}`;
}

export function dayKey(start: string | Date) {
  const p = parts(new Date(start));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- deterministic randomness (seeding)
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- DOB parsing
const NUMBER_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// "March 14th 2004", "3/14/2004", "2004-03-14", "march fourteenth two thousand four" -> 2004-03-14
export function normalizeDob(raw: unknown): string | null {
  const s = String(raw ?? "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? (Number(m[3]) > 30 ? "19" : "20") + m[3] : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const mi = MONTHS.findIndex((mo) => s.includes(mo.slice(0, 3)));
  if (mi < 0) return null;
  // Day: digits, or "twenty first" style words.
  let day: number | null = null;
  const dm = s.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (dm && Number(dm[1]) <= 31) day = Number(dm[1]);
  if (day == null) {
    const words = s.split(" ");
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "twenty" || w === "thirty") {
        const next = NUMBER_WORDS[words[i + 1] ?? ""];
        day = NUMBER_WORDS[w] + (next && next < 10 ? next : 0);
        break;
      }
      if (NUMBER_WORDS[w] && NUMBER_WORDS[w] <= 31 && !["thousand"].includes(w)) { day = NUMBER_WORDS[w]; break; }
    }
  }
  let year: number | null = null;
  const ym = s.match(/\b(19|20)\d{2}\b/);
  if (ym) year = Number(ym[0]);
  else if (/two thousand/.test(s)) {
    const tail = s.split("two thousand")[1]?.trim().split(" ") ?? [];
    let n = 0;
    for (const w of tail) if (NUMBER_WORDS[w] && !/(st|nd|rd|th)$/.test(w)) n += NUMBER_WORDS[w];
    year = 2000 + n;
  } else if (/nineteen/.test(s)) {
    const tail = s.split("nineteen").at(-1)!.trim().split(" ");
    let n = 0;
    for (const w of tail) if (NUMBER_WORDS[w] && !/(st|nd|rd|th)$/.test(w)) n += NUMBER_WORDS[w];
    if (n) year = 1900 + n;
  }
  if (day == null || year == null) return null;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- time requests and preferences
export type TimeAsk = { weekday?: number; month?: number; day?: number; hour?: number; minute?: number };

// Parses "Tuesday, October 13th at 9:30 AM", "the 15th at 2", "friday at eleven", "2026-10-16 11:00".
export function parseTimeAsk(raw: unknown): TimeAsk {
  const s = String(raw ?? "").toLowerCase();
  const out: TimeAsk = {};
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})/);
  if (iso) return { month: +iso[2], day: +iso[3], hour: +iso[4], minute: +iso[5] };
  const wd = WEEKDAYS.findIndex((w) => s.includes(w) || new RegExp(`\\b${w.slice(0, 3)}\\b`).test(s));
  if (wd >= 0) out.weekday = wd;
  const mo = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}`).test(s));
  if (mo >= 0) out.month = mo + 1;
  const dm = s.match(/\b(\d{1,2})(st|nd|rd|th)\b/) ?? (out.month ? s.match(new RegExp(`${MONTHS[out.month - 1].slice(0, 3)}\\w*\\s+(\\d{1,2})\\b`)) : null);
  if (dm) out.day = +dm[1];
  const tm = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/) ?? s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/) ?? s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (tm) {
    let h = +tm[1];
    const mer = tm[3]?.[0];
    if (mer === "p" && h < 12) h += 12;
    if (mer === "a" && h === 12) h = 0;
    if (!mer && h >= 1 && h <= 6) h += 12; // "at 2" in a clinic context means 2 PM
    out.hour = h;
    out.minute = tm[2] ? +tm[2] : 0;
  } else {
    const word = Object.entries(NUMBER_WORDS).find(([w, n]) => n <= 12 && new RegExp(`\\bat ${w}\\b`).test(s));
    if (word) {
      let h = word[1];
      if (/thirty/.test(s.split(`at ${word[0]}`)[1] ?? "")) out.minute = 30; else out.minute = 0;
      if (/p\.?m|afternoon|evening/.test(s) || (h >= 1 && h <= 6)) h = h === 12 ? 12 : h + 12;
      out.hour = h;
    }
  }
  return out;
}

export type Pref = { weekdays: number[]; part?: "morning" | "afternoon" | "late"; after?: number; before?: number; week?: "this" | "next"; date?: { m: number; d: number } };

export function parsePreference(raw: unknown): Pref {
  const s = String(raw ?? "").toLowerCase();
  const p: Pref = { weekdays: [] };
  if (!s || s.includes("{{") || s === "null" || /any|whenever|flexible|doesn'?t matter/.test(s) && !/(mon|tue|wed|thu|fri)/.test(s)) return p;
  WEEKDAYS.forEach((w, i) => { if (s.includes(w) || new RegExp(`\\b${w.slice(0, 3)}s?\\b`).test(s)) p.weekdays.push(i); });
  if (/morning|\bam\b|early/.test(s)) p.part = "morning";
  if (/afternoon|\bpm\b|after lunch/.test(s)) p.part = "afternoon";
  if (/evening|late|after work|after school/.test(s)) p.part = "late";
  const after = s.match(/after (\d{1,2})/);
  if (after) { let h = +after[1]; if (h < 7) h += 12; p.after = h; }
  const before = s.match(/before (\d{1,2})/);
  if (before) { let h = +before[1]; if (h < 7) h += 12; p.before = h; }
  if (/next week/.test(s)) p.week = "next";
  if (/this week/.test(s)) p.week = "this";
  const ask = parseTimeAsk(s);
  if (ask.month && ask.day) p.date = { m: ask.month, d: ask.day };
  else if (ask.day && !ask.month) p.date = { m: 0, d: ask.day };
  return p;
}

export type SlotRow = { id: string; provider_id: string; start: string; status: string; modes: string; held_by?: string | null; held_until?: string | null };

export function isFree(s: SlotRow, callId: string | null, now = Date.now()) {
  if (s.status === "open") return true;
  if (s.status === "held") return (callId && s.held_by === callId) || !s.held_until || Date.parse(s.held_until) < now;
  return false;
}

function matchesPref(s: SlotRow, p: Pref, now: number, level: number) {
  const t = parts(s.start);
  if (level < 3 && p.date && ((p.date.m && t.m !== p.date.m) || t.d !== p.date.d)) return false;
  if (level < 2 && p.weekdays.length && !p.weekdays.includes(t.wd)) return false;
  if (level < 1) {
    if (p.part === "morning" && t.h >= 12) return false;
    if (p.part === "afternoon" && t.h < 12) return false;
    if (p.part === "late" && t.h < 15) return false;
    if (p.after != null && t.h < p.after) return false;
    if (p.before != null && t.h >= p.before) return false;
  }
  if (level < 2 && p.week) {
    const days = (Date.parse(s.start) - now) / 864e5;
    const today = parts(now).wd;
    const toNextMonday = ((8 - today) % 7) || 7;
    if (p.week === "this" && days >= toNextMonday) return false;
    if (p.week === "next" && (days < toNextMonday - 1 || days >= toNextMonday + 7)) return false;
  }
  return true;
}

// Picks two open slots that fit the preference, on different days when possible.
// Relaxes the preference step by step (time of day, then weekday/week, then date) and reports how far it had to go.
export function pickSlots(slots: SlotRow[], prefRaw: unknown, mode: string, callId: string | null, now = Date.now()) {
  const pref = parsePreference(prefRaw);
  const wantVideo = /video|tele|virtual|online/.test(String(mode ?? "").toLowerCase());
  const minStart = now + 18 * 3600e3; // nothing sooner than tomorrow morning
  const pool = slots
    .filter((s) => isFree(s, callId, now) && Date.parse(s.start) > minStart && (!wantVideo || s.modes === "both"))
    .sort((a, b) => a.start.localeCompare(b.start));
  for (let level = 0; level <= 3; level++) {
    const hit = pool.filter((s) => matchesPref(s, pref, now, level));
    if (hit.length) {
      const first = hit[0];
      const second = hit.find((s) => dayKey(s.start) !== dayKey(first.start)) ?? hit[1];
      return { picks: [first, second].filter(Boolean) as SlotRow[], relaxed: level, total: hit.length, pref, wantVideo };
    }
  }
  return { picks: [] as SlotRow[], relaxed: 4, total: 0, pref, wantVideo };
}

// Resolves what the patient asked for to one slot of the provider's calendar (booked or not).
export function resolveSlot(slots: SlotRow[], said: unknown, now = Date.now()): SlotRow | undefined {
  const raw = String(said ?? "").trim();
  if (!raw || raw.includes("{{")) return undefined;
  const exact = slots.find((s) => slotLabel(s.start).toLowerCase() === raw.toLowerCase() || s.id === raw);
  if (exact) return exact;
  const ask = parseTimeAsk(raw);
  if (ask.day == null && ask.weekday == null) return undefined;
  const cands = slots.filter((s) => {
    const t = parts(s.start);
    if (Date.parse(s.start) < now) return false;
    if (ask.month && t.m !== ask.month) return false;
    if (ask.day && t.d !== ask.day) return false;
    if (ask.weekday != null && !ask.day && t.wd !== ask.weekday) return false;
    if (ask.hour != null && (t.h !== ask.hour || t.mi !== (ask.minute ?? 0))) return false;
    return true;
  }).sort((a, b) => a.start.localeCompare(b.start));
  // A bare weekday + time means the next one; a date without a time is ambiguous unless only one slot is free.
  if (ask.hour == null) {
    const free = cands.filter((s) => isFree(s, null, now));
    return free.length === 1 ? free[0] : undefined;
  }
  return cands[0];
}

// Nearest open slot to a target instant (same day first) for the "that one's taken" branch.
export function nearestOpen(slots: SlotRow[], target: string | undefined, callId: string | null, now = Date.now()) {
  const t = target ? Date.parse(target) : now;
  const day = target ? dayKey(target) : "";
  const open = slots.filter((s) => isFree(s, callId, now) && Date.parse(s.start) > now + 18 * 3600e3);
  return open.sort((a, b) => {
    const da = (dayKey(a.start) === day ? 0 : 1e13) + Math.abs(Date.parse(a.start) - t);
    const db = (dayKey(b.start) === day ? 0 : 1e13) + Math.abs(Date.parse(b.start) - t);
    return da - db;
  })[0];
}

// ---------------------------------------------------------------- compliance
// TCPA calling window: only dial 8:00 AM - 9:00 PM in the patient's local time.
export function callingWindow(now = Date.now()) {
  const p = parts(now);
  const open = p.h >= 8 && p.h < 21;
  return { open, local: `${cap(WEEKDAYS[p.wd])} ${clock(p.h, p.mi)} ET`, reason: open ? "" : "Outside 8 AM - 9 PM patient local time" };
}

export function businessHours(now = Date.now()) {
  const p = parts(now);
  return p.wd >= 1 && p.wd <= 5 && p.h >= 8 && p.h < 17;
}

// Adds n business hours (Mon-Fri, 8-17 ET) to a time. Used for task SLAs.
export function addBusinessHours(from: number, hours: number) {
  let t = from;
  let left = hours * 60;
  let guard = 0;
  while (left > 0 && guard++ < 20000) {
    t += 15 * 60e3;
    if (businessHours(t)) left -= 15;
  }
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------- worklist priority
const URGENCY: Record<string, number> = { cardiology: 30, endocrinology: 24, oncology: 34, dermatology: 14, orthopaedics: 16, "primary care": 18 };

export function priority(input: { department: string; missed_at: string; prior_no_shows: number; risk_flags: string[]; attempts: number }, now = Date.now()) {
  const days = Math.max(0, (now - Date.parse(input.missed_at)) / 864e5);
  const factors = [
    { k: "Clinical urgency", v: URGENCY[input.department.toLowerCase()] ?? 15 },
    { k: "Days since missed", v: Math.round(Math.min(20, days * 2)) },
    { k: "Prior no-shows", v: Math.min(18, input.prior_no_shows * 6) },
    { k: "Risk flags", v: Math.min(20, input.risk_flags.length * 7) },
    { k: "Attempts so far", v: -input.attempts * 8 },
  ];
  const score = Math.max(0, Math.min(100, factors.reduce((a, f) => a + f.v, 10)));
  return { score, factors };
}

// Retry cadence after an unsuccessful attempt: 4h, next business morning, 2 days.
export function nextAttempt(attempts: number, outcome: string, now = Date.now()): string | null {
  if (["rebooked", "declined", "opted_out", "wrong_number", "escalated_emergency", "crisis_support", "transferred"].includes(outcome)) return null;
  if (attempts >= 3) return null;
  const gapH = [4, 20, 48][attempts - 1] ?? 48;
  let t = now + gapH * 3600e3;
  for (let i = 0; i < 96 && !callingWindow(t).open; i++) t += 3600e3;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------- outcome classification
export const filled = (v: unknown) => v != null && String(v).trim() !== "" && !String(v).includes("{{") && !["null", "undefined", "none", "n/a"].includes(String(v).toLowerCase().trim());
export const truthy = (v: unknown) => v === true || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "yes";

export function tagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => (typeof t === "string" ? t : (t as any)?.name ?? (t as any)?.tag ?? "")).filter(Boolean);
}

export function classify(input: { answered_by?: string; tags: string[]; v: Record<string, any>; optedOut: boolean; transferred?: boolean; minutes: number; hasUserSpeech: boolean; status?: string }) {
  const { tags, v } = input;
  const has = (t: string) => tags.some((x) => x.toLowerCase().includes(t));
  if (input.answered_by === "voicemail" || has("voicemail")) return "voicemail";
  if (has("emergency")) return "escalated_emergency";
  if (has("crisis")) return "crisis_support";
  if (input.optedOut || has("opt-out")) return "opted_out";
  if (filled(v.confirmation) || has("rebooked")) return "rebooked";
  if (input.transferred || has("transferred")) return "transferred";
  if (has("wrong number")) return "wrong_number";
  if (has("not verified") || String(v.verified) === "false") return "not_verified";
  if (filled(v.decline_reason) || has("declined")) return "declined";
  if (filled(v.callback_preference) || filled(v.better_time) || has("callback") || has("waitlist")) return "callback_requested";
  if (!input.hasUserSpeech && input.minutes < 0.4) return "no_answer";
  return "no_outcome";
}

export const OUTCOMES = ["rebooked", "callback_requested", "declined", "not_verified", "voicemail", "no_answer", "opted_out", "wrong_number", "transferred", "escalated_emergency", "crisis_support", "no_outcome"];

// SMS segment math (GSM-7 160/153, UCS-2 70/67) for the outbox view.
export function smsSegments(text: string) {
  const ucs = /[^\x00-\x7F€£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà^{}\\\[~\]|]/.test(text);
  const [one, many] = ucs ? [70, 67] : [160, 153];
  return { encoding: ucs ? "UCS-2" : "GSM-7", segments: text.length <= one ? 1 : Math.ceil(text.length / many) };
}

// Speaks a confirmation code clearly: "PM-830318" -> "P, M, 8 3 0, 3 1 8"
export function spellCode(code: string) {
  const [prefix, digits = ""] = code.split("-");
  return `${prefix.split("").join(", ")}, ${digits.slice(0, 3).split("").join(" ")}, ${digits.slice(3).split("").join(" ")}`;
}

// ---------------------------------------------------------------- trace summarisation (Bland pathway call events)
export type TraceEvent = { sequence: number; event_type: string; node_id: string | null; operation_id?: number | null; payload: any; created_at: string };

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]);
};
export { pct };

export function summarizeTrace(events: TraceEvent[]) {
  const ev = [...events].sort((a, b) => a.sequence - b.sequence);
  if (!ev.length) return null;
  const t0 = Date.parse(ev[0].created_at);
  const rel = (e: TraceEvent) => Date.parse(e.created_at) - t0;
  const path: { node_id: string; at: number; label?: string; source?: string }[] = [];
  const turns: { role: string; text: string; at: number; node_id: string | null; gap_ms?: number }[] = [];
  const spans: { lane: string; at: number; dur: number; label: string; node_id: string | null; ok?: boolean }[] = [];
  const llm: number[] = [], tts: number[] = [], hooks: number[] = [], extract: number[] = [], endpoint: number[] = [], gaps: number[] = [];
  const invokes = new Map<number, TraceEvent>();
  let lastUser: number | null = null;
  let interrupts = 0;
  const start = ev.find((e) => e.event_type === "conversation.init");
  if (start) path.push({ node_id: start.payload?.start_node_id ?? start.node_id ?? "start", at: 0 });
  for (const e of ev) {
    const p = e.payload ?? {};
    const at = rel(e);
    switch (e.event_type) {
      case "node.transition":
        if (p.chosen_node_id) path.push({ node_id: p.chosen_node_id, at, label: p.chosen_label, source: p.decision_source });
        break;
      case "transcript.user":
        turns.push({ role: "user", text: p.text ?? "", at, node_id: e.node_id });
        lastUser = at;
        break;
      case "transcript.assistant": {
        const text = p.delivered_text ?? p.text ?? p.generated_response ?? "";
        const gap = lastUser != null ? at - lastUser : undefined;
        if (gap != null) gaps.push(gap);
        turns.push({ role: "assistant", text, at, node_id: e.node_id, gap_ms: gap });
        lastUser = null;
        break;
      }
      case "llm.inference":
        if (typeof p.ttft_ms === "number") {
          if (p.tag === "pathway_dialogue") llm.push(p.ttft_ms);
          spans.push({ lane: p.tag === "route" ? "Routing LLM" : "Dialogue LLM", at: Math.max(0, at - (p.ttr_ms ?? p.ttft_ms)), dur: p.ttr_ms ?? p.ttft_ms, label: `${p.tag} ${p.ttft_ms}ms`, node_id: e.node_id, ok: p.outcome === "success" });
        }
        break;
      case "tts.result":
        if (typeof p.ttfa_ms === "number") tts.push(p.ttfa_ms);
        if (typeof p.audio_ms === "number") spans.push({ lane: "Agent audio", at, dur: p.audio_ms, label: `${p.chars} chars`, node_id: e.node_id });
        break;
      case "endpointing.decision":
        if (typeof p.round_trip_ms === "number") endpoint.push(p.round_trip_ms);
        break;
      case "interrupt.early":
      case "interrupt.late":
        interrupts++;
        break;
      case "webhook.invoke":
      case "var_extraction.invoke":
      case "kb.invoke":
      case "transfer_call.invoke":
      case "sms.invoke":
        invokes.set(e.sequence, e);
        break;
      case "webhook.result":
      case "webhook.error":
      case "var_extraction.result":
      case "kb.result":
      case "transfer_call.result": {
        const inv = e.operation_id != null ? invokes.get(e.operation_id) : undefined;
        const kind = e.event_type.split(".")[0];
        const dur = p.duration_ms ?? (inv ? at - rel(inv) : 0);
        const begin = inv ? rel(inv) : at - dur;
        if (kind === "webhook") {
          hooks.push(dur);
          let path = "";
          try { path = new URL(p.url ?? inv?.payload?.url ?? "").pathname; } catch { /* ignore */ }
          spans.push({ lane: "Webhooks", at: begin, dur, label: `${path} ${p.status ?? "err"} · ${dur}ms`, node_id: e.node_id, ok: e.event_type === "webhook.result" && (p.status ?? 500) < 400 });
        } else if (kind === "var_extraction") {
          extract.push(dur);
          spans.push({ lane: "Extraction", at: begin, dur, label: Object.keys(p.variables_extracted ?? {}).join(", ") || "vars", node_id: e.node_id, ok: true });
        } else {
          spans.push({ lane: kind === "kb" ? "Knowledge base" : "Transfer", at: begin, dur, label: kind, node_id: e.node_id, ok: true });
        }
        break;
      }
    }
  }
  const end = ev.at(-1)!;
  return {
    duration_ms: rel(end),
    path, turns, spans, interrupts,
    stats: {
      llm_ttft: { p50: pct(llm, 0.5), p95: pct(llm, 0.95), n: llm.length },
      tts_ttfa: { p50: pct(tts, 0.5), p95: pct(tts, 0.95), n: tts.length },
      webhook: { p50: pct(hooks, 0.5), p95: pct(hooks, 0.95), n: hooks.length },
      extraction: { p50: pct(extract, 0.5), p95: pct(extract, 0.95), n: extract.length },
      endpointing: { p50: pct(endpoint, 0.5), p95: pct(endpoint, 0.95), n: endpoint.length },
      response_gap: { p50: pct(gaps, 0.5), p95: pct(gaps, 0.95), n: gaps.length },
    },
    samples: { llm, tts, hooks, gaps },
  };
}
