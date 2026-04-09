import { TemporalRegionHistory } from "../phase1/temporal.js";
import { candidateActionsForProfile, patchPlansFromCandidateActions } from "../phase1/actions.js";
import { fetchBoardSnapshot } from "../client/board.js";
import { executePatchPlan } from "../phase3/executor.js";

function patchKey(p) {
  return `${p.x},${p.y},${p.w},${p.h}`;
}

export class PatchCoordinator {
  constructor() {
    this.reserved = new Map(); // patchKey -> agentId
    this.occupied = new Map(); // patchKey -> {agentId, status, ts}
  }

  canAssign(patch, agentId) {
    const k = patchKey(patch);
    const r = this.reserved.get(k);
    const o = this.occupied.get(k);
    return (!r || r === agentId) && (!o || o.agentId === agentId);
  }

  reserve(patch, agentId) {
    const k = patchKey(patch);
    if (!this.canAssign(patch, agentId)) return false;
    this.reserved.set(k, agentId);
    return true;
  }

  markOccupied(patch, agentId, status) {
    const k = patchKey(patch);
    this.occupied.set(k, { agentId, status, ts: Date.now() });
  }

  release(patch, agentId) {
    const k = patchKey(patch);
    if (this.reserved.get(k) === agentId) this.reserved.delete(k);
  }

  assignNonConflictingPatches({ candidateActionsByAgent, maxPlansPerAgent = 3 }) {
    const assignments = {};

    // build patch plan candidates per agent
    const agentIds = Object.keys(candidateActionsByAgent);
    const plansByAgent = {};
    for (const agentId of agentIds) {
      const acts = candidateActionsByAgent[agentId];
      const plans = patchPlansFromCandidateActions({ candidateActions: acts, maxPlans: maxPlansPerAgent }).map((p, i) => ({
        ...p,
        regionId: acts[i]?.regionId,
      }));
      plansByAgent[agentId] = plans;
    }

    // greedy assign: for each agent, pick first plan not reserved
    for (const agentId of agentIds) {
      let picked = null;
      for (const p of plansByAgent[agentId]) {
        if (this.reserve(p, agentId)) {
          picked = p;
          break;
        }
      }
      assignments[agentId] = {
        patch: picked,
        conflicted: picked ? false : true,
        tried: plansByAgent[agentId].map(patchKey),
      };
    }

    return assignments;
  }

  expansionCandidate(patch) {
    // right neighbor first, then down
    const right = { ...patch, patchId: `${patch.patchId}_expR`, x: patch.x + patch.w };
    const down = { ...patch, patchId: `${patch.patchId}_expD`, y: patch.y + patch.h };
    return [right, down];
  }

  relocationCandidate({ agentId, candidateActions }) {
    const plans = patchPlansFromCandidateActions({ candidateActions, maxPlans: 8 }).map((p, i) => ({
      ...p,
      regionId: candidateActions[i]?.regionId,
    }));
    for (const p of plans) {
      const k = patchKey(p);
      const occ = this.occupied.get(k);
      if (occ && occ.agentId === agentId && (occ.status === "overwritten" || occ.status === "failed")) continue;
      if (this.canAssign(p, agentId)) return p;
    }
    return null;
  }
}

export async function runTwoAgentDemo({ baseUrl, boardWsUrl, snapshotIntervalMs = 1200 }) {
  const hist = new TemporalRegionHistory({ regionSize: 32, maxFrames: 3 });
  const s1 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s1.bytes, ts: Date.now() });
  await new Promise((r) => setTimeout(r, snapshotIntervalMs));
  const s2 = await fetchBoardSnapshot({ baseUrl });
  hist.addFrameFromPng({ pngBytes: s2.bytes, ts: Date.now() });

  const summaries = hist.computeTemporalSummaries();

  const coordinator = new PatchCoordinator();

  const agents = ["wave-restorer", "starry-finisher"];
  const candidateActionsByAgent = {};
  for (const a of agents) {
    candidateActionsByAgent[a] = candidateActionsForProfile({ regionSummaries: summaries, profileId: a, topN: 5 });
  }

  const assignments = coordinator.assignNonConflictingPatches({ candidateActionsByAgent, maxPlansPerAgent: 3 });

  const demo = { baseUrl, boardWsUrl, assignments: {}, results: {}, followups: {} };

  for (const agentId of agents) {
    const a = assignments[agentId];
    demo.assignments[agentId] = a;

    const patch = a.patch;
    if (!patch) {
      demo.results[agentId] = { status: "failed", stoppedReason: "no_nonconflicting_patch" };
      continue;
    }

    const execRes = await executePatchPlan({ baseUrl, boardWsUrl, patchPlan: patch, color: "#ffffff", chunkSize: 50 });
    coordinator.markOccupied(patch, agentId, execRes.status);
    coordinator.release(patch, agentId);
    demo.results[agentId] = execRes;

    if (execRes.status === "success") {
      const candidates = coordinator.expansionCandidate(patch);
      const picked = candidates.find((p) => coordinator.canAssign(p, agentId)) || null;
      demo.followups[agentId] = { kind: "expansion", candidates, picked };
    } else if (execRes.status === "overwritten" || execRes.matchRatio < 0.2) {
      const relocate = coordinator.relocationCandidate({ agentId, candidateActions: candidateActionsByAgent[agentId] });
      demo.followups[agentId] = { kind: "relocation", picked: relocate };
    } else {
      demo.followups[agentId] = { kind: "none" };
    }
  }

  // conflict check evidence
  const pickedKeys = agents
    .map((id) => ({ id, key: demo.assignments[id]?.patch ? patchKey(demo.assignments[id].patch) : null }))
    .filter((x) => x.key);
  demo.conflict = {
    picked: pickedKeys,
    unique: new Set(pickedKeys.map((x) => x.key)).size === pickedKeys.length,
  };

  return demo;
}
