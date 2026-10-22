#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用无头 Chrome 对文档站的关键视图截图，供人工目视核对。"""
import re
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # tech/docs
V = ROOT / ".verify"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE = "http://127.0.0.1:8899"

SHOTS = [
    # (输出名, url, 宽x高)
    # 主题不靠 Chrome flag（--force-prefers-color-scheme 在此环境无效），
    # 而是在变体页 head 预置 localStorage，走应用自身的 Theme.init 逻辑
    ("01-topbar-dark",   BASE + "/.verify/v-top-dark.html",        "1400,880"),
    ("02-arch-dark",     BASE + "/.verify/v-arch-dark.html#architecture", "1240,1750"),
    ("03-arch-light",    BASE + "/.verify/v-arch-light.html#architecture", "1240,1750"),
    ("04-topbar-light",  BASE + "/.verify/v-top-light.html",       "1400,880"),
    ("05-narrow-480",    BASE + "/.verify/v-narrow.html",          "480,900"),
    ("06-modal-dark",    BASE + "/.verify/v-modal-dark.html",      "900,900"),
    ("07-modal-light",   BASE + "/.verify/v-modal-light.html",     "900,900"),
    ("08-fab-dark",      BASE + "/.verify/v-fab.html",             "1100,760"),
]


def relocate(html, theme):
    """变体页落在 .verify/ 子目录，相对资源路径要上一级；关平滑滚动，否则锚点
    导航的滚动动画会被截图截在途中；预置 localStorage 让 Theme.init 落到指定主题。"""
    html = html.replace('href="assets/', 'href="../assets/')
    html = html.replace('src="assets/', 'src="../assets/')
    head = ('<style>html,*{scroll-behavior:auto!important}</style>'
            '<script>try{localStorage.setItem("mgw_docs_theme","' + theme + '")}'
            'catch(e){}</script></head>')
    return html.replace('</head>', head)


def build_variants():
    raw = (ROOT / "index.html").read_text(encoding="utf-8")
    dark = relocate(raw, "dark")
    light = relocate(raw, "light")

    # 顶栏 / 架构图：明暗各一份
    (V / "v-top-dark.html").write_text(dark, encoding="utf-8")
    (V / "v-top-light.html").write_text(light, encoding="utf-8")
    (V / "v-arch-dark.html").write_text(dark, encoding="utf-8")
    (V / "v-arch-light.html").write_text(light, encoding="utf-8")
    (V / "v-narrow.html").write_text(dark, encoding="utf-8")

    # 弹窗常开（去掉 hidden），并把二维码 src 直接落地，避免等 JS
    def modal(base):
        m = base.replace('<div class="modal" id="contactModal" hidden',
                         '<div class="modal" id="contactModal"')
        m = re.sub(r'data-src="(https://next\.jitword\.com[^"]+)"', r'src="\1"', m)
        m = m.replace('class="arch-svg"', 'class="arch-svg" style="display:none"')
        return m

    (V / "v-modal-dark.html").write_text(modal(dark), encoding="utf-8")
    (V / "v-modal-light.html").write_text(modal(light), encoding="utf-8")

    # FAB 特写：让「返回顶部」也一起出现，看两者垂直堆叠
    f = dark.replace('</head>',
                     '<style>#toTop{opacity:1!important;pointer-events:auto!important;'
                     'transform:none!important}</style></head>')
    (V / "v-fab.html").write_text(f, encoding="utf-8")


def shoot(name, url, size):
    prof = V / ("prof-" + name)
    if prof.exists():
        shutil.rmtree(prof)
    out = V / (name + ".png")
    if out.exists():
        out.unlink()
    cmd = [CHROME, "--headless", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--hide-scrollbars",
           "--user-data-dir=" + str(prof), "--window-size=" + size,
           "--screenshot=" + str(out), url]
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        time.sleep(0.5)
        if out.exists() and out.stat().st_size > 1000:
            time.sleep(0.6)
            break
        if p.poll() is not None and not out.exists():
            break
    if p.poll() is None:
        p.kill()
    shutil.rmtree(prof, ignore_errors=True)
    ok = out.exists() and out.stat().st_size > 1000
    print(("  ✓ " if ok else "  ✗ ") + name + ".png" +
          (("  %d KB" % (out.stat().st_size // 1024)) if ok else "  未生成"))
    return ok


def main():
    V.mkdir(exist_ok=True)
    build_variants()
    print("═" * 58)
    print("  无头 Chrome 截图")
    print("═" * 58)
    n = 0
    for name, url, size in SHOTS:
        n += shoot(name, url, size)
    print("─" * 58)
    print(f"  成功 {n}/{len(SHOTS)}，输出目录 {V}")
    print("═" * 58)


if __name__ == "__main__":
    main()
