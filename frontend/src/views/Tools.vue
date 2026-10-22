<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type ToolItem, type ToolDetail, type Upstream, type RoleItem, type ToolInvokeResult } from '../api';
import { useToast } from '../composables/useToast';
import { prettyJson } from '../utils/format';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';
import CanWrite from '../components/CanWrite.vue';

const toast = useToast();
const loading = ref(true);
const rows = ref<ToolItem[]>([]);
const upstreams = ref<Upstream[]>([]);

const fUpstream = ref('');
const fQuery = ref('');
const fOverridden = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api.tools.list({
      upstream: fUpstream.value || undefined,
      q: fQuery.value || undefined,
      overridden: fOverridden.value ? '1' : undefined,
    });
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
onMounted(async () => {
  try {
    upstreams.value = await api.upstreams.list();
  } catch { /* ignore */ }
  await load();
});

const grouped = computed(() => {
  const map = new Map<string, ToolItem[]>();
  for (const t of rows.value) {
    if (!map.has(t.upstream)) map.set(t.upstream, []);
    map.get(t.upstream)!.push(t);
  }
  return [...map.entries()];
});

// ── 详情弹窗 ──────────────────────────────────────────
const detail = ref<ToolDetail | null>(null);
const detailOpen = ref(false);
async function openDetail(t: ToolItem): Promise<void> {
  try {
    detail.value = await api.tools.detail(t.fullName);
    detailOpen.value = true;
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 描述覆写 ──────────────────────────────────────────
const descOpen = ref(false);
const descTarget = ref<ToolItem | null>(null);
const descText = ref('');
const descSaving = ref(false);
function openDesc(t: ToolItem): void {
  descTarget.value = t;
  descText.value = t.overridden ? t.description : t.rawDescription;
  descOpen.value = true;
}
async function saveDesc(): Promise<void> {
  if (!descTarget.value || descSaving.value) return;
  descSaving.value = true;
  try {
    const r = await api.tools.setDescription(descTarget.value.fullName, descText.value);
    if (r.warning) toast.warn(r.warning);
    else toast.success('描述已覆写，在线会话将收到 list_changed');
    descOpen.value = false;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  descSaving.value = false;
}

// ── 上下线 ────────────────────────────────────────────
const busy = ref<Record<string, boolean>>({});
async function toggle(t: ToolItem): Promise<void> {
  busy.value[t.fullName] = true;
  try {
    await api.tools.setEnabled(t.fullName, !t.enabled);
    toast.success(`${t.fullName} 已${t.enabled ? '下线' : '上线'}`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  busy.value[t.fullName] = false;
}

// ── 限流 ──────────────────────────────────────────────
const rateOpen = ref(false);
const rateTarget = ref<ToolItem | null>(null);
const rateQpm = ref<number | null>(null);
function openRate(t: ToolItem): void {
  rateTarget.value = t;
  rateQpm.value = t.rateQpm;
  rateOpen.value = true;
}
async function saveRate(): Promise<void> {
  if (!rateTarget.value) return;
  try {
    await api.tools.setRateLimit(rateTarget.value.fullName, rateQpm.value && rateQpm.value > 0 ? rateQpm.value : null);
    toast.success('工具级限流已更新');
    rateOpen.value = false;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 试调用（走完整治理链） ──────────────────────────────
const roles = ref<RoleItem[]>([]);
const invokeOpen = ref(false);
const invokeTarget = ref<ToolItem | null>(null);
const invokeArgs = ref('{}');
const invokeRole = ref('admin');
const invokeBusy = ref(false);
const invokeResult = ref<ToolInvokeResult | null>(null);
const invokeSchema = ref<any>({});
/** 最近一次发送的参数快照，用于「存为用例」 */
const lastArgs = ref<Record<string, unknown> | null>(null);
const caseName = ref('');
const caseSaving = ref(false);
/** 表单模式填写的值；json 模式直接改 invokeArgs */
const invokeMode = ref<'form' | 'json'>('form');
const formValues = ref<Record<string, any>>({});

interface FormField {
  name: string;
  type: string;
  required: boolean;
  desc: string;
  enum: unknown[] | null;
  complex: boolean;
  placeholder: string;
}

/** 从 input_schema 生成表单字段描述 */
const formFields = computed<FormField[]>(() => {
  const props = invokeSchema.value?.properties ?? {};
  const required: string[] = invokeSchema.value?.required ?? [];
  return Object.entries<any>(props).map(([name, v]) => {
    const type = v?.type ?? (v?.enum ? 'string' : 'any');
    return {
      name,
      type,
      required: required.includes(name),
      desc: v?.description ?? '',
      enum: Array.isArray(v?.enum) ? v.enum : null,
      complex: type === 'object' || type === 'array',
      placeholder: v?.default !== undefined ? `默认 ${JSON.stringify(v.default)}` : '',
    };
  });
});

function resetForm(): void {
  const next: Record<string, any> = {};
  for (const f of formFields.value) next[f.name] = f.type === 'boolean' ? '' : '';
  formValues.value = next;
  invokeArgs.value = '{}';
}

const MODES = [
  { k: 'form' as const, t: '表单' },
  { k: 'json' as const, t: 'JSON' },
];

/** 表单值 → 调用参数；空的可选字段直接省略，避免被填成 0/空串 */
function collectArgs(): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const f of formFields.value) {
    const raw = formValues.value[f.name];
    if (raw === '' || raw === undefined || raw === null) {
      if (f.required) {
        toast.error(`缺少必填参数：${f.name}`);
        return null;
      }
      continue;
    }
    if (f.complex) {
      try {
        out[f.name] = JSON.parse(String(raw));
      } catch {
        toast.error(`参数 ${f.name} 不是合法 JSON`);
        return null;
      }
    } else if (f.type === 'number' || f.type === 'integer') {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        toast.error(`参数 ${f.name} 不是数字`);
        return null;
      }
      out[f.name] = n;
    } else if (f.type === 'boolean') {
      out[f.name] = raw === true || raw === 'true';
    } else {
      out[f.name] = raw;
    }
  }
  return out;
}

/** 切到 JSON 模式时把当前表单值同步过去 */
function switchMode(mode: 'form' | 'json'): void {
  if (mode === invokeMode.value) return;
  if (mode === 'json') {
    const args = collectArgs();
    if (args) invokeArgs.value = JSON.stringify(args, null, 2);
  }
  invokeMode.value = mode;
}

async function openInvoke(t: ToolItem): Promise<void> {
  invokeTarget.value = t;
  invokeResult.value = null;
  invokeBusy.value = false;
  lastArgs.value = null;
  caseName.value = `${t.originalName} 冒烟`;
  invokeMode.value = 'form';
  try {
    const d = await api.tools.detail(t.fullName);
    invokeSchema.value = d.inputSchema ?? {};
  } catch {
    invokeSchema.value = {};
  }
  resetForm();
  if (!roles.value.length) {
    try { roles.value = await api.permissions.roles(); } catch { /* ignore */ }
  }
  if (!roles.value.some((r) => r.name === invokeRole.value)) {
    invokeRole.value = roles.value[0]?.name ?? 'admin';
  }
  invokeOpen.value = true;
}

async function sendInvoke(): Promise<void> {
  if (!invokeTarget.value || invokeBusy.value) return;

  let parsed: Record<string, unknown>;
  if (invokeMode.value === 'form') {
    const args = collectArgs();
    if (!args) return;
    parsed = args;
  } else {
    try {
      parsed = JSON.parse(invokeArgs.value || '{}');
    } catch (e) {
      toast.error(`参数不是合法 JSON：${(e as Error).message}`);
      return;
    }
  }

  invokeBusy.value = true;
  invokeResult.value = null;
  lastArgs.value = parsed;
  try {
    invokeResult.value = await api.tools.invoke(invokeTarget.value.fullName, parsed, invokeRole.value);
    if (invokeResult.value.ok) toast.success(`调用成功（${invokeResult.value.durationMs}ms）`);
    else toast.warn(`调用失败：${invokeResult.value.stage}`);
  } catch (e) {
    toast.error((e as Error).message);
  }
  invokeBusy.value = false;
}

/** 把刚刚成功的调用固化为冒烟用例，供「冒烟用例」页一键回归 */
async function saveCase(): Promise<void> {
  if (!invokeTarget.value || !lastArgs.value || caseSaving.value) return;
  const name = caseName.value.trim();
  if (!name) {
    toast.error('请填写用例名称');
    return;
  }
  caseSaving.value = true;
  try {
    await api.cases.create({
      name,
      toolFullName: invokeTarget.value.fullName,
      args: lastArgs.value,
      role: invokeRole.value,
    });
    toast.success('已存为冒烟用例');
  } catch (e) {
    toast.error((e as Error).message);
  }
  caseSaving.value = false;
}
</script>

<template>
  <div>
    <PageHeader title="工具目录" subtitle="网关聚合的全部工具（命名空间 upstream__tool）。可覆写描述、单独上下线、设置工具级限流；描述覆写含 Prompt 注入告警">
      <template #actions>
        <button class="btn-ghost" @click="load">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
      </template>
    </PageHeader>

    <!-- 筛选条 -->
    <div class="glass-card p-4 mb-5 flex flex-wrap items-center gap-3">
      <div class="relative min-w-[13rem] flex-1">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-faint">
          <Icon name="search" :size="15" />
        </span>
        <input v-model="fQuery" class="input pl-9" placeholder="搜索工具名或描述…" @keyup.enter="load" />
      </div>
      <select v-model="fUpstream" class="select w-44" @change="load">
        <option value="">全部上游</option>
        <option v-for="u in upstreams" :key="u.id" :value="u.name">{{ u.displayName || u.name }}</option>
      </select>
      <label class="flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
        <input v-model="fOverridden" type="checkbox" class="w-4 h-4 accent-white rounded" @change="load" />
        仅看已覆写
      </label>
      <button class="btn-primary" @click="load">
        <Icon name="filter" :size="15" /> 查询
      </button>
      <span class="text-xs text-faint ml-auto tabular-nums">共 {{ rows.length }} 个工具</span>
    </div>

    <Spinner v-if="loading" label="加载工具…" />
    <div v-else-if="!rows.length" class="glass-card">
      <Empty text="没有匹配的工具" icon="tool">
        <p class="text-xs text-faint mt-2">请先在「上游服务」中连通上游并刷新工具列表</p>
      </Empty>
    </div>

    <div v-else class="space-y-6">
      <div v-for="[upstream, tools] in grouped" :key="upstream">
        <div class="flex items-center gap-2 mb-2.5">
          <Icon name="server" :size="14" class="text-faint" />
          <h3 class="text-sm font-semibold text-fg mono">{{ upstream }}</h3>
          <span class="text-[11px] text-faint">{{ tools.length }} 个工具</span>
        </div>
        <div class="glass-card overflow-hidden">
          <table class="w-full">
            <thead>
              <tr>
                <th class="th">工具</th>
                <th class="th hidden md:table-cell">描述</th>
                <th class="th w-24">限流</th>
                <th class="th w-20">状态</th>
                <th class="th w-40 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in tools" :key="t.fullName" class="tr-hover">
                <td class="td">
                  <div class="flex items-center gap-2">
                    <span class="mono text-fg text-[13px]">{{ t.originalName }}</span>
                    <span v-if="t.sensitivity === 'high'" class="chip-warn !px-1.5 !py-0 !text-[10px]">敏感</span>
                    <span v-if="t.overridden" class="chip-on !px-1.5 !py-0 !text-[10px]" title="已覆写">覆写</span>
                  </div>
                </td>
                <td class="td hidden md:table-cell">
                  <span class="text-muted text-xs line-clamp-2 max-w-md">{{ t.description || '—' }}</span>
                </td>
                <td class="td">
                  <span class="text-xs tabular-nums" :class="t.rateQpm ? 'text-fg' : 'text-faint'">
                    {{ t.rateQpm ? `${t.rateQpm}/min` : '默认' }}
                  </span>
                </td>
                <td class="td">
                  <span :class="t.enabled ? 'chip-ok' : 'chip-off'">{{ t.enabled ? '在线' : '下线' }}</span>
                </td>
                <td class="td">
                  <div class="flex items-center justify-end gap-1.5">
                    <CanWrite>
                      <button class="btn-ghost btn-sm" title="试调用" @click="openInvoke(t)">
                        <Icon name="play" :size="13" />
                      </button>
                    </CanWrite>
                    <button class="btn-ghost btn-sm" title="详情" @click="openDetail(t)">
                      <Icon name="eye" :size="13" />
                    </button>
                    <CanWrite>
                      <button class="btn-ghost btn-sm" title="覆写描述" @click="openDesc(t)">
                        <Icon name="edit" :size="13" />
                      </button>
                      <button class="btn-ghost btn-sm" title="工具级限流" @click="openRate(t)">
                        <Icon name="gauge" :size="13" />
                      </button>
                      <button class="btn-sm" :class="t.enabled ? 'btn-danger' : 'btn-primary'"
                        :disabled="busy[t.fullName]" @click="toggle(t)">
                        {{ t.enabled ? '下线' : '上线' }}
                      </button>
                    </CanWrite>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <Modal v-model:open="detailOpen" :title="detail?.fullName ?? '工具详情'" width="40rem">
      <div v-if="detail" class="space-y-4">
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">上游</div>
            <div class="mono text-fg">{{ detail.upstream }}</div>
          </div>
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">原始名</div>
            <div class="mono text-fg">{{ detail.originalName }}</div>
          </div>
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">状态</div><span :class="detail.enabled ? 'chip-ok' : 'chip-off'">{{
              detail.enabled ? '在线' : '下线' }}</span>
          </div>
          <div class="glass-inset p-3">
            <div class="text-[11px] text-faint mb-1">敏感级别</div><span
              :class="detail.sensitivity === 'high' ? 'chip-warn' : 'chip-off'">{{ detail.sensitivity === 'high' ? '敏感'
                :
                '普通' }}</span>
          </div>
        </div>
        <div>
          <div class="text-[11px] text-faint mb-1.5">当前描述（对外暴露）</div>
          <div class="glass-inset p-3 text-sm text-fg leading-relaxed">{{ detail.description || '—' }}</div>
        </div>
        <div v-if="detail.overridden">
          <div class="text-[11px] text-faint mb-1.5">上游原始描述</div>
          <div class="glass-inset p-3 text-sm text-muted leading-relaxed">{{ detail.rawDescription || '—' }}</div>
        </div>
        <div>
          <div class="text-[11px] text-faint mb-1.5">Input Schema</div>
          <pre class="glass-inset p-3 text-[11px] mono text-muted overflow-x-auto max-h-64 scrollbar-thin">{{
            prettyJson(JSON.stringify(detail.inputSchema ?? {})) }}</pre>
        </div>
      </div>
    </Modal>

    <!-- 描述覆写 -->
    <Modal v-model:open="descOpen" title="覆写工具描述" width="38rem" subtitle="覆写后的描述会暴露给模型。留空并保存可恢复上游原始描述。含可疑指令模式时会告警。">
      <div v-if="descTarget">
        <div class="text-[11px] text-faint mb-1.5">上游原始描述</div>
        <div class="glass-inset p-3 text-xs text-muted leading-relaxed mb-4">{{ descTarget.rawDescription || '（空）' }}
        </div>
        <label class="label">覆写描述</label>
        <textarea v-model="descText" class="input mono h-32 resize-none" placeholder="为模型优化后的工具描述…" />
      </div>
      <template #footer>
        <button class="btn-ghost" @click="descOpen = false">取消</button>
        <button class="btn-primary" :disabled="descSaving" @click="saveDesc">{{ descSaving ? '保存中…' : '保存覆写' }}</button>
      </template>
    </Modal>

    <!-- 限流 -->
    <Modal v-model:open="rateOpen" title="工具级限流" width="26rem" subtitle="留空或 0 表示使用全局默认 QPM。工具级覆写优先于全局。">
      <div v-if="rateTarget">
        <label class="label">每分钟请求数（QPM）· {{ rateTarget.fullName }}</label>
        <input v-model.number="rateQpm" type="number" min="0" class="input" placeholder="留空=默认" />
      </div>
      <template #footer>
        <button class="btn-ghost" @click="rateOpen = false">取消</button>
        <button class="btn-primary" @click="saveRate">保存</button>
      </template>
    </Modal>

    <!-- 试调用 -->
    <Modal v-model:open="invokeOpen" :title="`试调用 ${invokeTarget?.fullName ?? ''}`" width="44rem"
      subtitle="走完整治理链（RBAC → 限流 → 熔断 → 并发 → 转发 → 审计），与真实客户端行为一致">
      <div v-if="invokeTarget" class="space-y-4">
        <div class="flex flex-wrap items-center gap-3">
          <label class="label !mb-0">以角色身份</label>
          <select v-model="invokeRole" class="select w-40">
            <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
          </select>
          <span class="text-[11px] text-faint">用于在发 Key 之前预演该角色的权限结果</span>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="label !mb-0">参数</label>
            <div class="flex items-center gap-0.5 rounded-lg bg-inset p-0.5">
              <button v-for="m in MODES" :key="m.k" class="px-2.5 py-1 text-[11px] rounded-md transition"
                :class="invokeMode === m.k ? 'bg-surface text-fg' : 'text-muted hover:text-muted'"
                @click="switchMode(m.k)">{{ m.t }}</button>
            </div>
          </div>

          <!-- 表单模式：按 input_schema 自动生成控件 -->
          <div v-if="invokeMode === 'form'">
            <div v-if="!formFields.length" class="glass-inset px-3 py-4 text-xs text-faint text-center">
              该工具无参数，可直接调用
            </div>
            <div v-else class="space-y-3 max-h-80 overflow-auto scrollbar-thin pr-1">
              <div v-for="f in formFields" :key="f.name">
                <label class="label !mb-1 flex items-center gap-1.5">
                  <span class="mono">{{ f.name }}</span>
                  <span v-if="f.required" class="chip-warn !px-1.5 !py-0 !text-[10px]">必填</span>
                  <span class="text-[10px] text-faint">{{ f.type }}</span>
                </label>

                <select v-if="f.enum" v-model="formValues[f.name]" class="select">
                  <option value="">（不填）</option>
                  <option v-for="o in f.enum" :key="String(o)" :value="o">{{ o }}</option>
                </select>

                <select v-else-if="f.type === 'boolean'" v-model="formValues[f.name]" class="select">
                  <option value="">（不填）</option>
                  <option :value="true">true</option>
                  <option :value="false">false</option>
                </select>

                <textarea v-else-if="f.complex" v-model="formValues[f.name]" class="input mono h-20 resize-none"
                  spellcheck="false" :placeholder="f.placeholder || (f.type === 'array' ? '[ ]' : '{ }')" />

                <input v-else-if="f.type === 'number' || f.type === 'integer'" v-model.number="formValues[f.name]"
                  type="number" class="input" :placeholder="f.placeholder" />

                <input v-else v-model="formValues[f.name]" class="input" :placeholder="f.placeholder" />

                <div v-if="f.desc" class="text-[11px] text-faint mt-1 leading-relaxed">{{ f.desc }}</div>
              </div>
            </div>
          </div>

          <!-- JSON 模式：完全自定义 -->
          <div v-else>
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-[11px] text-faint">完全自定义，适合嵌套结构或批量参数</span>
              <button class="btn-ghost btn-sm" @click="invokeArgs = '{}'">
                <Icon name="refresh" :size="12" /> 清空
              </button>
            </div>
            <textarea v-model="invokeArgs" class="input mono h-32 resize-none" spellcheck="false" placeholder="{}" />
          </div>
        </div>

        <div v-if="invokeResult" class="space-y-2">
          <!-- 治理链六步：严格串行，失败后置灰 -->
          <div class="glass-inset px-3 py-3">
            <div class="flex items-center">
              <template v-for="(s, i) in invokeResult.stages" :key="s.no">
                <div class="flex flex-col items-center gap-1 shrink-0">
                  <div class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] transition" :class="s.status === 'passed'
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
                <div v-if="i < invokeResult.stages.length - 1" class="flex-1 h-px mx-1.5 mb-4"
                  :class="s.status === 'passed' ? 'bg-ok' : 'bg-line'" />
              </template>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3 text-xs">
            <span :class="invokeResult.ok ? 'chip-ok' : 'chip-warn'">{{ invokeResult.ok ? '调用成功' : '调用失败' }}</span>
            <span class="text-muted">{{ invokeResult.stage }}</span>
            <span class="text-faint tabular-nums">{{ invokeResult.durationMs }}ms</span>
            <span v-if="invokeResult.errorCode" class="mono text-muted">{{ invokeResult.errorCode }}</span>
          </div>
          <div v-if="invokeResult.requestId" class="text-[11px] text-faint mono">
            requestId: {{ invokeResult.requestId }} · 可在「审计日志」中回查
          </div>
          <div class="flex items-center gap-2">
            <input v-model="caseName" class="input !py-1.5 !text-xs" placeholder="用例名称" />
            <button class="btn-ghost btn-sm shrink-0" :disabled="caseSaving" @click="saveCase">
              <Icon name="plus" :size="12" /> {{ caseSaving ? '保存中…' : '存为用例' }}
            </button>
          </div>
          <pre class="glass-inset p-3 text-[11px] mono text-muted overflow-auto max-h-72 scrollbar-thin">{{
            prettyJson(JSON.stringify(invokeResult.result ?? null)) }}</pre>
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="invokeOpen = false">关闭</button>
        <button class="btn-primary" :disabled="invokeBusy" @click="sendInvoke">{{ invokeBusy ? '调用中…' : '发送调用'
        }}</button>
      </template>
    </Modal>
  </div>
</template>
