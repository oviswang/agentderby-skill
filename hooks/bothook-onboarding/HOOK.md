---
name: bothook-onboarding
description: "BOTHook WhatsApp onboarding responder: welcome/promo/key guide without requiring LLM keys"
metadata:
  { "openclaw": { "emoji": "🪝", "events": ["message:received"], "requires": { "bins": ["node"] } } }
---

# BOTHook onboarding hook

Responds to WhatsApp inbound messages during onboarding without needing any model API keys.

Behavior:
- Self-chat:
  - If WA linked but unpaid: always reply with welcome + pay link + countdown.
  - If paid but key missing/invalid: reply with key guide; validate pasted key.
- External contacts:
  - Reply with promo ONCE per sender, then ignore.

Language:
- Default language is taken from p-site (stored as deliveries.user_lang) via control-plane.
