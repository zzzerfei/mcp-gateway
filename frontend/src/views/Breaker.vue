<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import {
  api,
  type BreakerStatus,
  type BreakerEventItem,
  type BreakerSummaryItem,
  type BreakerState,
  type Upstream,
  type Paged,
} from '../api';
import { fmtTime, fmtAgo, fmtNum, fmtDuration } from '../utils/format';
import { useToast } from '../composables/useToast';
import { getGatewayToken } from '../lib/logto';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Spinner from '../components/Spinner.vue';
import Empty from '../components/Empty.vue';

/**
 * P1-C・熔断事件面板。
 * 与 Reports（调用量报表）分离：这里只回答"上游健康度趋势"。
 * 数据源：内存快照（/status · 60s 自动刷新）+ circuit_breaker_events 表（/events · /summary）。
 */

const toast = useToast();
const days = ref(7);
const loadingSummary = ref(true);
const loadingEvents = ref(false);

const status = ref<BreakerStatus | null>(null);
const summary = ref<BreakerSummaryItem[]>([]);
const upstreams = ref<Upstream[]>([]);
const events = ref<Paged<BreakerEventItem>>({ total: 0, page: 1, size: 20, rows: [] });

const f = reactive({
  upstream: '',
  event: '' as '' | 'opened' | 'recovered',
});
const page = ref(1);

// ── 加载 ──────────────────────────────────────────────
async function loadStatus(): Promise<void> {
  try {
    status.value = await api.breaker.status();
  } catch (e) {
    toast.error((e as Error).message);
  }
}
async function loadSummary(): Promise<void> {
  loadingSummary.value = true;
  try {
    const [sm, ups] = await Promise.all([api.breaker.summary(days.value), api.upstreams.list()]);
    summary.value = sm;
    upstreams.value = ups;
  } catch (e) {
    toast.error((e as Error).message);
  }
  loadingSummary.value = false;
}
async function loadEvents(): Promise<void> {
  loadingEvents.value = true;
  try {
    const q: Record<string, unknown> = { page: page.value, size: 20 };
    if (f.upstream) q.upstream = f.upstream;
    if (f.event) q.event = f.event;
    events.value = await api.breaker.events(q);
  } catch (e) {
    toast.error((e as Error).message);
  }
  loadingEvents.value = false;
}
async function refreshAll(): Promise<void> {
  await Promise.all([loadStatus(), loadSummary(), loadEvents()]);
}
function setDays(d: number): void {
  if (days.value === d) return;
  days.value = d;
  loadSummary();
}
function onFilter(): void {
  page.value = 1;
  loadEvents();
}
function reset(): void {
  f.upstream = '';
  f.event = '';
  page.value = 1;
  loadEvents();
}

const totalPages = computed(() => Math.max(1, Math.ceil(events.value.total / 20)));
function goPage(p: number): void {
  const clamped = Math.min(Math.max(1, p), totalPages.value);
  if (clamped === page.value) return;
  page.value = clamped;
  loadEvents();
}

// ── 60s 自动刷新状态快照（兼做 SSE 断线兜底）─────────
let timer: number | null = null;

// ── P1-F・SSE 实时推流 ─────────────────────────
// 后端熔断迁移发生时即时推送到面板，无需等 60s。
// 断线时浏览器会自动 backoff 重连；同时保留 60s 全量兜底防遗漏。
const sseConnected = ref(false);
let es: EventSource | null = null;
async function connectSSE(): Promise<void> {
  if (es) return;
  let token: string;
  try {
    token = await getGatewayToken();
  } catch {
    return; // 未登录 / token 刷新失败：交给 60s 轮询兜底
  }
  const url = `/admin/api/breaker/events/stream?token=${encodeURIComponent(token)}`;
  es = new EventSource(url);
  es.onopen = () => (sseConnected.value = true);
  es.addEventListener('breaker', (ev: MessageEvent) => {
    try {
      const row = JSON.parse(ev.data) as BreakerEventItem;
      const matchFilter =
        (!f.upstream || f.upstream === row.upstream) && (!f.event || f.event === row.event);
      if (page.value === 1 && matchFilter) {
        events.value = {
          ...events.value,
          total: events.value.total + 1,
          rows: [row, ...events.value.rows].slice(0, events.value.size),
        };
      }
      void loadStatus();
      void loadSummary();
      toast.info(`上游 ${row.upstream} 状态 → ${row.event === 'opened' ? '熔断中' : '已恢复'}`);
    } catch (e) {
      console.warn('SSE breaker event 解析失败', e);
    }
  });
  es.onerror = () => {
    sseConnected.value = false;
    // 断线浏览器会自动重连；若被服务端拒绝（如 token 过期）则关闭，换新 token 重连
    if (es && es.readyState === EventSource.CLOSED) {
      es = null;
      window.setTimeout(() => void connectSSE(), 5000);
    }
    // 长时间断线依靠 60s 全量保准
  };
}
function disconnectSSE(): void {
  if (es) {
    es.close();
    es = null;
  }
  sseConnected.value = false;
}

