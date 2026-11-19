"""Exercise agent tool archive guards with synthetic local files only."""

from hashlib import sha256
import importlib.util
from io import BytesIO
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "prepare_agent_tools", Path(__file__).resolve().parents[1] / "agent-host/prepare.py",
)
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class AgentToolsTest(unittest.TestCase):
    """T3 archive validation is upstream-pinned and excludes unsafe entries."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "fixture.tar.gz"
        self.destination = self.root / "extract"

    def make_archive(self, extra=None):
        elf = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\x00"
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, contents in (("t3", elf), ("client/index.html", b"fixture")):
                entry = tarfile.TarInfo(f"{prepare.T3_ARCHIVE}/{name}")
                entry.mode = 0o755 if name == "t3" else 0o644
                entry.size = len(contents)
                archive.addfile(entry, BytesIO(contents))
            if extra:
                archive.addfile(extra)

    def expand_fixture(self):
        with patch.multiple(prepare, T3_BYTES=self.archive.stat().st_size,
                            T3_SHA256=sha256(self.archive.read_bytes()).hexdigest()):
            prepare.expand_t3(self.archive, self.destination)

    def test_exact_pins_extract_ordinary_linux_server_and_client(self):
        self.make_archive()
        self.expand_fixture()
        self.assertEqual((self.destination / "client/index.html").read_bytes(), b"fixture")
        self.assertTrue((self.destination / "t3").stat().st_mode & 0o111)

    def test_wrong_digest_is_rejected_without_extraction(self):
        self.make_archive()
        with patch.object(prepare, "T3_BYTES", self.archive.stat().st_size):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                prepare.expand_t3(self.archive, self.destination)
        self.assertFalse(self.destination.exists())

    def test_rejects_symlinks_even_when_pinned(self):
        link = tarfile.TarInfo(f"{prepare.T3_ARCHIVE}/client/escape")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        self.make_archive(link)
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.expand_fixture()
        self.assertFalse((self.destination / "client/escape").exists())

    def test_rejects_parent_traversal(self):
        escaping = tarfile.TarInfo(f"{prepare.T3_ARCHIVE}/client/../../escape")
        self.make_archive(escaping)
        with self.assertRaisesRegex(ValueError, "unexpected T3 Code archive member"):
            self.expand_fixture()
        self.assertFalse((self.root / "escape").exists())
