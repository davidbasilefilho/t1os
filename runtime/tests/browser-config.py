"""Unit-check browser profile permissions and filesystem-free fixture routing."""

from pathlib import Path
import runpy
from tempfile import TemporaryDirectory
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

smoke = runpy.run_path(str(Path(__file__).resolve().parents[1] / "browser" / "local-smoke.py"))


class BrowserSmokeConfigurationTests(unittest.TestCase):
    """These checks exercise no browser process and require no external network."""

    def test_private_profile(self):
        """Create separate private directories and reject public or redirected paths."""
        create = smoke["private_directory"]
        with TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            first = create(base / "first")
            second = create(base / "second")
            self.assertNotEqual(first, second)
            self.assertEqual(first.stat().st_mode & 0o777, 0o700)
            redirected = base / "redirected"
            redirected.symlink_to(first, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                create(redirected)
            first.chmod(0o755)
            with self.assertRaises(RuntimeError):
                create(first)

    def test_fixture_route(self):
        """Serve only a single fixture on loopback; do not follow proxy environment."""
        opener = build_opener(ProxyHandler({}))
        with smoke["fixture_server"]() as origin:
            self.assertTrue(origin.startswith("http://127.0.0.1:"))
            with opener.open(origin, timeout=5) as response:
                self.assertIn(b"Save fixture", response.read())
                self.assertIn("default-src 'none'", response.headers["Content-Security-Policy"])
            with self.assertRaises(HTTPError) as error:
                opener.open(f"{origin}/etc/passwd", timeout=5)
            self.assertEqual(error.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
