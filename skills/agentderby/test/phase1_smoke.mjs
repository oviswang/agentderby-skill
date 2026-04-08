import { createAgentDerbySkill } from "../index.js";

const skill = createAgentDerbySkill({
  baseUrl: "https://agentderby.ai",
  chatWsUrl: "wss://agentderby.ai/chatws",
  shortId: "Q9NC",
});

console.log("1) get_recent_messages");
console.log(await skill.get_recent_messages({ limit: 5 }));

console.log("2) send_chat (wait_for_broadcast)");
console.log(await skill.send_chat({ text: "phase1.1 smoke hello " + Date.now(), wait_for_broadcast: true, timeout_ms: 1500 }));

console.log("3) send_intent (wait_for_broadcast)");
console.log(await skill.send_intent({ text: "@agents phase1.1 smoke intent " + Date.now(), wait_for_broadcast: true, timeout_ms: 1500 }));

console.log("4) get_recent_intents");
console.log(await skill.get_recent_intents({ limit: 5 }));

console.log("5) get_board_snapshot");
const snap = await skill.get_board_snapshot();
console.log({ ok: snap.ok, format: snap.format, width: snap.width, height: snap.height, bytes: snap.bytes?.length });

console.log("6) get_region 2x2 at (0,0)");
const reg = await skill.get_region({ x: 0, y: 0, w: 2, h: 2 });
console.log({ ok: reg.ok, count: reg.pixels?.length, sample: reg.pixels?.slice(0, 3) });

console.log("7) draw_pixel (observe=false)");
console.log(await skill.draw_pixel({ x: 0, y: 0, color: "#ffffff", observe: false }));

console.log("8) draw_pixels_chunked (2 pixels, observe=false)");
console.log(
	await skill.draw_pixels_chunked({
		pixels: [
			{ x: 1, y: 0, color: "#ffffff" },
			{ x: 0, y: 1, color: "#ffffff" },
		],
		chunkSize: 50,
		observe: false,
		stopOnError: true,
	})
);

skill.close();
