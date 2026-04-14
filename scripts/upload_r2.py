#!/usr/bin/env python3
"""
Upload Avalon media assets to Cloudflare R2.

Reads the character-videos table from assets/EXTERNAL_REFS.md, uploads each
source file to the R2 bucket under the declared key, and rewrites the
"R2 URL (pending)" column in-place with the public URL.

Prerequisites:
    pip install boto3

Environment variables (required unless --dry-run):
    R2_ACCOUNT_ID          Cloudflare account id
    R2_ACCESS_KEY_ID       R2 API token access key
    R2_SECRET_ACCESS_KEY   R2 API token secret
    R2_BUCKET              e.g. avalonpediatw-media
    R2_PUBLIC_BASE         public URL base, e.g. https://media.avalonpediatw.com
                           or https://pub-<hash>.r2.dev

Usage:
    python scripts/upload_r2.py --dry-run
    python scripts/upload_r2.py
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REFS_PATH = REPO_ROOT / "assets" / "EXTERNAL_REFS.md"

ROW_RE = re.compile(
    r"^\|\s*(\d+)\s*"
    r"\|\s*([^|]+?)\s*"
    r"\|\s*`([^`]+)`\s*"
    r"\|\s*([\d,]+)\s*"
    r"\|\s*`([^`]+)`\s*"
    r"\|\s*([^|]+?)\s*\|"
)


def parse_refs(md_text: str) -> list[dict]:
    rows: list[dict] = []
    for line in md_text.splitlines():
        m = ROW_RE.match(line)
        if not m:
            continue
        rows.append({
            "idx": m.group(1),
            "name": m.group(2).strip(),
            "src": m.group(3).strip(),
            "size": int(m.group(4).replace(",", "")),
            "key": m.group(5).strip(),
            "url_cell": m.group(6).strip(),
            "raw": line,
        })
    return rows


def build_s3_client(account_id: str, access_key: str, secret_key: str):
    import boto3  # type: ignore
    from botocore.config import Config  # type: ignore
    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def content_type_for(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".mp4"):
        return "video/mp4"
    if lower.endswith(".webm"):
        return "video/webm"
    if lower.endswith(".mov"):
        return "video/quicktime"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    return "application/octet-stream"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse + validate only; no network calls.")
    args = ap.parse_args()

    if not REFS_PATH.exists():
        print(f"ERROR: {REFS_PATH} not found", file=sys.stderr)
        return 2

    md = REFS_PATH.read_text(encoding="utf-8")
    rows = parse_refs(md)
    if not rows:
        print("ERROR: no character-video rows parsed from EXTERNAL_REFS.md",
              file=sys.stderr)
        return 2

    print(f"Parsed {len(rows)} media refs from EXTERNAL_REFS.md")
    missing = [r for r in rows if not Path(r["src"]).exists()]
    if missing:
        print("WARN: source files missing:")
        for r in missing:
            print(f"  - {r['key']} -> {r['src']}")

    if args.dry_run:
        for r in rows:
            exists = "OK " if Path(r["src"]).exists() else "MISS"
            print(f"  [{exists}] {r['key']:40s} {r['size']:>12,} B")
        print("DRY RUN complete; no uploads performed.")
        return 0

    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET", "R2_PUBLIC_BASE"]
    missing_env = [k for k in required if not os.environ.get(k)]
    if missing_env:
        print(f"ERROR: missing env vars: {', '.join(missing_env)}",
              file=sys.stderr)
        return 2

    account_id = os.environ["R2_ACCOUNT_ID"]
    access_key = os.environ["R2_ACCESS_KEY_ID"]
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"]
    bucket = os.environ["R2_BUCKET"]
    public_base = os.environ["R2_PUBLIC_BASE"].rstrip("/")

    try:
        s3 = build_s3_client(account_id, access_key, secret_key)
    except ImportError:
        print("ERROR: boto3 not installed. Run: pip install boto3",
              file=sys.stderr)
        return 2

    updated_md = md
    for r in rows:
        src = Path(r["src"])
        if not src.exists():
            print(f"SKIP (missing): {r['key']}")
            continue
        print(f"UPLOAD -> s3://{bucket}/{r['key']}")
        try:
            s3.upload_file(
                str(src), bucket, r["key"],
                ExtraArgs={"ContentType": content_type_for(r["key"])},
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED: {exc}", file=sys.stderr)
            continue
        public_url = f"{public_base}/{r['key']}"
        new_row = re.sub(
            r"(\|\s*`" + re.escape(r["key"]) + r"`\s*\|\s*)`[^`]+`(\s*\|\s*)$",
            r"\1`" + public_url + r"`\2",
            r["raw"],
        )
        updated_md = updated_md.replace(r["raw"], new_row)
        print(f"  OK -> {public_url}")

    REFS_PATH.write_text(updated_md, encoding="utf-8")
    print(f"Updated {REFS_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