onMounted(async () => {
  await refreshAll();
  timer = window.setInterval(loadStatus, 60_000);
  void connectSSE();
});
onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer);
  disconnectSSE();
});

// ── 派生指标 ─────────────────────────────────────────
const openCount = computed(() =>
  (status.value?.upstreams ?? []).filter((u) => u.state === 'open').length,
);
const halfOpenCount = computed(() =>
  (status.value?.upstreams ?? []).filter((u) => u.state === 'half-open').length,
);
const totalOpened = computed(() => summary.value.reduce((s, r) => s + r.opened, 0));
const totalRecovered = computed(() => summary.value.reduce((s, r) => s + r.recovered, 0));
const activeUpstreams = computed(() => upstreams.value.filter((u) => u.enabled === 1).length);

/** 状态圆点颜色：closed 绿 / open 红 / half-open 黄 */
function dotCls(s: BreakerState): string {
  if (s === 'open') return 'bg-danger shadow-[0_0_12px_rgba(248,113,113,0.6)]';
  if (s === 'half-open') return 'bg-warn shadow-[0_0_12px_rgba(252,211,77,0.5)]';
  return 'bg-ok shadow-[0_0_10px_rgba(52,211,153,0.4)]';
}
function stateChip(s: BreakerState): string {
  if (s === 'open') return 'chip-err';
  if (s === 'half-open') return 'chip-warn';
  return 'chip-ok';
}
function eventChip(ev: 'opened' | 'recovered'): string {
  return ev === 'opened' ? 'chip-err' : 'chip-ok';
}
function upstreamDisplay(name: string): string {
  const u = upstreams.value.find((x) => x.name === name);
  return u?.displayName || name;
}
const maxOpened = computed(() => Math.max(1, ...summary.value.map((r) => r.opened)));
function barPct(n: number, max: number): string {
  return `${Math.max(2, Math.round((n / max) * 100))}%`;
}
</script>

