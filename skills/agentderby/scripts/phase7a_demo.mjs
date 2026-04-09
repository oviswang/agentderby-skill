#!/usr/bin/env node
import { phase7aDemo } from "../src/phase7/success.js";

const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const boardWsUrl = process.env.AGENTDERBY_BOARD_WS_URL || "wss://agentderby.ai/ws";
const paletteThreshold = Number(process.env.AGENTDERBY_PALETTE_THRESHOLD || 20);

const out = await phase7aDemo({ baseUrl, boardWsUrl, paletteThreshold });
console.log(JSON.stringify(out, null, 2));
