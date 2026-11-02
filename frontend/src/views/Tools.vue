<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { api, type ToolItem, type ToolDetail, type Upstream } from '../api';
import { useToast } from '../composables/useToast';
import { prettyJson } from '../utils/format';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';

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
</script>

<template>
  <div>
    <PageHeader title="工具目录" subtitle="网关聚合的全部工具（命名空间 upstream__tool）。可覆写描述、单独上下线、设置工具级限流；描述覆写含 Prompt 注入告警">
      <template #actions>
        <button class="btn-ghost" @click="load"><Icon name="refresh" :size="15" /> 刷新</button>
      </template>
    </PageHeader>

    <!-- 筛选条 -->
    <div class="glass-card p-4 mb-5 flex flex-wrap items-center gap-3">
      <div class="relative min-w-[13rem] flex-1">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-white/30"><Icon name="search" :size="15" /></span>
        <input v-model="fQuery" class="input pl-9" placeholder="搜索工具名或描述…" @keyup.enter="load" />
      </div>
      <select v-model="fUpstream" class="select w-44" @change="load">
        <option value="">全部上游</option>
        <option v-for="u in upstreams" :key="u.id" :value="u.name">{{ u.displayName || u.name }}</option>
      </select>
      <label class="flex items-center gap-2 text-xs text-white/50 cursor-pointer select-none">
        <input v-model="fOverridden" type="checkbox" class="w-4 h-4 accent-white rounded" @change="load" />
        仅看已覆写
      </label>
      <button class="btn-primary" @click="load"><Icon name="filter" :size="15" /> 查询</button>
      <span class="text-xs text-white/30 ml-auto tabular-nums">共 {{ rows.length }} 个工具</span>
    </div>

    <Spinner v-if="loading" label="加载工具…" />
    <div v-else-if="!rows.length" class="glass-card">
      <Empty text="没有匹配的工具" icon="tool">
        <p class="text-xs text-white/25 mt-2">请先在「上游服务」中连通上游并刷新工具列表</p>
      </Empty>
    </div>

    <div v-else class="space-y-6">
      <div v-for="[upstream, tools] in grouped" :key="upstream">
        <div class="flex items-center gap-2 mb-2.5">
          <Icon name="server" :size="14" class="text-white/35" />
          <h3 class="text-sm font-semibold text-white/70 mono">{{ upstream }}</h3>
          <span class="text-[11px] text-white/25">{{ tools.length }} 个工具</span>
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
                    <span class="mono text-white/85 text-[13px]">{{ t.originalName }}</span>
                    <span v-if="t.sensitivity === 'high'" class="chip-warn !px-1.5 !py-0 !text-[10px]">敏感</span>
                    <span v-if="t.overridden" class="chip-on !px-1.5 !py-0 !text-[10px]" title="已覆写">覆写</span>
                  </div>
                </td>
                <td class="td hidden md:table-cell">
                  <span class="text-white/50 text-xs line-clamp-2 max-w-md">{{ t.description || '—' }}</span>
                </td>
                <td class="td">
                  <span class="text-xs tabular-nums" :class="t.rateQpm ? 'text-white/75' : 'text-white/25'">
                    {{ t.rateQpm ? `${t.rateQpm}/min` : '默认' }}
                  </span>
                </td>
                <td class="td">
                  <span :class="t.enabled ? 'chip-ok' : 'chip-off'">{{ t.enabled ? '在线' : '下线' }}</span>
                </td>
                <td class="td">
                  <div class="flex items-center justify-end gap-1.5">
                    <button class="btn-ghost btn-sm" title="详情" @click="openDetail(t)"><Icon name="eye" :size="13" /></button>
                    <button class="btn-ghost btn-sm" title="覆写描述" @click="openDesc(t)"><Icon name="edit" :size="13" /></button>
                    <button class="btn-ghost btn-sm" title="工具级限流" @click="openRate(t)"><Icon name="gauge" :size="13" /></button>
                    <button class="btn-sm" :class="t.enabled ? 'btn-danger' : 'btn-primary'" :disabled="busy[t.fullName]" @click="toggle(t)">
                      {{ t.enabled ? '下线' : '上线' }}
                    </button>
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
          <div class="glass-inset p-3"><div class="text-[11px] text-white/30 mb-1">上游</div><div class="mono text-white/80">{{ detail.upstream }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-white/30 mb-1">原始名</div><div class="mono text-white/80">{{ detail.originalName }}</div></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-white/30 mb-1">状态</div><span :class="detail.enabled ? 'chip-ok' : 'chip-off'">{{ detail.enabled ? '在线' : '下线' }}</span></div>
          <div class="glass-inset p-3"><div class="text-[11px] text-white/30 mb-1">敏感级别</div><span :class="detail.sensitivity === 'high' ? 'chip-warn' : 'chip-off'">{{ detail.sensitivity === 'high' ? '敏感' : '普通' }}</span></div>
        </div>
        <div>
          <div class="text-[11px] text-white/30 mb-1.5">当前描述（对外暴露）</div>
          <div class="glass-inset p-3 text-sm text-white/75 leading-relaxed">{{ detail.description || '—' }}</div>
        </div>
        <div v-if="detail.overridden">
          <div class="text-[11px] text-white/30 mb-1.5">上游原始描述</div>
          <div class="glass-inset p-3 text-sm text-white/45 leading-relaxed">{{ detail.rawDescription || '—' }}</div>
        </div>
        <div>
          <div class="text-[11px] text-white/30 mb-1.5">Input Schema</div>
          <pre class="glass-inset p-3 text-[11px] mono text-white/60 overflow-x-auto max-h-64 scrollbar-thin">{{ prettyJson(JSON.stringify(detail.inputSchema ?? {})) }}</pre>
        </div>
      </div>
    </Modal>

    <!-- 描述覆写 -->
    <Modal v-model:open="descOpen" title="覆写工具描述" width="38rem"
      subtitle="覆写后的描述会暴露给模型。留空并保存可恢复上游原始描述。含可疑指令模式时会告警。">
      <div v-if="descTarget">
        <div class="text-[11px] text-white/30 mb-1.5">上游原始描述</div>
        <div class="glass-inset p-3 text-xs text-white/45 leading-relaxed mb-4">{{ descTarget.rawDescription || '（空）' }}</div>
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
  </div>
</template>
