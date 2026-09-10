import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

path = Path(__file__).resolve().parents[2] / "scripts/release/package-check.py"
spec = importlib.util.spec_from_file_location("package_check", path)
packages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packages)


class PackageContentsTests(unittest.TestCase):
    def test_publishable_archive_requires_docs_and_rejects_extra_duplicate_or_linked_files(self):
        allowed = ["package/package.json", "package/LICENSE", "package/README.md",
                   "package/THIRD-PARTY-NOTICES.md", "package/dist/index.js", "package/dist/index.d.ts"]
        cases = [(allowed, None, True), (allowed + ["package/.env"], None, False),
                 (allowed + [allowed[0]], None, False),
                 ([name for name in allowed if name != "package/README.md"], None, False),
                 (allowed, "package/dist/index.js", False)]
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "sdk.tgz"
            for files, symlink, valid in cases:
                with self.subTest(files=files, symlink=symlink):
                    with tarfile.open(archive, "w:gz") as stream:
                        for name in files:
                            member = tarfile.TarInfo(name)
                            if name == symlink:
                                member.type = tarfile.SYMTYPE
                                member.linkname = "../../outside"
                            stream.addfile(member, io.BytesIO())
                    if valid:
                        self.assertEqual(set(packages.package_files(archive)), set(allowed))
                    else:
                        with self.assertRaises(RuntimeError):
                            packages.package_files(archive)


if __name__ == "__main__":
    unittest.main()
