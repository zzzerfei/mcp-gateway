<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { api, type AuditItem, type AuditDetail, type Upstream, type Paged } from '../api';
import { fmtTime, fmtDuration, fmtBytes, prettyJson } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';

const toast = useToast();
const loading = ref(false);
const data = ref<Paged<AuditItem>>({ total: 0, page: 1, size: 20, rows: [] });
const upstreams = ref<Upstream[]>([]);

// ── 筛选 ──────────────────────────────────────────────
const f = reactive({
  keyword: '',
  user: '',
  tool: '',
  upstream: '',
  sensitive: false,
  ok: 'all' as 'all' | '1' | '0',
  from: '',
  to: '',
  size: 20,
});
const page = ref(1);

/** datetime-local 字符串 → epoch ms（空串返回 undefined） */
function toMs(s: string): number | undefined {
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? undefined : t;
}
function buildQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = { page: page.value, size: f.size };
  if (f.keyword.trim()) q.keyword = f.keyword.trim();
  if (f.user.trim()) q.user = f.user.trim();
  if (f.tool.trim()) q.tool = f.tool.trim();
  if (f.upstream) q.upstream = f.upstream;
  if (f.sensitive) q.sensitive = '1';
  if (f.ok !== 'all') q.ok = f.ok;
  const from = toMs(f.from);
  const to = toMs(f.to);
  if (from) q.from = from;
  if (to) q.to = to;
  return q;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.audit.query(buildQuery());
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
function onSearch(): void {
  page.value = 1;
  load();
}
function reset(): void {
  Object.assign(f, { keyword: '', user: '', tool: '', upstream: '', sensitive: false, ok: 'all', from: '', to: '', size: 20 });
  page.value = 1;
  load();
}
onMounted(async () => {
  try {
    upstreams.value = await api.upstreams.list();
  } catch {
    /* ignore */
  }
  await load();
});

// ── 分页 ──────────────────────────────────────────────
const totalPages = computed(() => Math.max(1, Math.ceil(data.value.total / f.size)));
function goPage(p: number): void {
  const clamped = Math.min(Math.max(1, p), totalPages.value);
  if (clamped === page.value) return;
  page.value = clamped;
  load();
}
function onSizeChange(): void {
  page.value = 1;
  load();
}

// ── 导出 ──────────────────────────────────────────────
const exporting = ref(false);
async function doExport(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await api.audit.export(buildQuery());
    toast.success('CSV 已开始下载（上限 10 万行）');
  } catch (e) {
    toast.error((e as Error).message);
  }
  exporting.value = false;
}

// ── 详情 ──────────────────────────────────────────────
const detail = ref<AuditDetail | null>(null);
const detailOpen = ref(false);
const detailLoading = ref(false);
async function openDetail(row: AuditItem): Promise<void> {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await api.audit.detail(row.id);
  } catch (e) {
    toast.error((e as Error).message);
    detailOpen.value = false;
  }
  detailLoading.value = false;
}

function eventChip(ev: string): string {
  if (ev === 'tool_call') return 'chip-on';
  if (ev === 'auth_fail' || ev === 'denied' || ev === 'error') return 'chip-err';
  return 'chip-off';
}
</script>

