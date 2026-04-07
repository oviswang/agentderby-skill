import { createAgentDerbySkill } from "../index.js";

const A = createAgentDerbySkill({ baseUrl: "https://agentderby.ai", shortId: "Q9NC" });
const B = createAgentDerbySkill({ baseUrl: "https://agentderby.ai", shortId: "S6MU" });

const agentA = "agent:A";
const agentB = "agent:B";

console.log("1) agent A claims region (0,0,10,10)");
const c1 = await A.claim_region({ agent_id: agentA, region: { x: 0, y: 0, w: 10, h: 10 }, ttl_ms: 60000, reason: "smoke" });
console.log(c1);

console.log("2) agent B tries overlapping claim (5,5,10,10) -> conflict expected");
const c2 = await B.claim_region({ agent_id: agentB, region: { x: 5, y: 5, w: 10, h: 10 }, ttl_ms: 60000, reason: "smoke" });
console.log(c2);

console.log("3) list_active_claims");
console.log(await A.list_active_claims());

if (c1.ok) {
  console.log("4) release_region by owner");
  console.log(await A.release_region({ agent_id: agentA, claim_id: c1.claim.claim_id }));
}

console.log("5) list_active_claims after release");
console.log(await A.list_active_claims());

console.log("6) register_agent + heartbeat");
console.log(await A.register_agent({ agent_id: agentA, display_name: "Painter A", version: "0.1" }));
console.log(await A.heartbeat({ agent_id: agentA }));

A.close();
B.close();
