"""Cancel every demo-backend booking our sims created (found in the engine traces' /book responses),
using the backend's own admin cancel action. Re-running is safe (already-cancelled -> 'not found')."""
import json, glob, pathlib, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[2]
env = dict(l.split("=", 1) for l in (ROOT/".env").read_text().splitlines() if "=" in l)
TOKEN = env["ADMIN_TOKEN"].strip().strip('"\''); BACKEND = (ROOT/".backend_url").read_text().strip()
confs = set(json.load(open("drained.json"))) if pathlib.Path("drained.json").exists() else set()
new = set()
for f in glob.glob("results/*.json"):
    for t in (json.load(open(f)).get("metadata") or {}).get("turn_details") or []:
        for lg in t.get("logs") or []:
            b = lg.get("response_body") if lg.get("type") == "webhook" else None
            if isinstance(b, dict) and b.get("booked") is True and b.get("confirmation"): new.add(b["confirmation"])
for c in sorted(new - confs):
    req = urllib.request.Request(f"{BACKEND}/api/appointments/{c}", method="POST", data=b"{}", headers={"x-admin-token": TOKEN, "content-type": "application/json", "user-agent": "penny-v2-migration/1.0"})
    with urllib.request.urlopen(req) as r: print(c, json.loads(r.read()))
json.dump(sorted(confs | new), open("drained.json", "w"))
print("total test bookings cancelled so far:", len(confs | new))
