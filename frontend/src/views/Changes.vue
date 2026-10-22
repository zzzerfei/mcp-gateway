<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { api, type ChangeItem } from '../api';
import { fmtTime, prettyJson } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';

const toast = useToast();
const loading = ref(false);
const rows = ref<ChangeItem[]>([]);
const total = ref(0);
const page = ref(1);
const size = ref(20);

// ── 目标类型字典（与后端 ChangeLog.targetType 联合一致）──
const TARGET_TYPES: Array<{ v: string; label: string }> = [
  { v: 'upstream', label: '上游服务' },
  { v: 'role', label: '角色' },
  { v: 'role_rules', label: '权限规则' },
  { v: 'api_key', label: 'API Key' },
  { v: 'tool_override', label: '工具覆写' },
  { v: 'settings', label: '系统设置' },
];
const typeLabel = (v: string): string => TARGET_TYPES.find((t) => t.v === v)?.label ?? v;

const f = reactive({ targetType: '', actor: '', from: '', to: '' });

function toMs(s: string): number | undefined {
  if (!s) return undefined;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? undefined : t;
}
function buildQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = { page: page.value, size: size.value };
  if (f.targetType) q.target_type = f.targetType; // 后端参数名为 snake_case
  if (f.actor.trim()) q.actor = f.actor.trim();
  const from = toMs(f.from);
  const to = toMs(f.to);
  if (from) q.from = from;
  if (to) q.to = to;
  return q;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.audit.changes(buildQuery());
    rows.value = r.rows;
    total.value = r.total;
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
  Object.assign(f, { targetType: '', actor: '', from: '', to: '' });
  page.value = 1;
  load();
}
onMounted(load);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / size.value)));
function goPage(p: number): void {
  const clamped = Math.min(Math.max(1, p), totalPages.value);
  if (clamped === page.value) return;
  page.value = clamped;
  load();
}

// ── 详情（before / after diff）────────────────────────
const detail = ref<ChangeItem | null>(null);
const detailOpen = ref(false);
function openDetail(c: ChangeItem): void {
  detail.value = c;
  detailOpen.value = true;
}

const ACTION_META: Record<string, { cls: string; label: string }> = {
  create: { cls: 'chip-ok', label: '新建' },
  update: { cls: 'chip-on', label: '更新' },
  delete: { cls: 'chip-err', label: '删除' },
  revoke: { cls: 'chip-err', label: '吊销' },
  rotate: { cls: 'chip-warn', label: '轮换' },
  refresh: { cls: 'chip-off', label: '刷新' },
  // F2・一键回滚产生的历史行
  rollback: { cls: 'chip-warn', label: '回滚' },
  // F9・系统自动熔断（stdio crash loop）
  'auto-disable': { cls: 'chip-err', label: '自动下线' },
};
function actionMeta(a: string): { cls: string; label: string } {
  return ACTION_META[a] ?? { cls: 'chip-off', label: a };
}

