"""End to end tests of the packaged extension in a real Firefox.

Serves a test site with every kind of image reference we know of from two
origins, drives the extension through selenium, and checks the epubs and pdfs
it downloads.

usage: python3 e2e/run.py <unpacked extension dir>

Needs selenium and pillow, plus firefox and geckodriver on the path (or in the
FIREFOX and GECKODRIVER environment variables).
"""

import functools
import http.server
import io
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
import zipfile
import zlib

from PIL import Image
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

EXT_ID = "repub@j0rd1smit.github.io"
UUID = "11111111-2222-3333-4444-555555555555"
BASE = f"moz-extension://{UUID}"

# the colors each test image is filled with, to tell them apart in the epub
COLORS = {
    "a": (255, 0, 0),
    "b-small": (0, 255, 0),
    "b-large": (0, 136, 0),
    "pic": (0, 0, 255),
    "pic-fallback": (0, 0, 136),
    "lazy": (255, 255, 0),
    "noscript": (0, 255, 255),
    "native": (255, 0, 255),
    "cover": (136, 136, 136),
    "blob": (255, 136, 0),
    "cross": (18, 52, 86),
}

PARA = "<p>" + " ".join(
    ["Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod "
     "tempor incididunt ut labore et dolore magna aliqua."] * 6
) + "</p>"


def png(color: tuple[int, int, int], width: int = 400, height: int = 300) -> bytes:
    """a solid png, without needing an image library to write it"""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    row = b"\0" + bytes(color) * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


def article(cross_origin: str) -> str:
    figures = [
        ('<img src="img/a.png" alt="relative" width="400" height="300">', "a"),
        ('<img src="img/b-small.png" srcset="img/b-small.png 1x, img/b-large.png 2x" '
         'alt="srcset" width="400" height="300">', "b-small"),
        ('<picture><source srcset="img/pic.png" type="image/png">'
         '<img src="img/pic-fallback.png" alt="picture" width="400" height="300"></picture>', "pic"),
        ('<img class="lazyload" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" '
         'data-src="img/lazy.png" alt="lazy" width="400" height="300">', "lazy"),
        (f'<img src="{cross_origin}/cross.png" alt="cross" width="400" height="300">', "cross"),
        ('<img src="img/blob.bin" alt="octet" width="400" height="300">', "blob"),
        ('<noscript><img src="img/noscript.png" alt="noscript" width="400" height="300"></noscript>', "noscript"),
    ]
    body = "\n".join(f"<figure>{fig}<figcaption>{alt} image</figcaption></figure>\n{PARA}" for fig, alt in figures)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test Article About Images</title>
<meta property="og:image" content="/img/cover.png">
<meta property="article:author" content="Jane Tester">
</head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<main><article>
<h1>Test Article About Images</h1>
<p class="byline">By Jane Tester</p>
{PARA}
<table><tr><th>Head A</th><th>Head B</th></tr><tr><td>cell 1</td><td>cell 2</td></tr></table>
{body}
<figure><svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg><figcaption>inline svg</figcaption></figure>
{PARA * 20}
<figure><img loading="lazy" src="img/native.png" resource="https://example.org/wiki/File:native.png" alt="native" width="400" height="300"><figcaption>native lazy image</figcaption></figure>
{PARA}
</article></main>
<script>console.log("page script")</script>
</body></html>"""


# a one page pdf, enough for firefox's viewer to open
PDF = b"""%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 40 100 Td (Hello pdf) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""


def serve(directory: str) -> tuple[http.server.ThreadingHTTPServer, int]:
    handler = functools.partial(QuietHandler, directory=directory)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002
        pass


