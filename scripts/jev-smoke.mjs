import { readFileSync } from "node:fs";
for (const line of readFileSync(".env","utf8").split("\n")) { const m=line.match(/^([A-Z_]+)=(.*)$/); if(m&&m[2]) process.env[m[1]]=m[2].trim(); }
console.log("key present:", !!process.env.TYPESAFE_API_KEY, "len", (process.env.TYPESAFE_API_KEY||"").length);
const { TypeSafeClient } = await import("@typesafe-ai/sdk");
const client = new TypeSafeClient();
const t0=Date.now();
const r = await client.systemOne({
  state: { tool: "read", file: "src/auth.ts", output: "export function login(u,p){ return db.users.find(x=>x.name===u && x.pw===p) }", task: "fix the login bug where passwords are compared in plaintext" },
  questions: {
    needed_now: { type: "noul", instructions: "Will the agent need `output` verbatim to continue `task` in the next steps?" },
    durable: { type: "noul", instructions: "Does `output` contain a durable fact about the project worth remembering in future sessions?" },
    kind: { type: "choice", instructions: "What kind of content is `output`?", criteria: { source_code: null, command_output: null, error: null, prose: null } }
  }
});
console.log("latency ms", Date.now()-t0);
console.log(JSON.stringify(r, null, 1));
