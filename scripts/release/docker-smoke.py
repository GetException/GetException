"""Isolated Linux Docker test. Never uses runtime/local or the developer's database."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy"))
import getexception as installer

spec = importlib.util.spec_from_file_location("bundle", ROOT / "scripts/release/bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def run_compose(arguments, redactions, *, stdout=subprocess.PIPE):
    result = subprocess.run(arguments, stdout=stdout, stderr=subprocess.PIPE, timeout=600)
    if result.returncode:
        detail = result.stderr.decode(errors="replace")
        for value in sorted(set(redactions), key=len, reverse=True):
            if value:
                detail = detail.replace(value, "[REDACTED]")
        # Test setup and application credentials use 64-character hex values.
        detail = re.sub(r"\b[a-fA-F0-9]{64}\b", "[REDACTED]", detail)
        raise installer.Failure(f"Test Docker Compose exited with {result.returncode}: {detail[-3000:]}")
    return result.stdout.decode().strip() if result.stdout else ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--build", action="store_true")
    group.add_argument("--published")
    parser.add_argument("--if-available", action="store_true")
    parser.add_argument("--built", action="store_true")
    parser.add_argument("--registry-fixtures", action="store_true", help="Use fixtures installed from published npm packages")
    args = parser.parse_args()
    if sys.platform != "linux" or not shutil.which("docker"):
        if args.if_available and not os.environ.get("CI"):
            print("Linux Docker test is skipped locally; it is mandatory in CI.")
            return
        raise RuntimeError("Run this test on Linux with Docker Compose")
    os.umask(0o077)
    project = "getexception-ci-" + secrets.token_hex(6)
    Path(".artifacts").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="docker-test-", dir=ROOT / ".artifacts") as temporary:
        work = Path(temporary).resolve()
        root = work / "installation"
        images = {}
        names = ["web", "ingest", "worker", "mail", "migrate"]
        sha = args.published or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        env = {key: value for key, value in os.environ.items() if not key.startswith("SMTP_")}
        env.update(ACME_EMAIL="", MAIL_ENABLED="false")
        options = argparse.Namespace(dashboard_host="monitor.example.com", ingest_host="ingest.example.com")
        if args.build:
            if not args.built:
                run(["corepack", "yarn", "generate"])
                run(["corepack", "yarn", "build"])
            for name in names:
                images[name] = "getexception-ci-" + name + ":" + sha
                run(["docker", "build", "--file", "docker/Dockerfile", "--target", name,
                     "--tag", images[name], "."])
            fake = {name: "ghcr.io/getexception/getexception-" + name + "@sha256:" + secrets.token_hex(32) for name in names}
            bundle.build_bundle(sha, fake, work / "bundle")
            release = root / "releases" / sha
            release.mkdir(parents=True)
            (root / "runtime").mkdir()
            installer.extract_archive(work / "bundle/getexception.tar.gz", release)
            from unittest.mock import patch
            with patch.dict(os.environ, env, clear=True):
                installer.configure(root, options)
        else:
            run(["gh", "release", "download", "deploy-" + sha, "--repo", installer.REPOSITORY,
                 "--pattern", "install-getexception.sh", "--dir", str(work)])
            run(["gh", "attestation", "verify", str(work / "install-getexception.sh"), "--repo", installer.REPOSITORY,
                 "--signer-workflow", installer.WORKFLOW, "--source-ref", "refs/heads/stable", "--source-digest", sha])
            install_args = ["bash", str(work / "install-getexception.sh"), "--release", sha,
                            "--install-dir", str(root), "--skip-start", "--dashboard-host", "monitor.example.com",
                            "--ingest-host", "ingest.example.com"]
            run(["gh", "release", "download", "deploy-" + sha, "--repo", installer.REPOSITORY,
                 "--pattern", "getexception.tar.gz", "--dir", str(work)])
            run(["gh", "attestation", "download", str(work / "getexception.tar.gz"), "--repo", installer.REPOSITORY], cwd=work)
            proofs = list(work.glob("sha256:*.jsonl"))
            if len(proofs) != 1:
                raise RuntimeError("Expected a single release attestation bundle")
            trusted_root = work / "trusted-root.jsonl"
            with trusted_root.open("w") as stream:
                run(["gh", "attestation", "trusted-root"], stdout=stream)
            # The first bootstrap must work without GitHub credentials; repeat with online verification.
            offline_env = {key: value for key, value in env.items() if key not in ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]}
            offline_env["GH_CONFIG_DIR"] = str(work / "empty-gh-config")
            run([*install_args, "--attestation-bundle", str(proofs[0]), "--trusted-root", str(trusted_root)], env=offline_env)
            before = (root / "runtime/.env").read_bytes()
            run(install_args, env=env)
            if (root / "runtime/.env").read_bytes() != before:
                raise RuntimeError("Published bootstrap replaced existing configuration")
            release = root / "releases" / sha
            images = installer.metadata(release)["images"]

        fixture_root = ROOT / (".artifacts/registry" if args.registry_fixtures else "fixtures")
        for name in ["browser", "react"]:
            if not (fixture_root / (name + "-spa/dist/index.html")).is_file():
                raise RuntimeError("Build the browser/React fixtures before testing the installer")

        # Keep the verified bundle unchanged. Only this test override enables local TLS.
        caddy = (release / "Caddyfile").read_text().replace("{$DASHBOARD_HOST} {", "{$DASHBOARD_HOST} {\n\ttls internal")
        caddy = caddy.replace("{$INGEST_HOST} {", "{$INGEST_HOST} {\n\ttls internal")
        for name in ["browser", "react"]:
            caddy += f"\n{name}.monitor.localhost {{\n\ttls internal\n\troot * /srv/{name}\n\tfile_server\n}}\n"
        (work / "Caddyfile.test").write_text(caddy)
        os.chmod(work / "Caddyfile.test", 0o644)
        override = {"services": {
            "web": {"environment": {"DASHBOARD_ORIGIN": "https://monitor.localhost", "INGEST_ORIGIN": "https://ingest.monitor.localhost"}},
            "ingest": {"environment": {"INGEST_ORIGIN": "https://ingest.monitor.localhost"}},
            "caddy": {"environment": {"DASHBOARD_HOST": "monitor.localhost", "INGEST_HOST": "ingest.monitor.localhost"},
                      "volumes": [str(work / "Caddyfile.test") + ":/etc/caddy/Caddyfile:ro",
                                  str(fixture_root / "browser-spa/dist") + ":/srv/browser:ro",
                                  str(fixture_root / "react-spa/dist") + ":/srv/react:ro"]}}}
        (work / "override.json").write_text(json.dumps(override))
        image_env = work / "images.env"
        image_env.write_text(installer.env_text({name.upper() + "_IMAGE": reference for name, reference in images.items()}))

        class DockerInstallation(installer.Installation):
            def compose(self, target, *arguments, stdout=subprocess.PIPE):
                # Local build tags are available only in this isolated test, never in the production controller.
                if arguments == ("pull",) and args.build:
                    return ""
                config = installer.read_env(root / "runtime/.env")
                redactions = [config.get(key, "") for key in [*installer.SECRET_KEYS, "SETUP_TOKEN_HASH", "SMTP_USER", "SMTP_PASSWORD"]]
                return run_compose(["docker", "compose", "-p", project, "--env-file", str(root / "runtime/.env"),
                                    "--env-file", str(image_env), "-f", str(target / "compose.yaml"),
                                    "-f", str(work / "override.json"), *arguments], redactions, stdout=stdout)

            def smoke(self, target, *, defer_ingest_dns=False):
                # This test uses a local CA; production smoke never disables certificate verification.
                for host, path, expected in [("monitor.localhost", "/login", "200"),
                                             ("monitor.localhost", "/health/ready", "404"),
                                             ("ingest.monitor.localhost", "/api/dashboard/status", "404")]:
                    for attempt in range(20):
                        result = subprocess.run(["curl", "--insecure", "--silent", "--location", "--max-time", "5",
                                                 "--resolve", host + ":443:127.0.0.1", "--output", "/dev/null",
                                                 "--write-out", "%{http_code}", "https://" + host + path], capture_output=True, text=True)
                        if result.returncode == 0 and result.stdout == expected:
                            break
                        if attempt == 19:
                            raise installer.Failure("Test HTTPS route failed")
                        time.sleep(1)
                self.compose(target, "exec", "-T", "web", "node", "-e",
                             "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1))")

        installation = DockerInstallation(root)
        try:
            installation.deploy(release, first=True)
            installation.compose(release, "exec", "-T", "worker-mail", "node", "-e",
                                 "fetch('http://127.0.0.1:3003/health/ready').then(async r=>"
                                 "process.exit(r.ok && (await r.json()).mailEnabled===false ? 0 : 1))")
            test_env = {**os.environ, "DEPLOYMENT_TEST_DIR": str(root), "DEPLOYMENT_TEST_PROJECT": project}
            run(["corepack", "yarn", "playwright", "test", "--config", "playwright.deployment.config.ts"], env=test_env)
            query = 'SELECT (SELECT count(*) FROM "user"), (SELECT count(*) FROM member), (SELECT count(*) FROM project), (SELECT count(*) FROM error_event)'
            before = ""
            for attempt in range(20):
                before = installation.compose(release, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "getexception", "-Atc", query)
                if before == "1|1|1|5":
                    break
                time.sleep(1)
            if before != "1|1|1|5":
                raise RuntimeError("Expected one Owner/project and five processed SDK events")
            grouped = installation.compose(release, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "getexception", "-Atc",
                                           'SELECT count(*), max("eventCount") FROM issue')
            if grouped != "4|2":
                raise RuntimeError("Repeated SDK errors were not grouped")
            config_before = (root / "runtime/.env").read_bytes()
            # Exercise real update + compatible rollback using another release identity and the same tested images.
            candidate = root / "releases" / secrets.token_hex(20)
            shutil.copytree(release, candidate)
            info = installer.metadata(candidate)
            info["sha"] = candidate.name
            installer.write_json(candidate / "release.json", info)
            installation.deploy(candidate)
            installation.rollback()
            after = installation.compose(release, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "getexception", "-Atc", query)
            if before != after or config_before != (root / "runtime/.env").read_bytes():
                raise RuntimeError("Update/rollback changed persistent accounts, events or configuration")
            run(["corepack", "yarn", "playwright", "test", "--config", "playwright.deployment.config.ts"],
                env={**test_env, "DEPLOYMENT_VERIFY_RESTART": "1"})
            # Verify the generated backup is a readable PostgreSQL archive.
            backup = next((root / "runtime/backups").glob("*.dump"))
            with backup.open("rb") as stream:
                result = subprocess.run(["docker", "compose", "-p", project, "--env-file", str(root / "runtime/.env"),
                                         "--env-file", str(image_env), "-f", str(release / "compose.yaml"), "exec", "-T",
                                         "postgres", "pg_restore", "--list"], stdin=stream, stdout=subprocess.DEVNULL)
                if result.returncode:
                    raise RuntimeError("Deployment backup cannot be read by pg_restore")
            installation.compose(release, "exec", "-T", "postgres", "createdb", "-U", "postgres", "getexception_restore_test")
            with backup.open("rb") as stream:
                restored = subprocess.run(["docker", "compose", "-p", project, "--env-file", str(root / "runtime/.env"),
                                          "--env-file", str(image_env), "-f", str(release / "compose.yaml"), "exec", "-T",
                                          "postgres", "pg_restore", "-U", "postgres", "--exit-on-error", "--clean", "--if-exists", "-d", "getexception_restore_test"],
                                         stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                if restored.returncode:
                    raise RuntimeError("Backup restore into a clean database failed")
            restored_counts = installation.compose(release, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "getexception_restore_test", "-Atc", query)
            if restored_counts != before:
                raise RuntimeError("Restored database differs from the pre-upgrade backup")
        finally:
            # The project name is generated above, never the developer or production Compose project.
            installation.compose(release, "down", "--volumes", "--remove-orphans")
    print("Docker bootstrap, event ingestion, update and rollback passed.")


if __name__ == "__main__":
    main()
