"""Offline tests of package identity, local registration, idempotence and operator-owned edits."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("stage", Path(__file__).resolve().parents[1] / "agent/stage.py")
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)


@unittest.skipIf(os.geteuid() == 0, "production provisioning only accepts non-root identities")
class Provision(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.artifact = self.home / "test.tgz"

    def fixture(self, extra=None):
        manifest = {"name": "holyagent", "version": "0.3.3", "pi": {"extensions": ["./extensions"]}}
        items = {"package/package.json": json.dumps(manifest), "package/scripts/holyagent": "fixture"}
        if extra:
            items[extra] = "not installed"
        with tarfile.open(self.artifact, "w:gz") as out:
            for path, text in items.items():
                data = text.encode()
                entry = tarfile.TarInfo(path)
                entry.size = len(data)
                out.addfile(entry, io.BytesIO(data))
        return hashlib.sha512(self.artifact.read_bytes()).hexdigest()

    def test_wrong_pin_never_registers(self):
        self.fixture()
        with self.assertRaisesRegex(ValueError, "SHA-512"):
            stage.stage(self.artifact, self.home)
        self.assertFalse((self.home / ".pi/agent/settings.json").exists())

    def test_verified_registration_repeats_without_overwriting_operator_choices(self):
        with patch.object(stage, "DIGEST", self.fixture()):
            stage.stage(self.artifact, self.home)
            pi = self.home / ".pi/agent/settings.json"
            t3 = self.home / ".t3/userdata/settings.json"
            provider = json.loads(t3.read_text())["providerInstances"]["pi"]
            self.assertEqual(provider, {"driver":"pi","enabled": True})
            self.assertEqual(pi.stat().st_mode & 0o777, 0o600)
            before = t3.stat().st_ino
            stage.stage(self.artifact, self.home)
            self.assertEqual(before, t3.stat().st_ino)
            t3.write_text('{"operatorSetting": true}')
            with self.assertRaisesRegex(ValueError, "left intact"):
                stage.stage(self.artifact, self.home)
            self.assertEqual(t3.read_text(), '{"operatorSetting": true}')

    def test_rejects_traversal_and_modified_installed_package(self):
        with patch.object(stage, "DIGEST", self.fixture(extra="package/../evil")):
            with self.assertRaisesRegex(ValueError, "archive member"):
                stage.stage(self.artifact,self.home)
        with patch.object(stage, "DIGEST", self.fixture()):
            stage.stage(self.artifact, self.home)
            path = self.home / ".local/share/t1os/agent/holyagent-0.3.3/scripts/holyagent"
            path.write_text("changed")
            with self.assertRaisesRegex(ValueError, "differs"):
                stage.stage(self.artifact,self.home)

    def test_operator_symlink_cannot_redirect_settings(self):
        self.fixture()
        (self.home / ".pi").symlink_to(self.home)
        with self.assertRaisesRegex(ValueError, "unsafe operator directory"):
            stage.stage(self.artifact, self.home)
        self.assertFalse((self.home / "agent/settings.json").exists())
