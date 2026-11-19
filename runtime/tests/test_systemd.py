"""Check every shipped unit's keys against the installed systemd parser, without starting a manager."""
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SECTIONS = re.compile(r"\[([^]\n]+)\]")


def directives(text):
    """Parse the section and directive names in systemd's own configuration catalog or our units."""
    section = None
    continued = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if continued:
            continued = line.endswith("\\")
            continue
        match = SECTIONS.fullmatch(line)
        if match:
            section = match[1]
            continue
        if section is None or "=" not in line:
            raise ValueError(f"malformed systemd directive: {line}")
        key = line.split("=", 1)[0]
        continued = line.endswith("\\")
        yield (section, key)


class UnitConfiguration(unittest.TestCase):
    """An unknown systemd option is an error even when verify merely logs and ignores it."""
    @classmethod
    def setUpClass(cls):
        executable = shutil.which("systemd") or "/usr/lib/systemd/systemd"
        dump = subprocess.check_output([executable, "--dump-configuration-items"], text=True)
        cls.known = set(directives(dump))

    def test_every_unit_and_dropin_directive_is_supported(self):
        paths = []
        for directory in [ROOT / "platform", ROOT / "runtime"]:
            paths.extend(directory.rglob("*.service"))
            paths.extend(directory.rglob("*.socket"))
        paths.append(ROOT / "runtime/remote/10-no-ssh-forwarding.conf")
        self.assertGreaterEqual(len(paths), 5)
        for path in paths:
            with self.subTest(path=path.name):
                self.assertEqual(set(directives(path.read_text())) - self.known, set())

    def test_negative_condition_control(self):
        self.assertNotIn(("Unit", "ConditionPathIsNonEmpty"), self.known)
        for path in [ROOT/"runtime/remote/t1os-ssh-tunnel.socket", ROOT/"runtime/desktop/t1os-desktop.service"]:
            self.assertIn(("Unit", "ConditionFileNotEmpty"), set(directives(path.read_text())))

if __name__ == "__main__":
    unittest.main()
