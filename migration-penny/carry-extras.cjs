// Deterministic post-build carriage of v1 features the norm builder does not map.
// Every value is copied from v1-export.json bytes; steps are matched by their (unique) v1 name.
//  1. Webhook steps: v1 node prompt (speech) + extractVars (captured right before the request fires)
//  2. Node tags (outcome classification) -> settings.tag
//  3. Global nodes -> settings.global {isGlobal, label: globalLabel}; returnMode "previous" when the
//     v1 global has no outgoing routes, "manual" (its own drawn/response routes stay live) when it does
//  4. pathwayExamples -> appended to the matching edge's description (routing examples)
const fs = require("fs");
const { randomUUID } = require("crypto");
const src = JSON.parse(fs.readFileSync("v1-export.json", "utf8"));
const snap = JSON.parse(fs.readFileSync("snapshot.json", "utf8"));
const byName = new Map(src.nodes.filter((n) => n.type).map((n) => [n.data.name, n]));
const varType = (t) => (t === "boolean" ? "boolean" : t === "number" || t === "integer" ? "number" : "string");
const log = [];
for (const sc of snap.behavior.nodes.filter((n) => n.type === "complex-scenario")) {
  const flow = sc.data.flow;
  const stepById = new Map(flow.nodes.map((s) => [s.id, s]));
  for (const step of flow.nodes) {
    const v1 = byName.get(step.data && step.data.name);
    if (!v1) continue;
    const d = v1.data;
    if (step.type === "webhook") {
      if (d.prompt) { step.data.prompt = d.prompt; log.push(`webhook prompt: ${d.name}`); }
      if (d.extractVars && d.extractVars.length) {
        step.data.variables = d.extractVars.map((r) => ({ id: randomUUID(), key: r[0], value: r[2], type: varType(r[1]), accurateSpelling: false }));
        log.push(`webhook extraction (${d.extractVars.map((r) => r[0])}): ${d.name}`);
      }
    }
    if (d.tag) { step.data.settings.tag = d.tag; log.push(`tag ${d.tag.name}: ${d.name}`); }
    if (d.isGlobal) {
      const hasRoutes = src.edges.some((e) => e.source === v1.id) || (d.responsePathways || []).length > 0;
      step.data.settings.global = { isGlobal: true, label: d.globalLabel, description: "", returnMode: hasRoutes ? "manual" : "previous", forwardingNode: "" };
      log.push(`global (${hasRoutes ? "manual" : "previous"}): ${d.name}`);
    }
    for (const ex of d.pathwayExamples || []) {
      const edge = flow.edges.find((e) => e.source === step.id && e.data.label === ex["Chosen Pathway"]);
      if (!edge) throw new Error(`no edge for example on ${d.name}: ${ex["Chosen Pathway"]}`);
      const said = ex["Conversation History"].filter((m) => m.role === "user" && m.content !== "<<CALL CONNECTED>>").map((m) => m.content).pop();
      edge.data.description = (edge.data.description ? edge.data.description + " " : "Example caller replies that mean this:") + ` "${said}"`;
      log.push(`example -> edge "${edge.data.label.slice(0, 40)}…" on ${d.name}`);
    }
  }
}
fs.writeFileSync("snapshot.json", JSON.stringify(snap));
console.log(log.join("\n"));

// ── v1 terminal semantics (build 2) ─────────────────────────────────────────
// Evidence (build 1 engine traces, sims 01/16): a flow exit had no compiled outgoing route, so every finished call
// fell back to the hub, which waited for a caller turn before hanging up (repeated "Goodbye"s). v1 End Call nodes
// speak their line and hang up immediately. Re-represent that:
//  5. v1 End Call steps: speak their verbatim prompt without waiting (skipUserResponse), exit edge forced (alwaysPick)
//  6. explicit root routes: each scenario that can exit -> the matching root end-call (forced); hub -> both end-calls
//     (authored hub routes, since an authored incoming edge removes an end-call's generated hub entry)
//  7. v1 "Wait for Response" node -> native v2 waitForResponse step (same prompt-step fields)
{
  const snap2 = JSON.parse(fs.readFileSync("snapshot.json", "utf8"));
  const v1Type = new Map(src.nodes.filter((n) => n.type).map((n) => [n.data.name, n.type]));
  const out = [];
  for (const sc of snap2.behavior.nodes.filter((n) => n.type === "complex-scenario")) {
    const flow = sc.data.flow;
    const endPill = flow.nodes.find((n) => n.type === "end");
    for (const step of flow.nodes) {
      const t = v1Type.get(step.data && step.data.name);
      if (t === "End Call") {
        step.data.settings.advanced.skipUserResponse = true;
        for (const e of flow.edges) if (e.source === step.id && e.target === endPill.id) e.data.alwaysPick = true;
        out.push(`terminal: ${step.data.name}`);
      }
      if (t === "Wait for Response") { step.type = "waitForResponse"; out.push(`waitForResponse: ${step.data.name}`); }
    }
  }
  const byNodeName = (nm) => snap2.behavior.nodes.find((n) => n.data && n.data.name === nm);
  const hub = snap2.behavior.nodes.find((n) => n.type === "agent");
  const closed = byNodeName("End call (closing already said)");
  const bye = byNodeName("End call (goodbye)");
  closed.data.useStaticText = true; // static "." — the v1 closing line was already spoken; nothing to add or fabricate
  out.push("root end-call 'closing already said': static silent pill");
  const route = (from, to, alwaysPick) => ({ id: randomUUID(), type: "pathway", source: from.id, target: to.id,
    data: { mode: "llm", label: to.data.entry.label, description: to.data.entry.description, alwaysPick, conditions: [] } });
  const exitsTo = {
    "Penny rebooking call": closed, "GLOBAL: Medical emergency": closed, "GLOBAL: Stop calling me (webhook)": closed,
    "GLOBAL: Wants a person (webhook: transfer or callback)": bye, "GLOBAL: Bad time to talk (webhook)": bye,
    "GLOBAL: Prefers another language": bye,
  };
  for (const [scName, target] of Object.entries(exitsTo)) {
    const sc = byNodeName(scName);
    if (!sc) throw new Error(`no scenario ${scName}`);
    snap2.behavior.edges.push(route(sc, target, true));
    out.push(`root route: ${scName} -> ${target.data.name}`);
  }
  snap2.behavior.edges.push(route(hub, closed, false), route(hub, bye, false));
  fs.writeFileSync("snapshot.json", JSON.stringify(snap2));
  console.log(out.join("\n"));
}
