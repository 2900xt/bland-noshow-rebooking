// SQLite schema + seed for the mock Penn scheduling backend (val-scoped Val Town database).
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { addBusinessHours, dayKey, parts, priority, rng, zoned } from "./logic.ts";

export type Row = Record<string, any>;
type Stmt = { sql: string; args?: any[] };

export async function q(sql: string, args: any[] = []): Promise<Row[]> {
  const r = await sqlite.execute({ sql, args });
  return r.rows as Row[];
}
export async function one(sql: string, args: any[] = []): Promise<Row | undefined> {
  return (await q(sql, args))[0];
}
export async function run(sql: string, args: any[] = []) {
  const r = await sqlite.execute({ sql, args });
  return { changes: Number((r as any).rowsAffected ?? 0) };
}
// One round trip for many statements (atomic). Used for reads too: the dashboard summary is one batch.
export async function batch(stmts: Stmt[]): Promise<Row[][]> {
  if (!stmts.length) return [];
  const out: Row[][] = [];
  for (let i = 0; i < stmts.length; i += 150) {
    const r = await sqlite.batch(stmts.slice(i, i + 150).map((s) => ({ sql: s.sql, args: s.args ?? [] })));
    for (const x of r) out.push(x.rows as Row[]);
  }
  return out;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT, department TEXT, location TEXT, address TEXT, video_ok INTEGER)`,
  `CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, dob TEXT, phone TEXT, dialable INTEGER DEFAULT 0,
     language TEXT DEFAULT 'English', telehealth_ok INTEGER DEFAULT 1, phone_ok INTEGER DEFAULT 1, sms_ok INTEGER DEFAULT 1,
     prior_no_shows INTEGER DEFAULT 0, risk_flags TEXT DEFAULT '[]', synthetic INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS worklist (id TEXT PRIMARY KEY, patient_id TEXT, provider_id TEXT, appointment_type TEXT, missed_at TEXT,
     status TEXT DEFAULT 'queued', attempts INTEGER DEFAULT 0, last_attempt_at TEXT, next_attempt_at TEXT, last_outcome TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, provider_id TEXT, start TEXT, status TEXT, modes TEXT, held_by TEXT, held_until TEXT)`,
  `CREATE INDEX IF NOT EXISTS slots_provider ON slots(provider_id, start)`,
  `CREATE TABLE IF NOT EXISTS appointments (confirmation TEXT PRIMARY KEY, patient_id TEXT, worklist_id TEXT, slot_id TEXT, provider_id TEXT,
     start TEXT, visit_mode TEXT, call_id TEXT, status TEXT DEFAULT 'booked', created_at TEXT, synthetic INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, patient_id TEXT, worklist_id TEXT, status TEXT, outcome TEXT, disposition TEXT,
     no_show_reason TEXT, summary TEXT, minutes REAL DEFAULT 0, price REAL, answered_by TEXT, ended_by TEXT, recording_url TEXT,
     tags TEXT DEFAULT '[]', variables TEXT DEFAULT '{}', transcript TEXT DEFAULT '[]', node_path TEXT DEFAULT '[]', trace TEXT,
     stats TEXT, pathway_version INTEGER, verified INTEGER, reached INTEGER, tasks_created INTEGER DEFAULT 0, synthetic INTEGER DEFAULT 0,
     to_number TEXT, created_at TEXT, started_at TEXT, ended_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS calls_created ON calls(created_at)`,
  `CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, at TEXT, category TEXT, kind TEXT, text TEXT, ms INTEGER)`,
  `CREATE INDEX IF NOT EXISTS call_events_call ON call_events(call_id, id)`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, patient_id TEXT, call_id TEXT, type TEXT, details TEXT, priority TEXT, status TEXT DEFAULT 'open',
     assignee TEXT, due_at TEXT, created_at TEXT, completed_at TEXT, synthetic INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, call_id TEXT, kind TEXT, text TEXT, encoding TEXT,
     segments INTEGER, status TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS rides (id TEXT PRIMARY KEY, patient_id TEXT, confirmation TEXT, pickup_at TEXT, status TEXT, call_id TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, provider_id TEXT, preference TEXT, status TEXT DEFAULT 'waiting',
     offered_slot TEXT, call_id TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS consent (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, channel TEXT, action TEXT, source TEXT, call_id TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, call_id TEXT, ok INTEGER, reason TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, method TEXT, path TEXT, status INTEGER, ms INTEGER, call_id TEXT,
     patient_id TEXT, source TEXT, summary TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit(at)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at TEXT)`,
];

const TABLES = ["providers", "patients", "worklist", "slots", "appointments", "calls", "call_events", "tasks", "messages", "rides", "waitlist", "consent", "verifications", "audit", "kv"];

