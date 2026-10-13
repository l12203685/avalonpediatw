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
    "LINE_BOT_CHANNEL_SECRET": "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
}
# Ordinary settings next to the secrets: these must never be ::add-mask::'d (a mask of "true"
# turns every later true/false in the job log into ***).
PLAIN = {"NODE_ENV": "production", "FEATURE_FLAG": "true", "PORT": "3000", "LOG_LEVEL": "info"}
REJECTED_VALUE = "reject-me-9876543210"  # the fake API refuses it and echoes it in the error body
# Chat-export secret (2026-10-13) and the retired paid-digest key: fake values shaped like the real ones.
ANTHROPIC_KEY = "sk-ant-api03-" + "Zx9" * 20
SA_JSON = json.dumps({
    "type": "service_account",
    "project_id": "example-project-000000",
    "private_key_id": "0123456789abcdef0123456789abcdef01234567",
    "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n",
    "client_email": "digest-test@example-project-000000.iam.gserviceaccount.com",
}, indent=2)
SA_SECRET_LINES = [line for line in SA_JSON.splitlines() if "private_key" in line or "client_email" in line]
OTHER_SA_JSON = SA_JSON.replace("0123456789abcdef0123", "fedcba9876543210fedc")


class FakeRender:
    def __init__(self) -> None:
        self.env = dict(SECRETS, **PLAIN)
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
                if body["value"] == REJECTED_VALUE:
                    return 400, {"message": f"invalid value {body['value']} for {key}"}
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

    def assert_plain_values_not_masked(self, out: str) -> None:
        masked = [line.removeprefix("::add-mask::") for line in out.splitlines() if line.startswith("::add-mask::")]
        for value in PLAIN.values():
            self.assertNotIn(value, masked)
        self.assertTrue(set(SECRETS.values()) <= set(masked), masked)

    def test_status_is_read_only_and_reports_keys_not_values(self) -> None:
        code, out = self.run_quiet(ops.status, self.api, {"DISCORD_BOT_TOKEN": "discord-gh-token-0123456789"})
        self.assertEqual(code, 0)
        self.assertTrue(all(m == "GET" for m, _ in self.fake.calls))
        self.assertIn("DISCORD_BOT_TOKEN: MISSING on Render, set in GitHub secrets", out)
        self.assertIn("GITHUB_ACCOUNTS_TOKEN: still on Render", out)
        self.assertIn(f"LINE groups seen in the last 6 days of logs: 1 ({ops.short(GROUP)})", out)
        self.assert_no_values_leak(out, list(SECRETS.values()) + ["discord-gh-token-0123456789", GROUP])
        self.assert_plain_values_not_masked(out)

    def test_apply_copies_only_differing_secrets_removes_retired_and_deploys(self) -> None:
        gh = {"DISCORD_BOT_TOKEN": "discord-gh", "LINE_BOT_CHANNEL_ACCESS_TOKEN": "line-token-gh",
              "LINE_BOT_CHANNEL_SECRET": SECRETS["LINE_BOT_CHANNEL_SECRET"], "LOBBY_MIRROR_LINE_GROUP_ID": ""}
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
        self.assert_plain_values_not_masked(out)
        for value in PLAIN.values():  # plain values are not printed either (keys only)
            self.assertNotIn(value, out)

    def test_put_error_does_not_echo_the_value(self) -> None:
        with self.assertRaises(ops.OpsError) as ctx:
            self.api.put_env(TARGET_ID, "JWT_SECRET", REJECTED_VALUE)
        self.assertIn("HTTP 400", str(ctx.exception))
        self.assertNotIn(REJECTED_VALUE, str(ctx.exception))
        self.assertIn("withheld", str(ctx.exception))
        with self.assertRaises(ops.OpsError) as ctx:  # no value sent: the body is still shown
            self.api.call("GET", "/nowhere")
        self.assertIn("unexpected GET /nowhere", str(ctx.exception))

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

    def masked(self, value) -> list[str]:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ops.mask(value)
        lines = buf.getvalue().splitlines()
        self.assertTrue(all(line.startswith("::add-mask::") for line in lines))
        return [line.removeprefix("::add-mask::") for line in lines]

    def test_mask_skips_plain_values(self) -> None:
        for value in ("true", "false", "0", "1", "3000", "production", "development", "info", "debug", "*",
                      "https://example.org", "https://avalon-server-z6c0-cs0s.onrender.com",
                      "https://avalon-game-platform.web.app,http://localhost:5173",
                      "avalon-server-z6c0", "avalonpediatw", "do_not_clear",
                      "not_suspended", "a-plain-sixteen!", "", None, "   "):
            with self.subTest(value=value):
                self.assertEqual(self.masked(value), [])

    def test_mask_masks_secret_looking_values(self) -> None:
        hex64, hex32 = "0123456789abcdef" * 4, "0123456789abcdef" * 2
        for value in ("rnd_abc", "ghp_abc", "github_pat_x", "xoxb-1", "Bearer abc", "AIzaSyX", "ya29.x",
                      "a1b2c3d4e5f6g7h8", "x" * 32, "x" * 64, hex64, hex32, GROUP,
                      "abcdefgh+/==ijkl", "MTEz.YWJj.ZGVm-_x1", "jwt-existing-value-123",
                      "https://user:p4ss@db.example.org/x"):
            with self.subTest(value=value):
                self.assertEqual(self.masked(value), [value])
        self.assertEqual(self.masked("  rnd_padded  "), ["  rnd_padded  "])  # masked as given
        pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----"
        self.assertEqual(self.masked(pem), ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"])  # line by line

    def test_main_masks_github_secrets_but_not_plain_env(self) -> None:
        buf = io.StringIO()
        env = {"RENDER_API_KEY": "rnd_test", "RENDER_API_BASE": self.server.base,
               "GH_DISCORD_BOT_TOKEN": "discord-gh-token-0123456789", "GH_LOBBY_MIRROR_LINE_GROUP_ID": ""}
        with contextlib.redirect_stdout(buf), unittest.mock.patch.dict("os.environ", env):
            self.assertEqual(ops.main(["status"]), 0)
        out = buf.getvalue()
        self.assertIn("::add-mask::discord-gh-token-0123456789", out)
        self.assert_plain_values_not_masked(out)
        self.assert_no_values_leak(out, list(SECRETS.values()) + ["discord-gh-token-0123456789"])

    def test_status_reports_the_optional_chat_export_secret_as_present_or_absent(self) -> None:
        code, out = self.run_quiet(ops.status, self.api, {"GOOGLE_SERVICE_ACCOUNT_JSON": SA_JSON})
        self.assertEqual(code, 0)
        self.assertIn("GOOGLE_SERVICE_ACCOUNT_JSON (optional, chat export): absent on Render, present in GitHub "
                      "secrets (AVALON_STATS_SHEETS_CREDENTIALS_JSON or GOOGLE_SHEETS_CREDENTIALS_JSON)", out)
        self.assertNotIn("ANTHROPIC_API_KEY (optional", out)  # the paid digest is gone (2026-10-13)
        self.assert_no_values_leak(out, SA_SECRET_LINES)
        self.assertTrue(all(m == "GET" for m, _ in self.fake.calls))

    def test_status_flags_a_leftover_anthropic_key_as_retired(self) -> None:
        self.fake.env["ANTHROPIC_API_KEY"] = ANTHROPIC_KEY
        code, out = self.run_quiet(ops.status, self.api, {})
        self.assertEqual(code, 0)
        self.assertIn("ANTHROPIC_API_KEY: still on Render (retired", out)
        self.assert_no_values_leak(out, [ANTHROPIC_KEY])

    def test_apply_copies_the_service_account_json_and_never_the_anthropic_key(self) -> None:
        gh = {"GOOGLE_SERVICE_ACCOUNT_JSON": SA_JSON, "ANTHROPIC_API_KEY": ANTHROPIC_KEY}
        code, out = self.run_quiet(ops.apply, self.api, gh, rotate=False, suspend_duplicate=False)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.fake.env["GOOGLE_SERVICE_ACCOUNT_JSON"], SA_JSON)  # multi-line JSON kept as is
        self.assertNotIn("ANTHROPIC_API_KEY", self.fake.env)
        self.assertIn("GOOGLE_SERVICE_ACCOUNT_JSON copied from GitHub secrets", out)
        self.assertNotIn("ANTHROPIC_API_KEY copied", out)
        masked = [line.removeprefix("::add-mask::") for line in out.splitlines() if line.startswith("::add-mask::")]
        for line in SA_SECRET_LINES:
            self.assertIn(line, masked)
        self.assertNotIn("{", masked)  # punctuation-only lines of the JSON are not masked
        self.assert_no_values_leak(out, SA_SECRET_LINES)
        self.assert_plain_values_not_masked(out)
        # Idempotent: the second run changes nothing.
        self.fake.calls.clear()
        _, out = self.run_quiet(ops.apply, self.api, gh, rotate=False, suspend_duplicate=False)
        self.assertIn("nothing to change", out)
        self.assertFalse(any(m in ("PUT", "POST", "DELETE") for m, _ in self.fake.calls))

    def test_apply_removes_a_leftover_anthropic_key_from_render(self) -> None:
        self.fake.env["ANTHROPIC_API_KEY"] = "sk-ant-existing-0000000000000000"
        code, out = self.run_quiet(ops.apply, self.api, {}, rotate=False, suspend_duplicate=False)
        self.assertEqual(code, 0, out)
        self.assertNotIn("ANTHROPIC_API_KEY", self.fake.env)
        self.assertIn("ANTHROPIC_API_KEY removed (retired)", out)
        self.assert_no_values_leak(out, ["sk-ant-existing-0000000000000000"])

    def test_apply_without_the_service_account_json_leaves_render_alone(self) -> None:
        code, out = self.run_quiet(ops.apply, self.api, {"GOOGLE_SERVICE_ACCOUNT_JSON": ""},
                                   rotate=False, suspend_duplicate=False)
        self.assertEqual(code, 0, out)
        puts = [p for m, p in self.fake.calls if m == "PUT"]
        self.assertFalse(any(p.endswith("/GOOGLE_SERVICE_ACCOUNT_JSON") for p in puts))
        self.assertNotIn("GOOGLE_SERVICE_ACCOUNT_JSON", self.fake.env)

    def test_service_account_json_prefers_avalon_stats_secret_then_google_sheets(self) -> None:
        cases = [
            ({"GH_AVALON_STATS_SHEETS_CREDENTIALS_JSON": SA_JSON, "GH_GOOGLE_SHEETS_CREDENTIALS_JSON": OTHER_SA_JSON}, SA_JSON),
            ({"GH_AVALON_STATS_SHEETS_CREDENTIALS_JSON": "  ", "GH_GOOGLE_SHEETS_CREDENTIALS_JSON": OTHER_SA_JSON}, OTHER_SA_JSON),
            ({}, ""),
        ]
        for environ, expected in cases:
            with self.subTest(sources=sorted(environ)):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    found = ops.github_secrets(environ)
                self.assertEqual(found["GOOGLE_SERVICE_ACCOUNT_JSON"], expected)
                self.assertNotIn("ANTHROPIC_API_KEY", found)
                masked = [line.removeprefix("::add-mask::") for line in buf.getvalue().splitlines()]
                for value in environ.values():  # every secret line of every source is masked, used or not
                    for line in value.splitlines():
                        if "private_key" in line:
                            self.assertIn(line, masked)

    def test_main_apply_copies_the_service_account_json_from_the_workflow_env(self) -> None:
        buf = io.StringIO()
        env = {"RENDER_API_KEY": "rnd_test", "RENDER_API_BASE": self.server.base,
               "GH_AVALON_STATS_SHEETS_CREDENTIALS_JSON": "", "GH_GOOGLE_SHEETS_CREDENTIALS_JSON": SA_JSON}
        with contextlib.redirect_stdout(buf), unittest.mock.patch.dict("os.environ", env):
            self.assertEqual(ops.main(["apply", "--no-wait"]), 0)
        out = buf.getvalue()
        self.assertEqual(self.fake.env["GOOGLE_SERVICE_ACCOUNT_JSON"], SA_JSON)
        self.assertNotIn("ANTHROPIC_API_KEY", self.fake.env)
        self.assert_no_values_leak(out, SA_SECRET_LINES)

    def test_main_without_key_exits_2(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), unittest.mock.patch.dict("os.environ", {"RENDER_API_KEY": ""}):
            self.assertEqual(ops.main(["status"]), 2)
        self.assertIn("RENDER_API_KEY is not set", buf.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=1)
