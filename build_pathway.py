"""Builds the Penn Medicine no-show rebooking pathway and pushes it to Bland.

Usage: python3 build_pathway.py            # updates the pathway, then snapshots + publishes a named version
       python3 build_pathway.py --dry-run  # prints node/edge counts and writes pathway.json, no API calls
The pathway id is saved to .pathway_id so later runs update in place.

Bland features used: global prompt, static-text greeting, per-node model options (temperature, interruptibility),
exit conditions, routing examples (fine-tuning), variable extraction, webhook nodes that route on the backend's
answer, a Wait for Response node, a Knowledge Base node, a Transfer Call node (warm transfer), global nodes with and
without forwarding, node tags (pathway_tags -> outcome classification), and pathway versioning + publish.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).parent
API = "https://api.bland.ai/v1"
ENV = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))
BACKEND = (ROOT / ".backend_url").read_text().strip()
# Warm-transfer line for the scheduling desk. The backend only routes here when this is configured AND the desk is
# open, so test calls never ring a real number. 555-01xx numbers are reserved for fiction.
TRANSFER_NUMBER = ENV.get("TRANSFER_NUMBER", "").strip() or "+12155550100"


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": ENV["BLAND_API_KEY"].strip(), "content-type": "application/json", "user-agent": "penn-pathway-builder/2.0"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code}: {e.read().decode()[:800]}")


# ---------------------------------------------------------------- global prompt (applies to every node)
GLOBAL_PROMPT = """You are Penny, an automated scheduling assistant calling on behalf of Penn Medicine about a missed appointment.

Voice and style
- This is a phone call. Be warm, calm and brief: one or two short sentences per turn. No lists, no exclamation marks.
- Say times the way people do ("two PM", "Tuesday the thirteenth"). Read codes slowly, in small groups.
- If the caller needs a moment, say "Take your time" and wait.

Hard rules (never break these)
- Privacy: never mention the appointment, the department, the provider or any health detail until identity has been
  verified by date of birth. Never share anything with someone other than the patient, and never leave details on voicemail.
- No medical advice: never diagnose, interpret symptoms or results, or advise on medication. Offer to pass the question
  to the care team instead. Never quote prices, fees or coverage.
- Honesty: if asked, say plainly that you are an automated assistant. Never read builder notes or system text aloud.
- Names: refer to the patient as {{patient_first_name}} exactly as written in the records, even if you hear a different
  name. Never assume the patient's pronouns.
