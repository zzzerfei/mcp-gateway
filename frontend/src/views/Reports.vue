<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type StatsOverview, type TimeseriesPoint } from '../api';
import { fmtNum, fmtTime } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Spinner from '../components/Spinner.vue';
import Empty from '../components/Empty.vue';

const toast = useToast();
const loading = ref(true);
const days = ref(7);
const bucket = ref<'hour' | 'day'>('hour');
const overview = ref<StatsOverview | null>(null);
const series = ref<TimeseriesPoint[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [ov, ts] = await Promise.all([
      api.stats.overview(days.value),
      api.stats.timeseries(days.value, bucket.value),
    ]);
    overview.value = ov;
    series.value = ts;
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
function setDays(d: number): void {
  if (days.value === d) return;
  days.value = d;
  bucket.value = d >= 14 ? 'day' : 'hour';
  load();
}
function setBucket(b: 'hour' | 'day'): void {
  if (bucket.value === b) return;
  bucket.value = b;
  load();
}
onMounted(load);

// ── 概览指标 ──────────────────────────────────────────
const failRate = computed(() => {
  const o = overview.value;
  if (!o || !o.totalCalls) return '0.0';
  return ((100 * o.totalFails) / o.totalCalls).toFixed(1);
});

// ── SVG 趋势图（无图表库，纯 SVG + HTML 悬浮层）────────
const W = 1000;
const H = 240;
const PAD_L = 44; // 左侧给 y 轴刻度留位
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 26; // 下方给 x 轴时间标签留位
const hover = ref(-1);

/** 向上取到“好看”的刻度：1/2/5/10/20/50/100/… */
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const m = n / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * base;
}