class Extension:
    """a firefox with the extension installed, downloading into a directory"""

    def __init__(self, ext_dir: str, downloads: str):
        self.downloads = downloads
        opts = Options()
        if os.environ.get("FIREFOX"):
            opts.binary_location = os.environ["FIREFOX"]
        opts.add_argument("-headless")
        # lets us open the extension's own pages, which marionette won't navigate to
        opts.add_argument("-remote-allow-system-access")
        opts.set_preference("extensions.webextensions.uuids", json.dumps({EXT_ID: UUID}))
        opts.set_preference("browser.download.dir", downloads)
        opts.set_preference("browser.download.folderList", 2)
        opts.set_preference("browser.download.useDownloadDir", True)
        opts.set_preference("browser.download.always_ask_before_handling_new_types", False)
        opts.set_preference("devtools.console.stdout.chrome", True)
        opts.set_preference("devtools.console.stdout.content", True)
        service = Service(os.environ.get("GECKODRIVER") or None, log_output=os.path.join(downloads, "..", "gecko.log"))
        self.driver = webdriver.Firefox(options=opts, service=service)
        self.driver.install_addon(ext_dir, temporary=True)
        time.sleep(2)

        before = set(self.driver.window_handles)
        with self.driver.context(self.driver.CONTEXT_CHROME):
            self.driver.execute_script(
                "gBrowser.selectedTab = gBrowser.addTab(arguments[0], "
                "{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});",
                f"{BASE}/popup.html",
            )
        deadline = time.time() + 10
        while set(self.driver.window_handles) == before and time.time() < deadline:
            time.sleep(0.2)
        self.ext_handle = next(iter(set(self.driver.window_handles) - before))
        self.driver.switch_to.window(self.ext_handle)
        time.sleep(1)

    def run(self, script: str, *args):
        return self.driver.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            f"Promise.resolve().then(() => {script}).then(done, (e) => done('error: ' + e));",
            *args,
        )

    def click_action(self):
        """click the extension's toolbar button, as a user would"""
        with self.driver.context(self.driver.CONTEXT_CHROME):
            self.driver.execute_script(
                """
                const wid = arguments[0].toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-browser-action";
                CustomizableUI.addWidgetToArea(wid, CustomizableUI.AREA_NAVBAR);
                const node = document.getElementById(wid);
                (node.querySelector(".unified-extensions-item-action-button") ?? node).click();
                """,
                EXT_ID,
            )

    def capture(self, url: str, options: dict, timeout: float = 60, click: bool = False) -> tuple[str, list[str]]:
        """open url, send it through the extension, and return the badge and downloads

        By default this sends the message the title popup does; with `click` it
        clicks the toolbar button instead.
        """
        for name in os.listdir(self.downloads):
            os.remove(os.path.join(self.downloads, name))
        self.run("browser.storage.local.clear()")
        self.run("browser.storage.local.set(arguments[0])", {"outputStyle": "download", **options})

        self.driver.switch_to.new_window("tab")
        page_handle = self.driver.current_window_handle
        self.driver.get(url)
        time.sleep(2)
        self.driver.switch_to.window(self.ext_handle)
        tab_id = self.run(
            "browser.tabs.query({}).then((tabs) => tabs.find((t) => t.url === arguments[0])?.id)", url
        )
        if click:
            self.driver.switch_to.window(page_handle)
            self.click_action()
            self.driver.switch_to.window(self.ext_handle)
        else:
            self.run("browser.runtime.sendMessage({ tabId: arguments[0] })", tab_id)

        deadline = time.time() + timeout
        badge = ""
        while time.time() < deadline:
            badge = self.run("browser.action.getBadgeText({ tabId: arguments[0] })", tab_id)
            files = [f for f in os.listdir(self.downloads) if not f.endswith(".part")]
            if badge == "err" or (badge == "done" and files):
                break
            time.sleep(0.5)
        time.sleep(0.5)
        self.driver.switch_to.window(page_handle)
        self.driver.close()
        self.driver.switch_to.window(self.ext_handle)
        return badge, sorted(f for f in os.listdir(self.downloads) if not f.endswith(".part"))

    def badge_after_navigating(self, url: str, other: str, midway: bool) -> tuple[str, list[str]]:
        """navigate the tab to `other` after (or while) capturing `url`, and return its final badge"""
        for name in os.listdir(self.downloads):
            os.remove(os.path.join(self.downloads, name))
        self.run("browser.storage.local.clear()")
        self.run("browser.storage.local.set({ outputStyle: 'download' })")
        self.driver.switch_to.new_window("tab")
        page_handle = self.driver.current_window_handle
        self.driver.get(url)
        time.sleep(2)
        self.driver.switch_to.window(self.ext_handle)
        tab_id = self.run("browser.tabs.query({}).then((tabs) => tabs.find((t) => t.url === arguments[0])?.id)", url)
        self.run("browser.runtime.sendMessage({ tabId: arguments[0] })", tab_id)
        if midway:
            self.run("browser.tabs.update(arguments[0], { url: arguments[1] })", tab_id, other)
        deadline = time.time() + (5 if midway else 60)
        while time.time() < deadline and not [f for f in os.listdir(self.downloads) if not f.endswith(".part")]:
            time.sleep(0.5)
        if not midway:
            time.sleep(1)
            self.run("browser.tabs.update(arguments[0], { url: arguments[1] })", tab_id, other)
        time.sleep(2)
        badge = self.run("browser.action.getBadgeText({ tabId: arguments[0] })", tab_id)
        self.driver.switch_to.window(page_handle)
        self.driver.close()
        self.driver.switch_to.window(self.ext_handle)
        return badge, sorted(os.listdir(self.downloads))

    def quit(self):
        self.driver.quit()


def epub_images(path: str) -> tuple[str, list[tuple[str, object]]]:
    """the epub's section and every image in it, in document order"""
    with zipfile.ZipFile(path) as zf:
        section = zf.read("OEBPS/section_0.xhtml").decode()
        images = []
        for src in re.findall(r'src="(images/[^"]+)"', section):
            data = zf.read(f"OEBPS/{src}")
            if src.endswith(".svg"):
                images.append((src, "svg"))
            else:
                images.append((src, Image.open(io.BytesIO(data)).convert("RGB").getpixel((5, 5))))
        return section, images


