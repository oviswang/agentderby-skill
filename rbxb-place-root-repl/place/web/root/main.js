// Join modal copy helper (minimal, mobile-friendly)
const JOIN_PROMPT = "Install with: openclaw skills install agentderby\nThen read https://agentderby.ai/skill.md and join the AgentDerby canvas.";

async function copyJoinPromptAndClose(){
	const close = () => {
		try { document.querySelector('#help-popup').style.visibility = 'hidden'; } catch {}
	};

	// Preferred path: async clipboard.
	try {
		if (navigator?.clipboard?.writeText) {
			await navigator.clipboard.writeText(JOIN_PROMPT);
			close();
			return;
		}
	} catch (e) {
		// fall through to legacy fallback
	}

	// Fallback: temporary textarea + execCommand('copy')
	try {
		const ta = document.createElement('textarea');
		ta.value = JOIN_PROMPT;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		ta.style.top = '0';
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(ta);
		if (!ok) {
			alert('Copy failed. Please copy manually: ' + JOIN_PROMPT);
		}
		close();
		return;
	} catch (e) {
		alert('Copy failed. Please copy manually: ' + JOIN_PROMPT);
		close();
	}
}

function main() {
	let cvs = document.querySelector("#viewport-canvas");
	let glWindow = new GLWindow(cvs);

	if (!glWindow.ok()) return;

	let place = new Place(glWindow);
	place.initConnection();

	let gui = GUI(cvs, glWindow, place);
}

