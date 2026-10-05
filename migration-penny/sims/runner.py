"""Sim runner for the Penny v2 migration. Usage:
  python3 runner.py create suite.json        # create/update MIG-PENNY scenarios (idempotent by name)
  python3 runner.py run <name-substr|all> [reps]   # run, poll, save results/<name>__<n>.json, print verdicts
"""
import json, sys, time, pathlib, urllib.request, urllib.error, concurrent.futures as cf
ROOT = pathlib.Path(__file__).resolve().parents[2]
KEY = [l.split("=",1)[1].strip().strip('"\'') for l in (ROOT/".env").read_text().splitlines() if l.startswith("BLAND_API_KEY=")][0]
BACKEND = (ROOT/".backend_url").read_text().strip()
AGENT = "b93214fd-ef8b-49c0-9c35-67be232acf15"
HERE = pathlib.Path(__file__).parent
def api(method, path, body=None):
    req = urllib.request.Request("https://api.bland.ai"+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": KEY, "content-type": "application/json", "user-agent": "penny-v2-migration/1.0"})
    for attempt in range(12):
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 11: time.sleep(15 * (attempt + 1)); continue
            raise SystemExit(f"{method} {path} -> {e.code}: {e.read().decode()[:600]}")
def fixture(pid):
    with urllib.request.urlopen(urllib.request.Request(f"{BACKEND}/api/request-data/{pid}", headers={"user-agent": "penny-v2-migration/1.0"})) as r: return json.loads(r.read())
def existing():
    d = api("GET", "/v1/agent-testing/scenarios")["data"]
    return {s["name"]: s for s in d if s.get("agent_id") == AGENT}
def create(suite_file):
    ex = existing()
    for sc in json.load(open(HERE/suite_file)):
        body = {"agent_id": AGENT, "name": "MIG-PENNY: "+sc["name"], "tester_persona_prompt": sc["persona"], "max_turns": sc.get("max_turns", 16),
                "request_data": fixture(sc.get("patient", "P1001")),
                "assertions": [{"type": "LLM_JUDGE", "name": a[0], "is_required": True, "config": {"prompt": a[1], "output_type": "boolean", "pass_on_true": True}} for a in sc["judges"]]}
        if body["name"] in ex:
            api("PUT", f"/v1/agent-testing/scenarios/{ex[body['name']]['id']}", {k: v for k, v in body.items() if k != "agent_id"}); print("updated", body["name"])
        else:
            api("POST", "/v1/agent-testing/scenarios", body); print("created", body["name"])
def trace(run):
    md = run.get("metadata") or {}; names = md.get("node_id_to_name") or {}
    path = []
    for t in md.get("turn_details") or []:
        for lg in t.get("logs") or []:
            if lg.get("type") == "decision":
                c = lg.get("decision") or {}
                n = c.get("Current Node Name") or names.get(c.get("Current Node ID"), "")
                if n and (not path or path[-1] != n): path.append(n)
    return path
def run_one(sc, rep):
    r = api("POST", f"/v1/agent-testing/scenarios/{sc['id']}/run", {})
    rid = (r.get("data") or r).get("run_id") or (r.get("data") or r).get("id")
    for _ in range(120):
        time.sleep(8)
        run = api("GET", f"/v1/agent-testing/runs/{rid}")["data"]
        if run["status"] not in ("PENDING", "RUNNING", "QUEUED", "IN_PROGRESS"): break
    out = HERE/"results"; out.mkdir(exist_ok=True)
    nm = sc["name"].replace("MIG-PENNY: ", "")
    json.dump(run, open(out/f"{nm.replace('/', '_')}__{rep}.json", "w"), indent=1)
    res = run.get("assertion_results") or []
    ok = run["status"] == "PASSED" and all(a.get("status") == "PASSED" for a in res)
    return nm, rep, run["status"], ok, res, trace(run), rid
if __name__ == "__main__":
    if sys.argv[1] == "create": create(sys.argv[2])
    else:
        sel = sys.argv[2]; reps = int(sys.argv[3]) if len(sys.argv) > 3 else 1
        scs = [s for n, s in sorted(existing().items()) if sel == "all" or any(x in n for x in sel.split(","))]
        with cf.ThreadPoolExecutor(4) as ex:
            for nm, rep, st, ok, res, path, rid in ex.map(lambda a: run_one(*a), [(s, i) for s in scs for i in range(reps)]):
                print(f"\n{'PASS' if ok else 'FAIL'} [{st}] {nm} #{rep} run={rid}")
                print("   path:", " > ".join(p[:30] for p in path))
                for a in res:
                    if a.get("status") != "PASSED": print("   x", a.get("assertion_id","")[:8], "::", str(a.get("reasoning"))[:400])
