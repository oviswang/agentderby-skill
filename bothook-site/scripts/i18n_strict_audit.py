#!/usr/bin/env python3
"""Strict i18n audit for bothook-site.

Checks:
- Each locale has index/contact/terms/privacy
- Canonical URL matches the locale path
- For Arabic pages: dir="rtl"
- Footer/nav links: home + contact + terms + privacy all point to locale pages (no root /contact.html, etc.)
- Index language switch panel contains hrefs for all locales + '/'

Outputs:
- translation_strict_audit.md (issues grouped by locale/page)

Exit code:
- 0 if no issues
- 2 if issues found
"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Tuple
from urllib.parse import urlparse
import os
import re

PAGES = ["index.html", "contact.html", "terms.html", "privacy.html"]


class LinkExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        d = dict(attrs)
        href = d.get("href")
        if href:
            self.links.append(href)


class HeadExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lang = None
        self.dir = None
        self.canonical = None
        self.alternates: List[Tuple[str | None, str | None]] = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "html":
            self.lang = d.get("lang")
            self.dir = d.get("dir")
        if tag == "link":
            rel = d.get("rel", "")
            if rel == "canonical":
                self.canonical = d.get("href")
            if rel == "alternate":
                self.alternates.append((d.get("hreflang"), d.get("href")))


def norm_href(href: str) -> str:
    if href.startswith("http://") or href.startswith("https://"):
        u = urlparse(href)
        return u.path
    return href


def extract_links(path: Path) -> List[str]:
    p = LinkExtractor()
    p.feed(path.read_text(encoding="utf-8"))
    return [norm_href(h) for h in p.links]


def extract_head(path: Path) -> HeadExtractor:
    p = HeadExtractor()
    p.feed(path.read_text(encoding="utf-8"))
    return p


def extract_langpanel_hrefs(raw: str) -> List[str]:
    # Best-effort: slice a block that contains the language menu.
    m = re.search(r'<div[^>]+id="langPanel"[\s\S]*?</div>\s*</div>', raw)
    if not m:
        return []
    frag = m.group(0)
    return re.findall(r'href="([^"]+)"', frag)


@dataclass
class Issue:
    locale: str
    page: str
    kind: str
    detail: str


def main() -> int:
    root = Path(".")
    locales = [
        d
        for d in os.listdir(root)
        if (root / d).is_dir() and (root / d / "index.html").exists() and d not in ("assets", "scripts")
    ]
    locales = sorted(locales)

    expected_footer = {
        loc: {
            "home": f"/{loc}/",
            "contact": f"/{loc}/contact.html",
            "terms": f"/{loc}/terms.html",
            "privacy": f"/{loc}/privacy.html",
        }
        for loc in locales
    }

    issues: List[Issue] = []

    for loc in locales:
        for page in PAGES:
            path = root / loc / page
            if not path.exists():
                issues.append(Issue(loc, page, "missing_file", ""))
                continue

            raw = path.read_text(encoding="utf-8")
            links = [h for h in extract_links(path) if h.startswith("/")]

            # Footer / navigation links
            for key, href in expected_footer[loc].items():
                if href not in links:
                    issues.append(Issue(loc, page, f"missing_{key}_link", href))

            for bad in ("/contact.html", "/terms.html", "/privacy.html"):
                if bad in links:
                    issues.append(Issue(loc, page, "bad_root_link", bad))

            # Head / canonical / direction
            head = extract_head(path)
            if not head.lang:
                issues.append(Issue(loc, page, "missing_html_lang", ""))

            if loc == "ar" and head.dir != "rtl":
                issues.append(Issue(loc, page, "missing_dir_rtl", ""))

            if not head.canonical:
                issues.append(Issue(loc, page, "missing_canonical", ""))
            else:
                can = norm_href(head.canonical)
                exp = f"/{loc}/" if page == "index.html" else f"/{loc}/{page}"
                if can != exp:
                    issues.append(Issue(loc, page, "canonical_mismatch", f"{can} != {exp}"))

            # Index language panel completeness
            if page == "index.html":
                panel_hrefs = extract_langpanel_hrefs(raw)
                needed = ["/"] + [f"/{l}/" for l in locales]
                missing = [h for h in needed if h not in panel_hrefs]
                if missing:
                    issues.append(Issue(loc, page, "langpanel_missing_hrefs", ", ".join(missing[:12]) + ("..." if len(missing) > 12 else "")))

    # Write report
    out: List[str] = []
    out.append("# i18n strict audit")
    out.append(f"Locales: {', '.join(locales)}")
    out.append(f"Pages: {', '.join(PAGES)}")
    out.append("")

    if not issues:
        out.append("No issues found.")
    else:
        from collections import defaultdict

        g = defaultdict(list)
        for it in issues:
            g[(it.locale, it.page)].append(it)
        for (loc, page), items in sorted(g.items()):
            out.append(f"## {loc}/{page}")
            for it in items:
                out.append(f"- {it.kind}: {it.detail}")
            out.append("")

    Path("translation_strict_audit.md").write_text("\n".join(out), encoding="utf-8")

    return 0 if not issues else 2


if __name__ == "__main__":
    raise SystemExit(main())
