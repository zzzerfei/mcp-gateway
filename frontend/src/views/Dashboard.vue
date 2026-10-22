<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue';
import { api, type Health, type StatsOverview, type TimeseriesPoint, type Upstream, type BackupSummary } from '../api';
import { fmtNum, fmtUptime, fmtAgo, fmtBytes } from '../utils/format';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Spinner from '../components/Spinner.vue';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();

const loading = ref(true);
const health = ref<Health | null>(null);
const metrics = ref<any>(null);
const overview = ref<StatsOverview | null>(null);
const series = ref<TimeseriesPoint[]>([]);
const upstreams = ref<Upstream[]>([]);
const backup = ref<BackupSummary | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  const [h, m, o, s, u, b] = await Promise.allSettled([
    api.system.health(),
    fetch('/metrics').then((r) => r.json()),
    api.stats.overview(7),
    api.stats.timeseries(1, 'hour'),
    api.upstreams.list(),
    // 备份概览属于敏感读（gateway:sensitive），只读角色不请求，避免 403
    auth.canSensitive ? api.backup.summary() : Promise.resolve(null),
  ]);
  if (h.status === 'fulfilled') health.value = h.value;
  if (m.status === 'fulfilled') metrics.value = m.value;
  if (o.status === 'fulfilled') overview.value = o.value;
  if (s.status === 'fulfilled') series.value = s.value;
  if (u.status === 'fulfilled') upstreams.value = u.value;
  if (b.status === 'fulfilled') backup.value = b.value;
  loading.value = false;
}
onMounted(load);

const cards = computed(() => {
  const o = overview.value;
  const h = health.value;
  return [
    { label: '近 7 日调用', value: fmtNum(o?.totalCalls ?? 0), icon: 'chart', sub: `失败 ${fmtNum(o?.totalFails ?? 0)}` },
    { label: '敏感调用', value: fmtNum(o?.sensitiveCount ?? 0), icon: 'shield', sub: '已 PII 脱敏入库' },
    { label: '注册工具', value: fmtNum(h?.tools ?? 0), icon: 'tool', sub: `注册表 v${h?.registryVersion ?? 0}` },
    { label: '在线会话', value: fmtNum(h?.sessions ?? 0), icon: 'link', sub: `运行 ${fmtUptime(h?.uptime_s)}` },
    { label: '上游连接', value: `${h?.upstreamsConnected ?? 0}/${upstreams.value.length}`, icon: 'server', sub: '已连通 / 总数' },
    { label: '审计队列', value: fmtNum(h?.auditQueueDepth ?? 0), icon: 'list', sub: metrics.value ? `RSS ${metrics.value.rss_mb} MB` : '待写入' },
    // 备份卡只对有敏感读权限的角色展示
    ...(auth.canSensitive
      ? [{
        label: '最近备份',
        value: backup.value?.latest ? fmtAgo(backup.value.latest.ts) : '从未',
        icon: 'box',
        sub: backup.value?.enabled
          ? `${backup.value.cron} · ${fmtBytes(backup.value.latest?.bytes ?? 0)}`
          : '未启用',
      }]
      : []),
  ];
});

function statusChip(s: string): string {
  return s === 'up' ? 'chip-ok' : s === 'down' ? 'chip-err' : s === 'connecting' ? 'chip-warn' : 'chip-off';
}
function statusText(s: string): string {
  return s === 'up' ? '正常' : s === 'down' ? '故障' : s === 'connecting' ? '连接中' : '未知';
}

// ── 趋势图 · 主轨面积走势 + 副轨失败率 · 单 Y 轴 · ResizeObserver 与真实像素 1:1 ───
// 上一版教训：viewBox 固定 + width:100% 会让坐标文字随容器拉伸；双 Y 轴 + 堆叠柱 + 曲线信息噪声过高
// 本版原则：主视觉只有“调用走势”（面积 + 折线 + 峰值）· 失败率降到副轨小柱，单 Y 轴只留3段
const chartEl = ref<HTMLElement | null>(null);
const chartW = ref(0);

// 布局常量（单位 = 真实像素）
const PAD = { l: 36, r: 14, t: 12, b: 22 };
const MAIN_H = 150;
const SUB_H = 22;
const GAP = 6;
const CH_H = PAD.t + MAIN_H + GAP + SUB_H + PAD.b; // 212
const MAIN_Y = PAD.t;
const SUB_Y = PAD.t + MAIN_H + GAP;
const SUB_BASELINE = SUB_Y + SUB_H;
const MAIN_BASELINE = MAIN_Y + MAIN_H;