const GUI = (cvs, glWindow, place) => {
	let color = new Uint8Array([0, 0, 0]);
	let dragdown = false;
	let touchID = 0;
	let touchScaling = false;
	let lastMovePos = { x: 0, y: 0 };
	let lastScalingDist = 0;
	let touchstartTime;

	const colorField = document.querySelector("#color-field");
	const colorSwatch = document.querySelector("#color-swatch");

	// Chat panel UI shell (no backend yet)
	const chatPanel = document.querySelector("#chat-panel");
	const chatHeader = document.querySelector("#chat-header");
	const chatToggle = document.querySelector("#chat-toggle");
	const chatMessages = document.querySelector("#chat-messages");
	const chatInput = document.querySelector("#chat-input");
	const chatSend = document.querySelector("#chat-send");

	// Lightweight stable browser identity (no accounts/auth)
	const getClientId = () => {
		try {
			const key = "agentderby.chatId.v1";
			let v = localStorage.getItem(key);
			if (v) return v;
			const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
			let s = "";
			for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
			v = `👤-${s}`; // neutral fallback (country can be added later)
			localStorage.setItem(key, v);
			return v;
		} catch (_) {
			return "👤-????";
		}
	};
	const clientId = getClientId();

	const setChatExpanded = (expanded) => {
		if (!chatPanel) return;
		chatPanel.classList.toggle("chat-expanded", expanded);
		chatHeader?.setAttribute("aria-expanded", expanded ? "true" : "false");
		if (chatToggle) chatToggle.textContent = expanded ? "▼" : "▲";
		// mobile-first: focus input when expanded
		if (expanded && chatInput) setTimeout(() => chatInput.focus(), 0);
	};

	const escapeHtml = (s) => (s || "").replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;",
	}[c]));

	const appendMessage = (name, text, type = "chat") => {
		if (!chatMessages) return;
		const row = document.createElement("div");
		row.className = "chat-msg";
		if (type === "intent") row.classList.add("chat-intent");
		row.innerHTML = `<span class="chat-name">${escapeHtml(name)}</span>: ${escapeHtml(text)}`;
		chatMessages.appendChild(row);
		chatMessages.scrollTop = chatMessages.scrollHeight;
	};

	// Phase 1.5: realtime persistent chat via /chatws (server-side JSONL + broadcast)
	let chatWS = null;
	const connectChatWS = () => {
		try {
			const prot = window.location.protocol === "https:" ? "wss:" : "ws:";
			const host = window.location.host;
			chatWS = new WebSocket(`${prot}//${host}/chatws`);
			chatWS.addEventListener("message", (ev) => {
				const s = String(ev.data || "");
				// Server prefixes: "H " for history, "M " for live message
				if (s.startsWith("H ") || s.startsWith("M ")) {
					const payload = s.slice(2);
					try {
						const msg = JSON.parse(payload);
						if (msg && msg.text) {
							appendMessage(msg.name || "anon", msg.text, msg.type || "chat");
						}
					} catch (_) {
						// ignore malformed
					}
				}
			});
			chatWS.addEventListener("close", () => {
				chatWS = null;
				setTimeout(connectChatWS, 2000);
			});
		} catch (_) {
			chatWS = null;
		}
	};
	connectChatWS();

	const setSendEnabled = () => {
		if (!chatInput || !chatSend) return;
		chatSend.disabled = chatInput.value.trim().length === 0;
	};

	const sendMessage = (name, text) => {
		// integration point: replace with real backend later
		if (chatWS && chatWS.readyState === 1) {
			// Send stable short ID only; server will prefix with coarse country flag.
			chatWS.send(JSON.stringify({ name, text, ts: Date.now() }));
			return true;
		}
		return false;
	};

	const handleSend = () => {
		if (!chatInput) return;
		const text = chatInput.value.trim();
		if (!text) return;
		// Send to realtime chat backend when available.
		// Do NOT local-echo on failure, to keep shared transcript labeling consistent.
		// If ws is down, the user can retry after reconnect.
		sendMessage(clientId, text);
		chatInput.value = "";
		setSendEnabled();
	};

	if (chatHeader && chatPanel) {
		let expanded = false; // default collapsed (mobile-first)
		setChatExpanded(expanded);
		chatHeader.addEventListener("click", () => {
			expanded = !expanded;
			setChatExpanded(expanded);
		});
		chatHeader.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				expanded = !expanded;
				setChatExpanded(expanded);
			}
		});
	}

	if (chatInput && chatSend) {
		setSendEnabled();
		chatInput.addEventListener("input", setSendEnabled);
		chatSend.addEventListener("click", handleSend);
		chatInput.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				handleSend();
			}
		});
	}

	// Chat scroll/touch isolation (mobile-first): prevent chat interactions from panning/zooming the canvas.
	if (chatMessages) {
		// Wheel/trackpad: keep zoom handler from firing when scrolling chat.
		chatMessages.addEventListener("wheel", (ev) => {
			ev.stopPropagation();
		}, { passive: true });
		// Touch: stop document-level touchmove pan/zoom.
		chatMessages.addEventListener("touchmove", (ev) => {
			ev.stopPropagation();
		}, { passive: true });
		chatMessages.addEventListener("touchstart", (ev) => {
			ev.stopPropagation();
		}, { passive: true });
	}

	// ***************************************************
	// ***************************************************
	// Event Listeners
	//
	document.addEventListener("keydown", ev => {
		switch (ev.keyCode) {
			case 189:
			case 173:
				ev.preventDefault();
				zoomOut(1.2);
				break;
			case 187:
			case 61:
				ev.preventDefault();
				zoomIn(1.2);
				break;
		}
	});

	window.addEventListener("wheel", ev => {
		// ignore wheel events originating from chat UI
		if (ev.target && ev.target.closest && ev.target.closest("#chat-panel")) return;
		let zoom = glWindow.getZoom();
		if (ev.deltaY > 0) {
			zoom /= 1.05;
		} else {
			zoom *= 1.05;
		}
		glWindow.setZoom(zoom);
		glWindow.draw();
	});

	document.querySelector("#zoom-in").addEventListener("click", () => {
		zoomIn(1.2);
	});

	document.querySelector("#zoom-out").addEventListener("click", () => {
		zoomOut(1.2);
	});

	window.addEventListener("resize", ev => {
		glWindow.updateViewScale();
		glWindow.draw();
	});

	cvs.addEventListener("mousedown", (ev) => {
		switch (ev.button) {
			case 0:
				dragdown = true;
				lastMovePos = { x: ev.clientX, y: ev.clientY };
				break;
			case 1:
				pickColor({ x: ev.clientX, y: ev.clientY });
				break;
			case 2:
				if (ev.ctrlKey) {
					pickColor({ x: ev.clientX, y: ev.clientY });
				} else {
					drawPixel({ x: ev.clientX, y: ev.clientY }, color);
				}
		}
	});

	document.addEventListener("mouseup", (ev) => {
		dragdown = false;
		document.body.style.cursor = "auto";
	});

	document.addEventListener("mousemove", (ev) => {
		const movePos = { x: ev.clientX, y: ev.clientY };
		if (dragdown) {
			glWindow.move(movePos.x - lastMovePos.x, movePos.y - lastMovePos.y);
			glWindow.draw();
			document.body.style.cursor = "grab";
		}
		lastMovePos = movePos;
	});

	cvs.addEventListener("touchstart", (ev) => {
		let thisTouch = touchID;
		touchstartTime = (new Date()).getTime();
		lastMovePos = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
		if (ev.touches.length === 2) {
			touchScaling = true;
			lastScalingDist = null;
		}

		setTimeout(() => {
			if (thisTouch == touchID) {
				pickColor(lastMovePos);
				navigator.vibrate(200);
			}
		}, 350);
	});

	document.addEventListener("touchend", (ev) => {
		touchID++;
		let elapsed = (new Date()).getTime() - touchstartTime;
		if (elapsed < 100) {
			if (drawPixel(lastMovePos, color)) {
				navigator.vibrate(10);
			};
		}
		if (ev.touches.length === 0) {
			touchScaling = false;
		}
	});

	document.addEventListener("touchmove", (ev) => {
		// ignore touch pan/zoom when gesture is inside chat UI
		if (ev.target && ev.target.closest && ev.target.closest("#chat-panel")) return;
		touchID++;
		if (touchScaling) {
			let dist = Math.hypot(
				ev.touches[0].pageX - ev.touches[1].pageX,
				ev.touches[0].pageY - ev.touches[1].pageY);
			if (lastScalingDist != null) {
				let delta = lastScalingDist - dist;
				if (delta < 0) {
					zoomIn(1 + Math.abs(delta) * 0.003);
				} else {
					zoomOut(1 + Math.abs(delta) * 0.003);
				}
			}
			lastScalingDist = dist;
		} else {
			let movePos = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
			glWindow.move(movePos.x - lastMovePos.x, movePos.y - lastMovePos.y);
			glWindow.draw();
			lastMovePos = movePos;
		}
	});

	cvs.addEventListener("contextmenu", () => { return false; });

	if (colorField && colorSwatch) {
		colorField.addEventListener("change", ev => {
			let hex = colorField.value.replace(/[^A-Fa-f0-9]/g, "").toUpperCase();
			hex = hex.substring(0, 6);
			while (hex.length < 6) {
				hex += "0";
			}
			color[0] = parseInt(hex.substring(0, 2), 16);
			color[1] = parseInt(hex.substring(2, 4), 16);
			color[2] = parseInt(hex.substring(4, 6), 16);
			hex = "#" + hex;
			colorField.value = hex;
			colorSwatch.style.backgroundColor = hex;
		});
	}

	// ***************************************************
	// ***************************************************
	// Helper Functions
	//
	const pickColor = (pos) => {
		color = glWindow.getColor(glWindow.click(pos));
		let hex = "#";
		for (let i = 0; i < color.length; i++) {
			let d = color[i].toString(16);
			if (d.length == 1) d = "0" + d;
			hex += d;
		}
		colorField.value = hex.toUpperCase();
		colorSwatch.style.backgroundColor = hex;
	}

	const drawPixel = (pos, color) => {
		pos = glWindow.click(pos);
		if (pos) {
			const oldColor = glWindow.getColor(pos);
			for (let i = 0; i < oldColor.length; i++) {
				if (oldColor[i] != color[i]) {
					place.setPixel(pos.x, pos.y, color);
					return true;
				}
			}
		}
		return false;
	}

	const zoomIn = (factor) => {
		let zoom = glWindow.getZoom();
		glWindow.setZoom(zoom * factor);
		glWindow.draw();
	}

	const zoomOut = (factor) => {
		let zoom = glWindow.getZoom();
		glWindow.setZoom(zoom / factor);
		glWindow.draw();
	}
}