<template>
  <div>
    <PageHeader title="熔断事件" subtitle="上游健康度趋势：连续失败达阈值时自动 open（保护上游 & 用户），恢复后半开→闭合。所有迁移留痕供复盘，与调用报表分离。">
      <template #actions>
        <div class="flex rounded-lg glass-inset p-0.5">
          <button v-for="d in [1, 7, 30]" :key="d" :class="days === d ? 'btn-primary btn-sm' : 'btn-sm text-muted'"
            @click="setDays(d)">
            {{ d === 1 ? '今天' : `${d} 天` }}
          </button>
        </div>
        <button class="btn-ghost" @click="refreshAll">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
      </template>
    </PageHeader>

    <!-- 配置条：阈值 & 打开时长（一次采样后展示） -->
    <div v-if="status"
      class="glass-inset px-4 py-2.5 mb-5 text-[11px] text-muted flex flex-wrap items-center gap-x-5 gap-y-1">
      <span class="flex items-center gap-1.5">
        <Icon name="info" :size="12" />
        <span>熔断策略</span>
      </span>
      <span>连续失败 <span class="text-fg tabular-nums">{{ status.config.failThreshold }}</span> 次 → open</span>
      <span>open 保持 <span class="text-fg tabular-nums">{{ (status.config.openMs / 1000).toFixed(0)
          }}s</span></span>
      <span>滑动窗口 <span class="text-fg tabular-nums">{{ (status.config.windowMs / 1000).toFixed(0)
          }}s</span></span>
      <span class="ml-auto flex items-center gap-2">
        <span class="w-1.5 h-1.5 rounded-full"
          :class="sseConnected ? 'bg-ok shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-line-strong'"></span>
        <span :class="sseConnected ? 'text-ok' : 'text-faint'">
          {{ sseConnected ? 'SSE 实时推流中' : '推流断开 · 60s 全量兜底' }}
        </span>
      </span>
    </div>

    <!-- 指标卡 -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      <div class="glass-card p-5">
        <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
          <Icon name="alert" :size="13" /> 当前熔断中
        </div>
        <div class="stat-num" :class="openCount ? 'text-danger' : ''">{{ fmtNum(openCount) }}</div>
        <div class="text-[11px] text-faint mt-1">
          <template v-if="halfOpenCount">{{ halfOpenCount }} 个半开观察中</template>
          <template v-else-if="!openCount">全部上游健康</template>
          <template v-else>—</template>
        </div>
      </div>
      <div class="glass-card p-5">
        <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
          <Icon name="power" :size="13" /> 近 {{ days }} 天熔断
        </div>
        <div class="stat-num" :class="totalOpened ? 'text-warn' : ''">{{ fmtNum(totalOpened) }}</div>
        <div class="text-[11px] text-faint mt-1">opened 事件次数</div>
      </div>
      <div class="glass-card p-5">
        <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
          <Icon name="check" :size="13" /> 近 {{ days }} 天恢复
        </div>
        <div class="stat-num">{{ fmtNum(totalRecovered) }}</div>
        <div class="text-[11px] text-faint mt-1">recovered 事件次数</div>
      </div>
      <div class="glass-card p-5">
        <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
          <Icon name="server" :size="13" /> 活跃上游
        </div>
        <div class="stat-num">{{ fmtNum(activeUpstreams) }}</div>
        <div class="text-[11px] text-faint mt-1">enabled=1 · 参与熔断决策</div>
      </div>
    </div>

    <!-- 实时状态网格 -->
    <div class="glass-card p-5 mb-5">
      <div class="flex items-center gap-2 mb-4">
        <Icon name="gauge" :size="14" class="text-muted" />
        <h3 class="text-sm font-semibold text-fg">实时熔断状态</h3>
        <span class="text-[10px] text-faint ml-auto">绿=closed · 黄=half-open · 红=open</span>
      </div>
      <div v-if="!status || !status.upstreams.length" class="py-6">
        <Empty text="暂无启用的上游" icon="server" />
      </div>
      <div v-else class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <div v-for="u in status.upstreams" :key="u.upstream"
          class="glass-inset rounded-xl p-3.5 flex items-center gap-3">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="dotCls(u.state)" />
          <div class="min-w-0 flex-1">
            <div class="text-xs text-fg truncate" :title="u.upstream">{{ upstreamDisplay(u.upstream) }}</div>
            <div class="text-[10px] text-faint mono truncate">{{ u.upstream }}</div>
          </div>
          <div class="text-right shrink-0">
            <span :class="stateChip(u.state)" class="!text-[10px]">{{ u.state }}</span>
            <div v-if="u.fails > 0" class="text-[10px] text-muted tabular-nums mt-1">
              fails {{ u.fails }}
            </div>
            <div v-else-if="u.openedAt" class="text-[10px] text-faint mt-1">{{ fmtAgo(u.openedAt) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 高频熔断 Top -->
    <div class="glass-card overflow-hidden mb-5">
      <div class="px-5 pt-4 pb-3 flex items-center gap-2 border-b border-line">
        <Icon name="chart" :size="15" class="text-muted" />
        <h3 class="text-sm font-semibold text-fg">高频熔断上游 Top</h3>
        <span class="text-[10px] text-faint ml-auto">近 {{ days }} 天</span>
      </div>
      <Spinner v-if="loadingSummary" label="加载中…" />
      <table v-else-if="summary.length" class="w-full">
        <thead>
          <tr>
            <th class="th">上游</th>
            <th class="th w-24 text-right">熔断</th>
            <th class="th w-24 text-right">恢复</th>
            <th class="th w-36 text-right">最近事件</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in summary" :key="r.upstream" class="tr-hover">
            <td class="td">
              <div class="text-fg text-xs mb-1">{{ upstreamDisplay(r.upstream) }}</div>
              <div class="h-1 rounded-full bg-line overflow-hidden">
                <div class="h-full bg-danger rounded-full" :style="{ width: barPct(r.opened, maxOpened) }" />
              </div>
            </td>
            <td class="td text-right tabular-nums" :class="r.opened ? 'text-danger' : 'text-muted'">{{
              fmtNum(r.opened)
              }}</td>
            <td class="td text-right tabular-nums text-ok">{{ fmtNum(r.recovered) }}</td>
            <td class="td text-right text-xs text-muted tabular-nums">{{ fmtTime(r.lastEventTs) }}</td>
          </tr>
        </tbody>
      </table>
      <Empty v-else text="近期未发生熔断事件，运行健康" icon="check" />
    </div>

    <!-- 事件时间线 -->
    <div class="glass-card overflow-hidden">
      <div class="px-5 pt-4 pb-3 flex flex-wrap items-center gap-3 border-b border-line">
        <Icon name="history" :size="15" class="text-muted" />
        <h3 class="text-sm font-semibold text-fg">事件时间线</h3>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <select v-model="f.upstream" class="select !w-auto !py-1.5 !text-xs" @change="onFilter">
            <option value="">全部上游</option>
            <option v-for="u in upstreams" :key="u.id" :value="u.name">{{ u.displayName || u.name }}</option>
          </select>
          <select v-model="f.event" class="select !w-auto !py-1.5 !text-xs" @change="onFilter">
            <option value="">全部事件</option>
            <option value="opened">熔断 open</option>
            <option value="recovered">恢复 closed</option>
          </select>
          <button class="btn-ghost btn-sm" @click="reset">重置</button>
        </div>
      </div>
      <Spinner v-if="loadingEvents" label="加载事件…" />
      <template v-else>
        <div v-if="events.rows.length" class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr>
                <th class="th w-40">时间</th>
                <th class="th w-28">事件</th>
                <th class="th">上游</th>
                <th class="th w-40">迁移</th>
                <th class="th w-24 text-right">滑窗失败</th>
                <th class="th w-24 text-right">保持时长</th>
                <th class="th">触发原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in events.rows" :key="r.id" class="tr-hover">
                <td class="td">
                  <div class="text-fg text-xs tabular-nums">{{ fmtTime(r.ts) }}</div>
                  <div class="text-[10px] text-faint">{{ fmtAgo(r.ts) }}</div>
                </td>
                <td class="td"><span :class="eventChip(r.event)">{{ r.event === 'opened' ? '熔断' : '恢复' }}</span></td>
                <td class="td">
                  <div class="text-fg text-xs">{{ upstreamDisplay(r.upstream) }}</div>
                  <div class="mono text-[10px] text-faint">{{ r.upstream }}</div>
                </td>
                <td class="td mono text-[11px] text-muted">
                  {{ r.fromState }} <span class="text-faint">→</span> {{ r.toState }}
                </td>
                <td class="td text-right tabular-nums text-xs" :class="r.failsInWindow ? 'text-warn' : 'text-muted'">
                  {{ r.failsInWindow }}
                </td>
                <td class="td text-right tabular-nums text-xs text-muted">{{ fmtDuration(r.openMs) }}</td>
                <td class="td mono text-[11px] text-muted truncate" :title="r.reason || ''">{{ r.reason || '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Empty v-else text="暂无熔断事件" icon="check" />
      </template>

      <!-- 分页 -->
      <div v-if="events.total > 20"
        class="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-line">
        <div class="text-xs text-faint tabular-nums">共 {{ events.total }} 条</div>
        <div class="flex items-center gap-1.5">
          <button class="btn-ghost btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <span class="text-xs text-muted tabular-nums px-2">{{ page }} / {{ totalPages }}</span>
          <button class="btn-ghost btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>
