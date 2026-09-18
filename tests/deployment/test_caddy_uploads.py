"""Exercise the real Caddy body-limit matchers with an HTTP upstream."""
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CADDY = Path(os.environ.get("CADDY_BINARY", ROOT / ".artifacts/tools/caddy"))
DOCKER = shutil.which("docker") if sys.platform == "linux" else None


class BodySink(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size)
        if len(body) != size:
            return  # Caddy rejected the body and closed the upstream connection.
        try:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"received": len(body)}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_args):
        pass


class CaddyUploadTests(unittest.TestCase):
    def test_upload_body_limits_for_each_route_depth(self):
        if not CADDY.is_file() and not DOCKER:
            if os.environ.get("CI"):
                self.fail("Caddy or Linux Docker is required to verify upload routing")
            self.skipTest("Install verified Caddy to check upload routing locally")

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), BodySink)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for template in ["deploy/Caddyfile", "docker/Caddyfile"]:
                with self.subTest(template=template):
                    self.check_routes(server.server_port, template)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def check_routes(self, upstream_port, template):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        text = (ROOT / template).read_text()
        # Reuse the shipped matcher/limit block verbatim; no emulated glob logic.
        limits = text[text.index("\t@source_upload"):text.index("\theader {")]
        with tempfile.TemporaryDirectory(prefix="getexception-caddy-") as directory:
            config = Path(directory) / "Caddyfile"
            config.write_text(
                "{\n admin off\n auto_https off\n}\n"
                f"http://127.0.0.1:{port} {{\n{limits}\n"
                f" reverse_proxy 127.0.0.1:{upstream_port}\n}}\n"
            )
            if CADDY.is_file():
                command = [str(CADDY), "run", "--config", str(config), "--adapter", "caddyfile"]
            else:
                # Use the same digest-pinned image as the installation, without publishing ports.
                image = next(line.split("image:", 1)[1].strip()
                             for line in (ROOT / "deploy/compose.yaml").read_text().splitlines()
                             if "image: caddy:" in line)
                command = [DOCKER, "run", "--rm", "--network", "host", "--read-only",
                           "--mount", f"type=bind,src={directory},dst=/probe,readonly",
                           image, "caddy", "run", "--config", "/probe/Caddyfile", "--adapter", "caddyfile"]
            with (Path(directory) / "output.log").open("w") as log:
                process = subprocess.Popen(command, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 90
                    while True:
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                                break
                        except OSError:
                            if process.poll() is not None or time.monotonic() >= deadline:
                                self.fail("Caddy upload-routing fixture did not start")
                            time.sleep(0.1)
                    base = "/api/v1/projects/11111111-1111-4111-8111-111111111111/source-maps"
                    upload = "/22222222-2222-4222-8222-222222222222"
                    artifact = "/33333333-3333-4333-8333-333333333333"
                    for path, size, expected in [
                        (base, 32 * 1024, 200),
                        (base + upload, 32 * 1024, 200),
                        (base + upload + artifact, 476923, 200),
                        (base + upload + artifact, 16 * 1024 * 1024, 200),
                        (base + upload + artifact, 16 * 1024 * 1024 + 1, 413),
                        # Caddy's `KB` suffix is decimal; stay clearly below 16 KB.
                        ("/api/dashboard/projects", 15 * 1024, 200),
                        ("/api/dashboard/projects", 16 * 1024 + 1, 413),
                        (base + "-unrelated", 32 * 1024, 413),
                        (base + upload + artifact + "/extra", 32 * 1024, 413),
                    ]:
                        with self.subTest(path=path, size=size):
                            request = urllib.request.Request(
                                f"http://127.0.0.1:{port}{path}", data=b"x" * size, method="PUT"
                            )
                            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                            try:
                                with opener.open(request, timeout=10) as response:
                                    status = response.status
                                    self.assertEqual(json.load(response), {"received": size})
                            except urllib.error.HTTPError as error:
                                status = error.code
                                error.close()
                            self.assertEqual(status, expected)
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
