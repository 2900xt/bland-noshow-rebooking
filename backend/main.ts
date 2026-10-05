// Mock Penn Medicine patient-access backend (stands in for Epic Cadence scheduling, the work queue, a ride vendor and the dialer).
// Deployed as a Val Town HTTP val. Three kinds of callers:
//   1. Bland webhook nodes, mid-call:      /verify /availability /book /post-book /ride /waitlist /handoff /task /optout /sms
//   2. Bland call webhooks:                 /bland/webhook  (live `webhook_events` stream + the end-of-call payload)
//   3. The ops dashboard (GET /) and CLI:   /api/*  (writes need the x-admin-token header)
import { batch, init, kvGet, kvSet, one, q, Row, run, seed, seedHistory } from "./db.ts";
import * as L from "./logic.ts";
import { bland, callEvents, env, pathway as fetchPathway, pathwayVersions, verifySignature } from "./bland.ts";
import { dashboardHtml } from "./ui.ts";

const now = () => new Date().toISOString();
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-admin-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const parse = (s: unknown, d: any = null) => { try { return s == null ? d : JSON.parse(String(s)); } catch { return d; } };
const realId = (v: unknown) => (L.filled(v) ? String(v) : null);
const newId = (p: string, n = 6) => `${p}-${Math.floor(10 ** (n - 1) + Math.random() * 9 * 10 ** (n - 1))}`;

type Ctx = { req: Request; url: URL; b: Record<string, any>; raw: string; audit: { call_id?: string; patient_id?: string; summary?: string; source?: string } };

// ---------------------------------------------------------------- shared lookups
async function worklistFor(b: Record<string, any>) {
  const wid = realId(b.worklist_id);
  return wid
    ? await one("SELECT w.*, p.name AS provider_name, p.department, p.location, p.address, p.video_ok FROM worklist w JOIN providers p ON p.id = w.provider_id WHERE w.id = ?", [wid])
    : await one("SELECT w.*, p.name AS provider_name, p.department, p.location, p.address, p.video_ok FROM worklist w JOIN providers p ON p.id = w.provider_id WHERE w.patient_id = ? ORDER BY w.created_at DESC LIMIT 1", [String(b.patient_id ?? "")]);
}

async function providerSlots(provider_id: string) {
  return (await q("SELECT * FROM slots WHERE provider_id = ? AND start > ? ORDER BY start", [provider_id, now()])) as L.SlotRow[];
}

const TASK_SLA: Record<string, [string, number]> = {
  crisis_followup: ["urgent", 1], emergency_followup: ["urgent", 4], nurse_callback: ["high", 4], nurse_message: ["high", 8],
  human_requested: ["high", 8], scheduler_callback: ["normal", 8], interpreter_callback: ["normal", 8], billing_callback: ["normal", 16],
  financial_counselor: ["normal", 16], ride_assistance: ["normal", 16], retry_call: ["normal", 24], waitlist_offer: ["high", 4], identity_followup: ["low", 24],
};

