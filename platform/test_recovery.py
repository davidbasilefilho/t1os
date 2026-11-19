"""Transaction tests: a failed candidate never displaces a validated release or its receipt."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


p = load("prov", "provision.py")
b = load("boot", "t1os-bootstrap.py")


class Activation(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.state = self.base / "state"
        self.state.mkdir()
        self.releases = self.base / "releases"
        self.releases.mkdir()
        self.a, self.b, self.c = (self.releases / (c * 64) for c in "abc")
        for path in (self.a, self.b, self.c):
            path.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(p, "INSTALL_ROOT", self.base).start()
        patch.object(p, "STATE", self.state).start()
        patch.object(p, "enable_unit").start()

    def test_a_then_b_and_c_fail_then_rollback_to_a(self):
        def prepare(path):
            if path != self.a:
                raise ValueError("candidate did not pass")
        with patch.object(p, "prepare", side_effect=prepare) as mocked:
            p.activate(self.a)
            for bad in [self.b, self.c]:
                with self.assertRaisesRegex(ValueError, "candidate"):
                    p.activate(bad)
                self.assertEqual(p.managed_target("current"), self.a)
                self.assertEqual(p.rollback_target(), self.a)
                self.assertEqual((self.state/"applied").read_text().strip(), self.a.name)
                self.assertEqual((self.state/"pending").read_text().strip(), bad.name)
            p.activate(p.rollback_target())
            self.assertEqual(mocked.call_args.args, (self.a,))
            self.assertFalse((self.state / "pending").exists())

    def test_first_failure_no_fake_current_or_receipt(self):
        with patch.object(p, "prepare", side_effect=ValueError("broken")):
            with self.assertRaisesRegex(ValueError, "broken"):
                p.activate(self.b)
        self.assertIsNone(p.managed_target("current"))
        self.assertFalse((self.state / "applied").exists())
        self.assertEqual((self.state / "pending").read_text().strip(), self.b.name)
        with self.assertRaisesRegex(ValueError, "no known-good"):
            p.rollback_target()

    def test_post_prepare_readiness_gate_blocks_promotion(self):
        def deny(_):
            raise ValueError("not ready")
        with patch.object(p, "prepare"):
            p.activate(self.a)
            with self.assertRaisesRegex(ValueError, "not ready"):
                p.activate(self.b, check=deny)
            self.assertEqual(p.managed_target("current"), self.a)
            p.activate(self.c)
            self.assertEqual(p.managed_target("previous"), self.a)
            self.assertEqual(p.rollback_target(), self.a)

    def test_reapply_hashes_without_frozen_copy_and_rejects_changed_input(self):
        media = self.base / "media"
        media.write_bytes(b"test fixture")
        digest = hashlib.sha256(media.read_bytes()).hexdigest()
        target = self.releases / digest
        target.mkdir()
        with patch.object(tempfile, "TemporaryFile", side_effect=AssertionError("private copy")):
            self.assertEqual(p.stage(media, digest, self.releases), target)
            media.write_bytes(b"changed test")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                p.stage(media, digest, self.releases)
        def mutate(source, size, accept):
            accept(source.read(size))
            with media.open("ab") as f:
                f.write(b"extra")
        media.write_bytes(b"test fixture")
        with patch.object(p, "consume_media", side_effect=mutate):
            with self.assertRaisesRegex(ValueError, "changed"):
                p.stage(media, digest, self.releases)

    def test_console_guard_denies_sudo_pty_or_physical_guest(self):
        with patch.object(os, "geteuid", return_value=0), patch.object(os, "isatty", return_value=True), \
             patch.object(os, "ttyname", return_value="/dev/pts/2"), patch.dict(os.environ,{}, clear=True):
            with self.assertRaisesRegex(ValueError, "console"):
                p.installed_only()
        with patch.object(subprocess, "check_output", return_value="none\n"):
            with self.assertRaisesRegex(ValueError,"QEMU"):
                p.assert_disposable_guest()

    def test_boot_receipt_no_overwrite_and_no_repromotion(self):
        stamp = self.state / "receipt"
        b.receipt(stamp, self.a.name)
        with self.assertRaises(FileExistsError):
            b.receipt(stamp, self.b.name)
        self.assertEqual(stamp.read_text().strip(), self.a.name)
        (self.state / "initial-bootstrap-sha256").write_text(self.a.name)
        def read(path):
            return self.c.name if path.name == "applied" else self.a.name
        with patch.object(b, "STATE", self.state), patch.object(b, "assert_machine"), \
             patch.object(b, "trusted"), patch.object(b, "read_sha", side_effect=read), \
             patch.object(b, "verify_current_boot") as current_boot, patch.object(b, "verify") as verify, \
             patch.object(b, "checkpoint_probe") as reopen, \
             patch.object(b, "deploy", side_effect=AssertionError()):
            self.assertEqual(b.main(), self.c.name)
            current_boot.assert_called_once_with(self.c.name)
            verify.assert_called_once_with(self.c.name)
            reopen.assert_called_once_with(b.BASE/"releases"/self.c.name, initial=False)

    def test_prior_boot_stale_skipped_and_failed_unit_do_not_count(self):
        sha = "a" * 64
        old = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        new = "00000000-1111-2222-3333-444444444444"
        fields = {"LoadState":"loaded", "Result":"success", "ActiveState":"active", "SubState":"exited", "ExecMainStatus":"0",
                  "ConditionResult":"yes", "AssertResult":"yes",
                  "ExecMainStartTimestampMonotonic":"10", "ExecMainExitTimestampMonotonic":"19"}
        b.confirm_boot_record(sha, new, f"{sha} {new}\n", fields)
        for text, changes in [(f"{sha} {old}\n", {}), (f"{sha} {new}\n", {"Result":"exit-code"}),
             (f"{sha} {new}\n", {"ExecMainStatus":"1"}), (f"{sha} {new}\n", {"ConditionResult":"no"}),
             (f"{sha} {new}\n", {"ExecMainStartTimestampMonotonic":"0"}),
             (f"{sha} {new}\n", {"ExecMainExitTimestampMonotonic":"0"})]:
            with self.subTest(text=text,changes=changes), self.assertRaises(ValueError):
                b.confirm_boot_record(sha, new, text, {**fields, **changes})

    def test_exact_bounded_reads(self):
        digest = hashlib.sha256()
        p.consume_media(io.BytesIO(b"data+later"), 4, digest.update)
        self.assertEqual(digest.digest(), hashlib.sha256(b"data").digest())
        with self.assertRaisesRegex(ValueError, "shrank"):
            p.consume_media(io.BytesIO(b"da"), 4, digest.update)


if __name__ == "__main__":
    unittest.main()
