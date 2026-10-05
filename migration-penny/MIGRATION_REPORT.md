# Migration report: Penny v1 pathway → v2 agent

| | |
| --- | --- |
| **Source** | v1 pathway `fb2dfe77-f579-4521-8ba1-b16b406fd032`, "Penn Medicine: No-show rebooking (Penny)" (production version 10). Read only; never modified. |
| **Target** | v2 agent `b93214fd-ef8b-49c0-9c35-67be232acf15`, "Penn Medicine No-show rebooking (Penny) (v2)" |
| **Final version** | `749bc3fd-3450-4e0d-ba30-0b18f6a704ce`, "Migration from v1 pathway (prod v10) - build 3 (callback confirmation)" |
| **Organization** | `d7421d55-f2ce-4dff-8bc6-43e91f9e5cab` (same org as the v1 pathway; checked before the first write) |
| **Result** | Parity audit passed. 20/20 simulations green in one sweep on the final version, each confirmed on the engine trace. |
| **Not done (by design)** | No phone number attached, nothing published or promoted, and the backend dialer still calls the v1 pathway. Cutover is a separate decision for you. |

## In plain language

Penny now exists as a v2 agent that behaves like the v1 pathway.

- **Carried exactly.** Every sentence she says, every question she asks, every backend call and every outcome tag was copied from v1 automatically, never retyped. A machine check confirms it byte for byte.
- **Tested.** Twenty simulated callers then exercised every outcome: rebooked, ride, waitlist, declined, wrong number, voicemail, not verified, emergency, crisis, symptoms, billing and medical questions, scam worry, bad time, wants a person, opt-out, Spanish, other language, and the "are you a robot?" question. All twenty passed on the final version.
- **Compared against v1 when tests failed.** Where a test failed, the same conversation was replayed against the live v1 pathway. Problems v1 doesn't have were fixed (two of them). Problems v1 also has were left as is and are listed below, so v2 doesn't quietly behave differently from what you run today.

## How it was built

1. **Normalize the export.** [normalize.cjs](normalize.cjs) reads the export ([v1-export.json](v1-export.json)) and maps three v1 node shapes the plugin's builder doesn't handle: Wait for Response, webhook `responseData`, and the inline Knowledge Base text.
2. **Architecture plan.** [plan.json](plan.json) holds the judgment calls (sections, entry descriptions, hub prompt). The system prompt is the v1 global prompt, verbatim.
3. **Build the snapshot.** The `norm` plugin's deterministic builder carries the content into [snapshot.json](snapshot.json).
4. **Carry the rest.** [carry-extras.cjs](carry-extras.cjs) copies what the builder doesn't, straight from the v1 bytes: webhook speech and extraction, node tags, global flags, and routing examples. It also applies the evidence-based fixes listed below.
5. **Audit.** `norm-migrate-audit` checks structure, routing-crash risks, and byte parity against the v1 export: prompts, URLs, transfer numbers and the global prompt.
6. **Verify.** [sims/](sims/) holds the 20-scenario suite ([suite.json](sims/suite.json)), the runner, the v1 differential replayer ([v1chat.py](sims/v1chat.py)) and the booking cleanup ([drain.py](sims/drain.py)).

## Architecture and disposition of every v1 node

| v1 | v2 | Count |
| --- | --- | --- |
| Main call script (greeting → verify → reason → barrier → slots → offer → book → ride → confirm → SMS → waitlist / decline) | One section, **"Penny rebooking call"**. The call starts directly on the static greeting. | 27 nodes |
| Global nodes | One section each, with the v1 `globalLabel` as the verbatim entry description, flagged as v2 step-level globals so they fire from anywhere. Globals with no routes in v1 auto-return to the interrupted step, as `{{prevNodePrompt}}` did. Globals with routes keep them. | 11 globals |
| Nodes reached only from a global (911 ending, opt-out ending, warm transfer, scheduler callback) | Inside their global's section | 4 nodes |
| End Call nodes | Steps that speak their verbatim line, then hang up immediately (see build 2) | 6 nodes |
| Wait for Response node ("5. Offer appointment times") | Native v2 `waitForResponse` step | 1 node |
| Knowledge Base node (inline FAQ text) | Prompt step with the FAQ text appended verbatim. No org knowledge base was created. | 1 node |
| (new) | Hub (a v2 requirement; only a safety net) plus 2 top-level hang-ups | 3 nodes |