const chart = computed(() => {
  const n = series.value.length;
  if (n === 0) return null;
  const rawMax = Math.max(0, ...series.value.map((p) => p.total));
  const hasTraffic = rawMax > 0;
  const maxTotal = niceCeil(rawMax || 1);
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const xOf = (i: number) => (n === 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW);
  const yOf = (v: number) => PAD_T + innerH - (v / maxTotal) * innerH;
  const pts = series.value.map((p, i) => ({
    x: xOf(i),
    y: yOf(p.total),
    yf: yOf(p.fails),
    xpct: ((xOf(i)) / W) * 100,
    i,
    ...p,
  }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  const fail = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.yf.toFixed(2)}`).join(' ');
  const baseY = PAD_T + innerH;
  const area = `${line} L ${pts[pts.length - 1].x.toFixed(2)} ${baseY} L ${pts[0].x.toFixed(2)} ${baseY} Z`;
  // y 轴 4 条网格：0 / 25 / 50 / 75 / 100%（包含顶格，不画 0 因为 baseY 就是 0）
  const yTicks = [0.25, 0.5, 0.75, 1].map((r) => ({
    y: PAD_T + innerH * (1 - r),
    label: Math.round(maxTotal * r).toString(),
  }));
  // x 轴取 5 个均匀时间标签（首/末不靠齐，向内缩一格）
  const xTickIdx: number[] = n <= 5
    ? pts.map((_, i) => i)
    : [0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4));
  const xTicks = xTickIdx.map((i) => ({ x: xOf(i), ts: series.value[i].ts }));
  return { pts, line, fail, area, baseY, maxTotal, n, hasTraffic, yTicks, xTicks, innerW, innerH };
});
const hoverPoint = computed(() => (chart.value && hover.value >= 0 ? chart.value.pts[hover.value] : null));

/** x 轴短标签：小时级“MM-dd HH:00” / 天级“MM-dd” */
function shortTime(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return bucket.value === 'day' ? `${mm}-${dd}` : `${mm}-${dd} ${String(d.getHours()).padStart(2, '0')}:00`;
}

// ── 表格条形图相对基准 ────────────────────────────────
const maxToolN = computed(() => Math.max(1, ...(overview.value?.topTools.map((t) => t.n) ?? [1])));
const maxUpstreamN = computed(() => Math.max(1, ...(overview.value?.byUpstream.map((t) => t.n) ?? [1])));
const maxUserN = computed(() => Math.max(1, ...(overview.value?.topUsers.map((t) => t.n) ?? [1])));
const barPct = (n: number, max: number): string => `${Math.max(2, Math.round((n / max) * 100))}%`;
function failCls(pct: number): string {
  if (pct >= 20) return 'text-danger';
  if (pct >= 5) return 'text-warn';
  return 'text-muted';
}
</script>

<template>
  <div>
    <PageHeader title="数据报表" subtitle="治理成效与运行态势：调用量、失败率、敏感触达、上游耗时分布、热点工具与用户。全部基于审计日志实时聚合。">
      <template #actions>
        <div class="flex rounded-lg glass-inset p-0.5">
          <button v-for="d in [1, 7, 30]" :key="d" :class="days === d ? 'btn-primary btn-sm' : 'btn-sm text-muted'" @click="setDays(d)">
            {{ d === 1 ? '今天' : `${d} 天` }}
          </button>
        </div>
        <button class="btn-ghost" @click="load"><Icon name="refresh" :size="15" /></button>
      </template>
    </PageHeader>

    <Spinner v-if="loading" label="聚合报表数据…" />

    <template v-else-if="overview">
      <!-- 指标卡 -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5"><Icon name="chart" :size="13" /> 总调用量</div>
          <div class="stat-num">{{ fmtNum(overview.totalCalls) }}</div>
          <div class="text-[11px] text-faint mt-1">近 {{ overview.days }} 天 · tool_call</div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5"><Icon name="alert" :size="13" /> 失败调用</div>
          <div class="stat-num" :class="overview.totalFails ? 'text-danger' : ''">{{ fmtNum(overview.totalFails) }}</div>
          <div class="text-[11px] mt-1" :class="failCls(Number(failRate))">失败率 {{ failRate }}%</div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5"><Icon name="shield" :size="13" /> 敏感触达</div>
          <div class="stat-num">{{ fmtNum(overview.sensitiveCount) }}</div>
          <div class="text-[11px] text-faint mt-1">命中敏感上游/工具</div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5"><Icon name="server" :size="13" /> 活跃上游</div>
          <div class="stat-num">{{ overview.byUpstream.length }}</div>
          <div class="text-[11px] text-faint mt-1">产生调用的上游数</div>
        </div>
      </div>

      <!-- F1・RBAC 影子模式卡：展示当前模式 + 若切 enforce 会拦下多少现实调用 -->
      <div class="glass-card p-5 mb-5">
        <div class="flex items-start justify-between gap-4 mb-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <Icon name="shield" :size="14" class="text-muted" />
              <h3 class="text-sm font-semibold text-fg">RBAC 执行模式</h3>
              <span :class="overview.rbacMode === 'observe' ? 'chip-warn' : 'chip-ok'">
                {{ overview.rbacMode === 'observe' ? '影子模式 observe' : '强制模式 enforce' }}
              </span>
            </div>
            <p class="text-[11px] text-faint mt-1 leading-relaxed">
              <template v-if="overview.rbacMode === 'observe'">
                越权调用已放行·仅记录不拦截，适合上线前灰度；切回强制前建议先确保下方列表为空。
              </template>
              <template v-else>
                当前直接拦截越权。若担心新规则一上来就阻断业务，可先切“影子模式”试跑 1-2 天。
              </template>
            </p>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-[11px] text-faint mb-1">若切 enforce 会拦下</div>
            <div class="stat-num" :class="(overview.wouldForbidCount ?? 0) > 0 ? 'text-warn' : ''">
              {{ fmtNum(overview.wouldForbidCount ?? 0) }}
            </div>
            <div class="text-[10px] text-faint mt-0.5">近 {{ overview.days }} 天</div>
          </div>
        </div>
        <div v-if="overview.wouldForbidTop?.length" class="border-t border-line pt-3">
          <div class="text-[11px] text-faint mb-2">高频越权 Top 10·工具 × 角色</div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-1.5">
            <div v-for="(w, i) in overview.wouldForbidTop" :key="`${w.tool}-${w.role}-${i}`" class="flex items-center gap-2 text-xs">
              <span class="text-faint tabular-nums w-4 text-right shrink-0">{{ i + 1 }}</span>
              <span class="mono text-fg truncate">{{ w.tool }}</span>
              <span class="chip-off shrink-0">{{ w.role }}</span>
              <span class="ml-auto tabular-nums text-warn shrink-0">{{ fmtNum(w.n) }}</span>
            </div>
          </div>
        </div>
        <div v-else class="border-t border-line pt-3 text-xs text-faint">
          {{ overview.rbacMode === 'observe' ? '当前未命中任何越权调用—可放心切回强制模式。' : '未启用影子模式，无历史数据。如需验证规则，请到权限页切为“影子”。' }}
        </div>
      </div>

      <!-- 趋势图 -->
      <div class="glass-card p-5 mb-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h3 class="text-sm font-semibold text-fg">调用趋势</h3>
            <p class="text-[11px] text-faint mt-0.5">白线=总调用量，红线=失败量（同轴）</p>
          </div>
          <div class="flex rounded-lg glass-inset p-0.5">
            <button :class="bucket === 'hour' ? 'btn-primary btn-sm' : 'btn-sm text-muted'" @click="setBucket('hour')">按小时</button>
            <button :class="bucket === 'day' ? 'btn-primary btn-sm' : 'btn-sm text-muted'" @click="setBucket('day')">按天</button>
          </div>
        </div>

        <div v-if="!chart" class="py-12">
          <Empty text="该时间范围内无数据，无法绘制趋势" icon="chart" />
        </div>
        <div v-else-if="!chart.hasTraffic" class="py-12">
          <Empty text="该时间范围内无调用发生（时间轴已就绪，调用一采入库即可自动展高）" icon="chart" />
        </div>
        <div v-else class="relative">
          <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="w-full h-64 block">
            <defs>
              <linearGradient id="mgwArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--mgw-chart-fill)" stop-opacity="0.28" />
                <stop offset="100%" stop-color="var(--mgw-chart-fill)" stop-opacity="0.02" />
              </linearGradient>
            </defs>
            <!-- y 轴网格与刻度 -->
            <g>
              <line v-for="(t, i) in chart.yTicks" :key="`g${i}`" :x1="PAD_L" :x2="W - PAD_R" :y1="t.y" :y2="t.y"
                stroke="var(--mgw-chart-grid)" stroke-opacity="0.14" stroke-width="1" vector-effect="non-scaling-stroke" :stroke-dasharray="i === chart.yTicks.length - 1 ? '0' : '3 4'" />
            </g>
            <!-- 基线（0） -->
            <line :x1="PAD_L" :x2="W - PAD_R" :y1="chart.baseY" :y2="chart.baseY"
              stroke="var(--mgw-chart-grid)" stroke-opacity="0.22" stroke-width="1" vector-effect="non-scaling-stroke" />
            <!-- x 轴竖向网格 -->
            <g>
              <line v-for="(t, i) in chart.xTicks" :key="`xg${i}`" :x1="t.x" :x2="t.x" :y1="PAD_T" :y2="chart.baseY"
                stroke="var(--mgw-chart-grid)" stroke-opacity="0.08" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="2 4" />
            </g>
            <!-- 面积 + 失败线 + 主折线 -->
            <path :d="chart.area" fill="url(#mgwArea)" />
            <path :d="chart.fail" fill="none" stroke="var(--mgw-danger)" stroke-opacity="0.75" stroke-width="1.5"
              vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
            <path :d="chart.line" fill="none" stroke="var(--mgw-chart-line)" stroke-opacity="0.92" stroke-width="2"
              vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
            <!-- 数据点（非零） -->
            <g>
              <circle v-for="(p, i) in chart.pts" :key="`c${i}`"
                v-show="p.total > 0"
                :cx="p.x" :cy="p.y" :r="hover === i ? 4 : 2.6"
                fill="var(--mgw-surface)" stroke="var(--mgw-chart-line)" stroke-width="1.2" vector-effect="non-scaling-stroke" />
            </g>
          </svg>

          <!-- y 轴标签（HTML 层，避开 SVG preserveAspectRatio 拉伸导致字体失真） -->
          <div class="absolute left-0 top-0 bottom-0 pointer-events-none text-[10px] text-faint tabular-nums">
            <div v-for="(t, i) in chart.yTicks" :key="`ylab${i}`"
              class="absolute -translate-y-1/2 pl-1"
              :style="{ top: `${(t.y / H) * 100}%` }">{{ t.label }}</div>
            <div class="absolute -translate-y-1/2 pl-1 text-faint" :style="{ top: `${(chart.baseY / H) * 100}%` }">0</div>
          </div>

          <!-- 悬浮层（每点一个区） -->
          <div class="absolute inset-0 flex" :style="{ paddingLeft: `${(PAD_L / W) * 100}%`, paddingRight: `${(PAD_R / W) * 100}%` }">
            <div v-for="i in chart.n" :key="`h${i}`" class="flex-1 h-full cursor-crosshair"
              @mouseenter="hover = i - 1" @mouseleave="hover = -1" />
          </div>
          <!-- 游标 + 提示 -->
          <template v-if="hoverPoint">
            <div class="absolute pointer-events-none" :style="{ top: `${(PAD_T / H) * 100}%`, bottom: `${(PAD_B / H) * 100}%`, left: `${(hoverPoint.x / W) * 100}%`, transform: 'translateX(-0.5px)' }">
              <div class="w-px h-full bg-line" />
            </div>
            <div class="absolute z-2 pointer-events-none glass-card !rounded-lg px-3 py-2 text-[11px] -translate-x-1/2 whitespace-nowrap"
              :style="{ left: `${(hoverPoint.x / W) * 100}%`, top: '4px' }">
              <div class="text-muted tabular-nums">{{ fmtTime(hoverPoint.ts) }}</div>
              <div class="text-fg mt-0.5">调用 <span class="tabular-nums font-semibold">{{ fmtNum(hoverPoint.total) }}</span></div>
              <div class="text-danger">失败 <span class="tabular-nums">{{ fmtNum(hoverPoint.fails) }}</span> · {{ hoverPoint.fail_pct }}%</div>
            </div>
          </template>
          <!-- x 轴时间标签（HTML 层） -->
          <div class="absolute left-0 right-0 bottom-0 pointer-events-none text-[10px] text-faint tabular-nums">
            <span v-for="(t, i) in chart.xTicks" :key="`xl${i}`"
              class="absolute -translate-x-1/2"
              :style="{ left: `${(t.x / W) * 100}%` }">{{ shortTime(t.ts) }}</span>
          </div>
        </div>
      </div>

      <!-- 热点表格 -->
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <!-- Top 工具 -->
        <div class="glass-card overflow-hidden">
          <div class="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line">
            <Icon name="tool" :size="15" class="text-muted" />
            <h3 class="text-sm font-semibold text-fg">热点工具 Top 10</h3>
          </div>
          <table v-if="overview.topTools.length" class="w-full">
            <thead><tr><th class="th">工具</th><th class="th w-24 text-right">调用</th><th class="th w-20 text-right">均耗时</th><th class="th w-20 text-right">失败率</th></tr></thead>
            <tbody>
              <tr v-for="t in overview.topTools" :key="t.tool" class="tr-hover">
                <td class="td">
                  <div class="mono text-fg text-xs mb-1">{{ t.tool }}</div>
                  <div class="h-1 rounded-full bg-line overflow-hidden"><div class="h-full bg-accent rounded-full" :style="{ width: barPct(t.n, maxToolN) }" /></div>
                </td>
                <td class="td text-right tabular-nums text-fg">{{ fmtNum(t.n) }}</td>
                <td class="td text-right tabular-nums text-muted text-xs">{{ t.avg_ms }} ms</td>
                <td class="td text-right tabular-nums text-xs" :class="failCls(t.fail_pct)">{{ t.fail_pct }}%</td>
              </tr>
            </tbody>
          </table>
          <Empty v-else text="暂无工具调用" icon="tool" />
        </div>

        <!-- 上游分布 -->
        <div class="glass-card overflow-hidden">
          <div class="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line">
            <Icon name="server" :size="15" class="text-muted" />
            <h3 class="text-sm font-semibold text-fg">上游调用分布</h3>
          </div>
          <table v-if="overview.byUpstream.length" class="w-full">
            <thead><tr><th class="th">上游</th><th class="th w-24 text-right">调用</th><th class="th w-20 text-right">失败率</th></tr></thead>
            <tbody>
              <tr v-for="u in overview.byUpstream" :key="u.upstream" class="tr-hover">
                <td class="td">
                  <div class="mono text-fg text-xs mb-1">{{ u.upstream }}</div>
                  <div class="h-1 rounded-full bg-line overflow-hidden"><div class="h-full bg-accent rounded-full" :style="{ width: barPct(u.n, maxUpstreamN) }" /></div>
                </td>
                <td class="td text-right tabular-nums text-fg">{{ fmtNum(u.n) }}</td>
                <td class="td text-right tabular-nums text-xs" :class="failCls(u.fail_pct)">{{ u.fail_pct }}%</td>
              </tr>
            </tbody>
          </table>
          <Empty v-else text="暂无上游数据" icon="server" />
        </div>

        <!-- 失败率 Top -->
        <div class="glass-card overflow-hidden">
          <div class="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line">
            <Icon name="alert" :size="15" class="text-muted" />
            <h3 class="text-sm font-semibold text-fg">高失败率工具</h3>
            <span class="text-[10px] text-faint ml-auto">样本 &gt; 20</span>
          </div>
          <table v-if="overview.failTop.length" class="w-full">
            <thead><tr><th class="th">工具</th><th class="th w-24 text-right">调用</th><th class="th w-24 text-right">失败率</th></tr></thead>
            <tbody>
              <tr v-for="t in overview.failTop" :key="t.tool" class="tr-hover">
                <td class="td"><span class="mono text-fg text-xs">{{ t.tool }}</span></td>
                <td class="td text-right tabular-nums text-muted">{{ fmtNum(t.n) }}</td>
                <td class="td text-right"><span class="chip-err tabular-nums">{{ t.fail_pct }}%</span></td>
              </tr>
            </tbody>
          </table>
          <Empty v-else text="没有失败率超标的工具，运行健康" icon="check" />
        </div>

        <!-- 活跃用户 -->
        <div class="glass-card overflow-hidden">
          <div class="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line">
            <Icon name="users" :size="15" class="text-muted" />
            <h3 class="text-sm font-semibold text-fg">活跃使用者 Top 10</h3>
          </div>
          <table v-if="overview.topUsers.length" class="w-full">
            <thead><tr><th class="th">使用者</th><th class="th w-24 text-right">调用</th></tr></thead>
            <tbody>
              <tr v-for="u in overview.topUsers" :key="u.user_name" class="tr-hover">
                <td class="td">
                  <div class="text-fg text-xs mb-1">{{ u.user_name }}</div>
                  <div class="h-1 rounded-full bg-line overflow-hidden"><div class="h-full bg-accent rounded-full" :style="{ width: barPct(u.n, maxUserN) }" /></div>
                </td>
                <td class="td text-right tabular-nums text-fg">{{ fmtNum(u.n) }}</td>
              </tr>
            </tbody>
          </table>
          <Empty v-else text="暂无使用者数据" icon="users" />
        </div>
      </div>

      <!-- P95 耗时 -->
      <div class="glass-card overflow-hidden mt-5">
        <div class="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line">
          <Icon name="clock" :size="15" class="text-muted" />
          <h3 class="text-sm font-semibold text-fg">各上游 P95 耗时</h3>
          <span class="text-[10px] text-faint ml-auto">真实分位数（排序取值），非平均值冒充</span>
        </div>
        <table v-if="overview.p95ByUpstream.length" class="w-full">
          <thead><tr><th class="th">上游</th><th class="th w-28 text-right">样本数</th><th class="th w-32 text-right">P95 耗时</th></tr></thead>
          <tbody>
            <tr v-for="p in overview.p95ByUpstream" :key="p.upstream" class="tr-hover">
              <td class="td"><span class="mono text-fg text-xs">{{ p.upstream }}</span></td>
              <td class="td text-right tabular-nums text-muted">{{ fmtNum(p.count) }}</td>
              <td class="td text-right"><span class="tabular-nums text-fg text-sm" :class="p.p95_ms > 3000 ? 'text-warn' : ''">{{ fmtNum(p.p95_ms) }} ms</span></td>
            </tr>
          </tbody>
        </table>
        <Empty v-else text="暂无耗时数据" icon="clock" />
      </div>
    </template>

    <div v-else class="glass-card"><Empty text="无法加载报表数据" icon="chart" /></div>
  </div>
</template>
