#!/usr/bin/env python3
"""Offline tests for render_ops.py against a fake Render API (stdlib only).

Run: python3 scripts/test_render_ops.py
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import threading
import unittest
import unittest.mock
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_ops as ops  # noqa: E402

TARGET_ID, DUP_ID, OTHER_ID, OWNER = "srv-target", "srv-dup", "srv-other", "tea-owner"
GROUP = "C" + "a1" * 16
SECRETS = {
    "JWT_SECRET": "jwt-existing-value-123",
    "ADMIN_SECRET": "admin-existing-value-456",
    "GITHUB_ACCOUNTS_TOKEN": "github_pat_leaked_aaaa",
    "GITHUB_RECORDS_TOKEN": "github_pat_leaked_aaaa",
    "LINE_BOT_CHANNEL_SECRET": "line-secret-same",
}


class FakeRender:
    def __init__(self) -> None:
        self.env = dict(SECRETS, NODE_ENV="production")
        self.dup_suspended = "not_suspended"
        self.calls: list[tuple[str, str]] = []
        self.deploy_status = "live"
        self.logs = [{"message": f"[LINE] event from group {GROUP} (type=message) — set LOBBY_MIRROR_LINE_GROUP_ID={GROUP}"}]

    def services(self) -> list[dict]:
        def svc(sid, name, suspended="not_suspended"):
            return {"cursor": sid, "service": {"id": sid, "name": name, "type": "web_service", "ownerId": OWNER,
                                               "suspended": suspended, "serviceDetails": {"url": f"https://{name}.onrender.com"}}}
        return [svc(TARGET_ID, "avalon-server-z6c0"), svc(DUP_ID, "avalonpediatw", self.dup_suspended),
                svc(OTHER_ID, "eon-prototype")]

    def handle(self, method: str, path: str, query: dict, body):
        self.calls.append((method, path))
        if method == "GET" and path == "/services":
            return 200, self.services()
        if path.startswith(f"/services/{TARGET_ID}/env-vars"):
            key = urllib.parse.unquote(path.rsplit("/", 1)[1]) if path.count("/") == 4 else None
            if method == "GET" and key is None:
                return 200, [{"cursor": k, "envVar": {"key": k, "value": v}} for k, v in self.env.items()]
            if method == "PUT" and key:
                self.env[key] = body["value"]
                return 200, {"key": key, "value": body["value"]}
            if method == "DELETE" and key:
                self.env.pop(key, None)
                return 204, None
        if path == f"/services/{TARGET_ID}/deploys":
            if method == "POST":
                return 201, {"id": "dep-new", "status": "created"}
            return 200, [{"cursor": "x", "deploy": {"id": "dep-new", "status": self.deploy_status,
                                                    "commit": {"id": "abcdef123"}, "createdAt": "now"}}]
        if method == "POST" and path == f"/services/{DUP_ID}/suspend":
            self.dup_suspended = "suspended"
            return 202, None
        if method == "GET" and path == "/logs":
            assert query["ownerId"] == [OWNER] and query["resource"] == [TARGET_ID], query
            return 200, {"hasMore": False, "logs": self.logs}
        return 404, {"message": f"unexpected {method} {path}"}


class Server:
    def __init__(self, fake: FakeRender) -> None:
        outer = fake

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # silence
                pass

            def _do(self):
                parsed = urllib.parse.urlparse(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                if self.headers["Authorization"] != "Bearer rnd_test":
                    code, payload = 401, {"message": "unauthorized"}
                else:
                    code, payload = outer.handle(self.command, parsed.path.removeprefix("/v1"),
                                                 urllib.parse.parse_qs(parsed.query), body)
                data = b"" if payload is None else json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_PUT = do_POST = do_DELETE = _do

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class RenderOpsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = FakeRender()
        self.server = Server(self.fake)
        self.api = ops.Render("rnd_test", base=self.server.base, sleep=lambda s: None)

    def tearDown(self) -> None:
        self.server.close()

    def run_quiet(self, fn, *args, **kwargs) -> tuple[int, str]:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = fn(*args, **kwargs)
        return code, buf.getvalue()

    def assert_no_values_leak(self, out: str, values) -> None:
        visible = "\n".join(line for line in out.splitlines() if not line.startswith("::add-mask::"))
        for value in values:
            if value:
                self.assertNotIn(value, visible)

    def test_status_is_read_only_and_reports_keys_not_values(self) -> None:
        code, out = self.run_quiet(ops.status, self.api, {"DISCORD_BOT_TOKEN": "discord-gh"})
        self.assertEqual(code, 0)
        self.assertTrue(all(m == "GET" for m, _ in self.fake.calls))
        self.assertIn("DISCORD_BOT_TOKEN: MISSING on Render, set in GitHub secrets", out)
        self.assertIn("GITHUB_ACCOUNTS_TOKEN: still on Render", out)
        self.assert_no_values_leak(out, list(SECRETS.values()) + ["discord-gh"])

    def test_apply_copies_only_differing_secrets_removes_retired_and_deploys(self) -> None:
        gh = {"DISCORD_BOT_TOKEN": "discord-gh", "LINE_BOT_CHANNEL_ACCESS_TOKEN": "line-token-gh",
              "LINE_BOT_CHANNEL_SECRET": "line-secret-same", "LOBBY_MIRROR_LINE_GROUP_ID": ""}
        code, out = self.run_quiet(ops.apply, self.api, gh, rotate=False, suspend_duplicate=False)
        self.assertEqual(code, 0, out)
        env = self.fake.env
        self.assertEqual(env["DISCORD_BOT_TOKEN"], "discord-gh")
        self.assertEqual(env["LINE_BOT_CHANNEL_ACCESS_TOKEN"], "line-token-gh")
        puts = [p for m, p in self.fake.calls if m == "PUT"]
        self.assertNotIn(f"/services/{TARGET_ID}/env-vars/LINE_BOT_CHANNEL_SECRET", puts)  # unchanged → untouched
        self.assertEqual(env["LOBBY_MIRROR_LINE_GROUP_ID"], GROUP)  # from the log line
        self.assertNotIn("GITHUB_ACCOUNTS_TOKEN", env)
        self.assertNotIn("GITHUB_RECORDS_TOKEN", env)
        self.assertEqual(env["JWT_SECRET"], SECRETS["JWT_SECRET"])  # no rotation unless asked
        self.assertIn(("POST", f"/services/{TARGET_ID}/deploys"), self.fake.calls)
        self.assertIn("-> live", out)
        self.assertEqual(self.fake.dup_suspended, "not_suspended")
        self.assertFalse(any(OTHER_ID in p for _, p in self.fake.calls))  # never touches other services
        self.assert_no_values_leak(out, list(SECRETS.values()) + list(gh.values()) + [GROUP])

    def test_apply_twice_second_run_changes_nothing(self) -> None:
        gh = {"DISCORD_BOT_TOKEN": "discord-gh"}
        self.run_quiet(ops.apply, self.api, gh, rotate=False, suspend_duplicate=False)
        self.fake.calls.clear()
        code, out = self.run_quiet(ops.apply, self.api, gh, rotate=False, suspend_duplicate=False)
        self.assertEqual(code, 0)
        self.assertIn("nothing to change", out)
        self.assertFalse(any(m in ("PUT", "POST", "DELETE") for m, _ in self.fake.calls))

    def test_rotate_and_suspend_duplicate(self) -> None:
        values = iter(["a" * 64, "b" * 64])
        code, out = self.run_quiet(ops.apply, self.api, {}, rotate=True, suspend_duplicate=True,
                                   token_hex=lambda n: next(values))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fake.env["JWT_SECRET"], "a" * 64)
        self.assertEqual(self.fake.env["ADMIN_SECRET"], "b" * 64)
        self.assertEqual(self.fake.dup_suspended, "suspended")
        self.assertIn("::add-mask::" + "a" * 64, out)
        self.assert_no_values_leak(out, ["a" * 64, "b" * 64])
        self.fake.calls.clear()
        _, out = self.run_quiet(ops.apply, self.api, {}, rotate=False, suspend_duplicate=True)
        self.assertIn("already suspended", out)

    def test_ambiguous_groups_are_not_guessed(self) -> None:
        other = "C" + "b2" * 16
        self.fake.logs.append({"message": f"[LINE] event from group {other} (type=message)"})
        code, out = self.run_quiet(ops.apply, self.api, {}, rotate=False, suspend_duplicate=False)
        self.assertEqual(code, 0)
        self.assertNotIn("LOBBY_MIRROR_LINE_GROUP_ID", self.fake.env)
        self.assertIn("2 LINE groups", out)

    def test_failed_deploy_fails_the_run(self) -> None:
        self.fake.deploy_status = "build_failed"
        code, out = self.run_quiet(ops.apply, self.api, {"DISCORD_BOT_TOKEN": "x-token"}, rotate=False,
                                   suspend_duplicate=False)
        self.assertEqual(code, 1)
        self.assertIn("ended build_failed", out)

    def test_duplicate_names_refuse(self) -> None:
        with self.assertRaises(ops.OpsError):
            ops.find([{"name": "a", "id": "1"}, {"name": "a", "id": "2"}], "a")

    def test_bad_key_is_reported(self) -> None:
        api = ops.Render("wrong", base=self.server.base)
        with self.assertRaisesRegex(ops.OpsError, "HTTP 401 \\(RENDER_API_KEY wrong or revoked\\?\\)"):
            api.services()

    def test_main_without_key_exits_2(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), unittest.mock.patch.dict("os.environ", {"RENDER_API_KEY": ""}):
            self.assertEqual(ops.main(["status"]), 2)
        self.assertIn("RENDER_API_KEY is not set", buf.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=1)
