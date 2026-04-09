#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PHASES = {
  "1": {
    phase: "Phase 1",
    script: path.join(__dirname, "phase1_demo.mjs"),
    files: [
      "skills/agentderby/src/phase1/region_scan.js",
      "skills/agentderby/src/client/board.js",
      "skills/agentderby/scripts/phase1_demo.mjs",
    ],
    demonstrates: [
      "full-board scan (PNG)",
      "RegionSummary samples",
      "AgentProfiles",
      "top-N recommendations",
    ],
  },
  "3": {
    phase: "Phase 3",
    script: path.join(__dirname, "phase3_evidence.mjs"),
    files: [
      "skills/agentderby/src/phase3/executor.js",
      "skills/agentderby/src/client/boardws.js",
      "skills/agentderby/scripts/phase3_evidence.mjs",
    ],
    demonstrates: [
      "WS allowDraw evidence",
      "before/after readback",
      "matchRatio + overwrite detection",
    ],
  },
  "6.1": {
    phase: "Phase 6.1",
    script: path.join(__dirname, "phase6_1_demo.mjs"),
    files: [
      "skills/agentderby/src/phase6/artwork_exec61.js",
      "skills/agentderby/src/phase5/refine.js",
      "skills/agentderby/src/phase3/executor.js",
      "skills/agentderby/scripts/phase6_1_demo.mjs",
    ],
    demonstrates: [
      "frontier dedupe memory",
      "relocation scoring",
      "cooldownUntil + scheduler skip",
      "validated execution results (readback)",
    ],
  },
};

function runNode(scriptPath, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function summarizeEvidence(phaseKey, payload) {
  // minimal standardized evidence summaries per phase
  if (!payload) return { pass: false, evidence: { reason: "non_json_output" }, limitations: ["demo did not output JSON"] };

  if (phaseKey === "1") {
    const ok = payload?.board?.regions && payload?.profiles && payload?.recommendations;
    return {
      pass: !!ok,
      evidence: {
        board: payload.board,
        sampleRegions: (payload.sampleRegionSummaries || []).slice(0, 2),
        profiles: Object.keys(payload.profiles || {}),
      },
      limitations: ["Phase 1 has no temporal change rate"],
    };
  }

  if (phaseKey === "3") {
    // phase3 evidence script prints execution trace object
    const trace = payload?.executionTrace?.[0];
    const ok = trace && typeof trace.allowDraw === "boolean" && typeof trace.matchRatio === "number" && trace.status;
    return {
      pass: !!ok,
      evidence: {
        allowDraw: trace?.allowDraw,
        accepted: trace?.accepted,
        matched: trace?.matched,
        matchRatio: trace?.matchRatio,
        status: trace?.status,
      },
      limitations: trace?.status === "overwritten" ? ["high contestation (overwrites) possible"] : [],
    };
  }

  if (phaseKey === "6.1") {
    const attempts = payload?.attempts || [];
    const has3 = attempts.length >= 3;
    const hasCooldown = payload?.finalState?.status === "cooldown";
    const hasSkip = payload?.cooldownSkipEvidence?.shouldSkip === true;
    const noImmediateDup = (() => {
      const ids = attempts.map((a) => a.attempt?.patchId).filter(Boolean);
      for (let i = 1; i < ids.length; i++) if (ids[i] === ids[i - 1]) return false;
      return true;
    })();
    const ok = has3 && noImmediateDup && (hasCooldown ? hasSkip : true);
    return {
      pass: !!ok,
      evidence: {
        chosenGoal: payload?.chosenGoal,
        attempts: attempts.map((a) => ({
          patchId: a.attempt?.patchId,
          status: a.attempt?.status,
          matchRatio: a.attempt?.matchRatio,
          relocationCandidate: a.attempt?.relocationCandidate || null,
        })),
        finalStatus: payload?.finalState?.status,
        cooldownSkipEvidence: payload?.cooldownSkipEvidence,
      },
      limitations: payload?.finalState?.status === "cooldown" ? ["goal entered cooldown due to repeated overwrites"] : [],
    };
  }

  return { pass: false, evidence: { reason: "no_summarizer" }, limitations: [] };
}

async function main() {
  const phaseKey = process.argv[2];
  if (!phaseKey || !(phaseKey in PHASES)) {
    const keys = Object.keys(PHASES).join(", ");
    console.error(`usage: node ${path.basename(__filename)} <phase>  (phase in: ${keys})`);
    process.exit(2);
  }

  const spec = PHASES[phaseKey];
  const startedAt = new Date().toISOString();

  const { code, stdout, stderr } = await runNode(spec.script);
  const payload = safeJsonParse(stdout.trim());
  const summary = summarizeEvidence(phaseKey, payload);

  const out = {
    kind: "agentderby.acceptance.v1",
    phase: spec.phase,
    phaseKey,
    startedAt,
    exitCode: code,
    filesInvolved: spec.files,
    demonstrates: spec.demonstrates,
    pass: summary.pass && code === 0,
    evidenceSummary: summary.evidence,
    limitations: summary.limitations,
    raw: {
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stderrTail: stderr.slice(-2000),
    },
  };

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e));
  process.exit(1);
});
