#!/usr/bin/env python3
"""Upload Avalon short videos to Cloudflare R2.

Reads credentials from environment (expected to come from
~/.claude/credentials/.env) — R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, R2_BUCKET. Never hard-code.

Usage:
    python scripts/upload_videos_r2.py --dry-run
    python scripts/upload_videos_r2.py --bucket avalonpediatw-media

Gated on M0.4 Cloudflare account creation. See docs/M0.5_r2_spike.md.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import yaml  # type: ignore
except ImportError:
    print("missing dep: pip install pyyaml", file=sys.stderr)
    sys.exit(2)

SRC_DIR = Path(r"C:/Users/admin/GoogleDrive/專案/阿瓦隆百科/assets/videos")
MANIFEST = Path(__file__).resolve().parents[1] / "content" / "_data" / "video_manifest.yaml"
KEY_PREFIX = "videos/shorts/"


def _r2_client(account_id: str, access_key: str, secret_key: str):
    try:
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore
    except ImportError:
        print("missing dep: pip install boto3", file=sys.stderr)
        sys.exit(2)
    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4", region_name="auto"),
    )


def _load_manifest() -> list[dict]:
    if not MANIFEST.exists():
        print(f"manifest not found: {MANIFEST}", file=sys.stderr)
        sys.exit(1)
    data = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    videos = data.get("videos", [])
    if not videos:
        print("manifest has no videos", file=sys.stderr)
        sys.exit(1)
    return videos


def _dry_run(videos: list[dict], bucket: str) -> int:
    total = 0
    for v in videos:
        src = SRC_DIR / v["original_filename"]
        key = f"{KEY_PREFIX}{v['slug']}.mp4"
        if src.exists():
            size = src.stat().st_size
            total += size
            print(f"[dry] PUT s3://{bucket}/{key}  <- {src.name} ({size/1024/1024:.2f} MB)")
        else:
            print(f"[dry] MISSING {src}", file=sys.stderr)
    print(f"[dry] total: {total/1024/1024:.2f} MB across {len(videos)} files")
    return 0


def _upload(videos: list[dict], bucket: str) -> int:
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.environ.get(k)]
    if missing:
        print(f"missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("source ~/.claude/credentials/.env before running", file=sys.stderr)
        return 2

    client = _r2_client(
        os.environ["R2_ACCOUNT_ID"],
        os.environ["R2_ACCESS_KEY_ID"],
        os.environ["R2_SECRET_ACCESS_KEY"],
    )

    uploaded = 0
    for v in videos:
        src = SRC_DIR / v["original_filename"]
        if not src.exists():
            print(f"SKIP missing: {src}", file=sys.stderr)
            continue
        key = f"{KEY_PREFIX}{v['slug']}.mp4"
        print(f"PUT s3://{bucket}/{key}  ({src.stat().st_size:,} bytes)")
        client.upload_file(
            Filename=str(src),
            Bucket=bucket,
            Key=key,
            ExtraArgs={
                "ContentType": "video/mp4",
                "CacheControl": "public, max-age=31536000, immutable",
                "Metadata": {
                    "title-zh": v["title_zh"],
                    "role-tag": v["role_tag"],
                    "category": v["category"],
                },
            },
        )
        uploaded += 1
    print(f"uploaded {uploaded}/{len(videos)} videos")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bucket", default=os.environ.get("R2_BUCKET", "avalonpediatw-media"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    videos = _load_manifest()
    if args.dry_run:
        return _dry_run(videos, args.bucket)
    return _upload(videos, args.bucket)


if __name__ == "__main__":
    sys.exit(main())
