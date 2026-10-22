<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import {
  api,
  type SmokeCaseItem,
  type CaseRunItem,
  type CaseRunAllResult,
  type RoleItem,
} from '../api';
import { prettyJson, fmtAgo, fmtDuration } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';
import CanWrite from '../components/CanWrite.vue';

/**
 * P3・冒烟用例 + 一键回归。
 * 用例来自「工具目录 → 试调用 → 存为用例」，执行时复用完整治理链。
 * 每条用例使用独立限流桶（keyId 负数），回归不会互相挤占额度。
 */

const toast = useToast();
const loading = ref(true);
const rows = ref<SmokeCaseItem[]>([]);
const roles = ref<RoleItem[]>([]);
const runningAll = ref(false);
const running = ref<Record<number, boolean>>({});
const lastRunAll = ref<CaseRunAllResult | null>(null);
const detailRow = ref<CaseRunItem | null>(null);
const detailOpen = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api.cases.list();
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
onMounted(async () => {
  try {
    roles.value = await api.permissions.roles();
  } catch {
    /* ignore */
  }
  await load();
});

const stats = computed(() => {
  const total = rows.value.length;
  const passed = rows.value.filter((r) => r.lastOk === 1).length;
  const failed = rows.value.filter((r) => r.lastOk === 0).length;
  return { total, passed, failed, never: total - passed - failed };
});

const broken = computed(() => rows.value.filter((r) => !r.toolExists).length);

