"""Remove network, sources and action parameters from the dashboard-only trace.

Never call this a substitute for disabling recording during authentication or ingestion.
Those contexts have no trace, screenshots or video at all.
"""
import json
import os
import sys
import zipfile

path = sys.argv[1]
replacement = path + ".sanitized"
with zipfile.ZipFile(path) as source, zipfile.ZipFile(replacement, "w", zipfile.ZIP_DEFLATED) as output:
    for entry in source.infolist():
        if entry.filename.endswith(".network"):
            output.writestr(entry.filename, "")
        elif entry.filename.endswith(".trace"):
            records = []
            for line in source.read(entry).decode().splitlines():
                record = json.loads(line)
                if record.get("type") in ["before", "after"]:
                    record.pop("params", None)
                    record.pop("result", None)
                    record.pop("error", None)
                if record.get("type") == "event":
                    continue
                records.append(json.dumps(record))
            output.writestr(entry.filename, "\n".join(records) + "\n")
        elif entry.filename.endswith((".png", ".jpeg", ".jpg", ".stacks")):
            output.writestr(entry.filename, source.read(entry))
os.replace(replacement, path)
