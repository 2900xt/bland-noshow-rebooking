"""v1 differential: replay scripted caller turns against the LIVE v1 pathway via its chat API (read-only use,
same mechanism as the project's chat_test.py). Usage: python3 v1chat.py <patient_id> <reps> "turn1" "turn2" ..."""
import json, sys, pathlib, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[2]
KEY = [l.split("=",1)[1].strip().strip('"\'') for l in (ROOT/".env").read_text().splitlines() if l.startswith("BLAND_API_KEY=")][0]
PID = (ROOT/".pathway_id").read_text().strip(); BACKEND = (ROOT/".backend_url").read_text().strip()
UA = {"user-agent": "penny-v2-migration/1.0"}
def call(path, body):
    req = urllib.request.Request("https://api.bland.ai/v1"+path, method="POST", data=json.dumps(body).encode(), headers={"authorization": KEY, "content-type": "application/json", **UA})
    with urllib.request.urlopen(req, timeout=90) as r: return json.loads(r.read())
rd = json.loads(urllib.request.urlopen(urllib.request.Request(f"{BACKEND}/api/request-data/{sys.argv[1]}", headers=UA)).read())
for rep in range(int(sys.argv[2])):
    c = call("/pathway/chat/create", {"pathway_id": PID, "request_data": rd}); cid = c.get("data", {}).get("chat_id") or c.get("chat_id")
    print(f"--- v1 rep {rep}")
    for msg in sys.argv[3:]:
        d = call(f"/pathway/chat/{cid}", {"message": msg}); d = d.get("data", d)
        print(f"  USER: {msg}\n    [{d.get('current_node_name')}] PENNY: {' | '.join(str(m) for m in (d.get('assistant_responses') or [d.get('assistant_response')]))[:260]}")
