# Penny: a no-show rebooking voice agent for Penn Medicine (Bland AI)

Penny is an outbound voice agent built on [Bland AI](https://bland.ai). She calls patients who missed an outpatient visit and works through the call in order:

1. Reach the patient.
2. Verify their identity on the server side.
3. Find out why they missed the visit.
4. Remove the barrier that caused it (a ride, a video visit, a financial counselor).
5. Offer two held appointment slots and book one atomically.
6. Text a confirmation, or put the patient on a waitlist.

At any point in the call, Penny also handles emergencies, mental-health crises, symptoms, clinical and billing questions, scam concerns, opt-outs and language needs.

The repo has three parts:

| Part | What it is |
| --- | --- |
| **Conversational pathway** ([build_pathway.py](build_pathway.py)) | The Bland v1 pathway, defined in code and pushed through the API (42 nodes, 11 global nodes, 16 outcome tags). |
| **Mock patient-access backend and ops console** ([backend/](backend/)) | A Val Town app that stands in for Epic scheduling, the work queue, a ride vendor, an SMS provider and the dialer, plus a live operations dashboard. |
| **Migration to Bland's v2 agent platform** ([migration-penny/](migration-penny/)) | The same agent rebuilt as a v2 agent: parity audit passed and 20/20 simulations green. See [v2 migration](#v2-migration). |

**Live ops console:** https://tahar--dddec02ac01d11f18b0b1607ee4eb77e.web.val.run/ (shows synthetic history plus any live calls; every write requires an admin token)

---

## How a call goes

```
Greeting (static text, AI disclosure up front)
  ├─ someone else answers ─► no details shared, ask for a better time
  ├─ wrong number / voicemail ─► PHI-free close
  └─ patient ─► date of birth ─► POST /verify (server-side check, 2 tries, locks after 3 misses)
                   └─ verified ─► "you missed your <visit> with <provider> on <date>" ─► why?
                        ├─ barrier (ride / cost / childcare) ─► offer ride, video visit or counselor
                        ├─ declined / got care elsewhere ─► respect it, close
                        └─ wants to rebook ─► POST /availability (2 slots held for 10 min)
                              ├─ picks one / asks for a specific time ─► POST /book (atomic, idempotent per call)
                              │     ├─ taken ─► offer the nearest open slot
                              │     └─ booked ─► visit prep + ride check ─► confirm code ─► SMS ─► end
                              ├─ different day/time ─► search again with the new preference
                              └─ nothing works ─► waitlist + scheduler callback task

Anytime (global nodes): emergency → 911 · crisis → 988 + "are you safe?" · symptoms → urgent care + nurse callback
 · clinical / billing question → deferred to a human · visit logistics → knowledge base · "is this a scam?"
 · bad time → callback task · wants a person → warm transfer or callback · stop calling → opt-out · other language
```

The full pass/fail definition (five must-haves and the quality bars) and the test matrix are in [TESTING.md](TESTING.md).

## Architecture

```
 Ops console (GET /)  ──/api/*──►  Val Town val (main.ts, SQLite)  ◄── webhook nodes, mid-call ──  Bland pathway / agent
        ▲                              │   ▲                                                          │
        │ polls                        │   └── /bland/webhook: live events + end-of-call payload ─────┘
        └──────────────────────────────┴──► Bland API: dial, per-call event log, sync, stop, pathway graph
```

- **The backend is the source of truth.** The agent never invents times, confirmation codes or facts; every value it speaks comes from a webhook response.
- **Privacy first.** The date of birth is checked server-side and never echoed back. Nothing about the appointment is said before verification, and nothing is left on voicemail or shared with a third party.
- **Outcomes come from node tags.** Tags such as Rebooked, Waitlist, Declined, Emergency and Opt-out become `pathway_tags`. The end-of-call webhook uses them to set the outcome, create follow-up tasks with SLAs, and advance the worklist retry schedule.
- **Bland Memory is deliberately off.** It could reference a past call to whoever answers the phone, before identity is verified.

## Repo layout

| Path | Purpose |
| --- | --- |
| [build_pathway.py](build_pathway.py) | Defines the whole v1 pathway in code, pushes it, snapshots a named version and publishes it. `--dry-run` writes `pathway.json` without calling the API. |
| [chat_test.py](chat_test.py) | Text-tests the pathway through Bland's chat API, using the same request data a real dial would use. |
| [place_call.py](place_call.py) | Places a real test call to the demo patient through the backend dialer. |
| [check_bland.sh](check_bland.sh) | Checks that the API key in `.env` works. |
| [backend/main.ts](backend/main.ts) | HTTP handler: webhook endpoints, the end-of-call processor and the admin API. |
| [backend/logic.ts](backend/logic.ts) | Pure scheduling logic (no I/O): preference parsing ("Tuesday mornings", "after 3 next week"), slot relaxation, SMS segment counting, outcome classification. |
| [backend/db.ts](backend/db.ts) | SQLite schema, seed data (one dialable demo patient plus synthetic patients), synthetic history. |
| [backend/dashboard.html](backend/dashboard.html) | Ops console: overview KPIs, live calls, call drawer with a latency waterfall, worklist, work queue, schedule, pathway graph. |
| [backend/deploy.py](backend/deploy.py) | Deploys the val to Val Town and sets its environment secrets. |
| [TESTING.md](TESTING.md) | Success criteria, test matrix and results, issues found on live calls and how they were fixed. |
| [migration-penny/](migration-penny/) | The v2 migration (see below). |

## Running it

Create a `.env` file in the repo root. It is gitignored and never committed.

```
BLAND_API_KEY=...      # Bland org API key
VALTOWN_TOKEN=...      # Val Town API token (deploy only)
TRANSFER_NUMBER=...    # optional: real scheduler line for the warm transfer
```

Then run these from the repo root:

```bash
python3 backend/deploy.py
```

```bash
python3 build_pathway.py
```

```bash
python3 chat_test.py "Hello?" "Yes, this is Taha" "March fourteenth, two thousand four"
```

```bash
python3 place_call.py +1XXXXXXXXXX
```

- `deploy.py` deploys the backend, writes `.backend_url`, and generates an `ADMIN_TOKEN` into `.env` on the first run.
- `build_pathway.py` builds, pushes and publishes the pathway, and writes `.pathway_id`.
- `chat_test.py` runs a text conversation with no phone credits used.
- `place_call.py` places a real call (the demo patient only).

Only the demo patient (P1001) can be dialed. Synthetic patients have fictional 555 numbers, and the default transfer number is a reserved fictional 555-01xx number, so test calls never ring a real line.

## Testing

Eleven text scenarios pass on pathway version 9 and later. The two live-phone-call scenarios have not been re-run on the current version yet. The scenarios cover the ride barrier with a taken slot and the nearest alternative, a parent answering, a wrong DOB twice, chest pain, a suicidal statement, a no-show fee question, a robot question followed by an opt-out, a scam concern plus a logistics question plus a re-search, a human request, a car accident with a nurse callback, and a bad time to talk.

Live calls on earlier versions surfaced several bugs that are now fixed. For example, voicemail detection hung up before the PHI-free message played, the agent used a misheard name, and webhooks were slow because the whole state was one JSON blob (1.26 s p50 down to about 110 ms after moving to SQLite). All of these are written up in [TESTING.md](TESTING.md).

## v2 migration

Bland is moving pathways to a new v2 "agents" platform. [migration-penny/](migration-penny/) rebuilds Penny as a v2 agent without touching the live v1 pathway, its phone numbers or the backend. The work uses Bland's `norm` migration plugin: a plan-driven snapshot builder, a byte-level parity audit, and simulation verification.

**Approach**
- **Mechanical carriage, no retyping.** [normalize.cjs](migration-penny/normalize.cjs) and [carry-extras.cjs](migration-penny/carry-extras.cjs) copy every prompt, extraction field, route label, webhook URL and body, tag, global trigger and routing example straight from the v1 export ([v1-export.json](migration-penny/v1-export.json)). They cover the v1 features the plugin's builder doesn't map: webhook speech and extraction, node tags, global nodes, an inline knowledge base, the Wait for Response node, and routing examples.
- **Architecture** ([plan.json](migration-penny/plan.json)):
  - One main flow holds the full call script (27 steps).
  - Each of the 11 safety and support globals is its own section, flagged as a v2 step-level global so it can fire from anywhere. Its trigger text is copied verbatim from v1.
  - The call starts directly on the verbatim greeting.
  - Two root hang-up nodes end the call. Each v1 closing line is spoken verbatim, then the call hangs up immediately, as in v1.
- **Audit:** the parity audit passes. Every v1 prompt, variable, edge label, webhook URL and body, transfer number and warm-transfer brief appears byte-for-byte in [snapshot.json](migration-penny/snapshot.json).
- **Verification:** [sims/](migration-penny/sims/) holds a 20-scenario simulation suite ([suite.json](migration-penny/sims/suite.json)), one scenario per outcome plus safety and honesty probes. Every result is graded on the engine's per-turn trace, not just the judge's text. Write-side tests run against the mock backend, using a synthetic patient for opt-out and wrong-DOB tests. Every test booking is cancelled afterward with the backend's own cancel action ([drain.py](migration-penny/sims/drain.py)).

**Result:** 20 of 20 scenarios green in one sweep on the final version, build 3 ([sweep3.txt](migration-penny/sims/sweep3.txt)), with every lane confirmed on its engine trace. The full write-up is in **[MIGRATION_REPORT.md](migration-penny/MIGRATION_REPORT.md)**.

When a test failed, the same caller lines were replayed against the live v1 pathway ([v1chat.py](migration-penny/sims/v1chat.py)):

- **v2-only failures were fixed:**
  - The endings took extra turns. Fixed in build 2: each closing line goes straight to a hang-up.
  - "Bad time" didn't confirm the callback time. Fixed in build 3; v1 did it 3/3.
- **Failures v1 shares were kept unchanged** and are documented in the report as carried defects. For example, the scheduler-callback step loops if the caller declines the callback.
- **One lane was a test-script problem:** the voicemail persona improvised its greeting. The persona was fixed and the agent left alone.

Earlier sweeps: [build 1](migration-penny/sims/sweep1.txt) ([cont.](migration-penny/sims/sweep1b.txt)) and [build 2](migration-penny/sims/sweep2.txt).

Not covered by simulation (listed in the report): the warm transfer during desk hours, the DOB lockout, and voice-only behavior such as voicemail detection, interruptions and latency. Number cutover from v1 to v2 is a separate, manual decision; the agent isn't published or attached to a number.

## Known limitations and security notes

- **Webhook calls are unauthenticated.** Webhook nodes don't send a shared secret. Setting `BLAND_WEBHOOK_SECRET` enables signature checks on the call webhooks; the mid-call endpoints would need the same in production.
- **Warm transfer is gated.** It only routes when `TRANSFER_NUMBER` is set and the desk is open (Mon–Fri, 8 AM–5 PM ET). The crisis line is deliberately a placeholder, so tests never reach a real crisis service.
- **Synthetic data.** The calendar and worklist are synthetic, and the demo patient's date of birth is fictional.
- **No secrets in the repo.** All keys live in `.env` locally and in Val Town environment variables when deployed.
