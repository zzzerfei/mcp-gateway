<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { api, type Upstream, type UpstreamInput } from '../api';
import { fmtAgo } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';
import CanWrite from '../components/CanWrite.vue';

const toast = useToast();
const loading = ref(true);
const rows = ref<Upstream[]>([]);
const busy = ref<Record<string, boolean>>({});

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api.upstreams.list();
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
onMounted(load);

// ── 表单 ──────────────────────────────────────────────
const modalOpen = ref(false);
const editing = ref<Upstream | null>(null);
const saving = ref(false);
interface KV { k: string; v: string }
const form = reactive({
  name: '',
  displayName: '',
  transport: 'http' as 'http' | 'stdio',
  url: '',
  headers: [] as KV[],
  command: '',
  argsText: '',
  cwd: '',
  env: [] as KV[],
  sensitivity: 'normal' as 'normal' | 'high',
  owner: '',
  timeoutMs: 20000,
  concurrency: 20,
  remark: '',
});

function resetForm(): void {
  Object.assign(form, {
    name: '', displayName: '', transport: 'http', url: '', headers: [], command: '',
    argsText: '', cwd: '', env: [], sensitivity: 'normal', owner: '', timeoutMs: 20000, concurrency: 20, remark: '',
  });
}
function openCreate(): void {
  editing.value = null;
  resetForm();
  modalOpen.value = true;
}
function openEdit(u: Upstream): void {
  editing.value = u;
  resetForm();
  Object.assign(form, {
    name: u.name,
    displayName: u.displayName,
    transport: u.transport,
    url: u.url ?? '',
    command: u.command ?? '',
    argsText: (u.args ?? []).join('\n'),
    cwd: u.cwd ?? '',
    sensitivity: u.sensitivity,
    owner: u.owner,
    timeoutMs: u.timeoutMs,
    concurrency: u.concurrency,
    remark: u.remark,
  });
  // 已加密的 headers/env 不回显明文，仅提示；如需修改则重新填写
  modalOpen.value = true;
}