## Fixes made during verification (with evidence)

| Build | Problem | Evidence | Fix |
| --- | --- | --- | --- |
| 2 | Calls didn't hang up after the closing line. v2 waited for the caller, detoured through the hub, and traded extra "Goodbye"s. | The build 1 compiled graph showed the flow exit had no outgoing route; engine traces in sims 01 and 16. v1 hangs up immediately (v1 replay, 3/3). | v1 End Call steps speak and leave the flow without waiting. Explicit top-level routes go from each section to the matching hang-up: "closing already said" is a static silent `.`, and "goodbye" speaks v1's End: no booking line verbatim. |
| 3 | "Bad time to talk" said goodbye without confirming the callback time. | v1 replay of the same caller lines: "Okay, I'll call you back after six PM tonight", 3/3. v2: missing. | The "goodbye" hang-up keeps v1's line verbatim plus one added sentence: *"If the caller just gave a time for a callback, first confirm briefly that you'll call back then."* This is the only non-verbatim prompt text in the agent. |

The test script was also fixed: the voicemail persona improvised "I'm not available right now" instead of a machine greeting. v1 routes that line the same way (3/3), so the agent was left alone and the persona now says the greeting word for word.

## Behavioral differences from v1 (accepted)

- **Interruption settings.** The per-node settings (the 911 line, reading the confirmation code) are not active in v2. v2 uses one call-level setting, so set it under the agent's Calls → Conversation feel if needed.
- **Routing examples.** v1 `pathwayExamples` on "reason" and "offer" are carried as example caller replies inside the matching route descriptions.
- **Global sections.** The 11 globals are separate sections rather than floating nodes. They are still flagged global, so they fire mid-flow.
- **Silent hang-up.** After a closing line, the hang-up step emits a static `.`, so nothing extra is spoken.
- **Human-handoff variance.** The trigger is byte-identical to v1. Across 6 v2 runs of the "wants a real person" test it missed once (the first sweep): the caller said "that's me… I want a real person" in one breath, and Penny asked for the date of birth first. One other run caught it a turn later and still promised the callback. v1 caught it 3/3; v2 passed 5 of 6, including the final sweep. Recorded as routing variance; watch it in production.

## v1 defects carried over unchanged (bug for bug)

These behave the same way in v1 (confirmed by v1 replay where noted). Fixing them in v2 would make it silently diverge from what you run today.

1. **Callback loop.** "Scheduler callback promised" has only one exit ("Callback arranged"). If the caller declines the callback, the agent repeats "Okay, take care" until the caller hangs up. Confirmed in v1 (2/3 replays; the third looped the same way in "Bad time").
2. **The "wants a person" trigger can over-fire.** "I already said I'd call back myself" can read as frustration with the assistant. Same in v1.
3. **Bad-time task detail.** The bad-time webhook fires when the step is entered, before the caller names a time, so the backend task can contain the literal text `{{better_time}}`. The webhook is the same as v1's.
4. **Literal `{{pickup_time}}`.** The confirm step says "If `{{pickup_time}}` is filled in…". When no ride was booked, the variable is unset and the literal placeholder reaches the model. Same as v1.
5. **Crisis step has no exit.** Penny stays with the caller (intended: "Stay with them"), so the call ends only when the caller hangs up.
6. **Ambiguous voicemail greetings.** An answering-machine greeting that sounds like a person ("I'm not available right now") routes to "someone else answered", not voicemail. Same in v1. On real calls, Bland's call-level voicemail detection (set by your dialer) handles machines first.

## What each call needs (request-data contract)

These must be supplied per call; your backend's `/api/request-data/:patient_id` already builds them:

| Field | Notes |
| --- | --- |
| `patient_id`, `worklist_id` | Sent to every webhook |
| `patient_first_name` | Spoken in the greeting; the system prompt pins it as the name to use |
| `appointment_type`, `provider_name`, `missed_date` | Spoken only after verification |
| `telehealth_ok` | Must be `yes` / `no` |
| `location` | Also returned by `/post-book` |
| `preferred_language` | Mentioned only in a builder note |

