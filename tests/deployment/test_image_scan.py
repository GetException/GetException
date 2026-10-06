from copy import deepcopy
from datetime import date
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("scan_image", ROOT / "scripts/release/scan-image.py")
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class ImageScanTests(unittest.TestCase):
    def finding(self):
        return {"vulnerability": {"id": "CVE-2026-85091", "severity": "High"},
                "artifact": {"name": "zlib", "version": "1.3.2-r0", "type": "apk",
                             "purl": "pkg:apk/alpine/zlib@1.3.2-r0?arch=x86_64&distro=alpine-3.24.2"}}

    def test_only_exact_reviewed_finding_is_assessed_and_report_is_preserved(self):
        report = {"matches": [self.finding()]}
        before = deepcopy(report)
        blocking, reviewed = scanner.evaluate(report, "postgres", date(2026, 10, 2))
        self.assertEqual(len(blocking), 0)
        self.assertEqual(len(reviewed), 1)
        self.assertEqual(report, before)

    def test_other_cve_package_version_target_or_expired_review_blocks(self):
        for part, key, value in [("vulnerability", "id", "CVE-2026-0000"),
                                 ("artifact", "name", "other"), ("artifact", "version", "1.3.3-r0"),
                                 ("artifact", "type", "deb"), ("artifact", "purl", "pkg:deb/debian/zlib@1.3.2")]:
            finding = self.finding()
            finding[part][key] = value
            blocking, reviewed = scanner.evaluate({"matches": [finding]}, "postgres", date(2026, 10, 2))
            self.assertEqual((len(blocking), len(reviewed)), (1, 0))
        for target, day in [("caddy", date(2026, 10, 2)), ("web", date(2026, 11, 3))]:
            blocking, reviewed = scanner.evaluate({"matches": [self.finding()]}, target, day)
            self.assertEqual((len(blocking), len(reviewed)), (1, 0))

    def test_invalid_or_externally_filtered_reports_fail_closed(self):
        for report in [{}, {"matches": None}, {"matches": [], "ignoredMatches": [self.finding()]}]:
            with self.assertRaises(ValueError):
                scanner.evaluate(report, "web")

    def test_critical_and_unknown_findings_remain_blocking(self):
        for severity in ["Critical", "Unknown"]:
            finding = self.finding()
            finding["vulnerability"] = {"id": "unreviewed", "severity": severity}
            self.assertEqual(len(scanner.evaluate({"matches": [finding]}, "web")[0]), 1)

    def test_openssl_findings_in_postgres_are_not_exempted(self):
        for cve in ["CVE-2026-54873", "CVE-2026-84782", "CVE-2026-84784", "CVE-2026-72897"]:
            finding = self.finding()
            finding["vulnerability"]["id"] = cve
            finding["artifact"].update(name="libssl3", version="3.5.8-r0")
            blocking, reviewed = scanner.evaluate({"matches": [finding]}, "postgres", date(2026, 10, 6))
            self.assertEqual((len(blocking), len(reviewed)), (1, 0))