let ready: Promise<void> | null = null;
export function init() {
  ready ??= (async () => {
    await batch(SCHEMA.map((sql) => ({ sql })));
    const n = await one("SELECT COUNT(*) AS n FROM providers");
    if (!n || Number(n.n) === 0) await seed();
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function kvGet(k: string, maxAgeMs = Infinity) {
  const r = await one("SELECT v, at FROM kv WHERE k = ?", [k]);
  if (!r || Date.now() - Date.parse(r.at) > maxAgeMs) return null;
  return JSON.parse(r.v);
}
export async function kvSet(k: string, v: unknown) {
  await run("INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at", [k, JSON.stringify(v), new Date().toISOString()]);
}

// ---------------------------------------------------------------- seed data (all fictional)
export const PROVIDERS = [
  { id: "PR1", name: "Dr. Patel", department: "Dermatology", location: "Perelman Center for Advanced Medicine", address: "3400 Civic Center Boulevard, Philadelphia", video_ok: 1 },
  { id: "PR2", name: "Dr. Chen", department: "Cardiology", location: "Penn Presbyterian Medical Center", address: "51 North 39th Street, Philadelphia", video_ok: 1 },
  { id: "PR3", name: "Dr. Alvarez", department: "Endocrinology", location: "Penn Medicine Radnor", address: "250 King of Prussia Road, Radnor", video_ok: 1 },
  { id: "PR4", name: "Dr. Okafor", department: "Orthopaedics", location: "Penn Medicine University City", address: "3737 Market Street, Philadelphia", video_ok: 0 },
];

const VISIT = { PR1: "dermatology follow-up", PR2: "cardiology follow-up", PR3: "diabetes management visit", PR4: "orthopaedic post-op check" } as Record<string, string>;

const FIRST = ["Maria", "James", "Aisha", "Robert", "Linh", "Dorothy", "Kevin", "Priya", "Marcus", "Elena", "Tyrone", "Grace", "Samuel", "Fatima", "Daniel", "Rosa", "Andre", "Helen", "Omar", "Keisha", "Victor", "Nadia", "Paul", "Imani"];
const LAST = ["Gonzalez", "Brooks", "Rahman", "Kowalski", "Nguyen", "Fitzgerald", "Osei", "Shah", "Washington", "Petrova", "Jackson", "Kim", "Feldman", "Haddad", "Murphy", "Delgado", "Thompson", "Ward", "Farouk", "Mitchell", "Romano", "Volkov", "Bennett", "Okoro"];
const FLAGS = ["transportation", "cost_concern", "caregiver", "work_schedule", "limited_english", "no_portal"];

export async function seed(now = Date.now()) {
  const r = rng(20261004);
  const iso = (t: number) => new Date(t).toISOString();
  const stmts: Stmt[] = TABLES.map((t) => ({ sql: `DELETE FROM ${t}` }));
  for (const p of PROVIDERS) stmts.push({ sql: "INSERT INTO providers VALUES (?,?,?,?,?,?)", args: [p.id, p.name, p.department, p.location, p.address, p.video_ok] });

  // The demo patient: the only one who can be dialed (to the phone number passed to /api/dial).
  stmts.push({
    sql: "INSERT INTO patients (id, first_name, last_name, dob, phone, dialable, language, telehealth_ok, prior_no_shows, risk_flags, synthetic) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    args: ["P1001", "Taha", "K.", "2004-03-14", "", 1, "English", 1, 1, JSON.stringify(["transportation"]), 0],
  });
  const missedDemo = zoned(2026, 10, 1, 10, 30).toISOString();
  stmts.push({ sql: "INSERT INTO worklist (id, patient_id, provider_id, appointment_type, missed_at, created_at) VALUES (?,?,?,?,?,?)", args: ["W-1001", "P1001", "PR1", VISIT.PR1, missedDemo, iso(now)] });

  // Synthetic worklist so the queue and analytics have something to show. Phones are 555-01xx (fictional).
  FIRST.forEach((first, i) => {
    const id = `P${1002 + i}`;
    const prov = PROVIDERS[Math.floor(r() * PROVIDERS.length)];
    const flags = FLAGS.filter(() => r() < 0.22);
    const lang = flags.includes("limited_english") ? (r() < 0.6 ? "Spanish" : "Vietnamese") : "English";
    const dob = `${1940 + Math.floor(r() * 62)}-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`;
    stmts.push({
      sql: "INSERT INTO patients (id, first_name, last_name, dob, phone, dialable, language, telehealth_ok, prior_no_shows, risk_flags, synthetic) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      args: [id, first, LAST[i], dob, `+1215555${String(100 + i).padStart(4, "0")}`, 0, lang, prov.video_ok && r() < 0.7 ? 1 : 0, Math.floor(r() * 4), JSON.stringify(flags), 1],
    });
    const missed = now - (1 + Math.floor(r() * 12)) * 864e5 - Math.floor(r() * 8) * 3600e3;
    stmts.push({ sql: "INSERT INTO worklist (id, patient_id, provider_id, appointment_type, missed_at, created_at) VALUES (?,?,?,?,?,?)", args: [`W-${1002 + i}`, id, prov.id, VISIT[prov.id], iso(missed), iso(missed + 864e5)] });
  });

  // Calendar: 15 business days x 8:00-16:30 every 30 min per provider. ~72% already booked by other patients.
  const p0 = parts(now);
  let day = 0, made = 0;
  while (made < 15) {
    day++;
    const d = new Date(Date.UTC(p0.y, p0.m - 1, p0.d + day, 12));
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    made++;
    for (const prov of PROVIDERS) {
      for (let h = 8; h < 17; h++) for (const mi of [0, 30]) {
        const start = zoned(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
        const busy = r() < (h === 12 ? 0.92 : 0.72);
        const modes = prov.video_ok && (h >= 15 || r() < 0.3) ? "both" : "in_person";
        stmts.push({ sql: "INSERT INTO slots (id, provider_id, start, status, modes) VALUES (?,?,?,?,?)", args: [`${prov.id}-${dayKey(start)}-${h}${mi || "00"}`, prov.id, start.toISOString(), busy ? "booked" : "open", modes] });
      }
    }
  }
  // Kept from the original test plan: Dr. Patel, Fri Oct 16 11:00 AM is always taken (exercises the booking-failure branch).
  stmts.push({ sql: "UPDATE slots SET status = 'booked' WHERE provider_id = 'PR1' AND start = ?", args: [zoned(2026, 10, 16, 11, 0).toISOString()] });
  // ...and the demo patient always has at least two open Patel slots in the first week.
  for (const [m, d, h, mi] of [[10, 13, 9, 30], [10, 15, 14, 0], [10, 19, 16, 30], [10, 21, 8, 0]]) {
    stmts.push({ sql: "UPDATE slots SET status = 'open', modes = 'both' WHERE provider_id = 'PR1' AND start = ?", args: [zoned(2026, m, d, h, mi).toISOString()] });
  }
  await batch(stmts);
}

// ---------------------------------------------------------------- synthetic history (clearly flagged; dashboard can hide it)
const REASONS = ["forgot", "transportation", "schedule_conflict", "cost_or_insurance", "felt_better", "too_sick", "childcare", "injury_or_accident", "other"];
const REASON_W = [0.27, 0.19, 0.17, 0.09, 0.08, 0.06, 0.06, 0.03, 0.05];
const OUTCOME_W: [string, number][] = [["rebooked", 0.38], ["voicemail", 0.17], ["no_answer", 0.1], ["callback_requested", 0.11], ["declined", 0.08], ["not_verified", 0.05], ["opted_out", 0.03], ["wrong_number", 0.03], ["transferred", 0.03], ["no_outcome", 0.02]];
const TASK_FOR: Record<string, [string, string, number][]> = {
  transportation: [["ride_assistance", "normal", 16]],
  cost_or_insurance: [["financial_counselor", "normal", 16]],
  too_sick: [["nurse_callback", "high", 4]],
  injury_or_accident: [["nurse_callback", "high", 4]],
};

function pick<T>(r: () => number, xs: T[], ws: number[]) {
  let x = r() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < xs.length; i++) { x -= ws[i]; if (x <= 0) return xs[i]; }
  return xs.at(-1)!;
}

const PATH_FOR: Record<string, string[]> = {
  rebooked: ["start", "verify", "verify_check", "reason", "get_slots", "offer", "book", "post_book", "confirm", "sms", "end_booked"],
  rebooked_ride: ["start", "verify", "verify_check", "reason", "barrier", "get_slots", "offer", "book", "post_book", "ride_offer", "ride_book", "confirm", "sms", "end_booked"],
  rebooked_taken: ["start", "verify", "verify_check", "reason", "get_slots", "offer", "book", "slot_taken", "book_alt", "post_book", "confirm", "sms", "end_booked"],
  callback_requested: ["start", "verify", "verify_check", "reason", "get_slots", "offer", "preferences", "waitlist", "end_other"],
  declined: ["start", "verify", "verify_check", "reason", "decline", "end_other"],
  not_verified: ["start", "verify", "verify_check", "verify_retry", "verify_check2", "verify_failed", "end_other"],
  opted_out: ["start", "verify", "g_optout", "end_optout"],
  wrong_number: ["start", "end_wrong"],
  transferred: ["start", "verify", "verify_check", "reason", "g_human", "transfer_scheduler"],
  voicemail: ["start", "voicemail"],
  no_answer: ["start"],
  no_outcome: ["start", "verify", "verify_check", "reason"],
};

export async function seedHistory(count = 140, now = Date.now()) {
  const r = rng(Math.floor(now / 864e5));
  const pts = await q("SELECT p.id, w.id AS wid, w.provider_id FROM patients p JOIN worklist w ON w.patient_id = p.id WHERE p.synthetic = 1");
  const stmts: Stmt[] = [];
  const g = (mean: number, sd: number) => Math.max(40, Math.round(mean + sd * (r() + r() + r() - 1.5) * 1.6));
  for (let i = 0; i < count; i++) {
    const p = pts[Math.floor(r() * pts.length)];
    const daysAgo = Math.floor(Math.pow(r(), 0.8) * 14);
    const hour = 9 + Math.floor(r() * 10);
    const pd = parts(now - daysAgo * 864e5);
    const created = zoned(pd.y, pd.m, pd.d, hour, Math.floor(r() * 60));
    if (created.getTime() > now) continue;
    const outcome = pick(r, OUTCOME_W.map((x) => x[0]), OUTCOME_W.map((x) => x[1]));
    const reached = !["voicemail", "no_answer", "wrong_number"].includes(outcome);
    const verified = reached && !["not_verified", "opted_out"].includes(outcome) ? 1 : 0;
    const reason = verified ? pick(r, REASONS, REASON_W) : "";
    let pathKey = outcome;
    if (outcome === "rebooked") pathKey = reason === "transportation" && r() < 0.7 ? "rebooked_ride" : r() < 0.12 ? "rebooked_taken" : "rebooked";
    const path = PATH_FOR[pathKey] ?? ["start"];
    const minutes = outcome === "no_answer" ? 0 : outcome === "voicemail" ? 0.4 + r() * 0.3 : Math.round((0.6 + path.length * 0.22 + r() * 1.2) * 10) / 10;
    const turns = Math.max(1, Math.round(path.length * 1.3));
    const samples = {
      llm: Array.from({ length: turns }, () => g(330, 90)),
      tts: Array.from({ length: turns }, () => g(210, 60)),
      hooks: Array.from({ length: path.filter((n) => ["verify_check", "get_slots", "book", "post_book", "sms", "ride_book", "waitlist", "book_alt"].includes(n)).length }, () => g(420, 220)),
      gaps: Array.from({ length: turns }, () => g(820, 260)),
    };
    const callId = `syn-${created.getTime().toString(36)}-${i}`;
    const tasks: [string, string, number][] = [...(TASK_FOR[reason] ?? [])];
    if (outcome === "callback_requested") tasks.push(["scheduler_callback", "normal", 8]);
    if (outcome === "transferred") tasks.length = 0;
    stmts.push({
      sql: `INSERT INTO calls (call_id, patient_id, worklist_id, status, outcome, disposition, no_show_reason, summary, minutes, price, answered_by, ended_by,
            tags, variables, node_path, stats, pathway_version, verified, reached, tasks_created, synthetic, created_at, started_at, ended_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [callId, p.id, p.wid, "completed", outcome, outcome, reason, `Synthetic call: ${outcome.replace(/_/g, " ")}.`, minutes,
        Math.round(minutes * 0.09 * 1000) / 1000, reached ? "human" : outcome === "voicemail" ? "voicemail" : "unknown", reached ? "ASSISTANT" : "USER",
        "[]", JSON.stringify({ no_show_reason: reason, verified: !!verified }), JSON.stringify(path.map((n) => ({ node_id: n }))),
        JSON.stringify({ samples }), null, verified, reached ? 1 : 0, tasks.length, 1,
        created.toISOString(), created.toISOString(), new Date(created.getTime() + minutes * 60e3).toISOString(), created.toISOString()],
    });
    for (const [type, prio, slaH] of tasks) {
      const done = r() < Math.min(0.92, daysAgo * 0.25);
      stmts.push({
        sql: "INSERT INTO tasks (id, patient_id, call_id, type, details, priority, status, due_at, created_at, completed_at, synthetic) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
        args: [`T-S${i}${type.slice(0, 2)}`, p.id, callId, type, `Synthetic follow-up (${reason || outcome})`, prio, done ? "done" : r() < 0.3 ? "claimed" : "open",
          addBusinessHours(created.getTime(), slaH), created.toISOString(), done ? new Date(created.getTime() + r() * slaH * 3600e3 * 1.3).toISOString() : null],
      });
    }
  }
  await batch(stmts);
  return stmts.length;
}
