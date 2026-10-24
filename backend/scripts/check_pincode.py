"""End-to-end check of ONE product on ONE app at ONE pincode through TinyFish.

Run from backend/ (uses real TinyFish credits: one agent run, ~4 minutes):

    python -m scripts.check_pincode --app instamart --pincode 110017 \\
        --product "Amul Taaza Toned Milk 500 ml"

Exit codes: 0 = result read, 1 = check failed or nothing could be read,
2 = configuration problem (no TINYFISH_API_KEY, bad arguments).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from app.config import get_settings
from app.services.tinyfish import TinyFishError
from app.services.tinyfish.base import AgentStep
from app.services.tinyfish.mock_client import MockTinyFishClient
from app.services.tinyfish.tinyfish_client import (
    LIVE_APPS,
    TinyFishLiveClient,
    check_pincode,
)


async def print_step(step: AgentStep) -> None:
    detail = f" · {step['detail']}" if step["detail"] else ""
    print(f"  [{step['ms'] / 1000:6.1f}s] {step['kind']:<10} {step['label']}{detail}")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", default="instamart", choices=LIVE_APPS)
    parser.add_argument("--pincode", default="110017")
    parser.add_argument("--product", default="Amul Taaza Toned Milk 500 ml")
    parser.add_argument("--url", help="Product page URL to open instead of searching")
    parser.add_argument(
        "--debug-dir", type=Path, help="Save page PNG + HTML here when a step fails"
    )
    parser.add_argument(
        "--allow-simulated",
        action="store_true",
        help="Run against the simulator when no TINYFISH_API_KEY is set",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

    settings = get_settings()
    if settings.tinyfish_enabled:
        client = TinyFishLiveClient(settings, debug_dir=args.debug_dir)
    elif args.allow_simulated:
        client = MockTinyFishClient()
    else:
        print(
            "TINYFISH_API_KEY is not set (or MOCK_MODE=true). Add it to backend/.env, "
            "or pass --allow-simulated to test against the simulator.",
            file=sys.stderr,
        )
        return 2

    print(f"Checking “{args.product}” on {args.app} at {args.pincode} ({client.mode})")
    try:
        result = await check_pincode(
            args.app,
            args.pincode,
            args.product,
            url=args.url,
            on_step=print_step,
            client=client,
        )
    except ValueError as exc:
        print(f"Invalid input: {exc}", file=sys.stderr)
        return 2
    except TinyFishError as exc:
        print(f"\nFAILED (retryable={exc.retryable}): {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    if result["in_stock"] is None and result["price"] is None:
        print("\nNo matching product was read from the page.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
