"""Scan the exact upstream images deployed by Compose, without a Docker daemon."""
from pathlib import Path
import re
import importlib.util

ROOT = Path(__file__).resolve().parents[2]
references = re.findall(r"^\s+image: (postgres:\S+)$", (ROOT / "deploy/compose.yaml").read_text(), re.M)
if len(references) != 1 or not re.fullmatch(r"postgres:[\w.-]+@sha256:[a-f0-9]{64}", references[0]):
    raise RuntimeError("PostgreSQL must have an immutable reference")
spec = importlib.util.spec_from_file_location("image_scan", ROOT / "scripts/release/scan-image.py")
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)
scanner.scan(references[0], "postgres")