Built-in: `call_id`. Produced during the call: `dob_given`, `verified`, `locked`, `time_preference`, `visit_mode`, `slot_1`, `slot_2`, `relaxed_note`, `chosen_slot`, `booked_slot`, `confirmation_spoken`, `prep`, `ride_needed`, `pickup_time`, `callback_window` and others.

## Integrations and test safety

All 13 webhooks call your own Val Town mock backend; nothing reaches a real patient, provider, SMS carrier or ride vendor.

| Type | Endpoints |
| --- | --- |
| Reads | `/verify` (logs an attempt; locks after 3 misses), `/availability` (holds slots for 10 minutes), `/post-book` |
| Writes | `/book`, `/ride`, `/sms` (mock outbox), `/waitlist`, `/task`, `/optout`, `/handoff` (creates a callback task when the desk is closed) |
| Transfer | `+12155550100`, a reserved fictional 555-01xx number. Transfers are inert in simulations. |

**Test patients.** Booking lanes used the demo patient P1001; opt-out, wrong-DOB, bad-time, human-request and language lanes used synthetic patient P1003, so P1001 was never opted out or locked.

**Test data left in the demo backend:**

| Item | Status |
| --- | --- |
| 7 test bookings (PM-455000, PM-222166, PM-834641, PM-609617, PM-611733, PM-331091, PM-984314) | All cancelled with the backend's own admin cancel action, which reopens the slot (verified `ok: true`). |
| 3 mock ride bookings | The backend has no cancel action for rides. They are in the `rides` table for P1001. |
| 6 mock SMS outbox entries, 3 waitlist entries, 3 bad-time tasks, 7 handoff callback tasks | Created by test calls. Clear them from the ops console, or reset demo data. |
| P1003 (James, synthetic) | Opted out 4 times by test 17. P1003 is synthetic and not dialable. |
| Verification attempts for P1001 / P1003 | Logged in `verifications`. |
| 20 Bland test scenarios ("MIG-PENNY: …") | Attached to the v2 agent. They use 20 of your plan's 21 scenario slots, so delete some if you need slots back. |

## Security notes

- **No secrets in the pathway.** It has no auth headers or other credentials, so nothing needs rotating because of the export.
- **Unauthenticated webhooks.** The webhook endpoints take no auth, so anyone with the URL can call `/verify`, `/book` or `/optout`. For anything beyond a demo, add a shared secret (the webhook steps support `auth`).
- **Temporary API key.** The migration used the Bland API key in `.env`. **Delete or rotate it in the Bland dashboard** (Settings → API keys) now that the migration is finished, if it was created only for this.

## Lanes not proven by simulation

| Lane | Why not |
| --- | --- |
| Warm transfer to the scheduling desk | Only offered when `TRANSFER_NUMBER` is set and the desk is open (Mon–Fri, 8 AM–5 PM ET). Transfers don't dial in simulations. Needs a coordinated live call. |
| Slot taken → nearest alternative → book it (6a/6b) | Data-gated. It happened by chance once on build 1 (test 02: `slot_taken` → alternative booked, passed), but was not re-exercised on the final version. |
| DOB lockout (3 misses in 30 minutes) | Would lock a patient record. It routes to the same "not verified" step as the covered wrong-DOB lane. |
| Voice-only behavior | Voicemail detection, interruptions, TCPA guard rails, warm-transfer audio and latency need a real phone call to the demo patient. |

## Process note

The plugin's completion tracker released itself once as "stalled" while the first sweep was running and the session was paused. It was re-armed afterward. Its final records come from real events only: the push of build 3, and the full green sweep on that exact version (`sims/sweep3.txt`).

## Next steps (yours)

1. Place one real phone call to the v2 agent covering a happy path and a "real person" request, ideally during desk hours with `TRANSFER_NUMBER` set.
2. When you're satisfied, publish and promote the agent, then point the backend dialer at the v2 agent. That's a separate cutover; the v1 pathway keeps working until then.
3. Delete or rotate the temporary API key.
