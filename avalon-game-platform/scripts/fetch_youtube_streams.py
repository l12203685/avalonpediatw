#!/usr/bin/env python3
"""Fetch past live streams from @AvalonPediaTW YouTube channel.

Uses yt-dlp (no API key required). Writes result to
`packages/web/src/data/streams.json` consumed by StreamsSection.tsx.

Usage:
    python -m yt_dlp  # ensure yt-dlp is installed
    python scripts/fetch_youtube_streams.py

The script:
  1. Lists the channel's /streams tab (flat playlist, no per-video fetch)
  2. Fetches upload_date + view_count + duration for each video (one pass)
  3. Writes sorted (newest-first) JSON for the web frontend
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

CHANNEL_URL = "https://www.youtube.com/@AvalonPediaTW"
STREAMS_TAB = f"{CHANNEL_URL}/streams"
OUT_PATH = Path(__file__).resolve().parents[1] / "packages/web/src/data/streams.json"
FETCHED_AT = __import__("datetime").date.today().isoformat()


def run_yt_dlp(args: list[str]) -> str:
    cmd = [sys.executable, "-m", "yt_dlp", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        raise RuntimeError(f"yt-dlp failed: exit {proc.returncode}")
    return proc.stdout


def main() -> int:
    # Step 1: flat playlist listing
    raw = run_yt_dlp(["--flat-playlist", "-J", STREAMS_TAB])
    listing = json.loads(raw)
    entries = listing.get("entries", [])
    if not entries:
        sys.stderr.write("No streams found.\n")
        return 1

    # Step 2: metadata pass (upload_date, view_count, duration)
    ids = [e["id"] for e in entries]
    meta_raw = run_yt_dlp(
        [
            "--skip-download",
            "--print",
            "%(id)s|%(upload_date)s|%(view_count)s|%(duration)s",
            *ids,
        ]
    )
    meta: dict[str, dict] = {}
    for line in meta_raw.splitlines():
        parts = line.strip().split("|")
        if len(parts) != 4:
            continue
        vid, ymd, views, dur = parts
        meta[vid] = {
            "upload_date": ymd if ymd != "NA" else "",
            "view_count": int(views) if views and views != "NA" else 0,
            "duration": int(dur) if dur and dur != "NA" else 0,
        }

    # Step 3: merge + write
    streams = []
    for e in entries:
        vid = e["id"]
        m = meta.get(vid, {})
        desc = (e.get("description") or "").replace("\r\n", "\n").strip()
        streams.append(
            {
                "videoId": vid,
                "title": e.get("title") or "",
                "duration": m.get("duration") or int(e.get("duration") or 0),
                "viewCount": m.get("view_count", 0),
                "uploadDate": m.get("upload_date", ""),
                "description": desc[:200],
            }
        )

    streams.sort(key=lambda s: s["uploadDate"], reverse=True)

    out = {
        "channel": "@AvalonPediaTW",
        "channelUrl": CHANNEL_URL,
        "fetchedAt": FETCHED_AT,
        "count": len(streams),
        "streams": streams,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(streams)} streams to {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
