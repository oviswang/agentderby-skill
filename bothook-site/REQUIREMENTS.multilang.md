# BOTHook – Apple-Grade Language Switching Enhancement Module

Source: user-provided spec (2026-02-18)

## 1) Language Switch Transition (150ms Fade)
- On language switch:
  - Fade-out main content: 150ms opacity transition (ease-in-out)
  - Change locale URL
  - Render new locale
  - Fade-in: 150ms
- Total perceived transition ≈ 300ms max
- No slide/zoom/flashy motion; subtle opacity only

Implementation notes:
- Wrap main content.
- On switch: add `.is-transitioning` to wrapper -> opacity: 0
- After 150ms navigate to new locale
- On new page mount: start opacity 0, then animate to 1 (150ms)
- Mobile compatible, no interaction block >150ms, no white flash, no layout shift

## 2) Language list format
- Native name first + English name in parentheses
- No flags
- Left aligned; handle RTL separately
- Typography hierarchy:
  - Native weight 500
  - English weight 400, slightly lighter color

## 3) RTL auto layout (/ar/)
- direction: rtl
- Mirror layout direction, swap margins, reverse chevrons, flip nav alignment, CTA alignment
- Switcher dropdown: text right-aligned
- Fade animation unchanged

## 4) Switcher UI (Apple-like)
- Header: globe icon + current language short label
- Dropdown:
  - soft shadow
  - 8–12px radius
  - no harsh border
  - light blur backdrop if supported
- Mobile: bottom sheet or centered floating panel; calm/premium

## 5) Browser language suggestion banner
- First visit only
- If browser language matches supported locale and differs from default:
  - top slim banner “View this page in 日本語?”
  - buttons: Switch / Not now
  - subtle, dismissible
  - store dismissal in localStorage; never show again
  - no auto-redirect

## 6) Performance
- Target perceived switch latency <300ms
- If static multi-page: preload locale CSS
- Avoid blocking fonts / visible reflow

## 7) Emotional principle
- Controlled, thoughtful, invisible polish

## 8) Final reminders
- Works across 12 locales
- Preserve URL shareability
- SEO integrity: canonical + hreflang
- Never auto-redirect
- Never trap user
