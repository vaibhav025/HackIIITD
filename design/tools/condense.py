"""Condense Figma get_design_context React output into an indented outline:
name | meaningful classes | text. Keeps the visual spec, drops wrapper noise."""
import re, sys
from html.parser import HTMLParser

KEEP = re.compile(r"^(bg-|border|rounded|shadow|drop-shadow|text-\[|text-(left|center|right)|font-\[|font-|tracking|leading-\[|uppercase|italic|p[xytrbl]?-\[|gap-|w-\[|h-\[|size-\[|min-|max-|opacity|grid|flex-col|justify-|items-|rotate|-rotate|inset|top-|left-|absolute|underline|line-through)")
NOISE = {"bg-clip-padding", "border-0", "border-[transparent]", "border-solid", "content-stretch", "leading-[0]", "not-italic"}

src = open(sys.argv[1]).read()
body = src[src.index("return (") :] if "return (" in src else src
body = re.sub(r"style=\{\{[^}]*\}\}", "", body)
body = re.sub(r"src=\{(\w+)\}", r'src="\1"', body)
body = re.sub(r"\{\s*`([^`]*)`\s*\}", r"\1", body)
body = re.sub(r'\{"([^"]*)"\}', r"\1", body)

class P(HTMLParser):
    def __init__(self):
        super().__init__(); self.depth = 0; self.out = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = [c for c in (a.get("classname") or "").split() if KEEP.match(c) and c not in NOISE]
        name = a.get("data-name") or ""
        nid = a.get("data-node-id") or ""
        extra = f" img={a['src']}" if tag == "img" else ""
        if name or cls or extra:
            self.out.append("  " * self.depth + f"<{tag} {nid} {name!r}> " + " ".join(cls) + extra)
        if tag not in ("img", "br", "input"):
            self.depth += 1
    def handle_endtag(self, tag):
        if tag not in ("img", "br", "input"):
            self.depth -= 1
    def handle_data(self, data):
        t = data.strip()
        if t and not t.startswith(("{", ")", "}")):
            self.out.append("  " * self.depth + "» " + t)

p = P(); p.feed(body)
print("\n".join(p.out))
