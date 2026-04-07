import { createAgentDerbySkill } from "../index.js";

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

  // Track claims created by THIS run so we can best-effort cleanup in finally.
  const createdClaims = [];
  let scenarioOk = false;

  const overlap = { x: R1.x + 2, y: R1.y + 2, w: 6, h: 6 };

  function overlaps(a, b){
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;
    return (a.x < bx2) && (ax2 > b.x) && (a.y < by2) && (ay2 > b.y);
  }

  async function cleanup(){
    console.log("CLEANUP) start");
    for (const c of createdClaims) {
      const who = c.which;
      const claim_id = c.claim_id;
      const agent_id = c.agent_id;
      console.log(`CLEANUP) release ${who} claim_id=${claim_id}`);
      try {
        const r = (who === 'A')
          ? await A.release_region({ agent_id, claim_id })
          : await B.release_region({ agent_id, claim_id });
        console.log("CLEANUP) result", summarize(r));
      } catch (e) {
        console.log("CLEANUP) error", String(e?.message || e));
      }
    }

    // Verify cleanup effect (do not throw here; keep best-effort).
    try {
      const after = await A.list_active_claims();
      const ids = new Set((after?.claims || []).map((x) => x.claim_id));
      const still = createdClaims.filter((c) => ids.has(c.claim_id)).map((c) => c.claim_id);
      console.log("CLEANUP) verify created claims gone:", { ok: after?.ok, still_present: still });
    } catch (e) {
      console.log("CLEANUP) verify error", String(e?.message || e));
    }

    console.log("CLEANUP) done");
  }

  try {
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
    createdClaims.push({ which: 'A', agent_id: agentA, claim_id: claimAId, region: R1 });

    // 5. B attempts overlapping claim on R1 and gets conflict
    console.log("5) B.claim_region overlap R1 -> expect conflict");
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
    createdClaims.push({ which: 'B', agent_id: agentB, claim_id: claimBId, region: R2 });

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

    // Final verification rule (improved):
    // - do NOT require global claims empty
    // - verify our claims are no longer present
    // - verify no remaining active claim overlaps our regions
    console.log("11) scenario verification (claims)");
    const claimsNow = await A.list_active_claims();
    console.log(summarize(claimsNow));
    assert(claimsNow?.ok, "list_active_claims ok");

    const active = (claimsNow?.claims || []);
    const activeIds = new Set(active.map((c) => c.claim_id));
    const ours = createdClaims.map((c) => c.claim_id);

    // our claims may still be present at this point (since we haven't released yet) – that's OK.
    // We'll verify absence AFTER release in finally.

    const overlappingOthers = active.filter((c) => {
      if (ours.includes(c.claim_id)) return false;
      const reg = c.region;
      return (reg && overlaps(reg, R1)) || (reg && overlaps(reg, R2));
    });
    if (overlappingOthers.length) {
      throw new Error(`ASSERT_FAIL: found overlapping active claim(s) with test regions: ${JSON.stringify(overlappingOthers)}`);
    }

    scenarioOk = true;
    console.log("SCENARIO_OK");
  } finally {
    // Always attempt cleanup of claims created by this run.
    await cleanup();

    // Post-cleanup verification: created claim IDs are gone + no active claim overlaps test regions.
    console.log("POST-CLEANUP) verification");
    const after = await A.list_active_claims();
    console.log(summarize(after));
    if (after?.ok) {
      const active = (after?.claims || []);
      const ids = new Set(active.map((c) => c.claim_id));
      const stillPresent = createdClaims.filter((c) => ids.has(c.claim_id)).map((c) => c.claim_id);
      if (stillPresent.length) {
        console.log("POST-CLEANUP) FAIL: created claims still present", stillPresent);
        // If scenario failed, keep original failure as main; but cleanup failure is still significant.
        // We treat leftover claims from this run as a test failure.
        throw new Error(`ASSERT_FAIL: cleanup did not remove created claims: ${JSON.stringify(stillPresent)}`);
      }

      const overlapping = active.filter((c) => {
        const reg = c.region;
        return reg && (overlaps(reg, R1) || overlaps(reg, R2));
      });
      if (overlapping.length) {
        console.log("POST-CLEANUP) FAIL: overlapping claims remain", summarize(overlapping));
        throw new Error(`ASSERT_FAIL: post-cleanup overlaps remain: ${JSON.stringify(overlapping)}`);
      }

      if (active.length) {
        console.log("POST-CLEANUP) NOTE: unrelated old claims still exist (not a failure):", active.length);
      }
    }

    if (scenarioOk) console.log("PASS");
  }
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
