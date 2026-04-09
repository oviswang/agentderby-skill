#!/usr/bin/env node
import { phase5Demo } from "../src/phase5/artwork.js";
const baseUrl = process.env.AGENTDERBY_BASE_URL || "https://agentderby.ai";
const demo = await phase5Demo({ baseUrl, snapshotIntervalMs: 1200 });
console.log(JSON.stringify(demo, null, 2));
