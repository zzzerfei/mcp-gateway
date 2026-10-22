#!/usr/bin/env python3
"""
seed-calls.py · 并发打真实 tools/call 把审计数据灌满
─────────────────────────────────────────────────────────────────────────────
读一个 context.json：
  {
    "baseUrl": "...",
    "keys":   { "analyst-bot": "mgw_live_...", ... },
    "sids":   { "analyst-bot": "<session-id>",  ... }
  }
按 CALLS_PER_TOOL 生成 (key, tool, args) 任务表，用线程池并发打。
所有 tools/call 走真实治理链：限流/熔断/RBAC/审计/PII → audit_logs 落库。
"""
from __future__ import annotations
import argparse
import json
import random
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

SYMS = ['600519.SH', '000001.SZ', 'AAPL', 'TSLA', 'BTC/USD', 'ETH/USD', 'HSI', 'NDX', '601318.SH', '00700.HK']
SVC = ['api-gateway', 'auth-svc', 'order-svc', 'pay-callback', 'search-index', 'notify-hub', 'billing-cron']
HOST = ['10.0.1.15', '10.0.2.33', 'web-01', 'web-02', 'db-primary', 'cache-01']
DOM = ['example.com', 'qq.com', 'alipay.com', 'kubernetes.io', 'cloudflare.com', 'openai.com']
TEXT = ['hello world', 'MCP 网关', '你好，中国', 'dashboard seed', 'streaming analytics']


def build_jobs(n: int) -> list[tuple[str, str, dict]]:
    r = random.Random(0xC0FFEE)
    jobs: list[tuple[str, str, dict]] = []

    basic_fns = [
        lambda i: ('mock-basic__echo',           {'msg': f'seed-{i}-{r.randint(0, 9999)}'}),
        lambda i: ('mock-basic__now',            {}),
        lambda i: ('mock-basic__uuid',           {'count': r.randint(1, 20)}),
        lambda i: ('mock-basic__sleep',          {'ms': r.choice([50, 100, 200, 400])}),
        lambda i: ('mock-basic__random_int',     {'min': 1, 'max': 1000}),
        lambda i: ('mock-basic__word_count',     {'text': r.choice(TEXT) * r.randint(1, 3)}),
        lambda i: ('mock-basic__reverse',        {'text': r.choice(TEXT)}),
        lambda i: ('mock-basic__b64',            {'text': r.choice(TEXT), 'mode': r.choice(['encode', 'decode'])}),
        lambda i: ('mock-basic__md5',            {'text': r.choice(TEXT) + str(i)}),
    ]
    fin_fns = [
        lambda i: ('mock-finance__quote',            {'symbol': r.choice(SYMS)}),
        lambda i: ('mock-finance__history',          {'symbol': r.choice(SYMS), 'days': r.randint(5, 60)}),
        lambda i: ('mock-finance__news',             {'ticker': r.choice(SYMS), 'limit': r.randint(3, 15)}),
        lambda i: ('mock-finance__fund_flow',        {'symbol': r.choice(SYMS)}),
        lambda i: ('mock-finance__financial_report', {'symbol': r.choice(SYMS), 'period': r.choice(['2024Q1', '2024Q2', '2024Q3', '2024FY'])}),
        lambda i: ('mock-finance__screen',           {'market': r.choice(['CN', 'HK', 'US']), 'min_cap': r.randint(0, 5) * 1_000_000_000}),
        lambda i: ('mock-finance__compare',          {'symbols': r.sample(SYMS, r.randint(2, 5))}),
        lambda i: ('mock-finance__calendar',         {'market': r.choice(['CN', 'HK', 'US']), 'date': '2026-09-12'}),
    ]
    ops_fns = [
        lambda i: ('mock-ops__whoami',     {}),
        lambda i: ('mock-ops__list_hosts', {'region': r.choice(['cn-north', 'cn-east', 'cn-south', 'us-west', 'eu-central'])}),
        lambda i: ('mock-ops__get_metrics', {'host': r.choice(HOST), 'window': r.choice(['5m', '1h', '24h'])}),
        lambda i: ('mock-ops__tail_logs',  {'service': r.choice(SVC), 'lines': r.randint(20, 200)}),
        lambda i: ('mock-ops__restart',    {'service': r.choice(SVC)}),
        lambda i: ('mock-ops__deploy',     {'service': r.choice(SVC), 'version': f'v{r.randint(1, 3)}.{r.randint(0, 9)}.{r.randint(0, 20)}'}),
        lambda i: ('mock-ops__ping',       {'host': r.choice(HOST)}),
        lambda i: ('mock-ops__dns_lookup', {'domain': r.choice(DOM)}),
    ]

    for i in range(n):
        for fn in basic_fns:
            t, a = fn(i)
            jobs.append((('analyst-bot' if i % 2 == 0 else 'dashboard-seed'), t, a))
        for fn in fin_fns:
            t, a = fn(i)
            jobs.append((('finance-bot' if i % 3 else 'analyst-bot'), t, a))
        for fn in ops_fns:
            t, a = fn(i)
            jobs.append((('ops-bot' if i % 3 else 'analyst-bot'), t, a))
    return jobs


