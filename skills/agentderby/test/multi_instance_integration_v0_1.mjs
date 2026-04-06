import { createAgentDerbySkill } from "../src/index.js";

// Multi-instance integration test for AgentDerby OpenClaw skill v0.1
// Scenario: A and B register, read intents, claim non-overlapping regions, draw, chat, release, and verify claims empty.
// NOTE: Uses only existing v0.1 APIs.

const baseUrl = "https://agentderby.ai";
const now = Date.now();

// Choose two regions that are unlikely to matter; small and far from (0,0) which is commonly used in smokes.
// Use per-test unique regions to avoid conflicts with prior runs (claims are TTL-based).
const baseX = 40 + ((now % 50) * 5);
const R1 = { x: baseX, y: 40, w: 6, h: 6 };
const R2 = { x: baseX + 20, y: 40, w: 6, h: 6 };

const agentA = `agent:A:${now}`;
const agentB = `agent:B:${now}`;

const A = createAgentDerbySkill({ baseUrl, shortId: "Q9NC" });
const B = createAgentDerbySkill({ baseUrl, shortId: "S6MU" });

function assert(cond, msg){
  if (!cond) throw new Error("ASSERT_FAIL: " + msg);
}

function summarize(obj){
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

async function main(){
  console.log("TEST_ID", now);
  console.log("R1", R1);
  console.log("R2", R2);

  // 1. A registers
  console.log("1) A.register_agent");
  const r1 = await A.register_agent({ agent_id: agentA, display_name: "Agent A", version: "0.1" });
  console.log(summarize(r1));
  assert(r1?.ok, "A.register_agent ok");

  // 2. B registers
  console.log("2) B.register_agent");
  const r2 = await B.register_agent({ agent_id: agentB, display_name: "Agent B", version: "0.1" });
  console.log(summarize(r2));
  assert(r2?.ok, "B.register_agent ok");

  // 3. both read recent intents
  console.log("3) A.get_recent_intents");
  const iA = await A.get_recent_intents({ limit: 5 });
  console.log(summarize({ ok: iA.ok, count: iA.intents?.length, sample: iA.intents?.[0] }));
  assert(iA?.ok, "A.get_recent_intents ok");

  console.log("3b) B.get_recent_intents");
  const iB = await B.get_recent_intents({ limit: 5 });
  console.log(summarize({ ok: iB.ok, count: iB.intents?.length, sample: iB.intents?.[0] }));
  assert(iB?.ok, "B.get_recent_intents ok");

  // 4. A claims region R1
  console.log("4) A.claim_region R1");
  const cA = await A.claim_region({ agent_id: agentA, region: R1, ttl_ms: 60000, reason: "integration_test" });
  console.log(summarize(cA));
  assert(cA?.ok, "A.claim_region ok");
  const claimAId = cA?.claim?.claim_id;
  assert(claimAId, "A.claim_region claim_id");

  // 5. B attempts overlapping claim on R1 and gets conflict
  console.log("5) B.claim_region overlap R1 -> expect conflict");
  const overlap = { x: R1.x + 2, y: R1.y + 2, w: 6, h: 6 };
  const cBConflict = await B.claim_region({ agent_id: agentB, region: overlap, ttl_ms: 60000, reason: "integration_test_overlap" });
  console.log(summarize(cBConflict));
  const errCode = String(cBConflict?.error?.code || '').toUpperCase();
  assert(!cBConflict?.ok && errCode === 'CONFLICT', "B overlapping claim conflicts");

  // 6. B claims a non-overlapping region R2
  console.log("6) B.claim_region R2");
  const cB = await B.claim_region({ agent_id: agentB, region: R2, ttl_ms: 60000, reason: "integration_test" });
  console.log(summarize(cB));
  assert(cB?.ok, "B.claim_region ok");
  const claimBId = cB?.claim?.claim_id;
  assert(claimBId, "B.claim_region claim_id");

  // 7. A draws a few pixels in R1
  console.log("7) A.draw_pixels in R1 (observe=true)");
  const pixelsA = [
    { x: R1.x + 1, y: R1.y + 1, color: "#ff0000" },
    { x: R1.x + 2, y: R1.y + 1, color: "#ff0000" },
    { x: R1.x + 1, y: R1.y + 2, color: "#ff0000" },
  ];
  const dA = await A.draw_pixels({ pixels: pixelsA, observe: true });
  console.log(summarize(dA));
  assert(dA?.ok && dA?.accepted === true, "A.draw_pixels accepted");

  // 8. B draws a few pixels in R2
  console.log("8) B.draw_pixels in R2 (observe=true)");
  const pixelsB = [
    { x: R2.x + 1, y: R2.y + 1, color: "#0000ff" },
    { x: R2.x + 2, y: R2.y + 1, color: "#0000ff" },
    { x: R2.x + 1, y: R2.y + 2, color: "#0000ff" },
  ];
  const dB = await B.draw_pixels({ pixels: pixelsB, observe: true });
  console.log(summarize(dB));
  assert(dB?.ok && dB?.accepted === true, "B.draw_pixels accepted");

  // 9. A sends a chat status message
  console.log("9) A.send_chat status (wait_for_broadcast)");
  const mA = await A.send_chat({
    text: `integration_test ${now} A done: claimed R1 + drew ${pixelsA.length} pixels`,
    wait_for_broadcast: true,
    timeout_ms: 1500
  });
  console.log(summarize(mA));
  assert(mA?.ok, "A.send_chat ok");

  // 10. B sends a chat status message
  console.log("10) B.send_chat status (wait_for_broadcast)");
  const mB = await B.send_chat({
    text: `integration_test ${now} B done: claimed R2 + drew ${pixelsB.length} pixels`,
    wait_for_broadcast: true,
    timeout_ms: 1500
  });
  console.log(summarize(mB));
  assert(mB?.ok, "B.send_chat ok");

  // 11. A releases R1
  console.log("11) A.release_region R1");
  const relA = await A.release_region({ agent_id: agentA, claim_id: claimAId });
  console.log(summarize(relA));
  assert(relA?.ok, "A.release_region ok");

  // 12. B releases R2
  console.log("12) B.release_region R2");
  const relB = await B.release_region({ agent_id: agentB, claim_id: claimBId });
  console.log(summarize(relB));
  assert(relB?.ok, "B.release_region ok");

  // 13. verify active claims becomes empty (best-effort)
  // Note: claims are TTL-memory. A prior failed run may leave claims until TTL expiry.
  // We consider the test pass if our two claim_ids are gone.
  console.log("13) list_active_claims -> expect OUR claims released");
  const claims = await A.list_active_claims();
  console.log(summarize(claims));
  assert(claims?.ok, "list_active_claims ok");
  const ids = new Set((claims?.claims || []).map((c) => c.claim_id));
  assert(!ids.has(claimAId), "claimAId removed");
  assert(!ids.has(claimBId), "claimBId removed");
  if ((claims?.claims || []).length !== 0) {
    console.log("NOTE: active claims not empty due to pre-existing claims (TTL-based):", (claims?.claims || []).length);
  }

  console.log("PASS");
}

main()
  .catch((e) => {
    console.error("FAIL", e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => {
    try { A.close(); } catch {}
    try { B.close(); } catch {}
  });
