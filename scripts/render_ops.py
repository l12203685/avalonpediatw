#!/usr/bin/env python3
"""Operate the Render service behind 阿瓦隆百科 from GitHub Actions (render-ops.yml).

Edward [20261010] chose to hand Render to automation via a Render API key kept as
the GitHub secret RENDER_API_KEY, so nobody has to click through the dashboard.
The key can control the whole Render account, so this script deliberately does
very little:

  * it only ever touches the service named TARGET_NAME (default avalon-server-z6c0)
    and, for `suspend`, the stale duplicate named DUPLICATE_NAME (default avalonpediatw);
  * it never prints an environment-variable value. Every value it handles is
    masked with ::add-mask:: first, and outputs show keys, "set"/"missing" and
    shortened ids only.

Actions
  status   read-only: services, latest deploys, which env keys the target has,
           which bot secrets exist in GitHub, and which LINE groups wrote to the bot.
  apply    idempotent: copy bot secrets from GitHub secrets (only when they differ),
           fill LOBBY_MIRROR_LINE_GROUP_ID from the "[LINE] event from group" log line
           when unset, delete retired keys, optionally rotate JWT_SECRET/ADMIN_SECRET,
           optionally suspend the duplicate, then deploy if anything changed and wait.

Stdlib only. RENDER_API_BASE overrides the API URL (tests run against a fake server).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

API_BASE = os.environ.get("RENDER_API_BASE", "https://api.render.com/v1").rstrip("/")
TARGET_NAME = os.environ.get("RENDER_TARGET_SERVICE", "avalon-server-z6c0")
DUPLICATE_NAME = os.environ.get("RENDER_DUPLICATE_SERVICE", "avalonpediatw")

# Copied from GitHub secrets of the same name when set there.
BOT_SECRET_KEYS = (
    "DISCORD_BOT_TOKEN",
    "LINE_BOT_CHANNEL_ACCESS_TOKEN",
    "LINE_BOT_CHANNEL_SECRET",
    "LOBBY_MIRROR_LINE_GROUP_ID",
)
# Features retired with website login / on-site games (2026-10-09/10).
RETIRED_KEYS = ("GITHUB_ACCOUNTS_TOKEN", "GITHUB_RECORDS_TOKEN")
ROTATE_KEYS = ("JWT_SECRET", "ADMIN_SECRET")
REQUIRED_KEYS = ("JWT_SECRET",) + BOT_SECRET_KEYS

GROUP_ID_RE = re.compile(r"event from group (C[0-9a-f]{32})")
LIVE, FAILED = "live", ("build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated")


class OpsError(Exception):
    pass


def mask(value: str | None) -> None:
    if value:
        print(f"::add-mask::{value}", flush=True)


def short(value: str) -> str:
    return value if len(value) <= 10 else f"{value[:5]}…{value[-4:]}"


class Render:
    def __init__(self, api_key: str, base: str = API_BASE, sleep: Callable[[float], None] = time.sleep):
        self.api_key = api_key
        self.base = base
        self.sleep = sleep

    def call(self, method: str, path: str, query: dict[str, Any] | None = None, body: Any = None) -> Any:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query, doseq=True)
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode(errors="replace")
            hint = " (RENDER_API_KEY wrong or revoked?)" if exc.code in (401, 403) else ""
            raise OpsError(f"Render API {method} {path} -> HTTP {exc.code}{hint}: {detail}") from None
        return json.loads(raw) if raw.strip() else None

    def services(self) -> list[dict]:
        return [row["service"] for row in self.call("GET", "/services", {"limit": 100}) or []]

    def env_vars(self, service_id: str) -> dict[str, str]:
        rows = self.call("GET", f"/services/{service_id}/env-vars", {"limit": 100}) or []
        env = {row["envVar"]["key"]: row["envVar"].get("value") or "" for row in rows}
        for value in env.values():
            mask(value)
        return env

    def put_env(self, service_id: str, key: str, value: str) -> None:
        mask(value)
        self.call("PUT", f"/services/{service_id}/env-vars/{urllib.parse.quote(key)}", body={"value": value})

    def delete_env(self, service_id: str, key: str) -> None:
        self.call("DELETE", f"/services/{service_id}/env-vars/{urllib.parse.quote(key)}")

    def deploys(self, service_id: str, limit: int = 3) -> list[dict]:
        return [row["deploy"] for row in self.call("GET", f"/services/{service_id}/deploys", {"limit": limit}) or []]

    def deploy(self, service_id: str) -> dict:
        return self.call("POST", f"/services/{service_id}/deploys", body={"clearCache": "do_not_clear"}) or {}

    def suspend(self, service_id: str) -> None:
        self.call("POST", f"/services/{service_id}/suspend")

    def line_group_ids(self, service: dict, days: int = 6) -> list[str]:
        now = datetime.now(timezone.utc)
        query = {
            "ownerId": service["ownerId"], "resource": [service["id"]], "text": ["event from group"],
            "startTime": (now - timedelta(days=days)).isoformat(), "endTime": now.isoformat(),
            "direction": "backward", "limit": 100,
        }
        found: list[str] = []
        for entry in (self.call("GET", "/logs", query) or {}).get("logs", []):
            for gid in GROUP_ID_RE.findall(entry.get("message", "")):
                if gid not in found:
                    found.append(gid)
        return found

    def wait_for(self, service_id: str, deploy_id: str, timeout_s: int = 900, every_s: int = 15) -> str:
        waited = 0
        while True:
            status = next((d.get("status", "") for d in self.deploys(service_id, 5) if d.get("id") == deploy_id), "")
            if status == LIVE or status in FAILED:
                return status
            if waited >= timeout_s:
                return status or "unknown"
            self.sleep(every_s)
            waited += every_s


def find(services: list[dict], name: str) -> dict | None:
    matches = [s for s in services if s.get("name") == name]
    if len(matches) > 1:
        raise OpsError(f"{len(matches)} Render services are named {name!r}; refusing to guess")
    return matches[0] if matches else None


def describe(service: dict) -> str:
    details = service.get("serviceDetails") or {}
    return (f"{service.get('name')} ({service.get('id')}) type={service.get('type')} "
            f"suspended={service.get('suspended')} url={details.get('url', '-')}")


def status(api: Render, github_env: dict[str, str]) -> int:
    services = api.services()
    print(f"Render services visible to the key: {len(services)}")
    for s in services:
        print("  " + describe(s))
    target = find(services, TARGET_NAME)
    if not target:
        raise OpsError(f"no Render service named {TARGET_NAME!r}")
    for d in api.deploys(target["id"]):
        commit = (d.get("commit") or {}).get("id", "")[:7]
        print(f"deploy {d.get('id')} {d.get('status')} commit={commit or '-'} created={d.get('createdAt')}")
    env = api.env_vars(target["id"])
    print(f"{TARGET_NAME} env keys: " + ", ".join(sorted(env)))
    for key in REQUIRED_KEYS:
        print(f"  {key}: {'set' if env.get(key) else 'MISSING'} on Render, "
              f"{'set' if github_env.get(key) else 'not set'} in GitHub secrets")
    for key in RETIRED_KEYS:
        if key in env:
            print(f"  {key}: still on Render (retired — `apply` removes it)")
    ids = api.line_group_ids(target)
    print(f"LINE groups seen in the last 6 days of logs: {len(ids)}" + (f" ({', '.join(short(i) for i in ids)})" if ids else ""))
    return 0


def apply(api: Render, github_env: dict[str, str], rotate: bool, suspend_duplicate: bool,
          wait: bool = True, token_hex: Callable[[int], str] = secrets.token_hex) -> int:
    services = api.services()
    target = find(services, TARGET_NAME)
    if not target:
        raise OpsError(f"no Render service named {TARGET_NAME!r}")
    sid = target["id"]
    env = api.env_vars(sid)
    changed: list[str] = []

    for key in BOT_SECRET_KEYS:
        wanted = github_env.get(key, "").strip()
        if wanted and env.get(key) != wanted:
            api.put_env(sid, key, wanted)
            changed.append(f"{key} copied from GitHub secrets")
            env[key] = wanted

    if not env.get("LOBBY_MIRROR_LINE_GROUP_ID"):
        ids = api.line_group_ids(target)
        if len(ids) == 1:
            api.put_env(sid, "LOBBY_MIRROR_LINE_GROUP_ID", ids[0])
            changed.append(f"LOBBY_MIRROR_LINE_GROUP_ID set from logs ({short(ids[0])})")
        elif ids:
            print(f"::warning::{len(ids)} LINE groups wrote to the bot ({', '.join(short(i) for i in ids)}); "
                  "not choosing one — set the GitHub secret LOBBY_MIRROR_LINE_GROUP_ID")
        else:
            print("LOBBY_MIRROR_LINE_GROUP_ID still unknown: no '[LINE] event from group' in the last 6 days of logs "
                  "(needs the LINE token live, then one message in the group)")

    for key in RETIRED_KEYS:
        if key in env:
            api.delete_env(sid, key)
            changed.append(f"{key} removed (retired)")

    if rotate:
        for key in ROTATE_KEYS:
            value = token_hex(32)
            api.put_env(sid, key, value)
            changed.append(f"{key} rotated")

    if suspend_duplicate:
        dup = find(services, DUPLICATE_NAME)
        if dup and dup["id"] != sid and dup.get("suspended") != "suspended":
            api.suspend(dup["id"])
            print(f"suspended duplicate service {describe(dup)}")
        elif dup:
            print(f"duplicate {DUPLICATE_NAME} already suspended")

    if not changed:
        print(f"{TARGET_NAME}: nothing to change")
        return 0
    for line in changed:
        print(f"{TARGET_NAME}: {line}")
    deploy = api.deploy(sid)
    print(f"deploy {deploy.get('id')} started")
    if not wait or not deploy.get("id"):
        return 0
    final = api.wait_for(sid, deploy["id"])
    print(f"deploy {deploy['id']} -> {final}")
    if final != LIVE:
        print(f"::error::Render deploy {deploy['id']} ended {final}")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("action", choices=("status", "apply"))
    parser.add_argument("--rotate-app-secrets", action="store_true")
    parser.add_argument("--suspend-duplicate", action="store_true")
    parser.add_argument("--no-wait", action="store_true")
    args = parser.parse_args(argv)

    api_key = os.environ.get("RENDER_API_KEY", "").strip()
    if not api_key:
        print("::error::GitHub secret RENDER_API_KEY is not set (Render → Account Settings → API Keys)")
        return 2
    github_env = {k: os.environ.get(f"GH_{k}", "") for k in BOT_SECRET_KEYS}
    for value in github_env.values():
        mask(value)
    api = Render(api_key)
    try:
        if args.action == "status":
            return status(api, github_env)
        return apply(api, github_env, args.rotate_app_secrets, args.suspend_duplicate, wait=not args.no_wait)
    except OpsError as exc:
        print(f"::error::{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
