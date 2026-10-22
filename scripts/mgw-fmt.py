#!/usr/bin/env python3
"""从 stdin 读 JSON，把 admin API 常见响应渲染成可读表格。
用法：
  curl ... | python3 scripts/mgw-fmt.py tools_table
  curl ... | python3 scripts/mgw-fmt.py matrix
  curl ... | python3 scripts/mgw-fmt.py audit
  curl ... | python3 scripts/mgw-fmt.py changes
  curl ... | python3 scripts/mgw-fmt.py overview
"""
import json
import sys


def _load():
    return json.load(sys.stdin)


def tools_table():
    tools = _load()
    print(f"  总数: {len(tools)}")
    if tools:
        print(f"  字段: {list(tools[0].keys())}")
    print()
    hdr = f"  {'fullName':<40} {'sens':<7} {'rate':>9} {'enabled':>7}"
    print(hdr)
    print("  " + "─" * (len(hdr) - 2))
    for t in sorted(tools, key=lambda x: x["fullName"]):
        rate = t.get("rateQpm", "-")
        if isinstance(rate, (int, float)):
            rate = f"{rate}/min"
        print(
            f"  {t['fullName']:<40} {t['sensitivity']:<7} {str(rate):>9} {str(bool(t['enabled'])):>7}"
        )


def matrix():
    m = _load()
    columns = m["columns"]
    rows = m["rows"]
    roles = [r["role"] for r in rows]
    role_summary = [(r["role"], "allow=" + str(r["allowedCount"])) for r in rows]
    print("  roles:", role_summary)
    print(f"  工具数: {len(columns)}  ·  registryVersion: {m['registryVersion']}")
    print()
    col_w = 12
    head = "  " + "fullName".ljust(40) + "│" + "│".join(r.center(col_w) for r in roles)
    print(head)
    print("  " + "─" * 40 + "┼" + "┼".join("─" * col_w for _ in roles))
    for c in columns:
        cells = []
        for r in rows:
            allow = r["cells"].get(c["fullName"], False)
            cells.append(("✓ allow" if allow else "· deny").center(col_w))
        print("  " + c["fullName"][:38].ljust(40) + "│" + "│".join(cells))


def audit():
    m = _load()
    rows = m["rows"]
    total = m["total"]
    page = m.get("page", 1)
    size = m.get("size", len(rows))
    print(f"  总数: {total} · 本页: {len(rows)} (page={page} size={size})")
    print()
    print(
        f"  {'id':>4} {'ts(hh:mm:ss)':<12} {'user':<12} {'tool':<32} "
        f"{'ok':<3} {'err':<12} {'dur':>6} {'sens':<5}"
    )
    print("  " + "─" * 100)
    for r in rows:
        ts_ms = r["ts"]
        import datetime as _dt
        t = _dt.datetime.fromtimestamp(ts_ms / 1000).strftime("%H:%M:%S")
        ok = "✓" if r["resultOk"] else "✗"
        dur = str(r.get("durationMs")) + "ms" if r.get("durationMs") is not None else "-"
        # 安全处理 None 字段（initialize/ping/session_end 等事件无 tool/user）
        tool = r.get("tool") or "(no-tool:" + r.get("event", "?") + ")"
        user = r.get("userName") or "(anon)"
        sens = r.get("sensitive") or "-"
        err = r.get("errorCode") or ""
        print(
            f"  {r['id']:>4} {t:<12} {str(user)[:12]:<12} {str(tool)[:32]:<32} "
            f"{ok:<3} {str(err)[:12]:<12} {dur:>6} {str(sens):<5}"
        )


def changes():
    m = _load()
    rows = m["rows"]
    print(f"  总数: {m['total']} · 本页: {len(rows)}")
    print()
    print(f"  {'id':>4} {'actor':<12} {'targetType':<10} {'action':<10} {'targetId':<24} summary")
    print("  " + "─" * 100)
    import datetime as _dt
    for r in rows:
        t = _dt.datetime.fromtimestamp(r["ts"] / 1000).strftime("%m-%d %H:%M:%S")
        print(
            f"  {r['id']:>4} {r['actor'][:12]:<12} {r['targetType']:<10} "
            f"{r['action']:<10} {r['targetId'][:24]:<24} {t} · {r['diffSummary'][:38]}"
        )


def overview():
    m = _load()
    print(f"  窗口: {m['days']} 天")
    print(f"  totalCalls: {m['totalCalls']}  · totalFails: {m['totalFails']}  · PII 命中: {m['sensitiveCount']}")
    print()
    print("  ── 上游 P95 延迟 ──")
    for r in m["p95ByUpstream"]:
        print(f"    · {r['upstream']:<20} count={r['count']:<5} p95={r['p95_ms']}ms")
    print()
    print("  ── Top 工具 ──")
    for r in m["topTools"][:10]:
        print(f"    · {r['tool']:<40} n={r['n']:<5} avg={r['avg_ms']}ms fail={r['fail_pct']}%")
    print()
    print("  ── 上游分布 ──")
    for r in m["byUpstream"]:
        upstream = r.get("upstream") or "(no-upstream)"
        n = r.get("n", 0) or 0
        fail = r.get("fail_pct", 0) or 0
        print(f"    · {upstream:<20} n={n:<5} fail={fail}%")
    print()
    print("  ── 失败 Top ──")
    for r in m["failTop"][:10]:
        print(f"    · {r['tool']:<40} fail_n={r['n']:<5} fail={r['fail_pct']}%")
    print()
    print("  ── 活跃用户 ──")
    for r in m["topUsers"][:10]:
        print(f"    · {r['user_name']:<20} n={r['n']}")


if __name__ == "__main__":
    globals()[sys.argv[1]]()