async function runOne(row: SmokeCaseItem): Promise<void> {
  if (running.value[row.id]) return;
  running.value[row.id] = true;
  try {
    const r = await api.cases.run(row.id);
    detailRow.value = r;
    detailOpen.value = true;
    if (r.ok) toast.success(`「${r.name}」通过 · ${r.durationMs}ms`);
    else toast.warn(`「${r.name}」失败：${r.stage}`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  running.value[row.id] = false;
}

async function runAll(): Promise<void> {
  if (runningAll.value) return;
  runningAll.value = true;
  try {
    lastRunAll.value = await api.cases.runAll();
    const r = lastRunAll.value;
    if (r.failed === 0) toast.success(`回归通过：${r.passed}/${r.total} · ${fmtDuration(r.durationMs)}`);
    else toast.warn(`回归完成：通过 ${r.passed}，失败 ${r.failed}`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  runningAll.value = false;
}

async function toggle(row: SmokeCaseItem): Promise<void> {
  try {
    await api.cases.update(row.id, { enabled: !row.enabled });
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function remove(row: SmokeCaseItem): Promise<void> {
  if (!window.confirm(`删除用例「${row.name}」？`)) return;
  try {
    await api.cases.remove(row.id);
    toast.success('已删除');
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 编辑 ──────────────────────────────────────────────
const editOpen = ref(false);
const editTarget = ref<SmokeCaseItem | null>(null);
const editForm = reactive({ name: '', role: 'admin', args: '{}' });
const editSaving = ref(false);

function openEdit(row: SmokeCaseItem): void {
  editTarget.value = row;
  editForm.name = row.name;
  editForm.role = row.role;
  editForm.args = prettyJson(row.argsJson);
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  if (!editTarget.value || editSaving.value) return;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(editForm.args || '{}');
  } catch (e) {
    toast.error(`参数不是合法 JSON：${(e as Error).message}`);
    return;
  }
  editSaving.value = true;
  try {
    await api.cases.update(editTarget.value.id, {
      name: editForm.name.trim() || editTarget.value.name,
      role: editForm.role,
      args,
    });
    toast.success('已保存');
    editOpen.value = false;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  editSaving.value = false;
}

function openDetailFromAll(r: CaseRunItem): void {
  detailRow.value = r;
  detailOpen.value = true;
}
</script>

<template>
  <div>
    <PageHeader title="冒烟用例" subtitle="把验证通过的调用固化为用例。执行时走完整治理链（RBAC → 限流 → 熔断 → 并发 → 转发 → 审计），每条用例独立限流桶，回归不会互相挤占额度。">
      <template #actions>
        <button class="btn-ghost" @click="load">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
        <CanWrite>
          <button class="btn-primary" :disabled="runningAll || !stats.total" @click="runAll">
            <Icon name="play" :size="15" /> {{ runningAll ? '回归中…' : '一键回归' }}
          </button>
        </CanWrite>
      </template>
    </PageHeader>

    <Spinner v-if="loading" label="加载用例…" />

    <template v-else>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="list" :size="13" /> 用例总数
          </div>
          <div class="stat-num">{{ stats.total }}</div>
          <div class="text-[11px] text-faint mt-1">启用中的会参与一键回归</div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="check" :size="13" /> 最近通过
          </div>
          <div class="stat-num text-ok">{{ stats.passed }}</div>
          <div class="text-[11px] text-faint mt-1">按每条用例最近一次结果统计</div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="alert" :size="13" /> 最近失败
          </div>
          <div class="stat-num" :class="stats.failed ? 'text-danger' : ''">{{ stats.failed }}</div>
          <div class="text-[11px] text-faint mt-1">失败会记录卡在治理链哪一步</div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="link" :size="13" /> 工具已下线
          </div>
          <div class="stat-num" :class="broken ? 'text-warn' : ''">{{ broken }}</div>
          <div class="text-[11px] text-faint mt-1">上游变更后需及时清理或更新</div>
        </div>
      </div>

      <!-- 一键回归结果 -->
      <div v-if="lastRunAll" class="glass-card mb-5 overflow-hidden">
        <div class="px-5 pt-4 pb-3 flex flex-wrap items-center gap-3 border-b border-line">
          <Icon name="chart" :size="15" class="text-muted" />
          <h3 class="text-sm font-semibold text-fg">最近一次回归</h3>
          <span class="chip-ok">通过 {{ lastRunAll.passed }}</span>
          <span :class="lastRunAll.failed ? 'chip-err' : 'chip-off'">失败 {{ lastRunAll.failed }}</span>
          <span class="text-xs text-faint tabular-nums ml-auto">总耗时 {{ fmtDuration(lastRunAll.durationMs) }}</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr>
                <th class="th w-16">状态</th>
                <th class="th">用例</th>
                <th class="th w-28">角色</th>
                <th class="th">结论</th>
                <th class="th w-20 text-right">耗时</th>
                <th class="th w-16 text-right">详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in lastRunAll.items" :key="r.id" class="tr-hover">
                <td class="td">
                  <span v-if="r.ok" class="chip-ok">通过</span>
                  <span v-else class="chip-err">失败</span>
                </td>
                <td class="td">
                  <div class="text-fg text-xs">{{ r.name }}</div>
                  <div class="mono text-[10px] text-faint">{{ r.toolFullName }}</div>
                </td>
                <td class="td mono text-xs text-muted">{{ r.role }}</td>
                <td class="td text-xs" :class="r.ok ? 'text-muted' : 'text-danger'">{{ r.stage }}</td>
                <td class="td text-right tabular-nums text-xs text-muted">{{ r.durationMs }}ms</td>
                <td class="td text-right">
                  <button class="btn-ghost btn-sm" title="查看调用结果" @click="openDetailFromAll(r)">
                    <Icon name="eye" :size="13" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 用例列表 -->
      <div class="glass-card overflow-hidden">
        <div class="px-5 pt-4 pb-3 flex items-center gap-3 border-b border-line">
          <Icon name="list" :size="15" class="text-muted" />
          <h3 class="text-sm font-semibold text-fg">全部用例</h3>
          <span class="text-xs text-faint ml-auto tabular-nums">{{ rows.length }} 条</span>
        </div>
        <div v-if="rows.length" class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr>
                <th class="th">用例</th>
                <th class="th">工具 / 角色</th>
                <th class="th hidden lg:table-cell">参数</th>
                <th class="th w-36">最近运行</th>
                <th class="th w-20">状态</th>
                <th class="th w-44 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.id" class="tr-hover">
                <td class="td">
                  <div class="text-fg text-[13px]">{{ r.name }}</div>
                  <div class="text-[10px] text-faint">{{ r.createdBy }} · {{ fmtAgo(r.createdAt) }} 创建</div>
                </td>
                <td class="td">
                  <div class="mono text-xs text-fg">{{ r.toolFullName }}</div>
                  <div class="flex items-center gap-1.5 mt-1">
                    <span class="mono text-[10px] text-faint">{{ r.role }}</span>
                    <span v-if="!r.toolExists" class="chip-warn !px-1.5 !py-0 !text-[10px]">工具已下线</span>
                  </div>
                </td>
                <td class="td hidden lg:table-cell">
                  <span class="mono text-[10px] text-faint line-clamp-2 max-w-xs break-all">{{
                    r.argsJson }}</span>
                </td>
                <td class="td">
                  <div v-if="r.lastRunAt" class="text-xs text-muted tabular-nums">{{ fmtAgo(r.lastRunAt) }}</div>
                  <div v-else class="text-xs text-faint">未运行</div>
                  <div v-if="r.lastRunAt" class="text-[10px] text-faint tabular-nums">{{ r.lastDurationMs }}ms</div>
                </td>
                <td class="td">
                  <span v-if="r.lastOk === 1" class="chip-ok">通过</span>
                  <span v-else-if="r.lastOk === 0" class="chip-err" :title="r.lastError ?? ''">失败</span>
                  <span v-else class="chip-off">未运行</span>
                </td>
                <td class="td">
                  <div class="flex items-center justify-end gap-1.5">
                    <CanWrite>
                      <button class="btn-ghost btn-sm" title="运行" :disabled="running[r.id]" @click="runOne(r)">
                        <Icon name="play" :size="13" />
                      </button>
                      <button class="btn-ghost btn-sm" title="编辑" @click="openEdit(r)">
                        <Icon name="edit" :size="13" />
                      </button>
                      <button class="btn-ghost btn-sm" :title="r.enabled ? '停用' : '启用'" @click="toggle(r)">
                        <Icon name="power" :size="13" />
                      </button>
                      <button class="btn-ghost btn-sm !text-danger" title="删除" @click="remove(r)">
                        <Icon name="trash" :size="13" />
                      </button>
                    </CanWrite>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Empty v-else text="还没有用例。去「工具目录 → 试调用」调用成功后，点「存为用例」即可。" icon="list" />
      </div>
    </template>

    <!-- 编辑用例 -->
    <Modal v-model:open="editOpen" :title="`编辑用例 · ${editTarget?.name ?? ''}`" width="38rem">
      <div v-if="editTarget" class="space-y-4">
        <div>
          <label class="label">用例名称</label>
          <input v-model="editForm.name" class="input" />
        </div>
        <div>
          <label class="label">执行角色</label>
          <select v-model="editForm.role" class="select">
            <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
          </select>
        </div>
        <div>
          <label class="label">调用参数（JSON）</label>
          <textarea v-model="editForm.args" class="input mono h-40 resize-none" spellcheck="false" />
        </div>
        <div class="text-[11px] text-faint mono">工具：{{ editTarget.toolFullName }}（不可修改）</div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="editOpen = false">取消</button>
        <button class="btn-primary" :disabled="editSaving" @click="saveEdit">{{ editSaving ? '保存中…' : '保存' }}</button>
      </template>
    </Modal>

    <!-- 单次运行详情 -->
    <Modal v-model:open="detailOpen" :title="`运行结果 · ${detailRow?.name ?? ''}`" width="44rem">
      <div v-if="detailRow" class="space-y-3">
        <div class="glass-inset px-3 py-3">
          <div class="flex items-center">
            <template v-for="(s, i) in detailRow.stages" :key="s.no">
              <div class="flex flex-col items-center gap-1 shrink-0">
                <div class="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" :class="s.status === 'passed'
                  ? 'bg-ok-soft text-ok ring-1 ring-ok-line'
                  : s.status === 'failed'
                    ? 'bg-danger-soft text-danger ring-1 ring-danger-line'
                    : 'bg-inset text-faint ring-1 ring-line'">
                  <span v-if="s.status === 'passed'">✓</span>
                  <span v-else-if="s.status === 'failed'">✕</span>
                  <span v-else>{{ s.no }}</span>
                </div>
                <span class="text-[10px] whitespace-nowrap"
                  :class="s.status === 'passed' ? 'text-muted' : s.status === 'failed' ? 'text-danger' : 'text-faint'">{{
                    s.name }}</span>
              </div>
              <div v-if="i < detailRow.stages.length - 1" class="flex-1 h-px mx-1.5 mb-4"
                :class="s.status === 'passed' ? 'bg-ok' : 'bg-line'" />
            </template>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3 text-xs">
          <span :class="detailRow.ok ? 'chip-ok' : 'chip-warn'">{{ detailRow.ok ? '调用成功' : '调用失败' }}</span>
          <span class="text-muted">{{ detailRow.stage }}</span>
          <span class="text-faint tabular-nums">{{ detailRow.durationMs }}ms</span>
          <span v-if="detailRow.errorCode" class="mono text-muted">{{ detailRow.errorCode }}</span>
        </div>
        <div v-if="detailRow.requestId" class="text-[11px] text-faint mono">
          requestId: {{ detailRow.requestId }} · 可在「审计日志」中回查
        </div>
        <pre class="glass-inset p-3 text-[11px] mono text-muted overflow-auto max-h-72 scrollbar-thin">{{
          prettyJson(JSON.stringify(detailRow.result ?? null)) }}</pre>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="detailOpen = false">关闭</button>
      </template>
    </Modal>
  </div>
</template>
