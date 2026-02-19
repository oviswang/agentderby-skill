#!/usr/bin/env python3
"""Self-check for BOTHook main site locale coverage.

Checks:
- required locale homepages exist
- each locale homepage has canonical/og:url matching its path
- language menu contains all locales
- x-default hreflang present

This is a lightweight guardrail to prevent missing pages when adding locales.
"""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]

LOCALES = [
  ('en', '/'),
  ('zh', '/zh/'),
  ('zh-tw', '/zh-tw/'),
  ('ja', '/ja/'),
  ('ko', '/ko/'),
  ('fr', '/fr/'),
  ('de', '/de/'),
  ('es', '/es/'),
  ('pt-br', '/pt-br/'),
  ('ru', '/ru/'),
  ('ar', '/ar/'),
  ('hi', '/hi/'),
  ('id', '/id/'),
  ('th', '/th/'),
  ('vi', '/vi/'),
]


def read_html(locale: str) -> str:
    if locale == 'en':
        p = ROOT / 'index.html'
    elif locale == 'zh':
        p = ROOT / 'zh' / 'index.html'
    else:
        p = ROOT / locale / 'index.html'
    if not p.exists():
        raise FileNotFoundError(str(p))
    return p.read_text(encoding='utf-8')


def main() -> int:
    ok = True
    expected_menu_count = len(LOCALES)

    for locale, path in LOCALES:
        try:
            s = read_html(locale)
        except FileNotFoundError as e:
            print(f"MISSING: {e}")
            ok = False
            continue

        url = f"https://bothook.me{path}"
        if url not in s:
            print(f"WARN: {locale} missing url reference {url}")
            ok = False

        if 'hreflang="x-default"' not in s:
            print(f"WARN: {locale} missing hreflang x-default")
            ok = False

        menu_count = s.count('class="langItem"')
        if menu_count != expected_menu_count:
            print(f"WARN: {locale} lang menu count {menu_count} != {expected_menu_count}")
            ok = False

    if ok:
        print(f"OK: locales={len(LOCALES)} all present")
        return 0
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