<template>
  <div>
    <PageHeader
      title="审计日志"
      subtitle="每次工具调用的完整留痕：谁、何时、调了什么、参数摘要、耗时、结果、是否触敏脱敏。异步攒批写入，敏感上游全量记录。"
    >
      <template #actions>
        <button class="btn-ghost" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
        <button class="btn-primary" :disabled="exporting" @click="doExport">
          <Icon name="download" :size="15" /> {{ exporting ? '导出中…' : '导出 CSV' }}
        </button>
      </template>
    </PageHeader>

    <!-- 筛选条 -->
    <div class="glass-card p-4 mb-5 space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <div class="relative min-w-[13rem] flex-1">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-faint"><Icon name="search" :size="15" /></span>
          <input v-model="f.keyword" class="input pl-9" placeholder="关键词：工具名 / 使用者 / 参数摘要…" @keyup.enter="onSearch" />
        </div>
        <input v-model="f.user" class="input w-36" placeholder="使用者" @keyup.enter="onSearch" />
        <input v-model="f.tool" class="input w-40 mono" placeholder="工具（模糊）" @keyup.enter="onSearch" />
        <select v-model="f.upstream" class="select w-40">
          <option value="">全部上游</option>
          <option v-for="u in upstreams" :key="u.id" :value="u.name">{{ u.displayName || u.name }}</option>
        </select>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <select v-model="f.ok" class="select w-32">
          <option value="all">全部结果</option>
          <option value="1">仅成功</option>
          <option value="0">仅失败</option>
        </select>
        <label class="flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
          <input v-model="f.sensitive" type="checkbox" class="w-4 h-4 accent-white rounded" />
          仅看触敏
        </label>
        <div class="flex items-center gap-2 text-xs text-muted">
          <span>从</span>
          <input v-model="f.from" type="datetime-local" class="input-sm !w-auto" />
          <span>至</span>
          <input v-model="f.to" type="datetime-local" class="input-sm !w-auto" />
        </div>
        <div class="ml-auto flex items-center gap-2">
          <button class="btn-ghost" @click="reset">重置</button>
          <button class="btn-primary" @click="onSearch"><Icon name="filter" :size="15" /> 查询</button>
        </div>
      </div>
    </div>

    <Spinner v-if="loading" label="查询审计日志…" />
    <div v-else-if="!data.rows.length" class="glass-card">
      <Empty text="没有匹配的审计记录" icon="list">
        <p class="text-xs text-faint mt-2">调整筛选条件，或确认网关已有工具调用流量</p>
      </Empty>
    </div>

    <template v-else>
      <div class="glass-card overflow-hidden">
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full min-w-[56rem]">
            <thead>
              <tr>
                <th class="th">时间</th>
                <th class="th">事件</th>
                <th class="th">使用者</th>
                <th class="th">工具</th>
                <th class="th hidden lg:table-cell">上游</th>
                <th class="th hidden md:table-cell">耗时</th>
                <th class="th">结果</th>
                <th class="th hidden xl:table-cell">来源 IP</th>
                <th class="th w-14 text-right">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rows" :key="r.id" class="tr-hover">
                <td class="td whitespace-nowrap">
                  <div class="text-fg text-xs tabular-nums">{{ fmtTime(r.ts) }}</div>
                </td>
                <td class="td"><span :class="eventChip(r.event)" class="mono !text-[10px]">{{ r.event }}</span></td>
                <td class="td">
                  <div class="text-fg text-[13px]">{{ r.userName || '—' }}</div>
                  <div v-if="r.role" class="text-[10px] text-faint mono">{{ r.role }}</div>
                </td>
                <td class="td">
                  <div class="mono text-fg text-xs flex items-center gap-1.5">
                    {{ r.tool || '—' }}
                    <span v-if="r.sensitive" class="chip-warn !px-1 !py-0 !text-[9px]" title="触发敏感">敏</span>
                    <span v-if="r.redacted" class="chip-off !px-1 !py-0 !text-[9px]" title="已脱敏">脱</span>
                  </div>
                </td>
                <td class="td hidden lg:table-cell"><span class="text-xs text-muted mono">{{ r.upstream || '—' }}</span></td>
                <td class="td hidden md:table-cell"><span class="text-xs text-muted tabular-nums">{{ fmtDuration(r.durationMs) }}</span></td>
                <td class="td">
                  <span v-if="r.resultOk" class="chip-ok">成功</span>
                  <span v-else class="chip-err mono !text-[10px]">{{ r.errorCode || '失败' }}</span>
                </td>
                <td class="td hidden xl:table-cell"><span class="text-xs text-faint mono">{{ r.callerIp || '—' }}</span></td>
                <td class="td text-right">
                  <button class="btn-ghost btn-sm" title="查看详情" @click="openDetail(r)"><Icon name="eye" :size="13" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 分页 -->
      <div class="flex flex-wrap items-center justify-between gap-3 mt-4 px-1">
        <div class="flex items-center gap-2 text-xs text-faint">
          <span class="tabular-nums">共 {{ data.total }} 条</span>
          <span>·</span>
          <span>每页</span>
          <select v-model.number="f.size" class="select !w-auto !py-1 !text-xs" @change="onSizeChange">
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>
        <div class="flex items-center gap-1.5">
          <button class="btn-ghost btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <span class="text-xs text-muted tabular-nums px-2">{{ page }} / {{ totalPages }}</span>
          <button class="btn-ghost btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
    </template>

    <!-- 详情弹窗 -->
    <Modal v-model:open="detailOpen" title="审计详情" width="42rem">
      <Spinner v-if="detailLoading" label="加载详情…" />
      <div v-else-if="detail" class="space-y-4">
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">时间</div><div class="text-fg tabular-nums text-xs">{{ fmtTime(detail.ts) }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">事件</div><div class="mono text-fg text-xs">{{ detail.event }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">Request ID</div><div class="mono text-muted text-[11px] break-all">{{ detail.requestId }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">使用者</div><div class="text-fg text-xs">{{ detail.userName || '—' }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">团队</div><div class="text-fg text-xs">{{ detail.team || '—' }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">角色</div><div class="mono text-fg text-xs">{{ detail.role || '—' }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">工具</div><div class="mono text-fg text-xs break-all">{{ detail.tool || '—' }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">上游</div><div class="mono text-fg text-xs">{{ detail.upstream || '—' }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">通道</div><div class="mono text-fg text-xs">{{ detail.channel || '—' }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">总耗时</div><div class="text-fg text-xs tabular-nums">{{ fmtDuration(detail.durationMs) }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">排队耗时</div><div class="text-fg text-xs tabular-nums">{{ fmtDuration(detail.queueMs) }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">结果字节</div><div class="text-fg text-xs tabular-nums">{{ fmtBytes(detail.resultBytes) }}</div></div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span v-if="detail.resultOk" class="chip-ok">调用成功</span>
          <span v-else class="chip-err mono">{{ detail.errorCode || '失败' }}</span>
          <span v-if="detail.sensitive" class="chip-warn">触发敏感</span>
          <span v-if="detail.redacted" class="chip-on">已脱敏</span>
          <span class="text-[11px] text-faint mono ml-auto">IP {{ detail.callerIp || '—' }}</span>
        </div>

        <div v-if="detail.errorMsg">
          <div class="text-[11px] text-faint mb-1.5">错误信息</div>
          <div class="glass-inset p-3 text-xs text-danger break-all leading-relaxed">{{ detail.errorMsg }}</div>
        </div>

        <div>
          <div class="text-[11px] text-faint mb-1.5">参数（全量，敏感字段已脱敏）</div>
          <pre class="glass-inset p-3 text-[11px] mono text-muted overflow-x-auto max-h-64 scrollbar-thin">{{ prettyJson(detail.argsFull) || detail.argsDigest || '（无参数）' }}</pre>
        </div>

        <div v-if="detail.sessionId || detail.clientInfo" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div v-if="detail.sessionId" class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">Session ID</div><div class="mono text-muted text-[11px] break-all">{{ detail.sessionId }}</div></div>
          <div v-if="detail.clientInfo" class="glass-inset p-3"><div class="text-[11px] text-faint mb-1">Client Info</div><div class="mono text-muted text-[11px] break-all">{{ detail.clientInfo }}</div></div>
        </div>
      </div>
    </Modal>
  </div>
</template>
