#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用系统真实字体度量 SVG <text> 宽度，检测架构图里的文字溢出 / 重叠。"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import ImageFont

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "index.html"

PINGFANG = "/System/Library/Fonts/PingFang.ttc"
SFNS = "/System/Library/Fonts/SFNS.ttf"
SFMONO = "/System/Library/Fonts/SFNSMono.ttf"
MENLO = "/System/Library/Fonts/Menlo.ttc"

# class -> (size, weight, family, letter-spacing em)
STYLE = {
    "a-title":       (13.0, 600, "sans", 0.0),
    "a-title-mono":  (12.4, 600, "mono", 0.0),
    "a-sub":         (10.4, 400, "sans", 0.0),
    "a-sub-mono":    (9.8,  400, "mono", 0.0),
    "a-tag":         (9.9,  500, "sans", 0.0),
    "a-tag-mono":    (9.4,  400, "mono", 0.0),
    "a-faint":       (9.2,  400, "mono", 0.0),
    "a-band":        (9.6,  700, "sans", 0.10),
    "a-lbl":         (9.4,  400, "mono", 0.0),
    "a-proc-lbl":    (10.6, 700, "sans", 0.07),
    "a-chip-t":      (11.2, 600, "sans", 0.0),
    "a-chip-s":      (9.2,  400, "sans", 0.0),
    "a-chip-out-t":  (11.2, 700, "sans", 0.0),
    "a-chip-out-s":  (9.2,  400, "sans", 0.0),
}

_cache = {}


def font(family, size, weight):
    """按字符类别返回 (cjk_font, latin_font)。size 放大 4 倍取样以提高精度。"""
    key = (family, round(size, 2), weight)
    if key in _cache:
        return _cache[key]
    px = max(8, int(round(size * 4)))
    if family == "mono":
        lat = ImageFont.truetype(MENLO if weight >= 600 else SFMONO, px, index=1 if weight >= 600 else 0)
        cjk = ImageFont.truetype(PINGFANG, px, index=8 if weight >= 600 else (5 if weight >= 500 else 2))
    else:
        try:
            lat = ImageFont.truetype(SFNS, px)
        except Exception:
            lat = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", px)
        cjk = ImageFont.truetype(PINGFANG, px, index=8 if weight >= 600 else (5 if weight >= 500 else 2))
    _cache[key] = (cjk, lat, px)
    return _cache[key]


def is_wide(ch):
    o = ord(ch)
    if 0x20 <= o <= 0x7E:
        return False
    if o in (0x00B7, 0x00D7, 0x2013, 0x2014):
        return False
    return True


def measure(text, family, size, weight, lsp_em):
    cjk, lat, px = font(family, size, weight)
    scale = size / px          # 字体按 size*4 取样，这里换算回真实字号
    total = 0.0
    for ch in text:
        f = cjk if is_wide(ch) else lat
        total += f.getlength(ch)
    total *= scale
    total += len(text) * size * lsp_em  # letter-spacing
    return total


def main():
    src = DOC.read_text(encoding="utf-8")
    svg_src = max(re.findall(r'<svg class="arch-svg".*?</svg>', src, re.S), key=len)
    svg = ET.fromstring(svg_src)
    m = re.match(r"\{(.+?)\}", svg.tag)
    ns = "{%s}" % m.group(1) if m else ""

    def tag(e):
        return e.tag.replace(ns, "")

    # 收集所有矩形（排除进程容器）
    rects = []
    for r in svg.iter():
        if tag(r) != "rect":
            continue
        cls = r.get("class", "")
        if "a-proc" in cls:
            continue
        x, y = float(r.get("x")), float(r.get("y"))
        w, h = float(r.get("width")), float(r.get("height"))
        if w < 40 or h < 30:
            continue
        rects.append({"x": x, "y": y, "w": w, "h": h,
                      "chip": ("a-chip" in cls)})

    overflow, orphan, tight = [], [], []
    boxes = []   # (x0,y0,x1,y1,label) 用于重叠检测

    for t in svg.iter():
        if tag(t) != "text":
            continue
        cls = (t.get("class") or "").split()[0]
        st = STYLE.get(cls)
        if not st:
            print("!! 未知 class:", cls, repr(t.text))
            continue
        size, weight, family, lsp = st
        label = (t.text or "").strip()
        wtxt = measure(label, family, size, weight, lsp)
        x = float(t.get("x"))
        y = float(t.get("y"))
        anchor = t.get("text-anchor", "start")
        if anchor == "middle":
            x0 = x - wtxt / 2
        elif anchor == "end":
            x0 = x - wtxt
        else:
            x0 = x
        x1 = x0 + wtxt
        # 文字垂直范围：baseline 上方约 0.78em，下方约 0.22em
        y0 = y - size * 0.80
        y1 = y + size * 0.22
        boxes.append((x0, y0, x1, y1, label))

        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        host, best = None, 1e18
        for r in rects:
            if r["x"] <= cx <= r["x"] + r["w"] and r["y"] - 4 <= cy <= r["y"] + r["h"] + 4:
                a = r["w"] * r["h"]
                if a < best:
                    best, host = a, r
        if host is None:
            orphan.append(f'{label!r} bbox=({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f})')
            continue
        pad = 3 if host["chip"] else 6
        pl = x0 - host["x"]
        pr = (host["x"] + host["w"]) - x1
        if pl < pad or pr < pad:
            rec = (f'{label!r}  padL={pl:+.1f} padR={pr:+.1f}  '
                   f'box=({host["x"]:.0f},{host["y"]:.0f},{host["w"]:.0f}x{host["h"]:.0f})')
            (overflow if (pl < 0 or pr < 0) else tight).append(rec)

    # 文字两两重叠
    dup = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                dup.append(f'{a[4]!r} <-> {b[4]!r}')

    print("═" * 66)
    print("  SVG 架构图 · 文字度量校验（系统真实字体）")
    print("═" * 66)
    print(f"  text 元素      {len(boxes)}")
    print(f"  承载矩形       {len(rects)}")
    print(f"  溢出盒外       {len(overflow)}")
    print(f"  贴边(<{3}px)     {len(tight)}")
    print(f"  无宿主矩形     {len(orphan)}")
    print(f"  文字互相重叠   {len(dup)}")
    print("─" * 66)
    for head, items in (("溢出", overflow), ("贴边", tight), ("无宿主", orphan), ("重叠", dup)):
        for it in items:
            print(f"  [{head}] {it}")
    print("═" * 66)
    return 1 if (overflow or orphan or dup) else 0


sys.exit(main())
