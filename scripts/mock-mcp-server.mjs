#!/usr/bin/env node
// ==============================================================================
//  mock-mcp-server.mjs · 给仪表盘 seed 提供可控真实工具源的 Mock MCP Server
//  ─────────────────────────────────────────────────────────────────────────────
//  3 个变体（--variant=basic|finance|ops），每变体 8-9 工具，共 25 工具。
//  工具返回随机 durationMs 与可控失败率，走完整治理链写入真实审计。
//
//  用法（本地手工调试）：
//    node scripts/mock-mcp-server.mjs --variant=basic
//  seed 脚本会自动以 stdio 方式启动 3 份实例并注册为上游。
// ==============================================================================
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '../backend/node_modules/@modelcontextprotocol/sdk');
const { McpServer } = require(resolve(sdkRoot, 'dist/cjs/server/mcp.js'));
const { StdioServerTransport } = require(resolve(sdkRoot, 'dist/cjs/server/stdio.js'));
const { z } = require(resolve(here, '../backend/node_modules/zod'));

const VARIANT = (process.argv.find((a) => a.startsWith('--variant=')) || '--variant=basic').split('=')[1];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function chance(p) { return Math.random() < p; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function failRate(p, msg) { if (chance(p)) throw new Error(msg); }

const server = new McpServer({ name: `mock-${VARIANT}`, version: '1.0.0' });

/** 注册工具的小助手：包一层延时与失败率，让 durationMs 与状态分布真实 */
function tool(name, description, shape, handler, opts = {}) {
  const minMs = opts.minMs ?? 5;
  const maxMs = opts.maxMs ?? 60;
  const failP = opts.failP ?? 0;
  const failMsg = opts.failMsg ?? `mock-${VARIANT}.${name}: simulated upstream hiccup`;
  server.tool(name, description, shape, async (args) => {
    const ms = rand(minMs, maxMs);
    await sleep(ms);
    if (failP > 0) failRate(failP, failMsg);
    const out = await handler(args ?? {});
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    return { content: [{ type: 'text', text }] };
  });
}

if (VARIANT === 'basic') {
  tool('echo', '把输入字符串原样回显（快速工具）', { msg: z.string() },
    ({ msg }) => `echo: ${msg}`, { minMs: 3, maxMs: 20 });
  tool('now', '返回当前服务器时间戳', {},
    () => ({ ts: Date.now(), iso: new Date().toISOString() }), { minMs: 2, maxMs: 15 });
  tool('uuid', '生成 N 个 UUID', { count: z.number().int().min(1).max(50) },
    ({ count }) => ({ ids: Array.from({ length: count }, () => randomUUID()) }), { minMs: 5, maxMs: 40 });
  tool('sleep', '按毫秒睡眠（长延时工具，测试 P95）', { ms: z.number().int().min(0).max(3000) },
    async ({ ms }) => { await sleep(ms); return `slept ${ms}ms`; }, { minMs: 0, maxMs: 5 });
  tool('random_int', '范围内随机整数', { min: z.number().int(), max: z.number().int() },
    ({ min, max }) => rand(min, max), { minMs: 3, maxMs: 15 });
  tool('word_count', '字符与词数统计', { text: z.string() },
    ({ text }) => ({ chars: text.length, words: text.split(/\s+/).filter(Boolean).length }),
    { minMs: 5, maxMs: 25 });
  tool('reverse', '字符串反转', { text: z.string() },
    ({ text }) => [...text].reverse().join(''), { minMs: 3, maxMs: 15 });
  tool('b64', 'Base64 编解码', { text: z.string(), mode: z.enum(['encode', 'decode']) },
    ({ text, mode }) => (mode === 'encode'
      ? Buffer.from(text).toString('base64')
      : Buffer.from(text, 'base64').toString('utf8')), { minMs: 5, maxMs: 25 });
  tool('md5', '计算字符串 MD5', { text: z.string() },
    ({ text }) => createHash('md5').update(text).digest('hex'), { minMs: 5, maxMs: 25 });
} else if (VARIANT === 'finance') {
  const symbols = ['600519.SH', '000001.SZ', 'AAPL', 'TSLA', 'BTC/USD', 'ETH/USD', 'HSI', 'NDX'];
  tool('quote', '行情快照（含买卖盘）', { symbol: z.string() },
    ({ symbol }) => ({
      symbol,
      last: +(100 + Math.random() * 500).toFixed(2),
      bid: +(99 + Math.random() * 2).toFixed(2),
      ask: +(101 + Math.random() * 2).toFixed(2),
      ts: Date.now(),
    }), { minMs: 80, maxMs: 500, failP: 0.04, failMsg: 'quote feed momentarily unavailable' });
  tool('history', '近 N 日 K 线', { symbol: z.string(), days: z.number().int().min(1).max(365) },
    ({ symbol, days }) => ({
      symbol, days,
      bars: Array.from({ length: Math.min(days, 30) }, (_, i) => ({
        t: Date.now() - i * 86400000,
        o: +(90 + Math.random() * 100).toFixed(2),
        c: +(90 + Math.random() * 100).toFixed(2),
        h: +(120 + Math.random() * 100).toFixed(2),
        l: +(80 + Math.random() * 30).toFixed(2),
        v: rand(1e5, 1e7),
      })),
    }), { minMs: 150, maxMs: 800 });
  tool('news', '按关键词拉财经新闻（失败率略高）', { ticker: z.string(), limit: z.number().int().min(1).max(30) },
    ({ ticker, limit }) => ({
      ticker,
      items: Array.from({ length: limit }, (_, i) => ({
        id: `${ticker}-${i}`,
        title: `${ticker} 相关报道 #${i}`,
        publishedAt: new Date(Date.now() - i * 3600e3).toISOString(),
      })),
    }), { minMs: 300, maxMs: 1200, failP: 0.12, failMsg: 'news provider 503' });
  tool('fund_flow', '资金流向', { symbol: z.string() },
    ({ symbol }) => ({ symbol, main: rand(-5e7, 5e7), retail: rand(-2e7, 2e7), ts: Date.now() }),
    { minMs: 100, maxMs: 400, failP: 0.03 });
  tool('financial_report', '财报摘要', { symbol: z.string(), period: z.string() },
    ({ symbol, period }) => ({
      symbol, period,
      revenue: rand(1e8, 5e10),
      netIncome: rand(1e7, 1e10),
      grossMargin: +(0.15 + Math.random() * 0.5).toFixed(4),
    }), { minMs: 500, maxMs: 2000 });
  tool('screen', '选股筛选（长查询）', { market: z.enum(['CN', 'HK', 'US']), min_cap: z.number().int().min(0) },
    ({ market, min_cap }) => ({
      market, min_cap,
      hits: Array.from({ length: rand(3, 12) }, () => ({ symbol: pick(symbols), cap: rand(min_cap || 1e9, 1e12) })),
    }), { minMs: 800, maxMs: 2500 });
  tool('compare', '多标的横向对比', { symbols: z.array(z.string()).min(1).max(10) },
    ({ symbols }) => ({ symbols, rows: symbols.map((s) => ({ s, pe: +(5 + Math.random() * 40).toFixed(2), pb: +(0.5 + Math.random() * 8).toFixed(2) })) }),
    { minMs: 200, maxMs: 900, failP: 0.05 });
  tool('calendar', '财经日历（今日/明日大事件）', { market: z.enum(['CN', 'HK', 'US']), date: z.string() },
    ({ market, date }) => ({
      market, date,
      events: Array.from({ length: rand(2, 6) }, (_, i) => ({
        time: `${String(rand(9, 20)).padStart(2, '0')}:${rand(0, 5) * 10}`,
        title: `${market} 事件 #${i}`,
      })),
    }), { minMs: 150, maxMs: 600, failP: 0.08 });
} else if (VARIANT === 'ops') {
  tool('whoami', '当前操作者身份', {},
    () => ({ user: process.env.USER || 'unknown', pid: process.pid, node: process.version }),
    { minMs: 2, maxMs: 10 });
  tool('list_hosts', '按 region 列主机', { region: z.string() },
    ({ region }) => ({
      region,
      hosts: Array.from({ length: rand(4, 12) }, (_, i) => ({
        id: `h-${region}-${i}`,
        ip: `10.${rand(0, 250)}.${rand(0, 250)}.${rand(1, 250)}`,
        cpu: rand(2, 64), mem: rand(4, 256),
      })),
    }), { minMs: 200, maxMs: 700 });
  tool('get_metrics', '拉主机指标（失败率偏高，模拟采集器抖动）', { host: z.string(), window: z.enum(['5m', '1h', '24h']) },
    ({ host, window }) => ({
      host, window,
      cpu: +(Math.random() * 100).toFixed(2),
      mem: +(Math.random() * 100).toFixed(2),
      iops: rand(50, 8000),
    }), { minMs: 250, maxMs: 1200, failP: 0.18, failMsg: 'metrics-agent timeout' });
  tool('tail_logs', '服务日志尾部 N 行（失败率中等）', { service: z.string(), lines: z.number().int().min(1).max(500) },
    ({ service, lines }) => ({
      service,
      lines: Array.from({ length: lines }, (_, i) => `${new Date(Date.now() - i * 1000).toISOString()} INFO [${service}] log line ${i}`),
    }), { minMs: 500, maxMs: 2000, failP: 0.09 });
  tool('restart', '重启服务（长操作）', { service: z.string() },
    async ({ service }) => { await sleep(rand(300, 1200)); return `restarted ${service}`; },
    { minMs: 1200, maxMs: 2800 });
  tool('deploy', '部署指定版本（长操作 + 偶发失败）', { service: z.string(), version: z.string() },
    async ({ service, version }) => { await sleep(rand(500, 1800)); return `deployed ${service}@${version}`; },
    { minMs: 1500, maxMs: 3500, failP: 0.07, failMsg: 'deploy pipeline failed at stage-2' });
  tool('ping', 'ICMP 探测目标主机（失败率较高）', { host: z.string() },
    ({ host }) => ({ host, rtt_ms: rand(1, 200), loss_pct: +(Math.random() * 5).toFixed(2) }),
    { minMs: 20, maxMs: 300, failP: 0.22, failMsg: 'icmp target unreachable' });
  tool('dns_lookup', '域名解析', { domain: z.string() },
    ({ domain }) => ({ domain, addresses: Array.from({ length: rand(1, 3) }, () => `${rand(1, 220)}.${rand(0, 255)}.${rand(0, 255)}.${rand(1, 255)}`) }),
    { minMs: 30, maxMs: 400, failP: 0.02 });
} else {
  process.stderr.write(`[mock-mcp-server] unknown variant: ${VARIANT}\n`);
  process.exit(2);
}

await server.connect(new StdioServerTransport());
process.stderr.write(`[mock-mcp-server] variant=${VARIANT} ready tools=${25}\n`);
