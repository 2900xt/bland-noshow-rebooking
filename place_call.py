"""Places a real test call to the demo patient through the backend dialer.
Usage: python3 place_call.py +15551234567

The backend (POST /api/dial) checks opt-out and attempt limits, builds request_data from the worklist, and sends the
call to Bland with live event streaming, dispositions, TCPA guard rails, voicemail, keyword boosts and the
end-of-call webhook. Watch it on the dashboard's Live page. The number is treated as a staff test line, so the
8 AM - 9 PM calling window is bypassed; opt-outs still apply.
"""
import json, sys, pathlib, urllib.request, urllib.error
ROOT = pathlib.Path(__file__).parent
ENV = dict(l.split("=", 1) for l in (ROOT/".env").read_text().splitlines() if "=" in l)
BACKEND = (ROOT/".backend_url").read_text().strip()
if len(sys.argv) < 2:
    raise SystemExit(__doc__)
req = urllib.request.Request(BACKEND + "/api/dial", method="POST",
    data=json.dumps({"patient_id": "P1001", "phone_number": sys.argv[1], "test_line": True}).encode(),
    headers={"content-type": "application/json", "x-admin-token": ENV["ADMIN_TOKEN"].strip()})
try:
    with urllib.request.urlopen(req) as r:
        res = json.loads(r.read())
        print("call_id:", res["call_id"])
        print("live view:", BACKEND + "/#/live")
except urllib.error.HTTPError as e:
    raise SystemExit(f"{e.code}: {e.read().decode()}")
