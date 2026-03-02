#!/usr/bin/env python3

"""
P-site i18n strict audit (T9).

This is intentionally lightweight: it checks file presence + <html lang> + RTL dir for ar
+ basic link hygiene.

Run:  python3 p-site/scripts/i18n_audit.py
Writes: p-site/translation_strict_audit.md
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path


PAGES = ["index.html"]  # extend later when /p/<uuid> becomes static per-locale


@dataclass
class Issue:
    locale: str
    page: str
    kind: str
    detail: str


def extract_html_lang_and_dir(raw: str) -> tuple[str | None, str | None]:
    m = re.search(r"<html\b([^>]*)>", raw, re.I)
    if not m:
        return None, None
    attrs = m.group(1)
    lang = None
    dir_ = None
    mlang = re.search(r"\blang=\"([^\"]+)\"", attrs)
    if mlang:
        lang = mlang.group(1)
    mdir = re.search(r"\bdir=\"([^\"]+)\"", attrs)
    if mdir:
        dir_ = mdir.group(1)
    return lang, dir_


def main() -> int:
    repo = Path(__file__).resolve().parents[1]  # p-site/
    locales_path = repo / "i18n" / "locales.json"
    data = json.loads(locales_path.read_text(encoding="utf-8"))
    locales = [x["code"] for x in data["locales"]]

    issues: list[Issue] = []

    for loc in locales:
        # en is root; others are /<loc>/
        base = repo if loc == "en" else (repo / loc)
        for page in PAGES:
            path = base / page
            if not path.exists():
                issues.append(Issue(loc, page, "missing_file", str(path.relative_to(repo))))
                continue
            raw = path.read_text(encoding="utf-8")
            lang, dir_ = extract_html_lang_and_dir(raw)
            if not lang:
                issues.append(Issue(loc, page, "missing_html_lang", ""))
            if loc == "ar" and dir_ != "rtl":
                issues.append(Issue(loc, page, "missing_dir_rtl", ""))

    out: list[str] = []
    out.append("# p-site i18n strict audit (T9)")
    out.append("")
    out.append("Locales: " + ", ").join(locales))
    out.append("Pages: " + ", ").join(PAGES))
    out.append("")

    if not issues:
        out.append("No issues found.")
    else:
        out.append(f"Issues: {len(issues)}")
        out.append("")
        for it in issues:
            out.append(f"- [{it.locale}] {it.page}: {it.kind} {it.detail}")

    (repo / "translation_strict_audit.md").write_text("\n".join(out), encoding="utf-8")
    return 0 if not issues else 2


if __name__ == "__main__":
    raise SystemExit(main())