function kvToRecord(list: KV[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let has = false;
  for (const { k, v } of list) if (k.trim()) { out[k.trim()] = v; has = true; }
  return has ? out : undefined;
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const payload: UpstreamInput = {
      name: form.name.trim(),
      displayName: form.displayName.trim(),
      transport: form.transport,
      sensitivity: form.sensitivity,
      owner: form.owner.trim(),
      timeoutMs: Number(form.timeoutMs) || 20000,
      concurrency: Number(form.concurrency) || 20,
      remark: form.remark.trim(),
    };
    if (form.transport === 'http') {
      payload.url = form.url.trim();
      const h = kvToRecord(form.headers);
      if (h) payload.headers = h;
    } else {
      payload.command = form.command.trim();
      payload.args = form.argsText.split('\n').map((s) => s.trim()).filter(Boolean);
      if (form.cwd.trim()) payload.cwd = form.cwd.trim();
      const e = kvToRecord(form.env);
      if (e) payload.env = e;
    }
    if (editing.value) {
      const { name, ...patch } = payload;
      await api.upstreams.update(name, patch);
      toast.success(`上游 ${name} 已更新`);
    } else {
      await api.upstreams.create(payload);
      toast.success(`上游 ${payload.name} 已创建并连通`);
    }
    modalOpen.value = false;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  saving.value = false;
}

async function probe(u: Upstream): Promise<void> {
  busy.value[u.name] = true;
  try {
    const r = await api.upstreams.probe(u.name);
    if (r?.ok) toast.success(`${u.name} 探测正常`);
    else toast.warn(`${u.name} 探测失败：${r?.error ?? '未知'}`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  busy.value[u.name] = false;
}

async function refresh(u: Upstream): Promise<void> {
  busy.value[u.name] = true;
  try {
    const r = await api.upstreams.refresh(u.name);
    if (r?.ok) toast.success(`${u.name} 已刷新，工具数 ${r?.toolCount ?? '—'}`);
    else toast.warn(`${u.name} 刷新失败：${r?.error ?? '未知'}`);
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  busy.value[u.name] = false;
}

const confirmDel = ref<Upstream | null>(null);
async function doRemove(): Promise<void> {
  const u = confirmDel.value;
  if (!u) return;
  try {
    await api.upstreams.remove(u.name);
    toast.success(`上游 ${u.name} 已下线`);
    confirmDel.value = null;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

const statusMeta = computed(() => (s: string, enabled: number) => {
  if (!enabled) return { cls: 'chip-off', text: '已下线' };
  return s === 'up'
    ? { cls: 'chip-ok', text: '正常' }
    : s === 'down'
      ? { cls: 'chip-err', text: '故障' }
      : s === 'connecting'
        ? { cls: 'chip-warn', text: '连接中' }
        : { cls: 'chip-off', text: '未知' };
});
</script>

<template>
  <div>
    <PageHeader title="上游服务"
      subtitle="聚合的 MCP Server 来源。支持 Streamable HTTP 与 stdio 两种传输，凭据 AES-256-GCM 加密存储，出站受 SSRF 白名单约束">
      <template #actions>
        <button class="btn-ghost" @click="load">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
        <CanWrite>
          <button class="btn-primary" @click="openCreate">
            <Icon name="plus" :size="15" /> 新增上游
          </button>
        </CanWrite>
      </template>
    </PageHeader>

    <Spinner v-if="loading" label="加载上游…" />
    <div v-else-if="!rows.length" class="glass-card">
      <Empty text="尚未配置任何上游服务" icon="server">
        <CanWrite>
          <button class="btn-primary mt-4" @click="openCreate">
            <Icon name="plus" :size="15" /> 新增第一个上游
          </button>
        </CanWrite>
      </Empty>
    </div>

    <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div v-for="u in rows" :key="u.id" class="glass-card glass-hover p-5">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="text-base font-semibold text-fg truncate">{{ u.displayName || u.name }}</h3>
              <span v-if="u.sensitivity === 'high'" class="chip-warn shrink-0">敏感</span>
            </div>
            <div class="text-[11px] text-faint mono mt-0.5 truncate">{{ u.name }}</div>
          </div>
          <span :class="statusMeta(u.lastStatus, u.enabled).cls" class="shrink-0">{{ statusMeta(u.lastStatus,
            u.enabled).text }}</span>
        </div>

        <div class="glass-inset px-3 py-2 mb-3 text-[11px] mono text-muted break-all">
          <span class="text-faint">{{ u.transport }}</span> ·
          <template v-if="u.url">{{ u.url }}</template>
          <template v-else-if="u.command">{{ u.command }} {{ (u.args || []).join(' ') }}</template>
          <span v-else class="text-faint">连接信息已隐藏</span>
        </div>

        <div class="grid grid-cols-3 gap-2 text-center mb-3">
          <div>
            <div class="text-sm text-fg tabular-nums">{{ u.timeoutMs }}ms</div>
            <div class="text-[10px] text-faint">超时</div>
          </div>
          <div>
            <div class="text-sm text-fg tabular-nums">{{ u.concurrency }}</div>
            <div class="text-[10px] text-faint">并发</div>
          </div>
          <div>
            <div class="text-sm text-fg truncate">{{ u.owner || '—' }}</div>
            <div class="text-[10px] text-faint">负责人</div>
          </div>
        </div>

        <div v-if="u.enabled && u.lastStatus === 'down' && u.lastError"
          class="text-[11px] text-danger bg-danger-soft border border-danger-line rounded-lg px-2.5 py-1.5 mb-3 break-all">
          {{ u.lastError }}
        </div>

        <div class="flex items-center justify-between gap-2 pt-3 border-t border-line">
          <span class="text-[11px] text-faint">{{ u.lastCheckedAt ? `检查于 ${fmtAgo(u.lastCheckedAt)}` : '未检查'
          }}</span>
          <div class="flex items-center gap-1.5">
            <CanWrite>
              <button class="btn-ghost btn-sm" :disabled="busy[u.name] || !u.enabled" title="探测连通性" @click="probe(u)">
                <Icon name="link" :size="13" /> 探测
              </button>
              <button class="btn-ghost btn-sm" :disabled="busy[u.name] || !u.enabled" title="刷新工具列表"
                @click="refresh(u)">
                <Icon name="refresh" :size="13" /> 刷新
              </button>
              <button class="btn-ghost btn-sm" @click="openEdit(u)">
                <Icon name="edit" :size="13" />
              </button>
              <button v-if="u.enabled" class="btn-danger btn-sm" @click="confirmDel = u">
                <Icon name="power" :size="13" />
              </button>
            </CanWrite>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <Modal v-model:open="modalOpen" :title="editing ? `编辑上游 · ${editing.name}` : '新增上游'" width="40rem"
      subtitle="http 传输需填 URL；stdio 传输需填启动命令。凭据加密存储，编辑时不回显明文。">
      <div class="space-y-4">
        <!-- 传输类型 -->
        <div>
          <label class="label">传输类型</label>
          <div class="flex gap-2">
            <button type="button" :class="form.transport === 'http' ? 'btn-primary' : 'btn-ghost'" class="flex-1"
              :disabled="!!editing" @click="form.transport = 'http'">Streamable HTTP</button>
            <button type="button" :class="form.transport === 'stdio' ? 'btn-primary' : 'btn-ghost'" class="flex-1"
              :disabled="!!editing" @click="form.transport = 'stdio'">stdio 子进程</button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">名称（命名空间）</label>
            <input v-model="form.name" class="input mono" placeholder="wiki" :disabled="!!editing" />
            <p class="text-[10px] text-faint mt-1">小写字母开头，工具将暴露为 name__tool</p>
          </div>
          <div>
            <label class="label">显示名</label>
            <input v-model="form.displayName" class="input" placeholder="企业知识库" />
          </div>
        </div>

        <!-- http -->
        <template v-if="form.transport === 'http'">
          <div>
            <label class="label">上游 URL</label>
            <input v-model="form.url" class="input mono" placeholder="http://10.0.1.20:3000/mcp" />
            <p class="text-[10px] text-faint mt-1">须落在出站 CIDR 白名单内；169.254.0.0/16 永久拒绝</p>
          </div>
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="label mb-0">请求头（如 Authorization）</label>
              <button type="button" class="text-[11px] text-muted hover:text-fg cursor-pointer"
                @click="form.headers.push({ k: '', v: '' })">+ 添加</button>
            </div>
            <div v-for="(h, i) in form.headers" :key="i" class="flex gap-2 mb-2">
              <input v-model="h.k" class="input-sm mono flex-1" placeholder="Authorization" />
              <input v-model="h.v" class="input-sm mono flex-[2]" placeholder="Bearer sk-..." />
              <button type="button" class="btn-ghost btn-sm" @click="form.headers.splice(i, 1)">
                <Icon name="close" :size="13" />
              </button>
            </div>
          </div>
        </template>

        <!-- stdio -->
        <template v-else>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label">启动命令</label>
              <input v-model="form.command" class="input mono" placeholder="npx" />
            </div>
            <div>
              <label class="label">工作目录（可选）</label>
              <input v-model="form.cwd" class="input mono" placeholder="/opt/mcp" />
            </div>
          </div>
          <div>
            <label class="label">参数（每行一个）</label>
            <textarea v-model="form.argsText" class="input mono h-20 resize-none"
              placeholder="-y&#10;@some/mcp-server" />
          </div>
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <label class="label mb-0">环境变量</label>
              <button type="button" class="text-[11px] text-muted hover:text-fg cursor-pointer"
                @click="form.env.push({ k: '', v: '' })">+ 添加</button>
            </div>
            <div v-for="(e, i) in form.env" :key="i" class="flex gap-2 mb-2">
              <input v-model="e.k" class="input-sm mono flex-1" placeholder="API_KEY" />
              <input v-model="e.v" class="input-sm mono flex-[2]" placeholder="..." />
              <button type="button" class="btn-ghost btn-sm" @click="form.env.splice(i, 1)">
                <Icon name="close" :size="13" />
              </button>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-3 gap-4">
          <div>
            <label class="label">敏感级别</label>
            <select v-model="form.sensitivity" class="select">
              <option value="normal">普通</option>
              <option value="high">敏感（全量审计）</option>
            </select>
          </div>
          <div>
            <label class="label">超时 (ms)</label>
            <input v-model.number="form.timeoutMs" type="number" class="input" />
          </div>
          <div>
            <label class="label">并发上限</label>
            <input v-model.number="form.concurrency" type="number" class="input"
              :disabled="form.transport === 'stdio'" />
            <p v-if="form.transport === 'stdio'" class="text-[10px] text-faint mt-1">stdio 强制串行</p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">负责人</label>
            <input v-model="form.owner" class="input" placeholder="张三 / 平台组" />
          </div>
          <div>
            <label class="label">备注</label>
            <input v-model="form.remark" class="input" placeholder="用途说明" />
          </div>
        </div>
      </div>

      <template #footer>
        <button class="btn-ghost" @click="modalOpen = false">取消</button>
        <button class="btn-primary" :disabled="saving || !form.name.trim()" @click="save">
          {{ saving ? '保存中…' : editing ? '保存并重连' : '创建并连接' }}
        </button>
      </template>
    </Modal>

    <!-- 下线确认 -->
    <Modal :open="!!confirmDel" title="下线上游" width="26rem" @update:open="confirmDel = null">
      <p v-if="confirmDel" class="text-sm text-fg leading-relaxed">
        确认下线 <span class="text-fg mono">{{ confirmDel.name }}</span>？其全部工具将从注册表移除，
        相关权限规则失效，在线会话会收到 tools/list_changed。此操作会记入变更留痕。
      </p>
      <template #footer>
        <button class="btn-ghost" @click="confirmDel = null">取消</button>
        <button class="btn-danger" @click="doRemove">确认下线</button>
      </template>
    </Modal>
  </div>
</template>
