"""Download every asset constant in a Figma context file into public/figma/<page>/."""
import re, subprocess, sys, pathlib
ctx, page = sys.argv[1], sys.argv[2]
out = pathlib.Path(__file__).resolve().parents[2] / "frontend/public/figma" / page
out.mkdir(parents=True, exist_ok=True)
for name, url in re.findall(r'^const (\w+) = "(https://www\.figma\.com/api/mcp/asset/[^"]+)"', open(ctx).read(), re.M):
    ext = url.rsplit(".", 1)[-1]
    dest = out / f"{name}.{ext}"
    subprocess.run(["curl", "-sfL", "-o", str(dest), url], check=True)
    print(dest.name, dest.stat().st_size)
