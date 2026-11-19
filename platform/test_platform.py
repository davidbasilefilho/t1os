"""Non-destructive tests for the installer and bundle boundaries."""

import hashlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load(name, path):
    """Load command entrypoints without executing their CLI."""
    spec = importlib.util.spec_from_file_location(name, HERE / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vm = load("omarchy_vm", "omarchy-vm.py")
provision = load("provision", "provision.py")
bundle = load("build_bundle", "build-bundle.py")


class VmTest(unittest.TestCase):
    """Ensure the unattended path never selects host disks or public networking."""

    def test_config_only_selects_the_disposable_disk(self):
        size = 40 * vm.GIB
        config = vm.config(size)
        self.assertEqual(config["custom_commands"], [])
        disks = config["disk_config"]["device_modifications"]
        self.assertEqual(len(disks), 1)
        self.assertEqual(disks[0]["device"], "/dev/vda")
        self.assertIs(disks[0]["wipe"], True)
        root = disks[0]["partitions"][1]
        self.assertEqual(root["size"]["value"] + root["start"]["value"] + vm.MIB, size)

    def test_default_dry_run_and_partial_confirmation(self):
        cli = [sys.executable, str(HERE / "omarchy-vm.py")]
        for name in ("iso", "signature", "public-key", "ovmf-code", "ovmf-vars"):
            cli.extend([f"--{name}", "/does-not-exist"])
        result = subprocess.run(cli, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"mode": "dry-run"', result.stdout)
        for args in (["--confirm", vm.TOKEN], ["--apply"], ["--apply", "--confirm", "bad"]):
            self.assertNotEqual(subprocess.run(cli + args, capture_output=True).returncode, 0)

    def test_vm_arguments_are_offline_and_seed_detached(self):
        with tempfile.TemporaryDirectory() as path:
            base = Path(path)
            fw, var, disk, iso, seed = [base / name for name in ("code", "vars", "disk", "iso", "seed")]
            first = vm.arguments(fw, var, disk, base, iso, seed)
            second = vm.arguments(fw, var, disk, base, accel="tcg")
            self.assertIn("-nic", first)
            self.assertEqual(first[first.index("-nic") + 1], "none")
            self.assertTrue(any("id=seed,media=cdrom,readonly=on" in arg for arg in first))
            self.assertFalse(any("id=seed" in arg or "id=installer" in arg for arg in second))
            self.assertEqual(first.count("-device"), 7)
            probe = vm.arguments(fw, var, disk, base, iso, seed, probe=True)
            self.assertEqual(probe[probe.index("-qmp") + 1], "stdio")
            self.assertNotIn("-vnc", probe)
            self.assertFalse(any(arg.startswith("unix:") for arg in probe))

    def test_reject_device_symlink_fifo_qemu_injection(self):
        with tempfile.TemporaryDirectory() as path:
            base = Path(path)
            (base / "file").touch()
            (base / "link").symlink_to("file")
            os.mkfifo(base / "fifo")
            (base / "iso,format=raw").touch()
            for wrong in (base / "link", base / "fifo", base / "iso,format=raw", Path("/dev/null")):
                with self.assertRaises(ValueError):
                    vm.regular_file(wrong)
            self.assertEqual(vm.regular_file(base / "file"), base / "file")

    def test_sha_mismatch_stops_before_gpg(self):
        with tempfile.TemporaryDirectory() as path:
            base = Path(path)
            iso = base / "anything"
            iso.write_bytes(b"not the ISO")
            with self.assertRaisesRegex(ValueError, "ISO SHA-256"):
                vm.verify_iso(iso, base / "missing.sig", base / "missing.asc", base)
            self.assertFalse((base / "gnupg").exists())


class ProvisionTest(unittest.TestCase):
    """Reject bad bundles before installation touches host state."""

    def fixture(self, extra=None):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:") as archive:
            for name in ("platform/first-boot", "platform/t1os-first-boot.service", "runtime/install.sh"):
                bundle.add(archive, name, b"fixture", 0o755)
            if extra:
                extra(archive)
        return stream

    def test_stage_valid_is_idempotent_but_rechecks_media(self):
        payload = self.fixture().getvalue()
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as path:
            base = Path(path)
            archive = base / "media.tar"
            archive.write_bytes(payload)
            releases = base / "releases"
            releases.mkdir()
            release = provision.stage(archive, digest, releases)
            self.assertEqual(provision.stage(archive, digest, releases), release)
            self.assertEqual((release / "runtime/install.sh").read_bytes(), b"fixture")
            archive.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                provision.stage(archive, digest, releases)

    def test_unpack_rejects_links_paths_and_duplicate_files(self):
        def add_link(archive):
            info = tarfile.TarInfo("runtime/link")
            info.type = tarfile.SYMTYPE
            info.linkname = "/root"
            archive.addfile(info)

        for extra in (add_link, lambda a: bundle.add(a, "runtime/../bad", b"", 0),
                      lambda a: bundle.add(a, "runtime/install.sh", b"", 0),
                      lambda a: bundle.add(a, "/runtime/absolute", b"", 0)):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as path:
                with self.assertRaisesRegex(ValueError, "bundle entry"):
                    provision.unpack(self.fixture(extra), Path(path))

    def test_agent_tool_bundle_preserves_executable_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as path:
            prepared = Path(path)
            (prepared / "bin").mkdir()
            entry = prepared / "bin" / "$pi"
            entry.write_bytes(b"pi wrapper")
            entry.chmod(0o755)
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w:") as archive:
                bundle.add_tools(archive, prepared)
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode="r:") as archive:
                self.assertEqual(archive.getmember("agent-host/bin/$pi").mode, 0o755)
            (prepared / "bin" / "link").symlink_to(entry)
            with tarfile.open(fileobj=io.BytesIO(), mode="w:") as archive:
                with self.assertRaisesRegex(ValueError, "unexpected tool file"):
                    bundle.add_tools(archive, prepared)

    def test_provision_dry_run_never_requires_root_or_reads_bundle(self):
        result = subprocess.run([sys.executable, str(HERE / "provision.py"), "--bundle",
                                 "/does-not-exist", "--sha256", "a" * 64],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no files or services changed", result.stdout)


if __name__ == "__main__":
    unittest.main()
