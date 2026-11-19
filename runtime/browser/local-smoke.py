#!/usr/bin/env python3
"""Exercise sandboxed Chromium against an in-process loopback fixture only."""

import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
from threading import Thread

HTML = b"""<!doctype html><title>t1os fixture</title>
<h1>t1os fixture</h1><label for="message">Message</label><input id="message">
<button id="save">Save fixture</button><output id="saved" aria-live="polite"></output>
<script>
const message = document.querySelector('#message');
const saved = document.querySelector('#saved');
saved.value = localStorage.getItem('message') || '';
document.querySelector('#save').addEventListener('click', () => {
  localStorage.setItem('message', message.value);
  saved.value = message.value;
});
</script>"""


class FixtureHandler(BaseHTTPRequestHandler):
    """Serve one static in-memory page without exposing any filesystem paths."""

    def do_GET(self):
        """Respond only to the fixture path."""
        if self.path != "/":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(HTML)))
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, _format, *_args):
        """Keep ephemeral fixture HTTP requests out of stdout."""


@contextmanager
def fixture_server():
    """Provide a fixture on loopback using a stable per-run origin."""
    with ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler) as httpd:
        thread = Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{httpd.server_port}"
        finally:
            httpd.shutdown()
            thread.join()


def private_directory(path):
    """Create an owner-only directory and reject redirected or shared paths."""
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (path.resolve() != path or not path.is_dir() or path.stat().st_mode & 0o077
            or path.stat().st_uid != os.getuid()):
        raise RuntimeError(f"Expected a private, non-redirected directory: {path}")
    return path


def exercise(origin, profile, executable):
    """Check screenshot, keyboard/click, ARIA, and profile reconnect."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        options = dict(
            chromium_sandbox=True,
            executable_path=executable,
            headless=True,
            accept_downloads=False,
            service_workers="block",
            args=["--disable-background-networking"],
        )
        for reconnect in (False, True):
            context = playwright.chromium.launch_persistent_context(profile, **options)
            try:
                context.route("**/*", lambda route: (
                    route.continue_() if route.request.url == f"{origin}/" else route.abort()
                ))
                page = context.pages[0]
                page.goto(origin, wait_until="load", timeout=10_000)
                if not reconnect:
                    page.get_by_label("Message").press_sequentially("fixture input")
                    page.get_by_role("button", name="Save fixture").click()
                    png = page.screenshot(timeout=10_000)
                    if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                        raise RuntimeError("Fixture screenshot was not PNG")
                if "fixture input" != page.locator("#saved").inner_text():
                    raise RuntimeError("Fixture input or reconnect state not present")
                if 'button "Save fixture"' not in page.locator("body").aria_snapshot():
                    raise RuntimeError("Fixture button missing from ARIA snapshot")
            finally:
                context.close()


def main():
    """Run with an isolated per-workspace browser directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace_id", help="a distinct ID for each workspace")
    parser.add_argument("--chromium", help="optional verified Chromium binary")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", args.workspace_id):
        parser.error("invalid workspace ID")
    base = private_directory(Path.home().resolve() / ".local" / "state" / "t1os-browser")
    profile = private_directory(base / args.workspace_id)
    with fixture_server() as origin:
        exercise(origin, profile, args.chromium)
    print(json.dumps({"chromium_fixture": "passed", "desktop_cua_tested": False}))


if __name__ == "__main__":
    main()
