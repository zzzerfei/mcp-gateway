<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type RoleItem, type RuleItem, type PreviewResult, type Matrix } from '../api';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Spinner from '../components/Spinner.vue';
import Empty from '../components/Empty.vue';
import CanWrite from '../components/CanWrite.vue';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();

const toast = useToast();
const tab = ref<'rules' | 'matrix'>('rules');
const loading = ref(true);
const roles = ref<RoleItem[]>([]);
const selected = ref<string>('');
const rules = ref<RuleItem[]>([]);
const rulesLoading = ref(false);
const dirty = ref(false);

async function loadRoles(): Promise<void> {
  loading.value = true;
  try {
    roles.value = await api.permissions.roles();
    if (!selected.value && roles.value.length) selected.value = roles.value[0].name;
    if (selected.value) await loadRules(selected.value);
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
async function loadRules(role: string): Promise<void> {
  rulesLoading.value = true;
  dirty.value = false;
  try {
    const r = await api.permissions.getRules(role);
    rules.value = r.rules.map((x) => ({ ...x }));
  } catch (e) {
    toast.error((e as Error).message);
  }
  rulesLoading.value = false;
}
function selectRole(name: string): void {
  if (selected.value === name) return;
  selected.value = name;
  loadRules(name);
}
onMounted(loadRoles);

// ── 规则增删 ──────────────────────────────────────────
function addRule(effect: 'allow' | 'deny'): void {
  rules.value.push({ effect, pattern: '', memo: '' });
  dirty.value = true;
}
function removeRule(i: number): void {
  rules.value.splice(i, 1);
  dirty.value = true;
}
function markDirty(): void {
  dirty.value = true;
}
/** 展示顺序：deny 组在前，allow 组在后（与后端 normalizeSort 语义一致） */
const orderedRules = computed(() => {
  const denies = rules.value.map((r, i) => ({ r, i })).filter((x) => x.r.effect === 'deny');
  const allows = rules.value.map((r, i) => ({ r, i })).filter((x) => x.r.effect === 'allow');
  return [...denies, ...allows];
});

// ── 新建角色 ──────────────────────────────────────────
const roleModal = ref(false);
const newRole = ref({ name: '', description: '' });
async function createRole(): Promise<void> {
  try {
    await api.permissions.createRole(newRole.value.name.trim(), newRole.value.description.trim());
    toast.success(`角色 ${newRole.value.name} 已创建`);
    roleModal.value = false;
    newRole.value = { name: '', description: '' };
    selected.value = '';
    await loadRoles();
  } catch (e) {
    toast.error((e as Error).message);
  }
}
const delRole = ref<RoleItem | null>(null);
async function doDeleteRole(): Promise<void> {
  if (!delRole.value) return;
  try {
    await api.permissions.deleteRole(delRole.value.name);
    toast.success(`角色 ${delRole.value.name} 已删除`);
    if (selected.value === delRole.value.name) selected.value = '';
    delRole.value = null;
    await loadRoles();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 保存（先预览后确认）──────────────────────────────
const preview = ref<PreviewResult | null>(null);
const previewOpen = ref(false);
const saving = ref(false);
async function onSave(): Promise<void> {
  const cleaned = rules.value.filter((r) => r.pattern.trim());
  if (cleaned.some((r) => !r.pattern.trim())) {
    toast.warn('存在空 pattern，已忽略');
  }
  try {
    // dryRun 预览
    const res = await api.permissions.saveRules(selected.value, cleaned, true);
    preview.value = res.preview;
    previewOpen.value = true;
  } catch (e) {
    toast.error((e as Error).message);
  }
}
async function confirmSave(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const cleaned = rules.value.filter((r) => r.pattern.trim());
    await api.permissions.saveRules(selected.value, cleaned, false);
    toast.success('规则已保存，在线会话收到 list_changed');
    previewOpen.value = false;
    dirty.value = false;
    await loadRoles();
  } catch (e) {
    toast.error((e as Error).message);
  }
  saving.value = false;
}

// ── 权限矩阵 ──────────────────────────────────────────
const matrix = ref<Matrix | null>(null);
const matrixLoading = ref(false);
const matrixUpstream = ref('');
const upstreamNames = computed(() => {
  if (!matrix.value) return [];
  return [...new Set(matrix.value.columns.map((c) => c.upstream))];
});
async function loadMatrix(): Promise<void> {
  matrixLoading.value = true;
  try {
    matrix.value = await api.permissions.matrix(matrixUpstream.value || undefined);
  } catch (e) {
    toast.error((e as Error).message);
  }
  matrixLoading.value = false;
}
function switchTab(t: 'rules' | 'matrix'): void {
  tab.value = t;
  if (t === 'matrix' && !matrix.value) loadMatrix();
}

// ── F1・权限模式开关（enforce / observe）──────────────
type RbacMode = 'enforce' | 'observe';
const rbacMode = ref<RbacMode>('enforce');
const modeSwitching = ref(false);
async function loadRbacMode(): Promise<void> {
  try {
    const s = await api.system.getSettings();
    const v = (s['rbac.mode'] as RbacMode) || 'enforce';
    rbacMode.value = v === 'observe' ? 'observe' : 'enforce';
  } catch {
    /* 设置读取失败不阻断主流程，保留默认 enforce */
  }
}
async function switchMode(next: RbacMode): Promise<void> {
  if (next === rbacMode.value || modeSwitching.value) return;
  const prev = rbacMode.value;
  rbacMode.value = next; // 乐观更新，失败时回退
  modeSwitching.value = true;
  try {
    await api.system.updateSettings({ 'rbac.mode': next });
    toast.success(next === 'observe' ? '已切至影子模式：越权调用会放行并记录，不会拦截' : '已切至强制模式：越权调用直接拦截');
  } catch (e) {
    rbacMode.value = prev;
    toast.error((e as Error).message);
  }
  modeSwitching.value = false;
}
onMounted(() => {
  // 只读角色没有网关设置读权限（gateway:sensitive），跳过避免无谓 403
  if (auth.canWrite) void loadRbacMode();
});

/** F3·lost/gained chip 上实时显示工具的近 7d 命中次数，O(1) 取 */
function impact7d(tool: string): number {
  return preview.value?.recent7dCalls?.[tool] ?? 0;
}
</script>

<template>
  <div>
    <PageHeader title="权限矩阵"
      subtitle="RBAC 通配符规则：按 sort 升序首条命中即决定，无命中=默认拒绝。deny 组自动排在 allow 组前。核心契约「可见即可调」——矩阵与 tools/list 同源">
      <template #actions>
        <!-- F1・模式开关（enforce 直接拦 · observe 只记不拦）；只读角色不展示 -->
        <CanWrite>
          <div class="seg-group" role="radiogroup" aria-label="RBAC 模式">
            <button role="radio" :aria-checked="rbacMode === 'enforce'"
              :class="rbacMode === 'enforce' ? 'seg-item-active' : 'seg-item'" :disabled="modeSwitching"
              title="强制模式：越权调用直接返回 FORBIDDEN" @click="switchMode('enforce')">
              <Icon name="shield" :size="14" /> 强制
            </button>
            <button role="radio" :aria-checked="rbacMode === 'observe'"
              :class="rbacMode === 'observe' ? 'seg-item-active' : 'seg-item'" :disabled="modeSwitching"
              title="影子模式：越权调用会放行，同时在审计里记 rbac_would_forbid（供上线前验证）" @click="switchMode('observe')">
              <Icon name="eye" :size="14" /> 影子
            </button>
          </div>
        </CanWrite>
        <div class="seg-group" role="tablist" aria-label="权限页视图切换">
          <button role="tab" :aria-selected="tab === 'rules'" :class="tab === 'rules' ? 'seg-item-active' : 'seg-item'"
            @click="switchTab('rules')">
            <Icon name="edit" :size="14" /> 规则编辑
          </button>
          <button role="tab" :aria-selected="tab === 'matrix'"
            :class="tab === 'matrix' ? 'seg-item-active' : 'seg-item'" @click="switchTab('matrix')">
            <Icon name="grid" :size="14" /> 权限矩阵
          </button>
        </div>
      </template>
    </PageHeader>

    <!-- ── 规则编辑 ── -->
    <div v-if="tab === 'rules'" class="grid grid-cols-1 lg:grid-cols-[16rem_1fr] gap-5">
      <!-- 角色列表 -->
      <div class="glass-card p-3 h-fit">
        <div class="flex items-center justify-between px-2 py-1.5 mb-1">
          <span class="text-[11px] font-semibold text-faint uppercase tracking-wider">角色</span>
          <CanWrite>
            <button class="text-muted hover:text-fg transition-colors cursor-pointer" title="新建角色"
              @click="roleModal = true">
              <Icon name="plus" :size="15" />
            </button>
          </CanWrite>
        </div>
        <Spinner v-if="loading" />
        <div v-else class="space-y-1">
          <div v-for="r in roles" :key="r.name" :class="selected === r.name ? 'nav-item-active' : 'nav-item'"
            @click="selectRole(r.name)">
            <span class="shrink-0">
              <Icon name="shield" :size="16" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px]">{{ r.name }}</div>
              <div class="text-[10px] text-faint truncate">{{ r.ruleCount }} 规则 · {{ r.activeKeyCount }} Key</div>
            </div>
            <span v-if="r.isBuiltin" class="text-[9px] text-faint shrink-0">内置</span>
            <CanWrite v-else>
              <button class="text-faint hover:text-danger transition-colors shrink-0 cursor-pointer" title="删除角色"
                @click.stop="delRole = r">
                <Icon name="trash" :size="14" />
              </button>
            </CanWrite>
          </div>
        </div>
      </div>

      <!-- 规则编辑区 -->
      <div class="glass-card p-5">
        <div v-if="!selected" class="py-16">
          <Empty text="请选择或新建一个角色" icon="shield" />
        </div>
        <template v-else>
          <div class="flex items-center justify-between mb-4">
            <div>
              <h3 class="text-base font-semibold text-fg mono">{{ selected }}</h3>
              <p class="text-[11px] text-faint mt-0.5">{{roles.find((r) => r.name === selected)?.description ||
                '无描述'}}</p>
            </div>
            <CanWrite>
              <div class="flex items-center gap-2">
                <button class="btn-ghost btn-sm" @click="addRule('deny')">
                  <Icon name="close" :size="13" /> 加 deny
                </button>
                <button class="btn-ghost btn-sm" @click="addRule('allow')">
                  <Icon name="check" :size="13" /> 加 allow
                </button>
              </div>
            </CanWrite>
          </div>

          <Spinner v-if="rulesLoading" label="加载规则…" />
          <template v-else>
            <div v-if="!rules.length" class="glass-inset p-6 text-center text-sm text-faint mb-4">
              暂无规则 —— 默认拒绝一切工具。添加 allow 规则以放开权限。
            </div>
            <div class="space-y-2 mb-5">
              <div v-for="item in orderedRules" :key="item.i" class="glass-inset p-3 flex items-center gap-3">
                <span :class="item.r.effect === 'deny' ? 'chip-err' : 'chip-ok'"
                  class="shrink-0 w-16 justify-center uppercase">{{ item.r.effect }}</span>
                <input v-model="item.r.pattern" class="input-sm mono flex-1" placeholder="wiki__*  |  *__delete_*  |  *"
                  :disabled="!auth.canWrite" @input="markDirty" />
                <input v-model="item.r.memo" class="input-sm flex-1 hidden md:block" placeholder="为什么加这条（半年后救命）"
                  :disabled="!auth.canWrite" @input="markDirty" />
                <select v-model="item.r.effect" class="select !w-24 !py-1.5 !text-xs" :disabled="!auth.canWrite"
                  @change="markDirty">
                  <option value="deny">deny</option>
                  <option value="allow">allow</option>
                </select>
                <CanWrite>
                  <button class="btn-ghost btn-sm shrink-0" @click="removeRule(item.i)">
                    <Icon name="trash" :size="13" />
                  </button>
                </CanWrite>
              </div>
            </div>
            <div class="flex items-center justify-between pt-4 border-t border-line">
              <span class="text-[11px] text-faint">
                <span v-if="dirty" class="text-warn">● 有未保存变更</span>
                <span v-else>已同步</span>
                · 匹配顺序：deny 组优先
              </span>
              <CanWrite>
                <div class="flex gap-2">
                  <button class="btn-ghost" :disabled="!dirty" @click="loadRules(selected)">放弃</button>
                  <button class="btn-primary" :disabled="!dirty" @click="onSave">
                    <Icon name="check" :size="15" /> 保存并预览
                  </button>
                </div>
              </CanWrite>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- ── 权限矩阵 ── -->
    <div v-else>
      <div class="glass-card p-4 mb-4 flex items-center gap-3">
        <select v-model="matrixUpstream" class="select w-52" @change="loadMatrix">
          <option value="">全部上游</option>
          <option v-for="u in upstreamNames" :key="u" :value="u">{{ u }}</option>
        </select>
        <button class="btn-ghost" @click="loadMatrix">
          <Icon name="refresh" :size="15" /> 刷新矩阵
        </button>
        <span class="text-[11px] text-faint ml-auto">实时计算，非存储 · 注册表 v{{ matrix?.registryVersion ?? '—' }}</span>
      </div>

      <Spinner v-if="matrixLoading" label="计算权限矩阵…" />
      <div v-else-if="!matrix || !matrix.columns.length" class="glass-card">
        <Empty text="暂无工具可展示，请先连通上游" icon="grid" />
      </div>
      <div v-else class="glass-card overflow-auto scrollbar-thin" style="max-height: 68vh">
        <table class="w-full border-collapse">
          <thead class="sticky top-0 z-2">
            <tr>
              <th class="th sticky left-0 z-3 bg-ink-800/95 backdrop-blur min-w-[16rem]">工具 \ 角色</th>
              <th v-for="row in matrix.rows" :key="row.role"
                class="th text-center whitespace-nowrap bg-ink-800/95 backdrop-blur">
                <div class="mono">{{ row.role }}</div>
                <div class="text-[9px] text-faint font-normal normal-case">{{ row.allowedCount }} 可见</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="col in matrix.columns" :key="col.fullName" class="tr-hover">
              <td class="td sticky left-0 z-1 bg-ink-900/90 backdrop-blur">
                <div class="flex items-center gap-2">
                  <span class="mono text-[12px] text-fg truncate">{{ col.fullName }}</span>
                  <span v-if="col.sensitivity === 'high'" class="chip-warn !px-1 !py-0 !text-[9px]">敏</span>
                  <span v-if="!col.enabled" class="chip-off !px-1 !py-0 !text-[9px]">下线</span>
                </div>
              </td>
              <td v-for="row in matrix.rows" :key="row.role" class="td text-center">
                <span v-if="row.cells[col.fullName]" class="inline-flex text-ok">
                  <Icon name="check" :size="16" />
                </span>
                <span v-else class="inline-flex text-faint">
                  <Icon name="close" :size="15" />
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建角色 -->
    <Modal v-model:open="roleModal" title="新建角色" width="26rem">
      <div class="space-y-4">
        <div>
          <label class="label">角色名</label>
          <input v-model="newRole.name" class="input mono" placeholder="auditor（小写字母/数字/下划线）" />
        </div>
        <div>
          <label class="label">描述</label>
          <input v-model="newRole.description" class="input" placeholder="只读审计员" />
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="roleModal = false">取消</button>
        <button class="btn-primary" :disabled="!newRole.name.trim()" @click="createRole">创建</button>
      </template>
    </Modal>

    <!-- 删除角色 -->
    <Modal :open="!!delRole" title="删除角色" width="26rem" @update:open="delRole = null">
      <p v-if="delRole" class="text-sm text-fg leading-relaxed">
        确认删除角色 <span class="text-fg mono">{{ delRole.name }}</span>？其全部规则将一并移除。内置角色或仍有有效 Key 的角色不可删除。
      </p>
      <template #footer>
        <button class="btn-ghost" @click="delRole = null">取消</button>
        <button class="btn-danger" @click="doDeleteRole">确认删除</button>
      </template>
    </Modal>

    <!-- 变更预览 -->
    <Modal v-model:open="previewOpen" title="权限变更预览" width="38rem" subtitle="保存前请确认影响面。可见集变化会立即影响在线会话的工具列表。">
      <div v-if="preview" class="space-y-4">
        <div class="grid grid-cols-3 gap-3 text-center">
          <div class="glass-inset p-3">
            <div class="stat-num text-xl">{{ preview.currentCount }}</div>
            <div class="text-[11px] text-faint mt-1">变更前可见</div>
          </div>
          <div class="glass-inset p-3">
            <div class="stat-num text-xl">{{ preview.nextCount }}</div>
            <div class="text-[11px] text-faint mt-1">变更后可见</div>
          </div>
          <div class="glass-inset p-3">
            <div class="stat-num text-xl">{{ preview.affectedKeyCount ?? preview.affectedKeys.length }}</div>
            <div class="text-[11px] text-faint mt-1">受影响 Key</div>
          </div>
        </div>

        <!-- F3·近 7d 命中量总结卡（仅当有实际影响时展示） -->
        <div v-if="(preview.totalImpact7d ?? 0) > 0" class="glass-inset p-3 flex items-center gap-3">
          <Icon name="alert" :size="16" class="text-warn shrink-0" />
          <div class="text-xs text-muted leading-relaxed">
            近 7d 该角色对变更集的实际调用共
            <span class="tabular-nums text-fg font-semibold">{{ preview.totalImpact7d }}</span> 次
            <span v-if="preview.lostCalls7d" class="text-danger">· 将屏蔽 {{ preview.lostCalls7d }}</span>
            <span v-if="preview.gainedCalls7d" class="text-ok">· 新放开 {{ preview.gainedCalls7d }}</span>
          </div>
        </div>

        <div v-if="preview.gained.length" class="glass-inset p-3">
          <div class="text-[11px] text-ok mb-2 flex items-center gap-1.5">
            <Icon name="plus" :size="12" /> 新增可见（{{ preview.gained.length }}）
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="t in preview.gained" :key="t" class="chip-ok mono !text-[10px]">
              {{ t }}<span v-if="impact7d(t)" class="ml-1 text-muted">· {{ impact7d(t) }}</span>
            </span>
          </div>
        </div>
        <div v-if="preview.lost.length" class="glass-inset p-3">
          <div class="text-[11px] text-danger mb-2 flex items-center gap-1.5">
            <Icon name="close" :size="12" /> 失去可见（{{ preview.lost.length }}）
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="t in preview.lost" :key="t" class="chip-err mono !text-[10px]">
              {{ t }}<span v-if="impact7d(t)" class="ml-1 text-muted">· {{ impact7d(t) }} 次/7d</span>
            </span>
          </div>
        </div>
        <div v-if="!preview.gained.length && !preview.lost.length"
          class="glass-inset p-4 text-center text-sm text-muted">
          可见集无变化（可能仅调整了规则顺序或备注）
        </div>
        <div v-if="preview.affectedKeys.length" class="text-[11px] text-faint">
          受影响 Key：<span class="mono text-muted">{{preview.affectedKeys.map((k) =>
            `${k.userName}(${k.keyPrefix})`).join('、')}}</span>
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="previewOpen = false">再想想</button>
        <button class="btn-primary" :disabled="saving" @click="confirmSave">{{ saving ? '保存中…' : '确认保存' }}</button>
      </template>
    </Modal>
  </div>
</template>
