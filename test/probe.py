#!/usr/bin/env python3
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import websocket


class CDPClient:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, suppress_origin=True, timeout=30)
        self.lock = threading.Lock()
        self.send_lock = threading.Lock()
        self.next_id = 1
        self.pending_responses = {}
        self.targets = {}
        self.sw_event = threading.Event()
        self.sw_target = None
        self.running = True
        self.reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self.reader_thread.start()

    def _reader_loop(self):
        while self.running:
            try:
                raw = self.ws.recv()
                if not raw:
                    break
                msg = json.loads(raw)
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                break

            msg_id = msg.get("id")
            if msg_id is not None:
                with self.lock:
                    q = self.pending_responses.get(msg_id)
                if q:
                    q.put(msg)
                continue

            method = msg.get("method")
            params = msg.get("params", {})
            if method in ("Target.targetCreated", "Target.targetInfoChanged"):
                tinfo = params.get("targetInfo", {})
                tid = tinfo.get("targetId")
                if tid:
                    with self.lock:
                        self.targets[tid] = tinfo
                    if tinfo.get("type") == "service_worker" and tinfo.get("url", "").endswith("/worker.js"):
                        self.sw_target = tinfo
                        self.sw_event.set()
            elif method == "Target.targetDestroyed":
                tid = params.get("targetId")
                if tid:
                    with self.lock:
                        self.targets.pop(tid, None)

    def call(self, method, params=None, session_id=None, timeout=30):
        with self.lock:
            cmd_id = self.next_id
            self.next_id += 1
            res_queue = queue.Queue()
            self.pending_responses[cmd_id] = res_queue

        payload = {
            "id": cmd_id,
            "method": method,
            "params": params or {}
        }
        if session_id:
            payload["sessionId"] = session_id

        with self.send_lock:
            self.ws.send(json.dumps(payload))

        try:
            res = res_queue.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"CDP command {method} (id={cmd_id}) timed out after {timeout}s")
        finally:
            with self.lock:
                self.pending_responses.pop(cmd_id, None)

        if "error" in res:
            raise RuntimeError(f"CDP error {method}: {res['error']}")
        return res.get("result", {})

    def wait_for_service_worker(self, timeout=15):
        start = time.time()
        while time.time() - start < timeout:
            if self.sw_target:
                return self.sw_target
            try:
                res = self.call("Target.getTargets", timeout=2)
                for t in res.get("targetInfos", []):
                    if t.get("type") == "service_worker" and t.get("url", "").endswith("/worker.js"):
                        self.sw_target = t
                        return t
            except Exception:
                pass
            if self.sw_event.wait(timeout=0.2):
                if self.sw_target:
                    return self.sw_target
        return None

    def close(self):
        self.running = False
        try:
            self.ws.close()
        except Exception:
            pass


class QuietHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def format_stats(s):
    if not isinstance(s, dict):
        return None
    return {
        "raf": round(float(s.get("raf", 0.0)), 2),
        "timeout": round(float(s.get("timeout", 0.0)), 2),
        "interval": round(float(s.get("interval", 0.0)), 2),
    }


