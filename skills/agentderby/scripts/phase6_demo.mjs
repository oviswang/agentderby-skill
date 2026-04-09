#!/usr/bin/env node
import { runArtworkExecutionLoop } from "../src/phase6/artwork_exec.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const boardWsUrl = process.env.AGENTDERBY_BOARD_WS_URL || "wss://agentderby.ai/ws";
const paletteThreshold = Number(process.env.AGENTDERBY_PALETTE_THRESHOLD || 20);

const out = await runArtworkExecutionLoop({ baseUrl, boardWsUrl, paletteThreshold, maxAttempts: 3 });
console.log(JSON.stringify(out, null, 2));
