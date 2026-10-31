# SPDX-License-Identifier: GPL-3.0-or-later
"""Serve a folder of games to ScummVM on the TV, and a page to upload games from a phone.

Usage:  python tools/pc-server.py [folder] [port]      (default: ./pc-games, port 8765)

Each subfolder of <folder> is one game. The TV app lists them, copies one into its own storage
and plays it without the PC afterwards. Opening http://<this PC>:<port>/ on a phone (the TV shows
a QR code for it) uploads files or a .zip into <folder>; a .zip is unpacked into a folder named after it.
Standard library only. There is no authentication: run it only while copying games, on a network you trust.
"""
import http.server
import json
import os
import shutil
import socket
import sys
import urllib.parse
import zipfile

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "pc-games")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765

UPLOAD_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send a game</title>
<style>
body { font: 18px system-ui, sans-serif; margin: 0; padding: 24px 16px; background: #1b1b1b; color: #eee; }
h1 { font-size: 22px; margin: 0 0 16px; }
label { display: block; margin: 16px 0 6px; }
input, button { font: inherit; width: 100%; box-sizing: border-box; padding: 12px; border-radius: 8px; border: 1px solid #555; background: #2a2a2a; color: #eee; }
button { background: #c60; border: 0; margin-top: 20px; }
#log { margin-top: 20px; white-space: pre-wrap; color: #bbb; }
</style></head><body>
<h1>Send a game to the TV</h1>
<p>Choose a .zip of the game, or all of its files.</p>
<label for="game">Game name (optional for a .zip)</label>
<input id="game" placeholder="e.g. monkey1">
<label for="files">Files</label>
<input id="files" type="file" multiple>
<button id="send">Send</button>
<div id="log"></div>
<script>
document.getElementById('send').onclick = async function () {
	var game = document.getElementById('game').value.trim();
	var files = document.getElementById('files').files;
	var log = document.getElementById('log');
	if (!files.length) { log.textContent = 'Choose at least one file.'; return; }
	for (var i = 0; i < files.length; i++) {
		var f = files[i];
		log.textContent = 'Sending ' + f.name + ' (' + (i + 1) + ' of ' + files.length + ')...';
		var url = '/upload?game=' + encodeURIComponent(game) + '&name=' + encodeURIComponent(f.name);
		var response = await fetch(url, { method: 'POST', body: f });
		if (!response.ok) { log.textContent = 'Failed on ' + f.name + ': ' + await response.text(); return; }
	}
	log.textContent = 'Done. On the TV: Yellow key, "Copy from PC".';
};
</script></body></html>"""


def safe_join(*parts):
    """Joins parts under ROOT and refuses anything that escapes it (../, absolute paths)."""
    path = os.path.abspath(os.path.join(ROOT, *parts))
    if path != ROOT and not path.startswith(ROOT + os.sep):
        raise ValueError("path outside the games folder")
    return path


def list_games():
    """{"game/sub/file": size} for every file under ROOT."""
    files = {}
    for folder, _, names in os.walk(ROOT):
        for name in names:
            if name.startswith("."):
                continue
            full = os.path.join(folder, name)
            files[os.path.relpath(full, ROOT).replace(os.sep, "/")] = os.path.getsize(full)
    return files


def unpack_zip(zip_path, dest):
    """Unpacks into dest, flattening a single top-level folder (most game zips have one)."""
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            safe_join(os.path.relpath(dest, ROOT), member)
        archive.extractall(dest)
    entries = [name for name in os.listdir(dest) if os.path.join(dest, name) != zip_path]
    if len(entries) == 1 and os.path.isdir(os.path.join(dest, entries[0])):
        inner = os.path.join(dest, entries[0])
        for name in os.listdir(inner):
            shutil.move(os.path.join(inner, name), dest)
        os.rmdir(inner)


class Handler(http.server.BaseHTTPRequestHandler):
    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/":
            self.send_body(200, UPLOAD_PAGE.encode(), "text/html; charset=utf-8")
        elif url.path == "/list.json":
            self.send_body(200, json.dumps(list_games()).encode(), "application/json")
        elif url.path.startswith("/files/"):
            try:
                path = safe_join(urllib.parse.unquote(url.path[len("/files/"):]))
            except ValueError:
                self.send_body(403, b"forbidden", "text/plain")
                return
            if not os.path.isfile(path):
                self.send_body(404, b"not found", "text/plain")
                return
            with open(path, "rb") as f:
                self.send_body(200, f.read(), "application/octet-stream")
        else:
            self.send_body(404, b"not found", "text/plain")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/upload":
            self.send_body(404, b"not found", "text/plain")
            return
        query = urllib.parse.parse_qs(url.query)
        name = os.path.basename(query.get("name", [""])[0])
        game = query.get("game", [""])[0].strip()
        is_zip = name.lower().endswith(".zip")
        if not game and is_zip:
            game = name[:-4]
        if not name or not game:
            self.send_body(400, b"missing game name", "text/plain")
            return
        try:
            dest = safe_join(game)
        except ValueError:
            self.send_body(403, b"forbidden", "text/plain")
            return
        os.makedirs(dest, exist_ok=True)
        target = os.path.join(dest, name)
        remaining = int(self.headers.get("Content-Length", 0))
        with open(target, "wb") as out:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                out.write(chunk)
                remaining -= len(chunk)
        if is_zip:
            try:
                unpack_zip(target, dest)
            except (zipfile.BadZipFile, ValueError) as error:
                self.send_body(400, str(error).encode(), "text/plain")
                return
            finally:
                os.remove(target)
        print("received:", game + "/" + name)
        self.send_body(200, b"ok", "text/plain")


def lan_ip():
    # Connecting a UDP socket sends nothing; it only picks the interface that routes to the LAN.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("192.168.0.1", 9))
        return s.getsockname()[0]


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    print("Games folder:", ROOT)
    print("Address for the TV:", lan_ip(), " port", PORT)
    print("No password: anyone on this network can read and write the games folder while this runs.")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
