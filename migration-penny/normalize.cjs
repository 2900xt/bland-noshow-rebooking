// Deterministic, reviewable normalization of the v1 export for the builder.
// Reads v1-export.json (untouched) -> v1-export.normalized.json. No prose is retyped:
//  - "Wait for Response" node -> Default (builder has no mapping; condition carries as loopWhile)
//  - Webhook responseData {name,data} -> response_data (the key the builder reads)
//  - Knowledge Base node with inline `kb` text -> Default with the kb text appended verbatim to its prompt
//    (no org KB is created; v1 KB was node-scoped)
const fs = require("fs");
const src = JSON.parse(fs.readFileSync("v1-export.json", "utf8"));
for (const n of src.nodes) {
  if (!n.type) continue;
  const d = n.data;
  if (n.type === "Wait for Response") n.type = "Default";
  if (n.type === "Webhook" && Array.isArray(d.responseData)) d.response_data = d.responseData;
  if (n.type === "Knowledge Base") {
    n.type = "Default";
    d.prompt = d.prompt + "\n\n=== KNOWLEDGE BASE (answer only from this) ===\n" + d.kb;
  }
}
fs.writeFileSync("v1-export.normalized.json", JSON.stringify(src, null, 1));
console.log("normalized");