async function addTask(patient_id: string, type: string, details: string, call_id: string | null, synthetic = 0) {
  const [prio, sla] = TASK_SLA[type] ?? ["normal", 16];
  if (call_id) {
    // One task per type per call. A later pass (post-call) knows more, so it refreshes the details.
    const dup = await one("SELECT id, details FROM tasks WHERE call_id = ? AND type = ?", [call_id, type]);
    if (dup) {
      if (details && details !== dup.details && !details.includes("{{")) await run("UPDATE tasks SET details = ? WHERE id = ?", [details, dup.id]);
      return dup.id as string;
    }
  }
  const id = newId("T", 5);
  await run("INSERT INTO tasks (id, patient_id, call_id, type, details, priority, status, due_at, created_at, synthetic) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id, patient_id, call_id, type, details, prio, "open", L.addBusinessHours(Date.now(), sla), now(), synthetic]);
  return id;
}

async function releaseHolds(call_id: string | null) {
  if (call_id) await run("UPDATE slots SET status = 'open', held_by = NULL, held_until = NULL WHERE status = 'held' AND held_by = ?", [call_id]);
}

async function holdSlot(id: string, call_id: string | null) {
  if (!call_id) return;
  await run("UPDATE slots SET status = 'held', held_by = ?, held_until = ? WHERE id = ? AND (status = 'open' OR (status = 'held' AND (held_by = ? OR held_until < ?)))",
    [call_id, new Date(Date.now() + 10 * 60e3).toISOString(), id, call_id, now()]);
}

// ---------------------------------------------------------------- mid-call webhook endpoints (called by Bland webhook nodes)
const webhooks: Record<string, (c: Ctx) => Promise<Response>> = {
  async "/verify"({ b, audit }) {
    const pid = String(b.patient_id ?? "");
    const call_id = realId(b.call_id);
    const patient = await one("SELECT dob FROM patients WHERE id = ?", [pid]);
    const fails = await one("SELECT COUNT(*) AS n FROM verifications WHERE patient_id = ? AND ok = 0 AND at > ?", [pid, new Date(Date.now() - 30 * 60e3).toISOString()]);
    if (Number(fails?.n ?? 0) >= 3) {
      audit.summary = "locked: 3 failed attempts in 30 min";
      return json({ verified: false, locked: true, reason: "locked", attempts_left: 0 });
    }
    const given = L.normalizeDob(b.dob);
    const ok = !!patient && given === patient.dob;
    const reason = ok ? "match" : given ? "mismatch" : "could_not_parse";
    await run("INSERT INTO verifications (patient_id, call_id, ok, reason, at) VALUES (?,?,?,?,?)", [pid, call_id, ok ? 1 : 0, reason, now()]);
    if (call_id) await run("UPDATE calls SET verified = ?, reached = 1, updated_at = ? WHERE call_id = ?", [ok ? 1 : 0, now(), call_id]);
    audit.summary = `${b.dob} -> ${given ?? "?"} : ${reason}`;
    // Never echo the real DOB back to the agent.
    return json({ verified: ok, locked: false, reason, attempts_left: Math.max(0, 2 - Number(fails?.n ?? 0)) });
  },

  async "/availability"({ b, audit }) {
    const w = await worklistFor(b);
    if (!w) return json({ ok: false, found: false, slot_1: "none", slot_2: "none" });
    const call_id = realId(b.call_id);
    await releaseHolds(call_id); // re-asking replaces the previous offer
    const slots = await providerSlots(w.provider_id);
    const mode = L.filled(b.visit_mode) ? b.visit_mode : "";
    const { picks, relaxed, total, wantVideo } = L.pickSlots(slots, b.preference, mode, call_id);
    for (const s of picks) await holdSlot(s.id, call_id);
    const notes = ["", "Nothing at that time of day; these are the closest.", "Nothing on those days; these are the closest.", "Nothing on that date; these are the closest."];
    audit.summary = `pref "${b.preference ?? ""}"${wantVideo ? " (video)" : ""} -> ${picks.map((s) => L.slotLabel(s.start)).join(" | ") || "none"}${relaxed ? ` (relaxed ${relaxed})` : ""}`;
    return json({
      ok: true,
      found: picks.length > 0,
      slot_1: picks[0] ? L.slotLabel(picks[0].start) : "none",
      slot_2: picks[1] ? L.slotLabel(picks[1].start) : "none",
      matched_preference: relaxed === 0,
      relaxed_note: notes[relaxed] ?? "No openings in the next three weeks.",
      open_count: total,
      video_available: wantVideo ? picks.length > 0 : !!w.video_ok,
      provider_name: w.provider_name,
      held_minutes: call_id ? 10 : 0,
    });
  },

  async "/book"({ b, audit }) {
    const w = await worklistFor(b);
    const call_id = realId(b.call_id);
    const pid = String(b.patient_id ?? "");
    if (!w) return json({ booked: false, reason: "no_worklist_item", alternative_slot: "none" });
    if (call_id) {
      const prior = await one("SELECT a.*, s.start FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE a.call_id = ? AND a.status = 'booked'", [call_id]);
      if (prior) { // idempotent: Bland retries or a second book node in the same call return the same booking
        audit.summary = `idempotent replay ${prior.confirmation}`;
        return json({ booked: true, confirmation: prior.confirmation, confirmation_spoken: L.spellCode(prior.confirmation), slot: L.slotLabel(prior.start), replay: true });
      }
    }
    const slots = await providerSlots(w.provider_id);
    const slot = L.resolveSlot(slots, b.slot);
    const mode = /video|tele|virtual/.test(String(b.visit_mode ?? "").toLowerCase()) ? "video" : "in_person";
    if (!slot) {
      const ask = L.parseTimeAsk(b.slot);
      const alt = L.nearestOpen(slots, undefined, call_id);
      if (alt) await holdSlot(alt.id, call_id);
      audit.summary = `no slot matches "${b.slot}" ${JSON.stringify(ask)}`;
      return json({ booked: false, reason: "slot_not_found", alternative_slot: alt ? L.slotLabel(alt.start) : "none" });
    }
    if (mode === "video" && slot.modes !== "both") {
      const alt = L.nearestOpen(slots.filter((s) => s.modes === "both"), slot.start, call_id);
      if (alt) await holdSlot(alt.id, call_id);
      audit.summary = `${L.slotLabel(slot.start)} is in-person only`;
      return json({ booked: false, reason: "video_not_offered", alternative_slot: alt ? L.slotLabel(alt.start) : "none" });
    }
    // Atomic compare-and-set: only one call can win a slot, even with two calls booking at once.
    const { changes } = await run(
      "UPDATE slots SET status = 'booked', held_by = ?, held_until = NULL WHERE id = ? AND (status = 'open' OR (status = 'held' AND (held_by = ? OR held_until < ?)))",
      [call_id, slot.id, call_id, now()],
    );
    if (!changes) {
      const alt = L.nearestOpen(slots.filter((s) => s.id !== slot.id), slot.start, call_id);
      if (alt) await holdSlot(alt.id, call_id);
      audit.summary = `${L.slotLabel(slot.start)} taken -> offered ${alt ? L.slotLabel(alt.start) : "none"}`;
      return json({ booked: false, reason: "slot_taken", alternative_slot: alt ? L.slotLabel(alt.start) : "none" });
    }
    const confirmation = newId("PM");
    await batch([
      { sql: "INSERT INTO appointments (confirmation, patient_id, worklist_id, slot_id, provider_id, start, visit_mode, call_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        args: [confirmation, pid, w.id, slot.id, w.provider_id, slot.start, mode, call_id, "booked", now()] },
      { sql: "UPDATE worklist SET status = 'rebooked' WHERE id = ?", args: [w.id] },
      { sql: "UPDATE waitlist SET status = 'resolved' WHERE patient_id = ? AND status = 'waiting'", args: [pid] },
      { sql: "UPDATE slots SET status = 'open', held_by = NULL, held_until = NULL WHERE status = 'held' AND held_by = ?", args: [call_id ?? "-"] },
    ]);
    audit.summary = `booked ${L.slotLabel(slot.start)} (${confirmation}, ${mode})`;
    return json({ booked: true, confirmation, confirmation_spoken: L.spellCode(confirmation), slot: L.slotLabel(slot.start), visit_mode: mode, provider_name: w.provider_name });
  },

  // After booking: decides whether to offer a ride (logic lives here so the pathway routes on one boolean) and returns visit prep.
  async "/post-book"({ b, audit }) {
    const call_id = realId(b.call_id);
    const appt = call_id ? await one("SELECT a.*, p.name, p.department, p.location, p.address FROM appointments a JOIN providers p ON p.id = a.provider_id WHERE a.call_id = ? AND a.status = 'booked'", [call_id])
      : await one("SELECT a.*, p.name, p.department, p.location, p.address FROM appointments a JOIN providers p ON p.id = a.provider_id WHERE a.patient_id = ? AND a.status = 'booked' ORDER BY a.created_at DESC LIMIT 1", [String(b.patient_id ?? "")]);
    if (!appt) return json({ ok: false, ride_needed: false, prep: "" });
    const video = appt.visit_mode === "video";
    const flags = parse((await one("SELECT risk_flags FROM patients WHERE id = ?", [appt.patient_id]))?.risk_flags, []);
    const ride_needed = !video && (L.truthy(b.needs_ride_help) || (String(b.no_show_reason ?? "").includes("transport") && flags.includes("transportation")));
    const PREP: Record<string, string> = {
      Dermatology: "bring a list of any creams or skin products you're using",
      Cardiology: "bring your medication list and wear something comfortable",
      Endocrinology: "bring your glucose meter or log if you have one",
      Orthopaedics: "wear loose clothing so the joint is easy to examine",
    };
    const arrive = L.parts(Date.parse(appt.start) - 15 * 60e3);
    const prep = video
      ? "You'll get a video link by text fifteen minutes before the visit. Find a quiet spot with good signal."
      : `Please arrive by ${L.clock(arrive.h, arrive.mi)} at ${appt.location}, and ${PREP[appt.department] ?? "bring your insurance card and photo ID"}.`;
    audit.summary = `prep for ${appt.confirmation}; ride_needed=${ride_needed}`;
    return json({ ok: true, ride_needed, prep, location: video ? "video visit" : appt.location, address: appt.address });
  },

  async "/ride"({ b, audit }) {
    const call_id = realId(b.call_id);
    const appt = await one("SELECT * FROM appointments WHERE patient_id = ? AND status = 'booked' ORDER BY created_at DESC LIMIT 1", [String(b.patient_id ?? "")]);
    if (!appt) return json({ ride_booked: false });
    const pickup = Date.parse(appt.start) - 50 * 60e3;
    const p = L.parts(pickup);
    const id = newId("RD", 5);
    await run("INSERT INTO rides (id, patient_id, confirmation, pickup_at, status, call_id, at) VALUES (?,?,?,?,?,?,?)", [id, appt.patient_id, appt.confirmation, new Date(pickup).toISOString(), "scheduled", call_id, now()]);
    audit.summary = `ride ${id} pickup ${L.clock(p.h, p.mi)}`;
    return json({ ride_booked: true, ride_id: id, pickup_time: `${L.clock(p.h, p.mi)}, about fifty minutes before your visit`, vendor_note: "The driver will call when they're outside." });
  },

  async "/waitlist"({ b, audit }) {
    const w = await worklistFor(b);
    const pid = String(b.patient_id ?? "");
    if (!w) return json({ added: false });
    await run("INSERT INTO waitlist (patient_id, provider_id, preference, status, call_id, at) VALUES (?,?,?,?,?,?)", [pid, w.provider_id, String(b.preference ?? ""), "waiting", realId(b.call_id), now()]);
    const pos = await one("SELECT COUNT(*) AS n FROM waitlist WHERE provider_id = ? AND status = 'waiting'", [w.provider_id]);
    const task_id = await addTask(pid, "scheduler_callback", `Waitlist for ${w.provider_name}; prefers: ${b.preference || "anything"}`, realId(b.call_id));
    await run("UPDATE worklist SET status = 'waitlisted' WHERE id = ?", [w.id]);
    audit.summary = `waitlist #${pos?.n} for ${w.provider_name}, task ${task_id}`;
    return json({ added: true, position: Number(pos?.n ?? 1), task_id });
  },

  // Human request: warm transfer if the scheduling desk is open and a transfer line is configured, otherwise a callback task.
  async "/handoff"({ b, audit }) {
    const open = L.businessHours();
    const line = env("TRANSFER_NUMBER");
    const available = open && !!line;
    let task_id = "";
    if (!available) task_id = await addTask(String(b.patient_id ?? ""), "human_requested", `Asked for a person. Best time: ${L.filled(b.callback_preference) ? b.callback_preference : "not given"}`, realId(b.call_id));
    audit.summary = available ? "warm transfer available" : `no transfer (${open ? "no line configured" : "desk closed"}) -> ${task_id}`;
    return json({ transfer_available: available, desk_open: open, task_id, callback_window: open ? "later today" : "by the end of the next business day" });
  },

  async "/task"({ b, audit }) {
    const type = String(b.type ?? "callback");
    const task_id = await addTask(String(b.patient_id ?? ""), type, String(b.details ?? ""), realId(b.call_id));
    audit.summary = `${type}: ${b.details ?? ""}`;
    return json({ created: true, task_id });
  },

  async "/optout"({ b, audit }) {
    const pid = String(b.patient_id ?? "");
    await batch([
      { sql: "UPDATE patients SET phone_ok = 0 WHERE id = ?", args: [pid] },
      { sql: "UPDATE worklist SET status = 'opted_out', next_attempt_at = NULL WHERE patient_id = ?", args: [pid] },
      { sql: "INSERT INTO consent (patient_id, channel, action, source, call_id, at) VALUES (?,?,?,?,?,?)", args: [pid, "voice", "opt_out", "patient request on call", realId(b.call_id), now()] },
    ]);
    audit.summary = "opted out of automated calls";
    return json({ opted_out: true });
  },

  async "/sms"({ b, audit }) {
    const pid = String(b.patient_id ?? "");
    const call_id = realId(b.call_id);
    const pt = await one("SELECT sms_ok FROM patients WHERE id = ?", [pid]);
    const appt = await one("SELECT a.*, p.name, p.location FROM appointments a JOIN providers p ON p.id = a.provider_id WHERE a.patient_id = ? AND a.status = 'booked' ORDER BY a.created_at DESC LIMIT 1", [pid]);
    const ride = appt ? await one("SELECT * FROM rides WHERE confirmation = ?", [appt.confirmation]) : null;
    let text = appt
      ? `Penn Medicine: You're booked with ${appt.name} on ${L.slotLabel(appt.start)}${appt.visit_mode === "video" ? " (video visit)" : ` at ${appt.location}`}. Conf ${appt.confirmation}.`
      : "Penn Medicine: Thanks for speaking with us.";
    if (ride) { const p = L.parts(ride.pickup_at); text += ` Ride pickup ${L.clock(p.h, p.mi)}.`; }
    text += " Reply C to confirm, R to reschedule, STOP to opt out.";
    const seg = L.smsSegments(text);
    const status = pt && !Number(pt.sms_ok) ? "suppressed (no SMS consent)" : "queued (mock 10DLC)";
    await run("INSERT INTO messages (patient_id, call_id, kind, text, encoding, segments, status, at) VALUES (?,?,?,?,?,?,?,?)", [pid, call_id, "confirmation", text, seg.encoding, seg.segments, status, now()]);
    audit.summary = `${status}, ${seg.segments} segment(s)`;
    return json({ sent: status.startsWith("queued") });
  },

  async "/can-call"({ b, audit }) {
    const r = await eligibility(String(b.patient_id ?? ""), false);
    audit.summary = r.allowed ? "allowed" : `blocked: ${r.reasons.join("; ")}`;
    return json(r);
  },
};

async function eligibility(pid: string, override: boolean) {
  const p = await one("SELECT * FROM patients WHERE id = ?", [pid]);
  const w = await one("SELECT * FROM worklist WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1", [pid]);
  const active = await one("SELECT call_id FROM calls WHERE patient_id = ? AND status IN ('queued','in_progress') AND updated_at > ?", [pid, new Date(Date.now() - 15 * 60e3).toISOString()]);
  const win = L.callingWindow();
  const reasons: string[] = [];
  if (!p) reasons.push("Unknown patient");
  else if (!Number(p.phone_ok)) reasons.push("Opted out of automated calls");
  // A staff test line may bypass the window, attempt cap and closed status (to re-run the demo); never an opt-out.
  if (!win.open && !override) reasons.push(`${win.reason} (now ${win.local})`);
  if (w && Number(w.attempts) >= 3 && !override) reasons.push("Max 3 attempts reached");
  if (w && w.status === "rebooked" && !override) reasons.push("Visit already rebooked");
  if (w && w.status === "opted_out") reasons.push("Worklist item is opted out");
  if (active) reasons.push("A call to this patient is already in progress");
  return { allowed: reasons.length === 0, reasons, window: win };
}

// ---------------------------------------------------------------- Bland call webhooks: live events + end-of-call
async function blandWebhook(c: Ctx) {
  const b = c.b;
  c.audit.source = "bland";
  c.audit.call_id = b.call_id;
  if (b.category && typeof b.message === "string" && !("concatenated_transcript" in b) && !("completed" in b)) return await liveEvent(c);
  return await postCall(c);
}

async function liveEvent({ b, audit }: Ctx) {
  const msg = String(b.message);
  let kind = "info", text = msg, ms: number | null = null;
  let m: RegExpMatchArray | null;
  if ((m = msg.match(/^Agent speech:\s*(.*)$/s))) { kind = "assistant"; text = m[1]; }
  else if ((m = msg.match(/^Handling user speech:\s*(.*)$/s))) { kind = "user"; text = m[1]; }
  else if ((m = msg.match(/^Sending first sentence:\s*(.*)$/s))) { kind = "assistant"; text = m[1]; }
  else if ((m = msg.match(/^([A-Za-z ]+):\s*(\d+)\s*ms/)) && b.category === "latency") { kind = "latency"; text = m[1].trim(); ms = +m[2]; }
  else if ((m = msg.match(/Webhook Response:\s*(\d+).*Response Time:\s*(\d+)ms/s))) { kind = "webhook"; text = `HTTP ${m[1]}`; ms = +m[2]; }
  await run("INSERT INTO call_events (call_id, at, category, kind, text, ms) VALUES (?,?,?,?,?,?)", [b.call_id, now(), b.category, kind, text.slice(0, 2000), ms]);
  const status = /call (ended|completed)/i.test(msg) ? "ended" : "in_progress";
  await run(`INSERT INTO calls (call_id, status, created_at, started_at, updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT(call_id) DO UPDATE SET status = CASE WHEN calls.status = 'completed' THEN calls.status ELSE excluded.status END,
             started_at = COALESCE(calls.started_at, excluded.started_at), updated_at = excluded.updated_at`, [b.call_id, status, now(), now(), now()]);
  audit.summary = `${kind}: ${text.slice(0, 80)}`;
  return json({ ok: true });
}

function normTranscript(b: Record<string, any>) {
  if (Array.isArray(b.transcripts) && b.transcripts.length) {
    return b.transcripts
      .filter((t: any) => t.text && t.user !== "agent-action")
      .map((t: any) => ({ role: t.user === "user" ? "user" : "assistant", text: t.text, at: t.created_at }));
  }
  return String(b.concatenated_transcript ?? "").split("\n").filter(Boolean).map((line) => {
    const [who, ...rest] = line.split(":");
    return { role: /user/i.test(who) ? "user" : "assistant", text: rest.join(":").trim() };
  });
}

async function postCall({ b, audit }: Ctx) {
  const v: Record<string, any> = { ...(b.request_data ?? {}), ...(b.variables ?? {}) };
  const call_id = String(b.call_id ?? newId("unknown"));
  const pid = String(v.patient_id ?? b.metadata?.patient_id ?? "");
  const wid = String(v.worklist_id ?? b.metadata?.worklist_id ?? "");
  const tags = L.tagNames(b.pathway_tags);
  const transcript = normTranscript(b);
  const minutes = Number(b.call_length ?? (b.corrected_duration ? Number(b.corrected_duration) / 60 : 0)) || 0;
  const optedOut = !!(await one("SELECT id FROM consent WHERE patient_id = ? AND action = 'opt_out' AND (call_id = ? OR at > ?)", [pid, call_id, new Date(Date.now() - 20 * 60e3).toISOString()]));
  const outcome = L.classify({ answered_by: b.answered_by, tags, v, optedOut, transferred: L.filled(b.transferred_to), minutes, hasUserSpeech: transcript.some((t: any) => t.role === "user"), status: b.status });

  // Work-queue tasks from what the agent captured. Deduped per call, so a mid-call /task and this pass never double up.
  const made: string[] = [];
  const add = async (type: string, details: string) => { made.push(await addTask(pid, type, details, call_id)); };
  const tagHas = (t: string) => tags.some((x) => x.toLowerCase().includes(t));
  // Safety net on the transcript too: if Penny gave crisis or 911 instructions, a clinician follows up even if no tag fired.
  const said = (re: RegExp) => transcript.some((t: any) => t.role === "assistant" && re.test(t.text));
  if (tagHas("crisis") || said(/\b988\b/)) await add("crisis_followup", "Crisis resources (988) given on call; same-day clinical review");
  if (tagHas("emergency") || said(/call 911 (right )?now/i)) await add("emergency_followup", "Caller told to call 911; check in with patient");
  if (L.filled(v.billing_question)) await add("billing_callback", v.billing_question);
  if (L.filled(v.clinical_question)) await add("nurse_message", v.clinical_question);
  if (L.truthy(v.nurse_callback_requested) || L.filled(v.ongoing_symptoms)) await add("nurse_callback", L.filled(v.ongoing_symptoms) ? `Ongoing symptoms: ${v.ongoing_symptoms}` : "Patient asked for a nurse call");
  const rideBooked = await one("SELECT id FROM rides WHERE call_id = ?", [call_id]);
  if (L.truthy(v.needs_ride_help) && !rideBooked) await add("ride_assistance", "Patient needs transport; no ride booked on the call");
  if (L.truthy(v.needs_financial_counselor)) await add("financial_counselor", "Patient asked about cost or coverage");
  if (L.filled(v.better_time)) await add("retry_call", `Reach patient at: ${v.better_time}`);
  if (L.filled(v.callback_preference) && (await one("SELECT id FROM tasks WHERE call_id = ? AND type = 'human_requested'", [call_id])))
    await add("human_requested", `Asked for a person. Best time: ${v.callback_preference}`);
  if (tagHas("language") || L.filled(v.preferred_language)) await add("interpreter_callback", `Call back with an interpreter (${v.preferred_language ?? "language not captured"})`);

  // Worklist state machine + retry cadence.
  const w = wid ? await one("SELECT * FROM worklist WHERE id = ?", [wid]) : await one("SELECT * FROM worklist WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1", [pid]);
  if (w) {
    const attempts = Number(w.attempts) + 1;
    const next = L.nextAttempt(attempts, outcome);
    const status = ({ rebooked: "rebooked", declined: "closed_declined", opted_out: "opted_out", wrong_number: "bad_number", escalated_emergency: "escalated", crisis_support: "escalated", transferred: "with_scheduler" } as Record<string, string>)[outcome]
      ?? (w.status === "waitlisted" ? "waitlisted" : next ? "retry_scheduled" : "exhausted");
    await run("UPDATE worklist SET attempts = ?, last_attempt_at = ?, last_outcome = ?, status = ?, next_attempt_at = ? WHERE id = ?", [attempts, now(), outcome, status, next, w.id]);
  }
  await releaseHolds(call_id);

  const verified = String(v.verified) === "true" ? 1 : String(v.verified) === "false" ? 0 : null;
  await run(`INSERT INTO calls (call_id, patient_id, worklist_id, status, outcome, disposition, no_show_reason, summary, minutes, price, answered_by, ended_by,
               recording_url, tags, variables, transcript, pathway_version, verified, reached, tasks_created, to_number, created_at, started_at, ended_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(call_id) DO UPDATE SET patient_id = excluded.patient_id, worklist_id = excluded.worklist_id, status = excluded.status, outcome = excluded.outcome,
               disposition = excluded.disposition, no_show_reason = excluded.no_show_reason, summary = excluded.summary, minutes = excluded.minutes, price = excluded.price,
               answered_by = excluded.answered_by, ended_by = excluded.ended_by, recording_url = excluded.recording_url, tags = excluded.tags, variables = excluded.variables,
               transcript = excluded.transcript, pathway_version = excluded.pathway_version, verified = COALESCE(excluded.verified, calls.verified),
               reached = excluded.reached, tasks_created = excluded.tasks_created, ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
    [call_id, pid, w?.id ?? wid, "completed", outcome, b.disposition_tag ?? null, L.filled(v.no_show_reason) ? v.no_show_reason : "", b.summary ?? "", minutes,
      b.price ?? null, b.answered_by ?? null, b.call_ended_by ?? null, b.recording_url ?? null, JSON.stringify(tags), JSON.stringify(v), JSON.stringify(transcript),
      b.pathway_version ?? null, verified, transcript.some((t: any) => t.role === "user") && b.answered_by !== "voicemail" ? 1 : 0, made.length,
      b.to ? `•••${String(b.to).slice(-4)}` : null, b.created_at ?? now(), b.started_at ?? null,
      b.end_at ?? b.ended_at ?? (b.created_at ? new Date(Date.parse(b.created_at) + minutes * 60e3).toISOString() : now()), now()]);

  // Pull Bland's event timeline now (node path + latency). If Bland hasn't finalised it yet, the call view fetches it lazily.
  try { await syncTrace(call_id); } catch { /* lazy later */ }
  audit.call_id = call_id;
  audit.patient_id = pid;
  audit.summary = `${outcome}${tags.length ? ` [${tags.join(", ")}]` : ""}, ${made.length} task(s)`;
  return json({ ok: true, outcome, tasks_created: made.length });
}

async function syncTrace(call_id: string) {
  const events = await callEvents(call_id);
  const t = L.summarizeTrace(events);
  if (!t) return null;
  const { samples, ...trace } = t;
  await run("UPDATE calls SET trace = ?, stats = ?, node_path = ? WHERE call_id = ?",
    [JSON.stringify(trace), JSON.stringify({ samples, ...t.stats }), JSON.stringify(t.path), call_id]);
  return t;
}

// ---------------------------------------------------------------- dialer
function callPayload(origin: string, pt: Row, w: Row, phone: string) {
  const request_data = {
    patient_id: pt.id, worklist_id: w.id, patient_first_name: pt.first_name,
    appointment_type: w.appointment_type, provider_name: w.provider_name, department: w.department, location: w.location,
    missed_date: L.slotLabel(w.missed_at).split(" at ")[0],
    telehealth_ok: Number(pt.telehealth_ok) && Number(w.video_ok) ? "yes" : "no",
    preferred_language: pt.language, attempt_number: Number(w.attempts) + 1,
  };
  const vm = `Hi, this is Penny, an automated assistant calling from Penn Medicine for ${pt.first_name}. Please call us back at the number on your MyPennMedicine account. Thank you.`;
  return {
    phone_number: phone,
    pathway_id: env("PATHWAY_ID"),
    request_data,
    metadata: { campaign: "no-show-recovery", worklist_id: w.id, patient_id: pt.id, attempt: request_data.attempt_number },
    external_id: `${w.id}-a${request_data.attempt_number}`,
    voice: "maya",
    record: true,
    max_duration: 10,
    wait_for_greeting: true,
    timezone: L.TZ,
    background_track: "office",
    noise_cancellation: true,
    // Bland's voicemail detection hangs up before a pathway voicemail node can run, so the PHI-free message is set here.
    voicemail: { action: "leave_message", message: vm, sensitive: true },
    webhook: `${origin}/bland/webhook`,
    webhook_events: ["queue", "call", "latency", "webhook"],
    dispositions: ["rebooked", "callback_requested", "declined", "not_verified", "opted_out", "wrong_number", "transferred_to_scheduler", "emergency_escalation", "crisis_resources_given", "no_outcome"],
    summary_prompt: "Summarize in two sentences for a patient-access scheduler: the outcome, why the visit was missed, and any follow-up promised. Do not include the date of birth or clinical details beyond what the patient volunteered.",
    keywords: ["Penn:2", "MyPennMedicine", "Penny", `${pt.first_name}:2`, String(w.provider_name).replace("Dr. ", "")],
    pronunciation_guide: [
      { word: "MyPennMedicine", pronunciation: "My Penn Medicine", case_sensitive: false, spaced: true },
      { word: "Perelman", pronunciation: "PEARL-man", case_sensitive: false, spaced: true },
    ],
    guard_rails: [
      { type: "tcpa:ai_disclosure", actions: [{ type: "end_call" }], config: { end_seconds: 30 } },
      { type: "tcpa:self_introduction", actions: [{ type: "end_call" }], config: { end_seconds: 30 } },
      { type: "tcpa:opt_out", actions: [{ type: "move_to_node", config: { node_id: "g_optout" } }] },
    ],
  };
}

async function workItem(pid: string) {
  return await one("SELECT w.*, p.name AS provider_name, p.department, p.location, p.video_ok FROM worklist w JOIN providers p ON p.id = w.provider_id WHERE w.patient_id = ? ORDER BY w.created_at DESC LIMIT 1", [pid]);
}

// ---------------------------------------------------------------- dashboard APIs
async function summary(url: URL) {
  const days = Math.min(30, Number(url.searchParams.get("days") ?? 14));
  const synth = url.searchParams.get("synthetic") !== "0";
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [calls, tasks, audit, counts, wl] = await batch([
    { sql: `SELECT call_id, outcome, minutes, price, verified, reached, no_show_reason, created_at, synthetic, stats, node_path, tasks_created, answered_by
            FROM calls WHERE created_at > ? AND status = 'completed' ${synth ? "" : "AND synthetic = 0"}`, args: [since] },
    { sql: `SELECT type, status, priority, due_at, created_at, completed_at, synthetic FROM tasks ${synth ? "" : "WHERE synthetic = 0"}` },
    { sql: "SELECT path, status, ms FROM audit WHERE at > ? AND source = 'bland-node'", args: [new Date(Date.now() - 7 * 864e5).toISOString()] },
    { sql: "SELECT (SELECT COUNT(*) FROM calls WHERE synthetic = 1) AS synthetic, (SELECT COUNT(*) FROM calls WHERE synthetic = 0 AND status = 'completed') AS live" },
    { sql: "SELECT status, COUNT(*) AS n FROM worklist GROUP BY status" },
  ]);
  const dayList = Array.from({ length: days }, (_, i) => L.dayKey(new Date(Date.now() - (days - 1 - i) * 864e5)));
  const byDay = (fn: (c: Row) => number) => dayList.map((d) => calls.filter((c) => L.dayKey(c.created_at) === d).reduce((a, c) => a + fn(c), 0));
  const n = calls.length;
  const reached = calls.filter((c) => Number(c.reached)).length;
  const verified = calls.filter((c) => Number(c.verified) === 1).length;
  const rebooked = calls.filter((c) => c.outcome === "rebooked").length;
  const offered = calls.filter((c) => (parse(c.node_path, []) as any[]).some((p) => p.node_id === "offer")).length;
  const minutes = calls.reduce((a, c) => a + Number(c.minutes || 0), 0);
  const cost = calls.reduce((a, c) => a + Number(c.price || 0), 0);
  const half = (from: number, to: number, fn: (c: Row) => boolean) => calls.filter((c) => { const age = (Date.now() - Date.parse(c.created_at)) / 864e5; return age >= from && age < to && fn(c); }).length;
  const rate = (a: number, b: number) => (b ? a / b : null);
  const cur = { n: half(0, 7, () => true), r: half(0, 7, (c) => !!Number(c.reached)), b: half(0, 7, (c) => c.outcome === "rebooked") };
  const prev = { n: half(7, 14, () => true), r: half(7, 14, (c) => !!Number(c.reached)), b: half(7, 14, (c) => c.outcome === "rebooked") };

  // Latency: pooled samples across all traced calls.
  const pool: Record<string, number[]> = { llm: [], tts: [], hooks: [], gaps: [] };
  for (const c of calls) { const s = parse(c.stats, {})?.samples; if (s) for (const k of Object.keys(pool)) pool[k].push(...(s[k] ?? [])); }
  const hist = Array.from({ length: 14 }, (_, i) => ({ from: i * 200, n: pool.gaps.filter((g) => g >= i * 200 && (i === 13 || g < (i + 1) * 200)).length }));

  // Pathway traffic: node visits, edge transitions, and where unresolved calls stopped.
  const nodes: Record<string, number> = {}, edges: Record<string, number> = {}, exits: Record<string, number> = {};
  for (const c of calls) {
    const path = (parse(c.node_path, []) as any[]).map((p) => p.node_id);
    path.forEach((id, i) => { nodes[id] = (nodes[id] ?? 0) + 1; if (i) edges[`${path[i - 1]}>${id}`] = (edges[`${path[i - 1]}>${id}`] ?? 0) + 1; });
    if (path.length) exits[path.at(-1)] = (exits[path.at(-1)] ?? 0) + 1;
  }

  // Contact rate by weekday x hour: when to dial.
  const heat: Record<string, { n: number; r: number }> = {};
  for (const c of calls) { const p = L.parts(c.created_at); const k = `${p.wd}-${p.h}`; heat[k] ??= { n: 0, r: 0 }; heat[k].n++; if (Number(c.reached)) heat[k].r++; }

  const openTasks = tasks.filter((t) => t.status !== "done");
  const overdue = openTasks.filter((t) => Date.parse(t.due_at) < Date.now()).length;
  const doneT = tasks.filter((t) => t.completed_at).map((t) => (Date.parse(t.completed_at) - Date.parse(t.created_at)) / 3600e3);
  const metOnTime = tasks.filter((t) => t.completed_at && Date.parse(t.completed_at) <= Date.parse(t.due_at)).length;

  const endpoints: Record<string, number[]> = {}, errs: Record<string, number> = {};
  for (const a of audit) { (endpoints[a.path] ??= []).push(Number(a.ms)); if (Number(a.status) >= 400) errs[a.path] = (errs[a.path] ?? 0) + 1; }

  const reasons: Record<string, number> = {}, outcomes: Record<string, number> = {};
  for (const c of calls) { if (c.no_show_reason) reasons[c.no_show_reason] = (reasons[c.no_show_reason] ?? 0) + 1; outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1; }

  return {
    generated_at: now(), days: dayList, synthetic_included: synth, counts: counts[0],
    kpi: {
      calls: n, reached, verified, rebooked, offered, minutes, cost,
      reach_rate: rate(reached, n), rebook_rate: rate(rebooked, reached), verify_rate: rate(verified, reached),
      avg_minutes: n ? minutes / n : null, cost_per_rebook: rebooked ? cost / rebooked : null,
      revenue_recovered: rebooked * 185, staff_hours_saved: (n * 7.5) / 60,
      tasks_open: openTasks.length, tasks_overdue: overdue,
      sla_met: rate(metOnTime, doneT.length), median_task_hours: L.pct(doneT, 0.5),
      delta: { calls: [cur.n, prev.n], reach: [rate(cur.r, cur.n), rate(prev.r, prev.n)], rebook: [rate(cur.b, cur.r), rate(prev.b, prev.r)], rebooked: [cur.b, prev.b] },
    },
    series: {
      calls: byDay(() => 1), rebooked: byDay((c) => (c.outcome === "rebooked" ? 1 : 0)), reached: byDay((c) => Number(c.reached) ? 1 : 0),
      minutes: byDay((c) => Number(c.minutes || 0)),
      outcomes: Object.fromEntries(L.OUTCOMES.map((o) => [o, byDay((c) => (c.outcome === o ? 1 : 0))])),
    },
    funnel: [["Dialed", n], ["Answered by a person", reached], ["Identity verified", verified], ["Offered times", offered], ["Rebooked", rebooked]],
    reasons, outcomes,
    latency: {
      llm_ttft: { p50: L.pct(pool.llm, 0.5), p95: L.pct(pool.llm, 0.95), n: pool.llm.length },
      tts_ttfa: { p50: L.pct(pool.tts, 0.5), p95: L.pct(pool.tts, 0.95), n: pool.tts.length },
      webhook: { p50: L.pct(pool.hooks, 0.5), p95: L.pct(pool.hooks, 0.95), n: pool.hooks.length },
      response_gap: { p50: L.pct(pool.gaps, 0.5), p95: L.pct(pool.gaps, 0.95), n: pool.gaps.length },
      gap_hist: hist,
    },
    traffic: { nodes, edges, exits },
    heat,
    tasks: {
      by_type: Object.entries(openTasks.reduce((a: Record<string, number>, t) => ((a[t.type] = (a[t.type] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]),
      by_status: tasks.reduce((a: Record<string, number>, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {}),
    },
    endpoints: Object.entries(endpoints).map(([path, ms]) => ({ path, n: ms.length, p50: L.pct(ms, 0.5), p95: L.pct(ms, 0.95), errors: errs[path] ?? 0 })).sort((a, b) => b.n - a.n),
    worklist: Object.fromEntries(wl.map((r) => [r.status, Number(r.n)])),
  };
}

async function worklistView() {
  const rows = await q(`SELECT w.*, p.first_name, p.last_name, p.language, p.telehealth_ok, p.phone_ok, p.prior_no_shows, p.risk_flags, p.dialable, p.synthetic,
                          pr.name AS provider_name, pr.department FROM worklist w JOIN patients p ON p.id = w.patient_id JOIN providers pr ON pr.id = w.provider_id`);
  const win = L.callingWindow();
  return {
    window: win,
    items: rows.map((r) => {
      const pr = L.priority({ department: r.department, missed_at: r.missed_at, prior_no_shows: Number(r.prior_no_shows), risk_flags: parse(r.risk_flags, []), attempts: Number(r.attempts) });
      const blocked = !Number(r.phone_ok) ? "Opted out" : ["rebooked", "opted_out", "closed_declined", "bad_number", "exhausted", "escalated"].includes(r.status) ? `Closed: ${r.status}`
        : r.next_attempt_at && Date.parse(r.next_attempt_at) > Date.now() ? `Retry after ${L.slotLabel(r.next_attempt_at)}` : !win.open ? "Waiting for calling window (8 AM)" : "";
      return { ...r, risk_flags: parse(r.risk_flags, []), priority: pr.score, factors: pr.factors, blocked, last_name: r.last_name?.[0] ? `${r.last_name[0]}.` : "" };
    }).sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || b.priority - a.priority),
  };
}

async function scheduleView(url: URL) {
  const days = Math.min(15, Number(url.searchParams.get("days") ?? 15));
  const [providers, slots, appts, wait] = await batch([
    { sql: "SELECT * FROM providers ORDER BY id" },
    { sql: "SELECT id, provider_id, start, status, modes, held_by, held_until FROM slots WHERE start > ? ORDER BY start", args: [now()] },
    { sql: `SELECT a.*, p.first_name FROM appointments a LEFT JOIN patients p ON p.id = a.patient_id WHERE a.created_at IS NOT NULL ORDER BY a.created_at DESC LIMIT 50` },
    { sql: "SELECT w.*, p.first_name, pr.name AS provider_name FROM waitlist w JOIN patients p ON p.id = w.patient_id JOIN providers pr ON pr.id = w.provider_id ORDER BY w.at DESC LIMIT 30" },
  ]);
  const dayList = [...new Set(slots.map((s) => L.dayKey(s.start)))].slice(0, days);
  const ours = new Set(appts.filter((a) => a.status === "booked").map((a) => a.slot_id));
  const grid = providers.map((p) => ({
    ...p,
    days: dayList.map((d) => {
      const ss = slots.filter((s) => s.provider_id === p.id && L.dayKey(s.start) === d);
      const held = ss.filter((s) => s.status === "held" && Date.parse(s.held_until) > Date.now()).length;
      return { day: d, total: ss.length, open: ss.filter((s) => s.status === "open").length, held, booked: ss.filter((s) => s.status === "booked").length, ours: ss.filter((s) => ours.has(s.id)).length,
        slots: ss.map((s) => ({ id: s.id, t: L.clock(L.parts(s.start).h, L.parts(s.start).mi), status: ours.has(s.id) ? "ours" : s.status === "held" && Date.parse(s.held_until) < Date.now() ? "open" : s.status, video: s.modes === "both" })) };
    }),
  }));
  return { days: dayList.map((d) => ({ key: d, label: L.slotLabel(L.zoned(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8), 12)).split(" at ")[0] })), grid, appointments: appts.map((a) => ({ ...a, label: L.slotLabel(a.start) })), waitlist: wait };
}

async function cancelAppointment(conf: string) {
  const a = await one("SELECT * FROM appointments WHERE confirmation = ? AND status = 'booked'", [conf]);
  if (!a) return { ok: false, error: "not found or already cancelled" };
  await batch([
    { sql: "UPDATE appointments SET status = 'cancelled' WHERE confirmation = ?", args: [conf] },
    { sql: "UPDATE slots SET status = 'open', held_by = NULL, held_until = NULL WHERE id = ?", args: [a.slot_id] },
    { sql: "UPDATE worklist SET status = 'queued' WHERE id = ?", args: [a.worklist_id] },
  ]);
  // Freed slot -> first waitlisted patient for this provider whose preference fits gets an offer (text + task).
  const waiting = await q("SELECT * FROM waitlist WHERE provider_id = ? AND status = 'waiting' AND patient_id != ? ORDER BY at", [a.provider_id, a.patient_id]);
  const slot = (await one("SELECT * FROM slots WHERE id = ?", [a.slot_id])) as L.SlotRow;
  const match = waiting.find((x) => L.pickSlots([slot], x.preference, "", null).relaxed === 0) ?? waiting[0];
  if (!match) return { ok: true, waitlist_offer: null };
  await holdSlot(slot.id, `waitlist-${match.id}`);
  await run("UPDATE slots SET held_until = ? WHERE id = ?", [new Date(Date.now() + 4 * 3600e3).toISOString(), slot.id]);
  const text = `Penn Medicine: An earlier visit opened up on ${L.slotLabel(slot.start)}. Reply YES within 4 hours to take it.`;
  const seg = L.smsSegments(text);
  await batch([
    { sql: "UPDATE waitlist SET status = 'offered', offered_slot = ? WHERE id = ?", args: [slot.id, match.id] },
    { sql: "INSERT INTO messages (patient_id, call_id, kind, text, encoding, segments, status, at) VALUES (?,?,?,?,?,?,?,?)", args: [match.patient_id, null, "waitlist_offer", text, seg.encoding, seg.segments, "queued (mock 10DLC)", now()] },
  ]);
  const task = await addTask(match.patient_id, "waitlist_offer", `Slot ${L.slotLabel(slot.start)} offered by text; held 4h`, null);
  return { ok: true, waitlist_offer: { patient_id: match.patient_id, slot: L.slotLabel(slot.start), task } };
}

async function pathwayGraph(refresh: boolean) {
  const id = env("PATHWAY_ID");
  let g = refresh ? null : await kvGet("pathway_graph", 10 * 60e3);
  if (!g && id) {
    const p = await fetchPathway(id);
    let versions: any[] = [];
    try { versions = await pathwayVersions(id); } catch { /* optional */ }
    const nodes = (p.nodes ?? []).filter((n: any) => n.id && n.data).map((n: any) => ({
      id: n.id, type: n.type, name: n.data.name, x: n.position?.x ?? 0, y: n.position?.y ?? 0,
      global: !!n.data.isGlobal, start: !!n.data.isStart, tag: n.data.tag ?? null,
      label: n.data.globalLabel ?? null, prompt: String(n.data.prompt ?? n.data.text ?? "").split("=== BUILDER NOTE")[0].slice(0, 900),
      url: n.data.url ? new URL(n.data.url).pathname : null, extract: (n.data.extractVars ?? []).map((v: any) => v[0]),
      condition: n.data.condition ?? null, kb: n.data.kb ? String(n.data.kb).length : 0,
      routes: (n.data.responsePathways ?? []).map((r: any) => ({ when: `${r[0]} ${r[1]} ${r[2]}`, to: r[3]?.id })),
    }));
    const edges = (p.edges ?? []).map((e: any) => ({ id: e.id, source: e.source, target: e.target, label: e.data?.label ?? e.label ?? "" }));
    for (const n of nodes) for (const r of n.routes) if (r.to) edges.push({ id: `r-${n.id}-${r.to}`, source: n.id, target: r.to, label: r.when, webhook: true });
    g = { id, name: p.name, nodes, edges, versions: versions.slice(0, 8).map((v: any) => ({ n: v.version_number, name: v.name, at: v.created_at, prod: v.is_prod_version ?? v.is_production ?? null })), fetched_at: now() };
    await kvSet("pathway_graph", g);
  }
  return g;
}

async function liveView() {
  const since = new Date(Date.now() - 20 * 60e3).toISOString();
  // Active calls, plus calls that ended in the last 3 minutes so the result stays on screen briefly.
  const calls = await q(`SELECT c.call_id, c.patient_id, c.status, c.outcome, c.created_at, c.started_at, c.updated_at, c.to_number, c.transcript, p.first_name
                         FROM calls c LEFT JOIN patients p ON p.id = c.patient_id
                         WHERE c.synthetic = 0 AND ((c.status IN ('queued','in_progress','ended') AND c.updated_at > ?) OR (c.status = 'completed' AND c.ended_at > ?))
                         ORDER BY c.created_at DESC LIMIT 6`,
    [since, new Date(Date.now() - 3 * 60e3).toISOString()]);
  const out = [];
  for (const c of calls) {
    const events = await q("SELECT at, category, kind, text, ms FROM call_events WHERE call_id = ? ORDER BY id DESC LIMIT 150", [c.call_id]);
    let node = null, path: any[] = [], turns: any[] = [];
    if (c.status !== "completed") {
      try {
        const t = L.summarizeTrace(await callEvents(c.call_id));
        if (t) { path = t.path; node = t.path.at(-1)?.node_id ?? null; turns = t.turns; }
      } catch { /* trace not available yet */ }
    } else {
      const row = await one("SELECT node_path FROM calls WHERE call_id = ?", [c.call_id]);
      path = parse(row?.node_path, []);
    }
    out.push({ ...c, transcript: parse(c.transcript, []), events: events.reverse(), node, path, turns });
  }
  return { calls: out, window: L.callingWindow(), at: now() };
}

// ---------------------------------------------------------------- router
function authed(req: Request) {
  const t = env("ADMIN_TOKEN");
  return !!t && req.headers.get("x-admin-token") === t;
}

async function api(c: Ctx): Promise<Response> {
  const { req, url, b } = c;
  const path = url.pathname;
  const seg = path.split("/").filter(Boolean); // ["api", ...]
  if (req.method === "POST" && !authed(req)) return json({ error: "admin token required" }, 401);
  c.audit.source = "dashboard";

  if (req.method === "GET") switch (seg[1]) {
    case "summary": return json(await summary(url));
    case "live": return json(await liveView());
    case "worklist": return json(await worklistView());
    case "schedule": return json(await scheduleView(url));
    case "pathway": {
      try { return json(await pathwayGraph(url.searchParams.has("refresh"))); } catch (e) { return json({ error: String(e) }, 502); }
    }
    case "tasks": return json(await q(`SELECT t.*, p.first_name FROM tasks t LEFT JOIN patients p ON p.id = t.patient_id ${url.searchParams.get("synthetic") === "0" ? "WHERE t.synthetic = 0" : ""} ORDER BY t.created_at DESC LIMIT 300`));
    case "messages": return json(await q("SELECT m.*, p.first_name FROM messages m LEFT JOIN patients p ON p.id = m.patient_id ORDER BY m.id DESC LIMIT 100"));
    case "audit": return json(await q("SELECT * FROM audit ORDER BY id DESC LIMIT ?", [Math.min(500, Number(url.searchParams.get("limit") ?? 150))]));
    case "request-data": {
      const pt = await one("SELECT * FROM patients WHERE id = ?", [seg[2] ?? "P1001"]);
      const w = pt && (await workItem(pt.id));
      if (!pt || !w) return json({ error: "unknown patient" }, 404);
      return json(callPayload(url.origin, pt, w, "").request_data);
    }
    case "config": {
      const pt = await one("SELECT * FROM patients WHERE id = 'P1001'");
      const w = pt && (await workItem("P1001"));
      const payload = pt && w ? callPayload(url.origin, pt, w, "+1XXXXXXXXXX") : null;
      return json({
        pathway_id: env("PATHWAY_ID"), bland_key: !!env("BLAND_API_KEY"), admin_token: !!env("ADMIN_TOKEN"), transfer_line: !!env("TRANSFER_NUMBER"),
        webhook_signing: !!env("BLAND_WEBHOOK_SECRET"), desk_open: L.businessHours(), window: L.callingWindow(), call_payload: payload,
      });
    }
    case "calls": {
      if (seg[2]) {
        const call = await one("SELECT * FROM calls WHERE call_id = ?", [seg[2]]);
        if (!call) return json({ error: "not found" }, 404);
        if (!call.trace && !Number(call.synthetic) && call.status === "completed") { try { await syncTrace(call.call_id); } catch { /* not ready */ } }
        const [row, events, tasks, appts, msgs, rides, verifs] = await batch([
          { sql: "SELECT c.*, p.first_name FROM calls c LEFT JOIN patients p ON p.id = c.patient_id WHERE c.call_id = ?", args: [seg[2]] },
          { sql: "SELECT at, category, kind, text, ms FROM call_events WHERE call_id = ? ORDER BY id", args: [seg[2]] },
          { sql: "SELECT * FROM tasks WHERE call_id = ?", args: [seg[2]] },
          { sql: "SELECT * FROM appointments WHERE call_id = ?", args: [seg[2]] },
          { sql: "SELECT * FROM messages WHERE call_id = ?", args: [seg[2]] },
          { sql: "SELECT * FROM rides WHERE call_id = ?", args: [seg[2]] },
          { sql: "SELECT ok, reason, at FROM verifications WHERE call_id = ?", args: [seg[2]] },
        ]);
        const r = row[0];
        return json({ ...r, tags: parse(r.tags, []), variables: parse(r.variables, {}), transcript: parse(r.transcript, []), node_path: parse(r.node_path, []),
          trace: parse(r.trace), stats: parse(r.stats), events, tasks, appointments: appts.map((a) => ({ ...a, label: L.slotLabel(a.start) })), messages: msgs, rides, verifications: verifs });
      }
      const synth = url.searchParams.get("synthetic") !== "0";
      return json(await q(`SELECT c.call_id, c.patient_id, c.status, c.outcome, c.disposition, c.no_show_reason, c.minutes, c.price, c.verified, c.reached, c.tasks_created,
                             c.synthetic, c.created_at, c.tags, c.summary, c.answered_by, p.first_name FROM calls c LEFT JOIN patients p ON p.id = c.patient_id
                           ${synth ? "" : "WHERE c.synthetic = 0"} ORDER BY c.created_at DESC LIMIT 250`));
    }
  }

  if (req.method === "POST") switch (seg[1]) {
    case "reset": await seed(); await kvSet("pathway_graph", null); return json({ ok: true });
    case "seed-history": return json({ ok: true, rows: await seedHistory(Number(b.count ?? 140)) });
    case "clear-synthetic":
      await batch([{ sql: "DELETE FROM calls WHERE synthetic = 1" }, { sql: "DELETE FROM tasks WHERE synthetic = 1" }]);
      return json({ ok: true });
    case "tasks": {
      const id = seg[2];
      const act = String(b.action ?? "");
      if (act === "claim") await run("UPDATE tasks SET status = 'claimed', assignee = ? WHERE id = ?", [String(b.assignee ?? "scheduler"), id]);
      else if (act === "complete") await run("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [now(), id]);
      else if (act === "reopen") await run("UPDATE tasks SET status = 'open', completed_at = NULL, assignee = NULL WHERE id = ?", [id]);
      else return json({ error: "action must be claim | complete | reopen" }, 400);
      c.audit.summary = `${act} ${id}`;
      return json({ ok: true });
    }
    case "appointments": return json(await cancelAppointment(seg[2]));
    case "calls": {
      const id = seg[2];
      if (seg[3] === "stop") { await bland("POST", `/calls/${id}/stop`); await run("UPDATE calls SET status = 'ended', updated_at = ? WHERE call_id = ?", [now(), id]); return json({ ok: true }); }
      if (seg[3] === "sync") {
        const d = await bland("GET", `/calls/${id}`);
        const res = await postCall({ ...c, b: d });
        return res;
      }
      return json({ error: "unknown action" }, 404);
    }
    case "dial": {
      const pid = String(b.patient_id ?? "P1001");
      const pt = await one("SELECT * FROM patients WHERE id = ?", [pid]);
      if (!pt) return json({ error: "unknown patient" }, 404);
      if (!Number(pt.dialable)) return json({ error: "Synthetic patient with a fictional 555 number; only the demo patient can be dialed." }, 400);
      const phone = String(b.phone_number ?? "").replace(/[^\d+]/g, "");
      if (!/^\+1\d{10}$/.test(phone)) return json({ error: "phone_number must be +1 followed by 10 digits" }, 400);
      // Staff test line override is allowed for the calling window only; opt-outs and attempt caps always apply.
      const el = await eligibility(pid, !!b.test_line);
      if (!el.allowed) return json({ error: "Not eligible to dial", reasons: el.reasons }, 409);
      const w = await workItem(pid);
      const payload = callPayload(url.origin, pt, w!, phone);
      const res = await bland("POST", "/calls", payload, 15000);
      const call_id = res.call_id ?? res.data?.call_id;
      await run("INSERT INTO calls (call_id, patient_id, worklist_id, status, to_number, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(call_id) DO NOTHING",
        [call_id, pid, w!.id, "queued", `•••${phone.slice(-4)}`, now(), now()]);
      await run("UPDATE worklist SET status = 'calling', last_attempt_at = ? WHERE id = ?", [now(), w!.id]);
      c.audit.call_id = call_id;
      c.audit.summary = `dialed ${pid} (${b.test_line ? "staff test line" : "patient"})`;
      return json({ ok: true, call_id, bland: res });
    }
  }
  return json({ error: "not found", path }, 404);
}

export default async function handler(req: Request): Promise<Response> {
  const t0 = performance.now();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  url.pathname = path;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  await init();
  if (req.method === "GET" && path === "/") return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });

  const raw = req.method === "POST" ? await req.text() : "";
  const b = parse(raw, {}) ?? {};
  const c: Ctx = { req, url, b, raw, audit: { call_id: realId(b.call_id) ?? undefined, patient_id: L.filled(b.patient_id) ? b.patient_id : undefined, source: "bland-node" } };
  let res: Response;
  try {
    if (path.startsWith("/api/")) res = await api(c);
    else if (["/bland/webhook", "/post-call", "/events"].includes(path) && req.method === "POST") {
      const sig = await verifySignature(raw, req.headers.get("x-webhook-signature"));
      if (sig === "invalid") res = json({ error: "bad signature" }, 401);
      else { res = await blandWebhook(c); c.audit.summary = `${c.audit.summary ?? ""}${sig === "verified" ? " (signed)" : ""}`; }
    } else if (req.method === "POST" && webhooks[path]) res = await webhooks[path](c);
    else if (req.method === "POST" && path === "/reset") res = authed(req) ? (await seed(), json({ ok: true })) : json({ error: "admin token required" }, 401);
    else res = json({ error: "not found", path }, 404);
  } catch (e) {
    c.audit.summary = `error: ${String(e).slice(0, 200)}`;
    res = json({ error: String(e) }, 500);
  }
  const live = c.audit.source === "bland" && c.b.category; // don't flood the audit log with every streamed event
  if (!(req.method === "GET") && !live) {
    await run("INSERT INTO audit (at, method, path, status, ms, call_id, patient_id, source, summary) VALUES (?,?,?,?,?,?,?,?,?)",
      [now(), req.method, path, res.status, Math.round(performance.now() - t0), c.audit.call_id ?? null, c.audit.patient_id ?? null, c.audit.source ?? null, c.audit.summary ?? null]).catch(() => {});
    if (Math.random() < 0.02) await run("DELETE FROM audit WHERE id < (SELECT MAX(id) - 3000 FROM audit)").catch(() => {});
  }
  return res;
}