let ro: ResizeObserver | null = null;
let roAttached = false;
async function attachResizeObserver(): Promise<void> {
  if (roAttached || typeof ResizeObserver === 'undefined') return;
  await nextTick();
  if (!chartEl.value) return;
  ro = new ResizeObserver((entries) => {
    for (const e of entries) chartW.value = Math.max(320, Math.floor(e.contentRect.width));
  });
  ro.observe(chartEl.value);
  roAttached = true;
}
// chartEl 只在 series 非空时挂载・onMounted 时后端数据未回，改用 watch+nextTick 补挂
watch(
  () => series.value.length,
  (n) => {
    if (n > 0) void attachResizeObserver();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  roAttached = false;
});

/** 将任意图形量上取整到 nice 刻度，避免轴顶接边 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const p = Math.pow(10, exp);
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const s of steps) if (v <= s * p) return s * p;
  return 10 * p;
}

const plotW = computed(() => Math.max(0, chartW.value - PAD.l - PAD.r));
const slot = computed(() => (series.value.length ? plotW.value / series.value.length : plotW.value));
const barW = computed(() => Math.max(2, slot.value * 0.55));
const maxTotal = computed(() => Math.max(1, ...series.value.map((p) => p.total)));
const axisMax = computed(() => niceCeil(maxTotal.value));

function barX(i: number): number {
  return PAD.l + slot.value * i + (slot.value - barW.value) / 2;
}
function barCenterX(i: number): number {
  return PAD.l + slot.value * (i + 0.5);
}
function yMain(v: number): number {
  return MAIN_Y + MAIN_H - (v / axisMax.value) * MAIN_H;
}

/** 主轨折线・直线不手折——宁可“看真”，避免平滑曲线误导峰谷 */
const linePath = computed(() => {
  if (!series.value.length) return '';
  return series.value
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${barCenterX(i).toFixed(1)},${yMain(p.total).toFixed(1)}`)
    .join(' ');
});
/** 面积闭合：折线 → 右端回到基线 → 左端基线 → Z */
const areaPath = computed(() => {
  const n = series.value.length;
  if (!n) return '';
  return `${linePath.value} L${barCenterX(n - 1).toFixed(1)},${MAIN_BASELINE} L${barCenterX(0).toFixed(1)},${MAIN_BASELINE} Z`;
});

/** 左轴只留 3 段刻度（0 / 中 / max），降低坐标噪声 */
const leftTicks = computed(() => [
  { v: axisMax.value, y: MAIN_Y },
  { v: Math.round(axisMax.value / 2), y: MAIN_Y + MAIN_H / 2 },
  { v: 0, y: MAIN_BASELINE },
]);

/** X 轴隔项自动抽稀：按容器宽／桶数自动选 step，保证标签不重迭 */
const xLabelStep = computed(() => {
  const n = series.value.length || 1;
  const minPxPerLabel = 44;
  const byWidth = Math.max(1, Math.ceil(minPxPerLabel / Math.max(1, slot.value)));
  const byCount = n <= 12 ? 1 : n <= 24 ? 3 : 6;
  return Math.max(byWidth, byCount);
});

/** 峰值时刻（total 最大那一个・多峰取首） */
const peakIndex = computed(() => {
  let mx = -1;
  let idx = -1;
  series.value.forEach((p, i) => {
    if (p.total > mx) {
      mx = p.total;
      idx = i;
    }
  });
  return idx;
});
const peakInfo = computed(() => {
  const i = peakIndex.value;
  if (i < 0 || !series.value[i] || series.value[i].total === 0) return null;
  const p = series.value[i];
  return {
    idx: i,
    x: barCenterX(i),
    y: yMain(p.total),
    ts: p.ts,
    total: p.total,
    // 靠右翻飘：当峰在右侧 65% 以上时文字向左对齐
    anchor: barCenterX(i) > chartW.value * 0.68 ? 'end' : barCenterX(i) < chartW.value * 0.15 ? 'start' : 'middle',
  };
});

/** 副轨失败率小柱・相对 axisPctMax 归一化 */
const maxPct = computed(() => Math.max(0, ...series.value.map((p) => p.fail_pct)));
const axisPctMax = computed(() => Math.max(5, niceCeil(maxPct.value)));
function failBarH(p: TimeseriesPoint): number {
  if (!p.fails) return 0;
  const h = (Math.min(100, p.fail_pct) / axisPctMax.value) * SUB_H;
  return Math.max(2, h);
}
function failBarY(p: TimeseriesPoint): number {
  return SUB_BASELINE - failBarH(p);
}

/** 24 小时窗口小结（图内自带 · 消除与 7 日卡片的口径误解） */
const seriesSummary = computed(() => {
  const total = series.value.reduce((s, p) => s + p.total, 0);
  const fails = series.value.reduce((s, p) => s + p.fails, 0);
  const pct = total ? +((100 * fails) / total).toFixed(1) : 0;
  return { total, fails, pct };
});
function hourLabel(ts: number): string {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0');
}

const hoverIdx = ref<number | null>(null);
function tooltipStyle(): Record<string, string> {
  if (hoverIdx.value === null) return { display: 'none' };
  const cx = barCenterX(hoverIdx.value);
  const flip = cx > chartW.value * 0.62;
  return {
    left: `${cx}px`,
    top: `${PAD.t + 2}px`,
    transform: flip ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
  };
}
</script>

<template>
  <div>
    <PageHeader title="仪表盘" subtitle="网关运行总览：调用量、治理健康度、上游连通性与热点工具">
      <template #actions>
        <button class="btn-ghost" @click="load">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
      </template>
    </PageHeader>

    <Spinner v-if="loading" label="加载运行数据…" />

    <template v-else>
      <!-- 指标卡 -->
      <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 gap-4 mb-6">
        <div v-for="c in cards" :key="c.label" class="glass-card glass-hover p-4">
          <div class="flex items-center justify-between mb-3">
            <span class="text-faint">
              <Icon :name="c.icon" :size="18" />
            </span>
          </div>
          <div class="stat-num text-2xl">{{ c.value }}</div>
          <div class="text-xs text-muted mt-1">{{ c.label }}</div>
          <div class="text-[11px] text-faint mt-0.5">{{ c.sub }}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <!-- 趋势 · 主轨面积走势 + 副轨失败率小柱 · 单 Y 轴 · ResizeObserver 真实像素 -->
        <div class="glass-card p-5 xl:col-span-2 flex flex-col">
          <div class="flex items-start justify-between gap-4 mb-3 flex-wrap">
            <div>
              <h3 class="text-sm font-semibold text-fg">近 24 小时调用趋势</h3>
              <p class="text-[11px] text-faint mt-1">主轨：调用量走势 · 副轨：失败率 · 悬停查看明细</p>
            </div>
            <div class="text-right leading-tight">
              <div class="tabular-nums flex items-baseline gap-1.5">
                <span class="stat-num text-2xl text-fg">{{ fmtNum(seriesSummary.total) }}</span>
                <span class="text-[11px] text-faint">次</span>
                <span v-if="seriesSummary.fails" class="text-[11px] text-danger tabular-nums">· {{
                  fmtNum(seriesSummary.fails) }} 失败</span>
              </div>
              <div class="text-[11px] text-faint mt-0.5 tabular-nums">
                <span>失败率 {{ seriesSummary.pct }}%</span>
                <span v-if="peakInfo">　峰值 {{ hourLabel(peakInfo.ts) }}:00 · {{ fmtNum(peakInfo.total) }}</span>
              </div>
            </div>
          </div>

          <div v-if="series.length" ref="chartEl" class="relative flex-1" @mouseleave="hoverIdx = null">
            <svg v-if="chartW > 0" :width="chartW" :height="CH_H" :viewBox="`0 0 ${chartW} ${CH_H}`"
              style="display:block" role="img" aria-label="近 24 小时调用趋势">
              <defs>
                <linearGradient id="mgw-area-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--mgw-chart-fill)" stop-opacity="0.28" />
                  <stop offset="60%" stop-color="var(--mgw-chart-fill)" stop-opacity="0.08" />
                  <stop offset="100%" stop-color="var(--mgw-chart-fill)" stop-opacity="0.01" />
                </linearGradient>
              </defs>

              <!-- 主轨网格线（3 段） -->
              <line v-for="(t, i) in leftTicks" :key="'grid' + i" :x1="PAD.l" :x2="chartW - PAD.r" :y1="t.y" :y2="t.y"
                stroke="var(--mgw-chart-grid)" stroke-opacity="0.06" stroke-width="1" />

              <!-- 主轨面积 + 折线 -->
              <path :d="areaPath" fill="url(#mgw-area-grad)" stroke="none" />
              <path :d="linePath" fill="none" stroke="var(--mgw-chart-line)" stroke-opacity="0.8" stroke-width="1.5"
                stroke-linejoin="round" stroke-linecap="round" />

              <!-- 峰值小圆（文字已移到 HTML 层避免 SVG 缩放） -->
              <circle v-if="peakInfo" :cx="peakInfo.x" :cy="peakInfo.y" r="3.2" fill="var(--mgw-chart-line)"
                opacity="0.92" />

              <!-- 副轨·失败率小柱 · 底部参考线 -->
              <line :x1="PAD.l" :x2="chartW - PAD.r" :y1="SUB_BASELINE" :y2="SUB_BASELINE"
                stroke="var(--mgw-chart-grid)" stroke-opacity="0.1" stroke-width="1" />
              <template v-for="(p, i) in series" :key="'fb' + i">
                <rect v-if="p.fails > 0" :x="barX(i)" :y="failBarY(p)" :width="barW" :height="failBarH(p)"
                  fill="var(--mgw-danger)" fill-opacity="0.65" rx="1" />
              </template>

              <!-- 主轨 baseline -->
              <line :x1="PAD.l" :x2="chartW - PAD.r" :y1="MAIN_BASELINE" :y2="MAIN_BASELINE"
                stroke="var(--mgw-chart-grid)" stroke-opacity="0.18" stroke-width="1" />

              <!-- 全列 hover 触达区（盖在上层） -->
              <rect v-for="(_, i) in series" :key="'hz' + i" :x="PAD.l + slot * i" :y="0" :width="slot" :height="CH_H"
                fill="transparent" style="cursor: crosshair" @mouseenter="hoverIdx = i" />

              <!-- 选中竖线 + 主轨焦点小圆 -->
              <line v-if="hoverIdx !== null" :x1="barCenterX(hoverIdx)" :x2="barCenterX(hoverIdx)" :y1="PAD.t"
                :y2="SUB_BASELINE" stroke="var(--mgw-chart-grid)" stroke-opacity="0.3" stroke-dasharray="2,3" />
              <circle v-if="hoverIdx !== null && series[hoverIdx]" :cx="barCenterX(hoverIdx)"
                :cy="yMain(series[hoverIdx].total)" r="4" fill="var(--mgw-surface)" stroke="var(--mgw-chart-line)"
                stroke-width="1.2" />
            </svg>

            <!-- 文字层：坐标轴数字与峰值标注全部移出 SVG，字号完全受 CSS 控制，不再被 viewBox/DPR 拉伸 -->
            <div class="chart-text-layer">
              <!-- Y 轴：只留 axisMax 与中点两个数字・去掉底部 0（baseline 已表达） -->
              <span v-for="(t, i) in leftTicks.slice(0, 2)" :key="'yl' + i" class="axis-num axis-num-y"
                :style="{ left: (PAD.l - 8) + 'px', top: t.y + 'px' }">{{ t.v }}</span>

              <!-- X 轴时刻・自动抽稀 -->
              <template v-for="(p, i) in series" :key="'xl' + i">
                <span v-if="i % xLabelStep === 0" class="axis-num axis-num-x"
                  :style="{ left: barCenterX(i) + 'px', top: (CH_H - 6) + 'px' }">{{ hourLabel(p.ts) }}</span>
              </template>

              <!-- 峰值标注・与图内右上角小结去重・只写时刻 -->
              <span v-if="peakInfo" class="peak-num" :style="{
                left: peakInfo.x + 'px',
                top: Math.max(PAD.t + 8, peakInfo.y - 8) + 'px',
                transform: peakInfo.anchor === 'end' ? 'translate(-100%, -100%)' : peakInfo.anchor === 'start' ? 'translate(0, -100%)' : 'translate(-50%, -100%)',
              }">{{ hourLabel(peakInfo.ts) }}:00 峰</span>
            </div>

            <!-- hover tooltip -->
            <div v-if="hoverIdx !== null && series[hoverIdx]"
              class="glass pointer-events-none absolute rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed whitespace-nowrap z-10 text-fg"
              :style="tooltipStyle()">
              <div class="mono text-muted mb-1">{{ hourLabel(series[hoverIdx].ts) }}:00</div>
              <div class="flex items-center gap-2"><span class="w-2.5 h-0.5 inline-block"
                  style="background: var(--mgw-chart-line)" /> 调用 <span class="tabular-nums ml-auto pl-4 text-fg">{{
                    series[hoverIdx].total }}</span></div>
              <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-sm inline-block"
                  style="background: var(--mgw-danger)" /> 失败 <span class="tabular-nums ml-auto pl-4">{{
                    series[hoverIdx].fails
                  }}</span></div>
              <div class="flex items-center gap-2"><span class="w-2 h-2 rounded-sm inline-block opacity-60"
                  style="background: var(--mgw-ok)" /> 成功 <span class="tabular-nums ml-auto pl-4">{{
                    series[hoverIdx].total
                    - series[hoverIdx].fails }}</span></div>
              <div class="mt-1 pt-1 border-t border-line text-[10px] text-muted tabular-nums">失败率 {{
                series[hoverIdx].fail_pct
                }}%</div>
            </div>
          </div>
          <div v-else class="h-52 flex items-center justify-center text-faint text-sm">
            暂无调用数据 · 可运行 <code class="mono mx-1 text-muted">./scripts/seed-dashboard.sh</code> 从数据源头灌满
          </div>
          <p class="text-[10.5px] text-faint mt-2">
            图内小结为 24 小时窗口・顶部卡片为 7 日窗口，两者口径不同
          </p>
        </div>

        <!-- 上游状态 -->
        <div class="glass-card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-fg">上游连通性</h3>
            <router-link to="/upstreams" class="text-[11px] text-muted hover:text-fg transition-colors">管理
              →</router-link>
          </div>
          <div v-if="upstreams.length" class="space-y-2.5">
            <div v-for="u in upstreams" :key="u.id"
              class="flex items-center justify-between gap-3 glass-inset px-3 py-2.5">
              <div class="min-w-0">
                <div class="text-sm text-fg truncate font-medium">{{ u.displayName || u.name }}</div>
                <div class="text-[11px] text-faint truncate mono">{{ u.transport }} · {{ u.name }}</div>
              </div>
              <span :class="statusChip(u.enabled ? u.lastStatus : 'unknown')" class="shrink-0">{{ u.enabled ?
                statusText(u.lastStatus) : '已下线' }}</span>
            </div>
          </div>
          <div v-else class="py-8 text-center text-faint text-sm">尚未配置上游</div>
        </div>
      </div>

      <!-- Top 工具 / 失败 Top -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
        <div class="glass-card p-5">
          <h3 class="text-sm font-semibold text-fg mb-4">热点工具 Top 10（近 7 日）</h3>
          <div v-if="overview?.topTools?.length" class="space-y-1">
            <div v-for="t in overview.topTools" :key="t.tool" class="flex items-center gap-3 py-1.5">
              <span class="text-[11px] text-muted mono truncate flex-1">{{ t.tool }}</span>
              <span class="text-xs text-muted tabular-nums w-16 text-right">{{ fmtNum(t.n) }} 次</span>
              <span class="text-[11px] tabular-nums w-16 text-right"
                :class="t.fail_pct > 5 ? 'text-danger' : 'text-faint'">{{
                  t.fail_pct }}%</span>
            </div>
          </div>
          <div v-else class="py-8 text-center text-faint text-sm">暂无数据</div>
        </div>

        <div class="glass-card p-5">
          <h3 class="text-sm font-semibold text-fg mb-4">高失败率工具（样本 &gt; 20）</h3>
          <div v-if="overview?.failTop?.length" class="space-y-2.5">
            <div v-for="t in overview.failTop" :key="t.tool">
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="text-muted mono truncate">{{ t.tool }}</span>
                <span class="text-danger tabular-nums">{{ t.fail_pct }}% · {{ fmtNum(t.n) }} 次</span>
              </div>
              <div class="h-1.5 rounded-full bg-line overflow-hidden">
                <div class="h-full rounded-full bg-danger" :style="{ width: `${Math.min(100, t.fail_pct)}%` }" />
              </div>
            </div>
          </div>
          <div v-else class="py-8 text-center text-faint text-sm">暂无高失败率工具（健康）</div>
        </div>
      </div>

      <p v-if="health" class="text-center text-[11px] text-faint mt-6">
        数据更新于 {{ fmtAgo(health.ts) }} · 网关运行 {{ fmtUptime(health.uptime_s) }}
      </p>
    </template>
  </div>
</template>

<style scoped>
/* 图表文字层・HTML 绝对定位，字号 100% 由 CSS 控制，不受 SVG viewBox 缩放影响 */
.chart-text-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
  z-index: 4;
}

.axis-num {
  position: absolute;
  font-size: 10px;
  line-height: 1;
  color: var(--mgw-faint);
  white-space: nowrap;
  font-weight: 400;
  letter-spacing: 0.2px;
}

.axis-num-y {
  transform: translate(-100%, -50%);
}

.axis-num-x {
  transform: translate(-50%, -100%);
}

.peak-num {
  position: absolute;
  font-size: 10.5px;
  line-height: 1;
  color: var(--mgw-muted);
  font-weight: 500;
  white-space: nowrap;
  letter-spacing: 0.2px;
}
</style>