def main() -> int:
    ext_dir = os.path.abspath(sys.argv[1])
    work = tempfile.mkdtemp(prefix="repub-e2e-")
    site = os.path.join(work, "site")
    other = os.path.join(work, "other")
    downloads = os.path.join(work, "downloads")
    for path in (os.path.join(site, "img"), other, downloads):
        os.makedirs(path)

    for name, color in COLORS.items():
        target = os.path.join(other if name == "cross" else os.path.join(site, "img"), f"{name}.png")
        with open(target, "wb") as out:
            out.write(png(color))
    # served as application/octet-stream
    os.rename(os.path.join(site, "img", "blob.png"), os.path.join(site, "img", "blob.bin"))
    with open(os.path.join(site, "paper.pdf"), "wb") as out:
        out.write(PDF)

    site_server, site_port = serve(site)
    other_server, other_port = serve(other)
    # localhost and 127.0.0.1 are different origins, and the other server sends
    # no cors headers, so the page itself can't fetch that image
    with open(os.path.join(site, "article.html"), "w") as out:
        out.write(article(f"http://127.0.0.1:{other_port}"))

    failures: list[str] = []

    def check(cond: bool, message: str):
        print(("ok   " if cond else "FAIL ") + message)
        if not cond:
            failures.append(message)

    ext = Extension(ext_dir, downloads)
    try:
        page = f"http://localhost:{site_port}/article.html"

        badge, files = ext.capture(page, {})
        check(badge == "done", f"article badge is done ({badge})")
        check(files == ["Test Article About Images.epub"], f"article downloaded as epub ({files})")
        if files:
            section, images = epub_images(os.path.join(downloads, files[0]))
            colors = [color for _, color in images]
            expected = ["cover", "a", "b-small", "pic", "lazy", "cross", "blob", "noscript", "native"]
            for name in expected:
                check(COLORS[name] in colors, f"epub has the {name} image")
            check("svg" in colors, "epub has the inline svg")
            check(COLORS["pic-fallback"] not in colors, "picture uses its source, not the fallback")
            check("Jane Tester" in section, "epub has the author")
            check("<table" in section, "epub keeps the table")

        badge, files = ext.capture(page, {}, click=True)
        check(badge == "done", f"toolbar click badge is done ({badge})")
        check(files == ["Test Article About Images.epub"], f"toolbar click downloaded the epub ({files})")

        other = f"http://localhost:{site_port}/paper.pdf"
        badge, files = ext.badge_after_navigating(page, other, midway=False)
        check(files and badge == "", f"navigating after a capture clears the badge ({badge!r})")
        badge, files = ext.badge_after_navigating(page, other, midway=True)
        # the capture gives up on a page that navigated away
        check(badge == "", f"navigating mid capture leaves no badge ({badge!r}, {files})")

        badge, files = ext.capture(page, {"convertTables": True})
        check(badge == "done", f"table conversion badge is done ({badge})")
        if files:
            section, images = epub_images(os.path.join(downloads, files[0]))
            check("<table" not in section, "table converted to an image")
            with zipfile.ZipFile(os.path.join(downloads, files[0])) as zf:
                known = set(COLORS.values()) | {"svg"}
                tables = [Image.open(io.BytesIO(zf.read(f"OEBPS/{src}"))) for src, color in images if color not in known]
            check(len(tables) == 1, f"one table image ({len(tables)})")
            if tables:
                # a table whose cells wrapped would be cut off above its thick
                # bottom border, which should fill the last row of pixels
                table = tables[0].convert("RGBA")
                last = [table.getpixel((x, table.height - 1)) for x in range(table.width)]
                inked = sum(1 for r, g, b, a in last if a > 128 and r + g + b < 200)
                check(inked > 0.9 * table.width, f"table image isn't cropped ({inked}/{table.width} border pixels)")

        badge, files = ext.capture(page, {"imageHandling": "strip"})
        if files:
            _, images = epub_images(os.path.join(downloads, files[0]))
            # the cover and inline svgs aren't page images, so they stay
            check(all(color in ("svg", COLORS["cover"]) for _, color in images), "strip removes images")

        badge, files = ext.capture(f"http://localhost:{site_port}/paper.pdf", {})
        check(badge == "done", f"pdf badge is done ({badge})")
        check(files == ["paper.pdf"], f"pdf downloaded as pdf ({files})")
        if files:
            with open(os.path.join(downloads, files[0]), "rb") as pdf:
                check(pdf.read() == PDF, "pdf downloaded unchanged")

        badge, files = ext.capture(page, {"outputStyle": "upload"})
        check(badge == "err", f"upload without a token fails ({badge})")
        check(files == [], "upload without a token downloads nothing")
    finally:
        ext.quit()
        site_server.shutdown()
        other_server.shutdown()

    if failures:
        print(f"\n{len(failures)} failures; firefox log in {work}/gecko.log")
        return 1
    if os.environ.get("E2E_KEEP"):
        print(f"\nkept {work}")
    else:
        shutil.rmtree(work, ignore_errors=True)
    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