def main():
    parser = argparse.ArgumentParser(description="Hidden-tab timing probe")
    parser.add_argument("--ext", required=True, help="Path to unpacked extension directory")
    parser.add_argument("--hidden-seconds", type=int, required=True, help="Seconds to keep tab hidden")
    parser.add_argument("--port", type=int, default=9333, help="CDP debugging port (default: 9333)")
    parser.add_argument("--chrome", required=True, help="Path to a Chromium chrome.exe (headful; a temporary profile is used)")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    temp_work_dir = (repo_root / "temp_work").resolve()
    test_dir = (repo_root / "test").resolve()
    ext_dir = Path(args.ext).resolve()

    if not ext_dir.is_dir():
        sys.stderr.write(f"Error: extension directory does not exist: {ext_dir}\n")
        sys.exit(1)

    chrome_exe = Path(args.chrome)
    if not chrome_exe.is_file():
        sys.stderr.write(f"Error: chrome executable not found: {chrome_exe}\n")
        sys.exit(1)

    # 1. Start HTTP server
    handler_factory = functools.partial(QuietHTTPHandler, directory=str(test_dir))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_factory)
    http_port = httpd.server_address[1]
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    profile_dir = temp_work_dir / f"profile-{uuid.uuid4().hex[:8]}"
    profile_dir.mkdir(parents=True, exist_ok=True)

    chrome_proc = None
    client = None

    try:
        # 2. Launch Chrome
        cmd = [
            str(chrome_exe),
            f"--user-data-dir={profile_dir}",
            f"--remote-debugging-port={args.port}",
            f"--load-extension={ext_dir}",
            f"--disable-extensions-except={ext_dir}",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=900,700"
        ]
        chrome_proc = subprocess.Popen(cmd)

        # 3. Connect via CDP
        ws_url = None
        connect_start = time.time()
        while time.time() - connect_start < 15:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/json/version", timeout=1) as resp:
                    vdata = json.loads(resp.read().decode("utf-8"))
                    ws_url = vdata.get("webSocketDebuggerUrl")
                    if ws_url:
                        break
            except Exception:
                time.sleep(0.2)

        if not ws_url:
            raise RuntimeError(f"Could not obtain webSocketDebuggerUrl from Chrome on port {args.port}")

        client = CDPClient(ws_url)

        # 4. Discover targets & wait for service worker
        client.call("Target.setDiscoverTargets", {"discover": True})
        sw_target = client.wait_for_service_worker(timeout=15)
        if not sw_target:
            raise RuntimeError("Service worker target not found")

        # 5. Attach to service worker & set hosts to localhost
        sw_att = client.call("Target.attachToTarget", {"targetId": sw_target["targetId"], "flatten": True})
        sw_session_id = sw_att["sessionId"]

        eval_sw = client.call("Runtime.evaluate", {
            "expression": "chrome.storage.local.set({hosts: ['localhost']})",
            "awaitPromise": True,
            "returnByValue": True
        }, session_id=sw_session_id)
        if "exceptionDetails" in eval_sw:
            raise RuntimeError(f"Error setting storage in service worker: {eval_sw['exceptionDetails']}")

        # Wait ~1.5 s for content-script registration
        time.sleep(1.5)

        # 6. Open Tab A at http://localhost:<http_port>/hidden.html
        page_url = f"http://localhost:{http_port}/hidden.html"
        tab_a_res = client.call("Target.createTarget", {"url": page_url})
        tab_a_id = tab_a_res["targetId"]
        client.call("Target.activateTarget", {"targetId": tab_a_id})

        # Attach to Tab A and start audio with user gesture
        tab_a_att = client.call("Target.attachToTarget", {"targetId": tab_a_id, "flatten": True})
        tab_a_session_id = tab_a_att["sessionId"]

        time.sleep(0.5)
        client.call("Runtime.evaluate", {
            "expression": "window.__startAudio()",
            "userGesture": True,
            "awaitPromise": True
        }, session_id=tab_a_session_id)

        # Wait for video to be ready and playing before hiding
        vr_start = time.time()
        while time.time() - vr_start < 10:
            vr_res = client.call("Runtime.evaluate", {
                "expression": "!!window.__videoReady && !!document.getElementById('probe-video') && !document.getElementById('probe-video').paused",
                "returnByValue": True
            }, session_id=tab_a_session_id)
            if vr_res.get("result", {}).get("value") is True:
                break
            time.sleep(0.2)

        # Wait remaining visible time
        time.sleep(1.0)

        # 7. Create Tab B (about:blank) and activate it so Tab A becomes hidden
        tab_b_res = client.call("Target.createTarget", {"url": "about:blank"})
        tab_b_id = tab_b_res["targetId"]
        client.call("Target.activateTarget", {"targetId": tab_b_id})

        # 8. Keep Tab A hidden for --hidden-seconds
        time.sleep(args.hidden_seconds)

        # 9. Read from Tab A

        # Check injection
        inj_res = client.call("Runtime.evaluate", {
            "expression": "Object.getOwnPropertyDescriptor(document, 'hidden') !== undefined",
            "returnByValue": True
        }, session_id=tab_a_session_id)
        injected = bool(inj_res.get("result", {}).get("value", False))

        # Read window.__probe.vis
        vis_res = client.call("Runtime.evaluate", {
            "expression": "window.__probe.vis",
            "returnByValue": True
        }, session_id=tab_a_session_id)
        vis = vis_res.get("result", {}).get("value", [])

        first_hidden = next((e for e in vis if isinstance(e, dict) and e.get("state") == "hidden"), None)
        if not first_hidden:
            sys.stderr.write("Error: Tab A never reported real hidden state\n")
            sys.exit(2)

        first_hidden_t = first_hidden["t"]

        # Stats for hidden window: [first_hidden_t + 2000, performance.now()]
        stats_expr = f"window.__stats({first_hidden_t + 2000}, performance.now())"
        stats_res = client.call("Runtime.evaluate", {
            "expression": stats_expr,
            "returnByValue": True
        }, session_id=tab_a_session_id)
        hidden_stats = stats_res.get("result", {}).get("value", {})

        # Stats for last 60s if hidden_seconds >= 360
        if args.hidden_seconds >= 360:
            last60_expr = "(() => { const t1 = performance.now(); return window.__stats(t1 - 60000, t1); })()"
            last60_res = client.call("Runtime.evaluate", {
                "expression": last60_expr,
                "returnByValue": True
            }, session_id=tab_a_session_id)
            last60_stats = last60_res.get("result", {}).get("value", None)
        else:
            last60_stats = None

        # Media stats
        media_expr = f"window.__mediaStats({first_hidden_t + 2000}, performance.now())"
        media_res = client.call("Runtime.evaluate", {
            "expression": media_expr,
            "returnByValue": True
        }, session_id=tab_a_session_id)
        media_stats = media_res.get("result", {}).get("value", {})

        # Video stats
        video_expr = f"window.__videoStats({first_hidden_t + 2000}, performance.now())"
        video_res = client.call("Runtime.evaluate", {
            "expression": video_expr,
            "returnByValue": True
        }, session_id=tab_a_session_id)
        video_stats = video_res.get("result", {}).get("value", {})

        # 10. Output JSON to stdout
        output = {
            "injected": injected,
            "hiddenSeconds": args.hidden_seconds,
            "hidden": format_stats(hidden_stats),
            "last60": format_stats(last60_stats),
            "media": {
                "playingAtEnd": bool(media_stats.get("playingAtEnd", False)),
                "currentTimeAdvancedWhileHidden": bool(media_stats.get("currentTimeAdvancedWhileHidden", False))
            },
            "video": {
                "playingAtEnd": bool(video_stats.get("playingAtEnd", False)),
                "currentTimeAdvancedWhileHidden": bool(video_stats.get("currentTimeAdvancedWhileHidden", False))
            }
        }
        print(json.dumps(output))

    finally:
        if client:
            try:
                client.close()
            except Exception:
                pass
        if chrome_proc:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(chrome_proc.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                chrome_proc.wait(timeout=5)
            except Exception:
                try:
                    chrome_proc.kill()
                except Exception:
                    pass
        if httpd:
            try:
                httpd.shutdown()
                httpd.server_close()
            except Exception:
                pass
        if profile_dir:
            time.sleep(0.5)
            temp_work_resolved = temp_work_dir.resolve()
            profile_resolved = profile_dir.resolve()
            if temp_work_resolved in profile_resolved.parents and profile_resolved.name.startswith("profile-"):
                for _ in range(10):
                    try:
                        shutil.rmtree(profile_resolved)
                        break
                    except Exception:
                        time.sleep(0.5)


if __name__ == "__main__":
    main()
