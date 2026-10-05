"""Text-chat a pathway via Bland's pathway chat API (no phone credits for a real call).
Usage: python3 chat_test.py "msg1" "msg2" ...
Request data comes from the backend's worklist (same as a real dial), so webhooks hit real records.
"""
import json, sys, pathlib, urllib.request, urllib.error
ROOT = pathlib.Path(__file__).parent
KEY = [l.split("=",1)[1].strip() for l in (ROOT/".env").read_text().splitlines() if l.startswith("BLAND_API_KEY=")][0]
PID = (ROOT/".pathway_id").read_text().strip()
BACKEND = (ROOT/".backend_url").read_text().strip()
with urllib.request.urlopen(BACKEND + "/api/request-data/P1001") as r:
    DEMO = json.loads(r.read())

def call(path, body):
    req = urllib.request.Request("https://api.bland.ai/v1"+path, method="POST", data=json.dumps(body).encode(),
        headers={"authorization": KEY, "content-type": "application/json", "user-agent": "penn-pathway-builder/1.0"})
    try:
        with urllib.request.urlopen(req) as r: return json.loads(r.read())
    except urllib.error.HTTPError as e: raise SystemExit(f"{path} -> {e.code}: {e.read().decode()[:800]}")

chat = call("/pathway/chat/create", {"pathway_id": PID, "request_data": DEMO})
cid = chat.get("data", {}).get("chat_id") or chat.get("chat_id")
if not cid: raise SystemExit(chat)
for msg in sys.argv[1:]:
    r = call(f"/pathway/chat/{cid}", {"message": msg})
    d = r.get("data", r)
    print(f"\nUSER: {msg}")
    print(f"  [node: {d.get('current_node_name')}]")
    for m in (d.get("assistant_responses") or [d.get("assistant_response") or d]): print(f"  PENNY: {m}")
