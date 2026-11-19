"""Offline readiness gates: version pins, registration, RPC coverage and isolation."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parents[1]
READY = runpy.run_path(str(RUNTIME / "agent-host/check-ready"))
STAGE = runpy.run_path(str(RUNTIME / "agent/stage.py"))


class ReadinessTests(unittest.TestCase):
    def test_runtime_manifest_matches_registration(self):
        deps = json.loads((RUNTIME.parent / "apps/agent-host/package.json").read_text())["dependencies"]
        for name, version in STAGE["FEATURES"].items():
            self.assertEqual(deps[name], version)
        self.assertNotIn("@amaster.ai/pi-computer-use", deps)
        self.assertNotIn("@opencode/browse", deps)

    def test_conflicting_local_install_is_preserved(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            existing = root / "package"
            existing.mkdir()
            with self.assertRaisesRegex(ValueError, "left intact"):
                STAGE["keep_link"](existing, root / "candidate")
            self.assertTrue(existing.is_dir())
            self.assertFalse(existing.is_symlink())

    def test_rpc_gate_needs_both_replies_and_all_extensions(self):
        commands = [{"name": name} for name in sorted(READY["COMMANDS"])]
        state = {"type": "response", "id": "get_state", "command": "get_state", "success": True}
        reply = {"type": "response", "id": "get_commands", "command": "get_commands",
                 "success": True, "data": {"commands": commands}}
        READY["result"]([state, reply])
        with self.assertRaisesRegex(ValueError, "get_state"):
            READY["result"]([reply])
        commands.pop()
        with self.assertRaisesRegex(ValueError, "missing"):
            READY["result"]([state, reply])

    def test_refuses_fake_isolation_before_loading_candidate(self):
        if os.geteuid() == 0:
            self.skipTest("guest entry point requires non-root identity")
        with tempfile.TemporaryDirectory() as work:
            result = subprocess.run([RUNTIME / "agent-host/check-ready", work],
                                    env={"T1OS_READY_NET": os.readlink("/proc/self/ns/net")},
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("isolated user and network namespaces required", result.stderr)