def fire(base: str, key: str, sid: str, raw: str, tool: str, args: dict, timeout: float) -> tuple[str, int, str]:
    body = json.dumps({
        'jsonrpc': '2.0', 'id': 99,
        'method': 'tools/call',
        'params': {'name': tool, 'arguments': args},
    }).encode('utf-8')
    req = urllib.request.Request(
        base.rstrip('/') + '/mcp', data=body, method='POST',
        headers={
            'Authorization': f'Bearer {raw}',
            'Mcp-Session-Id': sid,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = resp.status
            try:
                _ = resp.read()
            except Exception:  # noqa: BLE001 · SSE 流中提前关不会
                pass
            return tool, code, ''
    except urllib.error.HTTPError as e:
        return tool, e.code, str(e.reason)
    except Exception as e:  # noqa: BLE001
        return tool, 0, type(e).__name__ + ':' + str(e)[:80]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--context', required=True, help='seed-context.json 路径')
    ap.add_argument('--calls', type=int, default=12, help='每工具调用次数')
    ap.add_argument('--concurrency', type=int, default=2, help='同一上游内并发（stdio 上限 2，与后端 effLimit 对齐）')
    ap.add_argument('--timeout', type=float, default=45.0, help='单次调用超时（长操作工具会排队 · 需大于单个工具 maxMs × 同 Key 并发）')
    args = ap.parse_args()

    with open(args.context, 'r', encoding='utf-8') as f:
        ctx = json.load(f)
    base = ctx['baseUrl']
    keys = ctx['keys']
    sids = ctx['sids']

    jobs = build_jobs(args.calls)
    total = len(jobs)
    ok_count = err_count = 0
    t0 = time.time()

    # 按上游分桶（避免同一个 stdio 上游内并发超过后端 effLimit=2 引发 UPSTREAM_BUSY 不落审计）
    buckets: dict[str, list[tuple[str, str, dict]]] = {}
    for item in jobs:
        _k, t, _a = item
        bucket = t.split('__')[0]  # mock-basic / mock-finance / mock-ops / rail-12306
        buckets.setdefault(bucket, []).append(item)

    per_workers = max(1, args.concurrency)  # 同上游内串行度
    pools = {b: ThreadPoolExecutor(max_workers=per_workers) for b in buckets}
    all_futs = []
    for _b, items in buckets.items():
        for (k, t, a) in items:
            all_futs.append(pools[_b].submit(fire, base, k, sids[k], keys[k], t, a, args.timeout))

    done = 0
    for fu in as_completed(all_futs):
        tool, code, _msg = fu.result()
        if 200 <= code < 300:
            ok_count += 1
        else:
            err_count += 1
        done += 1
        if done % 50 == 0:
            el = time.time() - t0
            print(f'  · {done}/{total} · 已用 {el:.1f}s · 2xx={ok_count} 其他={err_count}', file=sys.stderr, flush=True)
    for p in pools.values():
        p.shutdown(wait=True)
    el = time.time() - t0
    print(json.dumps({
        'total': total, 'ok': ok_count, 'other': err_count, 'seconds': round(el, 2),
    }, ensure_ascii=False))
    return 0 if err_count == 0 else 0  # 部分 5xx 是预期（工具内置失败率）


if __name__ == '__main__':
    raise SystemExit(main())