// ── F2・一键回滚：仅对 targetType=role_rules 且 action=update/rollback 行开放 ──
const rollbackTarget = ref<ChangeItem | null>(null);
const rollbackWorking = ref(false);
function canRollback(c: ChangeItem): boolean {
  return c.targetType === 'role_rules' && (c.action === 'update' || c.action === 'rollback');
}
function askRollback(c: ChangeItem): void {
  rollbackTarget.value = c;
}
async function doRollback(): Promise<void> {
  const t = rollbackTarget.value;
  if (!t || rollbackWorking.value) return;
  rollbackWorking.value = true;
  try {
    await api.permissions.rollback(t.targetId, t.id);
    toast.success(`角色 ${t.targetId} 已回滚至变更 #${t.id} 之前的快照`);
    rollbackTarget.value = null;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  rollbackWorking.value = false;
}
</script>

<template>
  <div>
    <PageHeader title="变更记录" subtitle="所有治理面写操作的留痕：上游增删改、权限规则变更、Key 签发/吊销/轮换、工具描述覆写、系统设置调整。含变更前后快照，可追溯「谁在何时改了什么」。">
      <template #actions>
        <button class="btn-ghost" @click="load">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
      </template>
    </PageHeader>

    <!-- 筛选条 -->
    <div class="glass-card p-4 mb-5 flex flex-wrap items-center gap-3">
      <select v-model="f.targetType" class="select w-40" @change="onSearch">
        <option value="">全部类型</option>
        <option v-for="t in TARGET_TYPES" :key="t.v" :value="t.v">{{ t.label }}</option>
      </select>
      <input v-model="f.actor" class="input w-40" placeholder="操作人" @keyup.enter="onSearch" />
      <div class="flex items-center gap-2 text-xs text-muted">
        <span>从</span>
        <input v-model="f.from" type="datetime-local" class="input-sm !w-auto" />
        <span>至</span>
        <input v-model="f.to" type="datetime-local" class="input-sm !w-auto" />
      </div>
      <div class="ml-auto flex items-center gap-2">
        <button class="btn-ghost" @click="reset">重置</button>
        <button class="btn-primary" @click="onSearch">
          <Icon name="filter" :size="15" /> 查询
        </button>
      </div>
    </div>

    <Spinner v-if="loading" label="加载变更记录…" />
    <div v-else-if="!rows.length" class="glass-card">
      <Empty text="暂无变更记录" icon="history">
        <p class="text-xs text-faint mt-2">在治理面进行的任何写操作都会记录在此</p>
      </Empty>
    </div>

    <template v-else>
      <div class="glass-card overflow-hidden">
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full min-w-[48rem]">
            <thead>
              <tr>
                <th class="th w-44">时间</th>
                <th class="th w-36">操作人</th>
                <th class="th w-40">对象</th>
                <th class="th w-24">动作</th>
                <th class="th">变更摘要</th>
                <th class="th w-24 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in rows" :key="c.id" class="tr-hover">
                <td class="td whitespace-nowrap text-xs text-muted tabular-nums">{{ fmtTime(c.ts) }}</td>
                <td class="td">
                  <div class="text-fg text-[13px]">{{ c.actor }}</div>
                  <div v-if="c.actorIp" class="text-[10px] text-faint mono">{{ c.actorIp }}</div>
                </td>
                <td class="td">
                  <span class="chip-off">{{ typeLabel(c.targetType) }}</span>
                  <div class="text-[10px] text-faint mono mt-1 truncate max-w-[9rem]">#{{ c.targetId }}</div>
                </td>
                <td class="td"><span :class="actionMeta(c.action).cls">{{ actionMeta(c.action).label }}</span></td>
                <td class="td"><span class="text-xs text-muted">{{ c.diffSummary || '—' }}</span></td>
                <td class="td text-right whitespace-nowrap">
                  <button v-if="canRollback(c)" class="btn-ghost btn-sm mr-1" title="回滚到本次变更之前的快照"
                    @click="askRollback(c)">
                    <Icon name="refresh" :size="13" /> 回滚
                  </button>
                  <button class="btn-ghost btn-sm" title="查看前后快照" @click="openDetail(c)">
                    <Icon name="eye" :size="13" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 分页 -->
      <div class="flex items-center justify-between gap-3 mt-4 px-1">
        <span class="text-xs text-faint tabular-nums">共 {{ total }} 条变更</span>
        <div class="flex items-center gap-1.5">
          <button class="btn-ghost btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <span class="text-xs text-muted tabular-nums px-2">{{ page }} / {{ totalPages }}</span>
          <button class="btn-ghost btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
    </template>

    <!-- 详情：前后快照 -->
    <Modal :open="!!detail"
      :title="detail ? `${typeLabel(detail.targetType)} · ${actionMeta(detail.action).label}` : '变更详情'" width="44rem"
      @update:open="detail = null">
      <div v-if="detail" class="space-y-4">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">时间</div>
            <div class="text-fg tabular-nums">{{ fmtTime(detail.ts) }}</div>
          </div>
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">操作人</div>
            <div class="text-fg">{{ detail.actor }}</div>
          </div>
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">对象 ID</div>
            <div class="mono text-muted break-all">#{{ detail.targetId }}</div>
          </div>
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">来源 IP</div>
            <div class="mono text-muted">{{ detail.actorIp || '—' }}</div>
          </div>
        </div>

        <div v-if="detail.diffSummary" class="glass-inset p-3 text-sm text-fg leading-relaxed">
          {{ detail.diffSummary }}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <div class="text-[11px] text-faint mb-1.5 flex items-center gap-1.5"><span
                class="w-1.5 h-1.5 rounded-full bg-danger" />变更前</div>
            <pre class="glass-inset p-3 text-[11px] mono text-muted overflow-x-auto max-h-72 scrollbar-thin">{{
              prettyJson(detail.beforeJson) || '（无 / 新建）' }}</pre>
          </div>
          <div>
            <div class="text-[11px] text-faint mb-1.5 flex items-center gap-1.5"><span
                class="w-1.5 h-1.5 rounded-full bg-ok" />变更后</div>
            <pre class="glass-inset p-3 text-[11px] mono text-fg overflow-x-auto max-h-72 scrollbar-thin">{{
              prettyJson(detail.afterJson) || '（无 / 删除）' }}</pre>
          </div>
        </div>
      </div>
    </Modal>

    <!-- F2・回滚确认弹窗 -->
    <Modal :open="!!rollbackTarget" title="回滚角色规则" width="32rem" @update:open="rollbackTarget = null">
      <div v-if="rollbackTarget" class="space-y-3 text-sm text-fg leading-relaxed">
        <p>
          将把角色 <span class="mono text-fg">{{ rollbackTarget.targetId }}</span> 的规则回滚到
          <span class="mono text-fg">变更 #{{ rollbackTarget.id }}</span> 发生之前的快照。
        </p>
        <div class="glass-inset p-3">
          <div class="text-[11px] text-faint mb-1">参考变更</div>
          <div class="text-xs text-muted">{{ rollbackTarget.diffSummary || '—' }}</div>
          <div class="text-[10px] text-faint mt-1 tabular-nums">{{ fmtTime(rollbackTarget.ts) }} · {{
            rollbackTarget.actor
            }}</div>
        </div>
        <p class="text-xs text-warn">当前规则将被完全替换，在线会话会收到 list_changed，请确认影响面。</p>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="rollbackTarget = null">取消</button>
        <button class="btn-danger" :disabled="rollbackWorking" @click="doRollback">{{ rollbackWorking ? '回滚中…' : '确认回滚'
          }}</button>
      </template>
    </Modal>
  </div>
</template>
