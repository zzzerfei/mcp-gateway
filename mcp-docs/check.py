#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文档站结构自检：标签闭合 / 锚点可达 / id 唯一 / 章节完整。"""
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOC = ROOT / "index.html"

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

errors = []
warnings = []


class Checker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.ids = []
        self.hrefs = []
        self.chapters = []
        self.h2 = 0
        self.h3 = 0
        self.pres = 0
        self.tables = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.append(a["id"])
        if tag == "a" and a.get("href", "").startswith("#"):
            self.hrefs.append(a["href"][1:])
        if tag == "section" and "chapter" in (a.get("class") or ""):
            self.chapters.append(a.get("id"))
        if tag == "h2":
            self.h2 += 1
        if tag == "h3":
            self.h3 += 1
        if tag == "pre":
            self.pres += 1
        if tag == "table":
            self.tables += 1
        if tag not in VOID:
            self.stack.append((tag, self.getpos()))

    def handle_startendtag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.append(a["id"])

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            errors.append(f"多余的闭合标签 </{tag}> @ {self.getpos()}")
            return
        # 允许中间有未闭合的情况：找到最近匹配
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                for j in range(len(self.stack) - 1, i, -1):
                    t, pos = self.stack[j]
                    errors.append(f"<{t}> 未闭合（在 </{tag}> 处发现）@ 开启于 {pos}")
                del self.stack[i:]
                return
        errors.append(f"孤立闭合 </{tag}> @ {self.getpos()}")


src = DOC.read_text(encoding="utf-8")
ck = Checker()
ck.feed(src)
ck.close()

for tag, pos in ck.stack:
    errors.append(f"<{tag}> 直到文件末尾仍未闭合 @ 开启于 {pos}")

# id 唯一性
dup = [k for k, v in Counter(ck.ids).items() if v > 1]
if dup:
    errors.append(f"重复 id：{dup}")

# 锚点可达性（app.js 会为无 id 的 h3 自动生成，故此处只校验显式 href）
idset = set(ck.ids)
missing = sorted({h for h in ck.hrefs if h and h not in idset})
if missing:
    errors.append(f"锚点指向不存在的 id：{missing}")

# 章节完整性
if None in ck.chapters:
    errors.append("存在没有 id 的 .chapter section")

# 资源引用
for m in re.finditer(r'(?:href|src)="(assets/[^"]+)"', src):
    p = ROOT / m.group(1)
    if not p.exists():
        errors.append(f"资源缺失：{m.group(1)}")

# 未转义的裸 < 在代码块里（粗查：`<code>` 段内出现 "< " 或 "<-" 之类）
for i, block in enumerate(re.findall(r"<pre[^>]*><code[^>]*>(.*?)</code></pre>", src, re.S)):
    stripped = re.sub(r"&[a-z]+;|&#\d+;", "", block)
    bad = re.findall(r"<(?![/a-zA-Z!])", stripped)
    if bad:
        warnings.append(f"第 {i+1} 个代码块可能含未转义的 '<'：{bad[:3]}")

print("═" * 62)
print("  MCP 网关文档站 · 结构自检")
print("═" * 62)
print(f"  章节 (.chapter)   {len(ck.chapters)}")
print(f"  h2 / h3           {ck.h2} / {ck.h3}")
print(f"  代码块 pre        {ck.pres}")
print(f"  表格 table        {ck.tables}")
print(f"  显式 id           {len(ck.ids)}")
print(f"  内部锚点 href     {len(ck.hrefs)}")
print(f"  文档字数(去空白)  {len(re.sub(chr(92)+'s+', '', re.sub(r'<[^>]+>', '', src)))}")
print("─" * 62)

if warnings:
    print(f"  ⚠ {len(warnings)} 条警告")
    for w in warnings:
        print(f"    - {w}")
    print("─" * 62)

if errors:
    print(f"  ✗ {len(errors)} 条错误")
    for e in errors:
        print(f"    - {e}")
    sys.exit(1)

print("  ✓ 全部通过：标签闭合 / id 唯一 / 锚点可达 / 资源存在")
print("═" * 62)
