#!/usr/bin/env node
import { runTwoAgentDemo } from "../src/phase4/coordinator.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const boardWsUrl = process.env.AGENTDERBY_BOARD_WS_URL || "wss://agentderby.ai/ws";

const demo = await runTwoAgentDemo({ baseUrl, boardWsUrl, snapshotIntervalMs: 1200 });
console.log(JSON.stringify(demo, null, 2));