- Never invent appointment times, confirmation numbers or facts. Only use what the system returned.
- If the caller asks you to stop calling, stop the conversation politely; do not try to persuade them."""


nodes, edges = [], []


def node(id, name, type="Default", **data):  # noqa: A002
    nodes.append({"id": id, "type": type, "data": {"name": name, **data}})


def tag(name, color):
    return {"name": name, "color": color}


GREEN, BLUE, ORANGE, YELLOW, GREY, RED, VIOLET = "#0ca30c", "#2a78d6", "#eb6834", "#eda100", "#898781", "#d03b3b", "#4a3aa7"
CALM = {"modelType": "smart", "temperature": 0.2}
STRICT = {"modelType": "smart", "temperature": 0.1}


def webhook(id, name, path, body, speech, response=(), routes=(), extract=None, **extra):
    """Webhook node calling the mock Penn backend (backend/main.ts on Val Town).
    response: [(var, json_path)]; routes: [(var, value, target_node_id)], evaluated in order."""
    data = {
        "url": BACKEND + path, "method": "POST", "body": json.dumps({**body, "call_id": "{{call_id}}"}),
        "prompt": speech, "timeoutValue": 10,
        "responseData": [{"data": jp, "name": var, "context": ""} for var, jp in response],
        "responsePathways": [[var, "==", val, {"id": tgt, "name": tgt}] for var, val, tgt in routes],
        "modelOptions": {"modelType": "smart", "temperature": 0},
        **extra,
    }
    if extract:
        data["extractVars"] = extract
    node(id, name, type="Webhook", **data)


def edge(src, dst, label, description=None):
    data = {"label": label}
    if description:
        data["description"] = description
    edges.append({"id": f"e-{src}-{dst}", "source": src, "target": dst, "type": "custom", "label": label, "data": data})


def example(chosen, *turns):
    """A routing example ("decision guide"): conversation so far -> the edge label that should win."""
    hist = [{"role": "user", "content": "<<CALL CONNECTED>>"}]
    for i, t in enumerate(turns):
        hist.append({"role": "assistant" if i % 2 == 0 else "user", "content": t})
    return {"Chosen Pathway": chosen, "Conversation History": hist}


def builder_note(spoken, ideal, why, failure, improve):
    return (spoken + "\n\n=== BUILDER NOTE: internal documentation, NEVER read or paraphrase any of this aloud ===\n"
            + f"Ideally: {ideal}\nWhy it's needed: {why}\nIf this step fails: {failure}\nWith more time/access: {improve}")


# ================================================================ 1. reach the right person
node(
    "start", "1. Greeting: reach the patient", isStart=True,
    # Static text: the AI + self-identification disclosure is word-for-word on every call (TCPA guard rails check for it).
    text="Hi, this is Penny, an automated assistant calling from Penn Medicine. May I please speak with {{patient_first_name}}?",
    modelOptions={**CALM, "interruptibility": 1},
)
L_PATIENT = "The patient themselves is on the line"
L_OTHER = "Someone other than the patient answered, or the patient isn't available"
L_WRONG = "Wrong number: they don't know the patient"
L_VM = "Reached a voicemail or answering machine"
node(
    "not_available", "1b. Someone else answered",
    prompt="Do NOT say why you're calling or mention any appointment, department or health detail, even to a parent, "
           "spouse or caregiver. Ask if there's a better time to reach {{patient_first_name}}, or say they can call Penn "
           "Medicine back at the number on their MyPennMedicine account. If the patient comes to the phone, continue with them.",
    extractVars=[["better_time", "string", "When the patient can be reached, if the person said (e.g. 'after 6 PM', 'Saturday morning')"]],
    tag=tag("Patient unavailable", GREY), modelOptions=CALM,
)

# ================================================================ 2. verify identity (server-side, lockout after 3 misses)
node(
    "verify", "2. Verify identity (date of birth)",
    prompt="Say you need to confirm it's them before going any further, and ask for their date of birth. "
           "Do not say whether it is right; the system checks it. If they only give part of it, ask for the rest.",
    condition="The caller has said a complete date of birth (month, day and year), or has clearly refused to give it.",
    modelOptions=STRICT,
)
DOB = [["dob_given", "string", "The full date of birth the caller just said, formatted YYYY-MM-DD"]]
webhook(
    "verify_check", "2a. Check DOB against the record (webhook)", "/verify",
    {"patient_id": "{{patient_id}}", "dob": "{{dob_given}}"},
    "Say only: 'Thank you, one moment.'",
    response=[("verified", "$.verified"), ("locked", "$.locked")],
    routes=[("locked", "true", "verify_failed"), ("verified", "true", "reason"), ("verified", "false", "verify_retry")],
    extract=DOB,
)
node(
    "verify_retry", "2b. DOB didn't match: ask once more",
    prompt="Say politely that it didn't match what you have, and ask them to say their date of birth once more: month, "
           "day and year. Do not hint at the right answer or say which part was wrong.",
    condition="The caller has said a complete date of birth again, or has refused.",
    modelOptions=STRICT,
)
webhook(
    "verify_check2", "2c. Second DOB check (webhook)", "/verify",
    {"patient_id": "{{patient_id}}", "dob": "{{dob_given}}"},
    "Say only: 'Thanks, one moment.'",
    response=[("verified", "$.verified"), ("locked", "$.locked")],
    routes=[("verified", "true", "reason"), ("verified", "false", "verify_failed"), ("locked", "true", "verify_failed")],
    extract=DOB,
)
node(
    "verify_failed", "2d. Identity not verified",
    prompt="Say you're not able to confirm the details over the phone, so you can't go further today. Ask them to call "
           "Penn Medicine at the number on their MyPennMedicine account or appointment letter. Reveal nothing about the "
           "appointment. Wrap up politely.",
    tag=tag("Not verified", YELLOW), modelOptions=CALM,
)

# Only the patient's own words count: Penny mentioning that video is possible must not flip this.
VISIT_MODE = ["visit_mode", "string", "'video' ONLY if the patient themselves explicitly asked for a video, virtual or telehealth visit; "
                                      "otherwise 'in_person'. Ignore the assistant saying video is an option."]

# Questions the caller may slip in alongside an answer ("I forgot. Is there a fee?"). The globals catch them when they're
# the whole turn; extracting them here too means a mixed turn still lands in the work queue.
SIDE_QUESTIONS = [["billing_question", "string", "Any question the caller asked about bills, fees, cost or insurance, word for word; empty if none"],
                  ["clinical_question", "string", "Any medical or medication question the caller asked; empty if none"]]

# ================================================================ 3. why was it missed
L_OPEN = "Patient is open to rescheduling, forgot, or had a schedule conflict"
L_BARRIER = "Patient missed it because of a logistics barrier: transportation, cost, insurance or childcare (NOT an accident, injury or illness)"
L_DECLINE = "Patient doesn't want to reschedule, already rescheduled, or got care elsewhere"
node(
    "reason", "3. Explain the missed visit and ask why",
    prompt="Tell them: 'Our records show you missed your {{appointment_type}} with {{provider_name}} on {{missed_date}}. "
           "We just wanted to check in and help you get it rescheduled.' Then gently ask if everything is okay and whether "
           "something got in the way. Listen without judgment. Do not lecture about missed appointments or mention fees. "
           "If they mention an injury, accident, new illness or feeling unwell, first ask whether they are okay now.",
    extractVars=[
        ["no_show_reason", "string", "One of: forgot, transportation, cost_or_insurance, schedule_conflict, felt_better, "
                                     "too_sick, injury_or_accident, childcare, got_care_elsewhere, already_rescheduled, other"],
        ["safety_concern", "boolean", "Patient mentioned a recent injury, accident or feeling unwell"],
        *SIDE_QUESTIONS,
    ],
    pathwayExamples=[
        example(L_BARRIER, "Our records show you missed your dermatology follow-up... did something get in the way?", "Honestly I didn't have a way to get there, my car's in the shop."),
        example(L_OPEN, "Our records show you missed your dermatology follow-up... did something get in the way?", "Oh shoot, I totally forgot about it."),
        example(L_OPEN, "Our records show you missed your dermatology follow-up... did something get in the way?", "Work ran late, I couldn't get out."),
        example(L_DECLINE, "Our records show you missed your dermatology follow-up... did something get in the way?", "I ended up seeing someone closer to home, so I don't need it."),
        example(L_BARRIER, "Our records show you missed your dermatology follow-up... did something get in the way?", "I wasn't sure my insurance would cover it."),
    ],
    tag=tag("Verified", BLUE), modelOptions=CALM,
)
node(
    "barrier", "4. Address a barrier (ride / cost / childcare)",
    prompt="Acknowledge the barrier in one sentence. If transportation: say Penn Medicine can often arrange a ride to the "
           "visit, and if {{telehealth_ok}} is 'yes', that a video visit from home is also an option. If cost or insurance: "
           "say a financial counselor can call them to go over options; do not quote prices or coverage. If childcare: "
           "mention a video visit if {{telehealth_ok}} is 'yes', or an earlier or later time of day. Then ask if they'd like "
           "to pick a new time, and whether in person or by video.",
    extractVars=[["needs_ride_help", "boolean", "Patient wants help arranging transportation"],
                 ["needs_financial_counselor", "boolean", "Patient wants a financial counselor to call"],
                 VISIT_MODE],
    modelOptions=CALM,
)

# ================================================================ 4-5. find and offer times (backend holds offered slots for 10 min)
PREF = [["time_preference", "string", "Days or times the patient said work for them (e.g. 'Tuesday mornings', 'after 3 next week'), or 'any' if they didn't say"],
        VISIT_MODE]
webhook(
    "get_slots", "4b. Look up open times (webhook)", "/availability",
    {"patient_id": "{{patient_id}}", "worklist_id": "{{worklist_id}}", "preference": "{{time_preference}}", "visit_mode": "{{visit_mode}}"},
    "Say only: 'Let me pull up the schedule.'",
    response=[("found", "$.found"), ("slot_1", "$.slot_1"), ("slot_2", "$.slot_2"), ("relaxed_note", "$.relaxed_note"), ("video_available", "$.video_available")],
    routes=[("found", "true", "offer"), ("found", "false", "preferences")],
    extract=PREF,
)
L_PICK = "Patient picked one of the offered times, OR asked for one specific date and time to be checked"
L_REFINE = "Patient turned down the offered times AND named a different day, part of the day or week to try (not one specific time)"
L_NONE = "None of the times work and the patient has no other preference to try"
node(
    # Wait for Response: the patient often says "hold on, let me check my calendar".
    "offer", "5. Offer appointment times", type="Wait for Response",
    prompt="If {{relaxed_note}} is not empty, say it first in your own words. Offer exactly these two times and nothing else: "
           "{{slot_1}} or {{slot_2}}. If {{telehealth_ok}} is 'yes', mention that either can be a video visit. "
           "NEVER invent, guess or adjust a time: you only know these two. If they ask for a different specific date and "
           "time, say 'Let me check that for you.' If they want to check their calendar, tell them to take their time.",
    pathwayExamples=[
        example(L_PICK, "I have Tuesday, October 13th at 9:30 AM or Thursday, October 15th at 2:00 PM. Would either work?", "The Tuesday one."),
        example(L_PICK, "I have Tuesday, October 13th at 9:30 AM or Thursday, October 15th at 2:00 PM. Would either work?", "Can you do Friday the 16th at 11?"),
        example(L_REFINE, "I have Tuesday, October 13th at 9:30 AM or Thursday, October 15th at 2:00 PM. Would either work?", "Not really, do you have anything on a Monday afternoon?"),
        example(L_NONE, "I have Tuesday, October 13th at 9:30 AM or Thursday, October 15th at 2:00 PM. Would either work?", "No, my schedule is all over the place right now."),
    ],
    condition="The patient has picked one of the offered times, asked for a specific time, named a different day or time "
              "of day to try, said none of the times work, or said they don't want to reschedule.",
    extractVars=SIDE_QUESTIONS,
    modelOptions=CALM,
)
webhook(
    "refine", "5b. Search again with the new preference (webhook)", "/availability",
    {"patient_id": "{{patient_id}}", "worklist_id": "{{worklist_id}}", "preference": "{{time_preference}}", "visit_mode": "{{visit_mode}}"},
    "Say only: 'Let me look.'",
    response=[("found", "$.found"), ("slot_1", "$.slot_1"), ("slot_2", "$.slot_2"), ("relaxed_note", "$.relaxed_note")],
    routes=[("found", "true", "offer"), ("found", "false", "preferences")],
    extract=PREF,
)

# ================================================================ 6. book (atomic compare-and-set on the slot; idempotent per call)
webhook(
    "book", "6. Book the slot (webhook)", "/book",
    {"patient_id": "{{patient_id}}", "worklist_id": "{{worklist_id}}", "slot": "{{chosen_slot}}", "visit_mode": "{{visit_mode}}"},
    "Say only: 'Great, let me lock that in.'",
    response=[("booked", "$.booked"), ("confirmation", "$.confirmation"), ("confirmation_spoken", "$.confirmation_spoken"),
              ("booked_slot", "$.slot"), ("alternative_slot", "$.alternative_slot"), ("book_failure", "$.reason")],
    routes=[("booked", "true", "post_book"), ("booked", "false", "slot_taken")],
    extract=[["chosen_slot", "string", "The date and time the patient chose or asked for, written like 'Tuesday, October 13th at 9:30 AM'"],
             VISIT_MODE],
)
node(
    "slot_taken", "6a. That time isn't available",
    prompt="If {{book_failure}} is 'video_not_offered', say that time is in person only. Otherwise apologise briefly: that "
           "time isn't open. Offer the closest open time, {{alternative_slot}}, and ask if that works.",
    modelOptions=CALM,
)
webhook(
    "book_alt", "6b. Book the alternative (webhook)", "/book",
    {"patient_id": "{{patient_id}}", "worklist_id": "{{worklist_id}}", "slot": "{{alternative_slot}}", "visit_mode": "{{visit_mode}}"},
    "Say only: 'Perfect, one moment.'",
    response=[("booked", "$.booked"), ("confirmation", "$.confirmation"), ("confirmation_spoken", "$.confirmation_spoken"), ("booked_slot", "$.slot")],
    routes=[("booked", "true", "post_book"), ("booked", "false", "preferences")],
)

# ================================================================ 7. after booking: ride, prep, confirm, text
webhook(
    "post_book", "6c. Visit prep + ride check (webhook)", "/post-book",
    {"patient_id": "{{patient_id}}", "needs_ride_help": "{{needs_ride_help}}", "no_show_reason": "{{no_show_reason}}"},
    "Say only: 'You're all set.'",
    response=[("ride_needed", "$.ride_needed"), ("prep", "$.prep"), ("location", "$.location")],
    routes=[("ride_needed", "true", "ride_offer"), ("ride_needed", "false", "confirm")],
)
node(
    "ride_offer", "7a. Offer to book a ride",
    prompt="Since getting there was hard last time, offer to book a free ride to and from the visit right now. Ask if they'd like that.",
    modelOptions=CALM,
)
webhook(
    "ride_book", "7b. Book the ride (mock transport vendor, webhook)", "/ride",
    {"patient_id": "{{patient_id}}"},
    "Say only: 'Booking that now.'",
    response=[("ride_booked", "$.ride_booked"), ("pickup_time", "$.pickup_time")],
    routes=[("ride_booked", "true", "confirm"), ("ride_booked", "false", "confirm")],
)
node(
    "confirm", "7. Confirm and prep",
    prompt="Confirm the new visit: {{booked_slot}} with {{provider_name}}. Read the confirmation code slowly as: "
           "{{confirmation_spoken}}. If {{pickup_time}} is filled in, say the ride pickup is at {{pickup_time}}. Share this prep "
           "in one sentence: {{prep}}. Say a text with the details is on the way, and a reminder will come the day before. "
           "If they asked for a financial counselor, say someone will call about that. Ask if there's anything else.",
    tag=tag("Rebooked", GREEN), modelOptions={**CALM, "interruptibility": 1},
)
webhook(
    "sms", "7c. Send text confirmation (webhook)", "/sms",
    {"patient_id": "{{patient_id}}"},
    "Say only: 'I've just sent that to you by text.'",
    response=[("sms_sent", "$.sent")],
    routes=[("sms_sent", "true", "end_booked"), ("sms_sent", "false", "end_booked")],
)

# ================================================================ 8. nothing works: waitlist + scheduler callback
node(
    "preferences", "8. No time works: capture preferences",
    prompt="Say you can put them on the cancellation list, so if something opens up that fits they'll get a text, and a "
           "scheduler will also call them back. Ask which days and times generally work best. Confirm it back briefly.",
    extractVars=[["callback_preference", "string", "Days and times that work for the patient"]],
    modelOptions=CALM,
)
webhook(
    "waitlist", "8a. Add to waitlist + scheduler callback task (webhook)", "/waitlist",
    {"patient_id": "{{patient_id}}", "worklist_id": "{{worklist_id}}", "preference": "{{callback_preference}}"},
    "Say only: 'Okay, you're on the list, and a scheduler will call you within one business day.'",
    response=[("waitlist_position", "$.position")],
    tag=tag("Waitlist", ORANGE),
)
node(
    "decline", "9. Patient doesn't want to reschedule",
    prompt="Respect their choice; don't push more than once. If they got care elsewhere or already rescheduled, thank them. "
           "If they feel better, say that's good to hear and that they can always call the number on their MyPennMedicine "
           "account if anything changes. Wrap up warmly.",
    extractVars=[["decline_reason", "string", "Why the patient declined to reschedule"]],
    tag=tag("Declined", GREY), modelOptions=CALM,
)

# ================================================================ endings
node("end_booked", "End: rebooked", type="End Call", prompt="Thank {{patient_first_name}}, say you look forward to seeing them, and say goodbye.")
node("end_other", "End: no booking", type="End Call", prompt="Thank them for their time and say goodbye politely. No health details.")
node("end_wrong", "End: wrong number", type="End Call", tag=tag("Wrong number", GREY),
     prompt="Apologise for the mix-up, say you'll update the records, and say goodbye. Do not repeat the patient's name or any health detail.")
node("end_emergency", "End: emergency, told to call 911", type="End Call", tag=tag("Emergency", RED),
     prompt="Say: 'Please call 911 now. Take care.' Then end the call.")
node("end_optout", "End: opted out", type="End Call", prompt="Say: 'Understood. You won't get these automated calls from us again. Take care.'")
node("voicemail", "Voicemail (no health information)", type="End Call", tag=tag("Voicemail", GREY),
     prompt="Leave this voicemail exactly, then hang up: 'Hi, this is Penny, an automated assistant calling from Penn Medicine "
            "for {{patient_first_name}}. Please call us back at the number on your MyPennMedicine account. Thank you.'")

# ================================================================ global nodes (reachable from anywhere)
node(
    "g_emergency", "GLOBAL: Medical emergency", isGlobal=True,
    globalLabel="Caller describes a possible medical emergency right now: chest pain, trouble breathing, stroke signs, "
                "severe bleeding, fainting, or says they are in danger",
    prompt="Stop everything else. Say calmly and clearly: 'This sounds like it could be an emergency. Please hang up and "
           "call 911 right now, or have someone near you call.' Say it once; repeat only if they ask again or seem unsure. No scheduling, no symptom questions.",
    tag=tag("Emergency", RED), modelOptions={"modelType": "smart", "temperature": 0, "interruptibility": 0},
)
node(
    "g_crisis", "GLOBAL: Mental health crisis", isGlobal=True,
    globalLabel="Caller expresses thoughts of suicide or self-harm, or says they are in emotional crisis",
    prompt=builder_note(
        "Respond with care, slowly. Say you're really glad they told you. Say they can call or text 988, the Suicide and "
        "Crisis Lifeline, any time, day or night, or call 911 if they are in immediate danger. Ask: 'Are you safe right "
        "now?' Stay with them. Do not return to scheduling unless they clearly want to.",
        ideal="Warm-transfer to 988 or Penn's behavioral health crisis line while staying on the line.",
        why="Giving a number is weaker than a connected handoff.",
        failure="Repeat 988 and 911. The Crisis tag makes the backend open an urgent same-day clinical review task.",
        improve="Transfer Call node to the crisis line (not wired in the demo so test calls never reach a real crisis line).",
    ),
    tag=tag("Crisis", RED), modelOptions={"modelType": "smart", "temperature": 0, "interruptibility": 2},
)
node(
    "g_symptoms", "GLOBAL: Recent injury or ongoing symptoms (not an emergency)", isGlobal=True,
    globalLabel="Caller mentions a recent accident, injury, new illness, pain or symptoms they still have, or says they "
                "haven't been feeling well, and it is NOT an obvious emergency",
    prompt="Pause scheduling. Say you're sorry to hear it and ask if they're okay now, and whether they still have pain or "
           "symptoms today. Do not assess or advise. If they still have symptoms, say: 'Please reach out to your doctor or "
           "an urgent care today about that, and if it gets severe, call 911.' Offer to have a nurse from the care team "
           "call them. Then ask if they'd still like to reschedule the original visit.",
    extractVars=[["ongoing_symptoms", "string", "Symptoms or injury the patient still has, if any"],
                 ["nurse_callback_requested", "boolean", "Patient wants a nurse to call them"]],
    modelOptions=CALM,
)
node(
    "g_clinical", "GLOBAL: Non-urgent medical question", isGlobal=True,
    globalLabel="Caller asks a medical or medication question that isn't an emergency (test results, whether to keep "
                "taking a medicine, what a symptom means)",
    prompt="Say you're not able to answer medical questions, but you'll make sure their care team gets it and follows up "
           "through MyPennMedicine or a call. Then return to where you left off: {{prevNodePrompt}}",
    extractVars=[["clinical_question", "string", "The medical question to pass to the care team"]],
    modelOptions=CALM,
)
node(
    "g_billing", "GLOBAL: Billing or insurance question", isGlobal=True,
    globalLabel="Caller asks about a bill, a no-show fee, cost, or insurance coverage",
    prompt="Say you don't have access to billing details, but a billing specialist can call them back. Never confirm or "
           "deny a no-show fee. Then return to where you left off: {{prevNodePrompt}}",
    extractVars=[["billing_question", "string", "The billing or insurance question"]],
    modelOptions=CALM,
)
node(
    "g_logistics", "GLOBAL: Visit logistics questions (knowledge base)", type="Knowledge Base", isGlobal=True,
    globalLabel="Caller asks a practical question about the visit: where it is, what to bring, how long it takes, how "
                "video visits work, how to cancel or reschedule, interpreters, or MyPennMedicine",
    prompt="Answer the question in one or two sentences using only the knowledge base and these facts: the visit is with "
           "{{provider_name}} at {{location}}. If the answer isn't there, say you're not sure and that the details will be "
           "in their confirmation text. Only discuss visit details if identity has already been verified. "
           "Then return to where you left off: {{prevNodePrompt}}",
    kb=(
        "PENN MEDICINE VISIT FAQ (demo content for the mock backend)\n"
        "Arrival: arrive 15 minutes early for in-person visits to check in.\n"
        "What to bring: photo ID, insurance card, a list of current medications, and any questions written down.\n"
        "Visit length: most follow-up visits take 20 to 40 minutes.\n"
        "Video visits: join from the MyPennMedicine app or the link in the text sent 15 minutes before. A phone or computer "
        "with a camera and a quiet place with good signal is all that's needed. Test your camera beforehand.\n"
        "Cancel or reschedule: reply R to the confirmation text, or call the number on your MyPennMedicine account. Please "
        "give at least 24 hours notice when possible so someone else can use the slot.\n"
        "Interpreters: free medical interpreters are available for in-person and video visits; ask when you check in or "
        "tell the scheduler.\n"
        "Rides: Penn Medicine can arrange transportation for eligible patients; the assistant can book one after scheduling.\n"
        "MyPennMedicine: the patient portal for messages, results, visit details and video visits.\n"
        "Parking and directions: details are included in the confirmation text and on MyPennMedicine."
    ),
    modelOptions=CALM,
)
node(
    "g_identity", "GLOBAL: Is this really Penn? (scam concern)", isGlobal=True,
    globalLabel="Caller is suspicious: asks if this is a scam, how they know it's really Penn Medicine, or why you need "
                "their date of birth (NOT simply asking whether you are a robot or automated: just answer that honestly)",
    prompt="Reassure without pressure: that's a fair question; you only ask for a date of birth to protect their privacy, "
           "and you will never ask for a Social Security number, payment or passwords. If they'd rather, they can hang up "
           "and call the number on their MyPennMedicine account or appointment letter. Then ask if they'd like to continue: "
           "{{prevNodePrompt}}",
    modelOptions=CALM,
)
webhook(
    "g_bad_time", "GLOBAL: Bad time to talk (webhook)", "/task",
    {"patient_id": "{{patient_id}}", "type": "retry_call", "details": "Bad time; call back: {{better_time}}"},
    "Say: 'No problem at all.' Ask when would be a better time to call back, then confirm you'll call then.",
    response=[("task_id", "$.task_id")],
    extract=[["better_time", "string", "When the patient said it would be better to call back"]],
    isGlobal=True,
    globalLabel="Caller says it's a bad time: they're driving, at work, busy, or asks you to call back later (but did NOT "
                "ask to stop calling)",
    tag=tag("Callback", ORANGE),
)
webhook(
    "g_human", "GLOBAL: Wants a person (webhook: transfer or callback)", "/handoff",
    {"patient_id": "{{patient_id}}", "callback_preference": "{{callback_preference}}"},
    "Acknowledge it without arguing: 'Of course, let me see who's available.'",
    response=[("transfer_available", "$.transfer_available"), ("callback_window", "$.callback_window")],
    routes=[("transfer_available", "true", "transfer_scheduler"), ("transfer_available", "false", "human_callback")],
    extract=[["callback_preference", "string", "Best time to call back, if the caller said"]],
    isGlobal=True,
    globalLabel="Caller asks to speak to a real person or a human scheduler, or is frustrated with the automated assistant",
)
node(
    "transfer_scheduler", "GLOBAL 2a. Warm transfer to the scheduling desk", type="Transfer Call",
    prompt="Say: 'I'm connecting you with a scheduler now. Please hold for just a moment.'",
    transferNumber=TRANSFER_NUMBER,
    warmTransferFields={
        "isEnabled": True, "userHandling": "on-hold", "isAgentPromptStatic": False,
        "agentPrompt": "Brief the scheduler in two sentences: the patient's first name, that they missed their "
                       "{{appointment_type}} with {{provider_name}} on {{missed_date}}, the reason if known, and any times offered.",
        "waitingPrompt": "", "mergeCallPrompt": "", "isMergeCallPromptStatic": False, "useCustomFromNumber": False, "fromNumber": "",
    },
    tag=tag("Transferred", VIOLET),
)
node(
    "human_callback", "GLOBAL 2b. Scheduler callback promised",
    prompt="Say the scheduling desk can't take a transfer right now, so a scheduler will call them back {{callback_window}}. "
           "If they haven't said a good time, ask for one. Then wrap up politely.",
    extractVars=[["callback_preference", "string", "Best time for the scheduler to call back"]],
    tag=tag("Callback", ORANGE), modelOptions=CALM,
)
webhook(
    "g_optout", "GLOBAL: Stop calling me (webhook)", "/optout",
    {"patient_id": "{{patient_id}}"},
    "Apologise for the bother in one sentence.",
    response=[("opted_out", "$.opted_out")],
    routes=[("opted_out", "true", "end_optout"), ("opted_out", "false", "end_optout")],
    isGlobal=True,
    globalLabel="Caller asks not to be called again, to be removed from the list, or says to stop calling",
    tag=tag("Opt-out", GREY),
)
node(
    "g_language", "GLOBAL: Prefers another language", isGlobal=True,
    globalLabel="Caller speaks or asks for a language other than English, or says they don't understand English well",
    prompt=builder_note(
        "If they speak Spanish, continue in Spanish. For any other language, say simply that someone will call back with an "
        "interpreter, then end politely.",
        ideal="Start the call in the patient's preferred language from {{preferred_language}} (passed in request data).",
        why="Many Penn patients prefer a language other than English; they shouldn't be the ones who get dropped.",
        failure="The Language tag makes the backend open an interpreter callback task.",
        improve="Per-language voices and prompts selected at dial time from the EHR's preferred-language field.",
    ),
    extractVars=[["preferred_language", "string", "The language the caller prefers"]],
    tag=tag("Language", BLUE), modelOptions=CALM,
)

# ================================================================ edges
edge("start", "verify", L_PATIENT)
edge("start", "not_available", L_OTHER)
edge("start", "end_wrong", L_WRONG)
edge("start", "voicemail", L_VM)
edge("not_available", "verify", "The patient has come to the phone")
edge("not_available", "end_other", "Got a better time, or the person wants to end the call")

edge("verify", "verify_check", "Caller stated a full date of birth")
edge("verify", "verify_failed", "Caller refuses to give a date of birth")
edge("verify_retry", "verify_check2", "Caller stated a date of birth again")
edge("verify_retry", "verify_failed", "Caller refuses or can't give it")
edge("verify_failed", "end_other", "Caller understands / call is wrapping up")

edge("reason", "get_slots", L_OPEN)
edge("reason", "barrier", L_BARRIER)
edge("reason", "decline", L_DECLINE)
edge("barrier", "get_slots", "Patient wants to pick a new time")
edge("barrier", "decline", "Patient still doesn't want to reschedule")

edge("offer", "book", L_PICK)
edge("offer", "refine", L_REFINE)
edge("offer", "preferences", L_NONE)
edge("offer", "decline", "Patient decides not to reschedule after all")

edge("slot_taken", "book_alt", "Patient accepts the alternative time")
edge("slot_taken", "refine", "Patient wants to look at other days or times instead")
edge("slot_taken", "preferences", "The alternative doesn't work and they have no other preference")

edge("ride_offer", "ride_book", "Patient wants the ride")
edge("ride_offer", "confirm", "Patient doesn't need a ride")
edge("confirm", "sms", "Patient has nothing else, or asks for a text")

edge("preferences", "waitlist", "Patient gave the days and times that work")
edge("waitlist", "end_other", "Added to the waitlist")
edge("decline", "end_other", "Patient is done")

# Globals return to the previous node by default; these must leave the main flow instead.
edge("g_emergency", "end_emergency", "Caller acknowledges, or the emergency instruction has been given twice")
edge("g_language", "end_other", "Caller needs an interpreter callback")
edge("g_bad_time", "end_other", "Callback time confirmed")
edge("human_callback", "end_other", "Callback arranged")

# Canvas layout for Bland's editor and the ops console: (column, row), main flow top to bottom, globals on the right.
LAYOUT = {
    "start": (2, 0), "not_available": (0, 1), "verify": (2, 1), "end_wrong": (4, 1), "voicemail": (5, 1),
    "verify_check": (2, 2), "verify_retry": (3, 2), "verify_check2": (4, 2), "verify_failed": (4, 3),
    "reason": (2, 3), "barrier": (1, 4), "decline": (3, 4), "get_slots": (2, 5),
    "offer": (2, 6), "refine": (1, 6), "preferences": (0, 7), "book": (2, 7), "slot_taken": (3, 7), "book_alt": (3, 8),
    "post_book": (2, 8), "ride_offer": (1, 9), "ride_book": (1, 10), "confirm": (2, 10), "sms": (2, 11), "end_booked": (2, 12),
    "waitlist": (0, 8), "end_other": (0, 12), "end_emergency": (8, 0), "end_optout": (8, 7),
    "g_emergency": (7, 0), "g_crisis": (7, 1), "g_symptoms": (8, 1), "g_clinical": (7, 2), "g_billing": (8, 2),
    "g_logistics": (7, 3), "g_identity": (8, 3), "g_bad_time": (7, 4), "g_human": (7, 5),
    "transfer_scheduler": (8, 5), "human_callback": (8, 6), "g_optout": (7, 7), "g_language": (7, 8),
}


def main():
    for n in nodes:
        col, row = LAYOUT[n["id"]]
        n["position"] = {"x": col * 420, "y": row * 300}
    ids = {n["id"] for n in nodes}
    for e in edges:
        assert e["source"] in ids and e["target"] in ids, e
    for n in nodes:
        for r in n["data"].get("responsePathways", []):
            assert r[3]["id"] in ids, (n["id"], r)
    payload_nodes = nodes + [{"globalConfig": {"globalPrompt": GLOBAL_PROMPT}, "position": {"x": 0, "y": 0}}]
    payload = {
        "name": "Penn Medicine: No-show rebooking (Penny)",
        "description": "Outbound call to a patient who missed an outpatient visit: reach them, verify identity server-side, "
                       "learn why they missed it, remove barriers (ride booking, video visits), offer held slots, book atomically, "
                       "text a confirmation, or waitlist. Globals cover emergencies, crisis, symptoms, clinical/billing questions, "
                       "logistics (knowledge base), scam concerns, bad timing, human handoff (warm transfer or callback), opt-out "
                       "and language. Node tags feed outcome classification in the backend.",
        "nodes": payload_nodes,
        "edges": edges,
    }
    print(f"{len(nodes)} nodes ({sum(1 for n in nodes if n['data'].get('isGlobal'))} global, "
          f"{sum(1 for n in nodes if n['type'] == 'Webhook')} webhook, {sum(1 for n in nodes if n['data'].get('tag'))} tagged), {len(edges)} edges")
    if "--dry-run" in sys.argv:
        (ROOT / "pathway.json").write_text(json.dumps(payload, indent=2))
        print("wrote pathway.json")
        return
    id_file = ROOT / ".pathway_id"
    if id_file.exists():
        pid = id_file.read_text().strip()
    else:
        res = call("POST", "/pathway/create", {"name": payload["name"], "description": payload["description"]})
        pid = res.get("pathway_id") or res.get("data", {}).get("pathway_id")
        id_file.write_text(pid)
    res = call("POST", f"/pathway/{pid}", payload)
    print("update:", res.get("status"), res.get("message", ""))
    # Snapshot this build as a named version and publish it, so every call records which version it ran on.
    import datetime
    label = "build " + datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    ver = call("POST", f"/pathway/{pid}/version", {"name": label, "nodes": payload_nodes, "edges": edges})
    vnum = (ver.get("data") or {}).get("version_number") or ver.get("version_number")
    if vnum:
        pub = call("POST", f"/pathway/{pid}/publish", {"version_id": vnum, "environment": "production"})
        print(f"version {vnum} ({label}) -> production:", pub.get("message", pub))
    else:
        print("version snapshot response:", json.dumps(ver)[:300])
    print("pathway_id:", pid)


if __name__ == "__main__":
    main()
