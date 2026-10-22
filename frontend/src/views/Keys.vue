<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue';
import { api, type KeyItem, type IssuedKey, type RoleItem } from '../api';
import { fmtTime, fmtAgo, copyText } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import Empty from '../components/Empty.vue';
import Spinner from '../components/Spinner.vue';

const toast = useToast();
const loading = ref(true);
const rows = ref<KeyItem[]>([]);
const roles = ref<RoleItem[]>([]);

// ── 筛选 ──────────────────────────────────────────────
const fUser = ref('');
const fRole = ref('');
const fStatus = ref<'all' | 'active' | 'revoked' | 'expired'>('all');

async function load(): Promise<void> {
  loading.value = true;
  try {
    const revoked = fStatus.value === 'revoked' ? 1 : fStatus.value === 'all' ? undefined : 0;
    rows.value = await api.keys.list({
      user: fUser.value.trim() || undefined,
      role: fRole.value || undefined,
      revoked,
    });
  } catch (e) {
    toast.error((e as Error).message);
  }
  loading.value = false;
}
onMounted(async () => {
  try {
    roles.value = await api.permissions.roles();
  } catch {
    /* 角色拉取失败不阻断列表 */
  }
  await load();
});

function statusOf(k: KeyItem): 'revoked' | 'expired' | 'active' {
  if (k.revoked) return 'revoked';
  if (k.expiresAt && k.expiresAt < Date.now()) return 'expired';
  return 'active';
}
/** 服务端只认 user/role/revoked；active/expired 的细分在客户端再筛一道 */
const visibleRows = computed(() => {
  if (fStatus.value === 'active') return rows.value.filter((k) => statusOf(k) === 'active');
  if (fStatus.value === 'expired') return rows.value.filter((k) => statusOf(k) === 'expired');
  return rows.value;
});

// ── 签发 ──────────────────────────────────────────────
const issueOpen = ref(false);
const issuing = ref(false);
const form = reactive({
  name: '',
  userName: '',
  team: '',
  role: '',
  profile: '',
  expiresInDays: 90 as number | null,
});
function openIssue(): void {
  Object.assign(form, {
    name: '', userName: '', team: '', profile: '', expiresInDays: 90,
    role: roles.value[0]?.name ?? '',
  });
  issueOpen.value = true;
}
async function doIssue(): Promise<void> {
  if (issuing.value) return;
  if (!form.name.trim() || !form.userName.trim() || !form.role) {
    toast.warn('名称、使用者、角色均为必填');
    return;
  }
  issuing.value = true;
  try {
    const issued = await api.keys.issue({
      name: form.name.trim(),
      userName: form.userName.trim(),
      team: form.team.trim(),
      role: form.role,
      profile: form.profile.trim(),
      expiresInDays: form.expiresInDays && form.expiresInDays > 0 ? form.expiresInDays : null,
    });
    issueOpen.value = false;
    reveal(issued, '签发成功');
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  issuing.value = false;
}

// ── 明文一次性展示 ────────────────────────────────────
const revealed = ref<IssuedKey | null>(null);
const revealOpen = ref(false);
const revealTitle = ref('');
function reveal(k: IssuedKey, title: string): void {
  revealed.value = k;
  revealTitle.value = title;
  revealOpen.value = true;
}
async function copyRaw(): Promise<void> {
  if (!revealed.value) return;
  const ok = await copyText(revealed.value.raw);
  ok ? toast.success('明文已复制到剪贴板') : toast.error('复制失败，请手动选择');
}

// ── 吊销 ──────────────────────────────────────────────
const revokeTarget = ref<KeyItem | null>(null);
const revokeReason = ref<'leak' | 'offboard' | 'rotate' | 'other'>('other');
const REASONS: Array<{ v: 'leak' | 'offboard' | 'rotate' | 'other'; label: string }> = [
  { v: 'leak', label: '密钥泄露' },
  { v: 'offboard', label: '人员离职' },
  { v: 'rotate', label: '定期轮换' },
  { v: 'other', label: '其他' },
];
function openRevoke(k: KeyItem): void {
  revokeTarget.value = k;
  revokeReason.value = 'other';
}
async function doRevoke(): Promise<void> {
  const k = revokeTarget.value;
  if (!k) return;
  try {
    await api.keys.revoke(k.id, revokeReason.value);
    toast.success(`Key ${k.prefix} 已吊销，在线会话即刻失效`);
    revokeTarget.value = null;
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// ── 轮换 ──────────────────────────────────────────────
const rotateTarget = ref<KeyItem | null>(null);
const graceMinutes = ref(0);
function openRotate(k: KeyItem): void {
  rotateTarget.value = k;
  graceMinutes.value = 0;
}
async function doRotate(): Promise<void> {
  const k = rotateTarget.value;
  if (!k) return;
  try {
    const issued = await api.keys.rotate(k.id, Math.max(0, Number(graceMinutes.value) || 0));
    rotateTarget.value = null;
    reveal(issued, '轮换成功');
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
}

async function copyPrefix(k: KeyItem): Promise<void> {
  const ok = await copyText(k.prefix);
  ok ? toast.success('前缀已复制') : toast.error('复制失败');
}

// ── 按使用者吊销全部 ──────────────────────────────────
const bulkOpen = ref(false);
const bulkUser = ref('');
const bulkReason = ref<'leak' | 'offboard' | 'rotate' | 'other'>('offboard');
const bulkBusy = ref(false);
function openBulk(): void {
  bulkUser.value = fUser.value.trim();
  bulkReason.value = 'offboard';
  bulkOpen.value = true;
}
async function doBulk(): Promise<void> {
  const userName = bulkUser.value.trim();
  if (!userName) {
    toast.warn('请填写使用者名');
    return;
  }
  if (bulkBusy.value) return;
  bulkBusy.value = true;
  try {
    const res = await api.keys.revokeUser(userName, bulkReason.value);
    bulkOpen.value = false;
    toast.success(
      res.count
        ? `已吊销 ${userName} 名下 ${res.count} 个 Key，在线会话下次调用即失效`
        : `${userName} 名下没有有效 Key`,
    );
    await load();
  } catch (e) {
    toast.error((e as Error).message);
  }
  bulkBusy.value = false;
}
</script>

<template>
  <div>
    <PageHeader title="API Key" subtitle="调用方身份凭据。明文仅在签发/轮换时出现一次，服务端只存 Argon2 派生的校验值。吊销立即失效，轮换可设宽限期平滑切换。">
      <template #actions>
        <button class="btn-ghost" @click="load">
          <Icon name="refresh" :size="15" /> 刷新
        </button>
        <button class="btn-danger" @click="openBulk">
          <Icon name="power" :size="15" /> 按使用者吊销
        </button>
        <button class="btn-primary" @click="openIssue">
          <Icon name="plus" :size="15" /> 签发 Key
        </button>
      </template>
    </PageHeader>

    <!-- 筛选条 -->
    <div class="glass-card p-4 mb-5 flex flex-wrap items-center gap-3">
      <div class="relative min-w-[12rem] flex-1">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-faint">
          <Icon name="search" :size="15" />
        </span>
        <input v-model="fUser" class="input pl-9" placeholder="按使用者名筛选…" @keyup.enter="load" />
      </div>
      <select v-model="fRole" class="select w-40" @change="load">
        <option value="">全部角色</option>
        <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
      </select>
      <select v-model="fStatus" class="select w-36" @change="load">
        <option value="all">全部状态</option>
        <option value="active">有效</option>
        <option value="expired">已过期</option>
        <option value="revoked">已吊销</option>
      </select>
      <button class="btn-primary" @click="load">
        <Icon name="filter" :size="15" /> 查询
      </button>
      <span class="text-xs text-faint ml-auto tabular-nums">共 {{ visibleRows.length }} 个 Key</span>
    </div>

    <Spinner v-if="loading" label="加载 Key…" />
    <div v-else-if="!visibleRows.length" class="glass-card">
      <Empty text="没有匹配的 API Key" icon="key">
        <button class="btn-primary mt-4" @click="openIssue">
          <Icon name="plus" :size="15" /> 签发第一个 Key
        </button>
      </Empty>
    </div>

    <div v-else class="glass-card overflow-hidden">
      <div class="overflow-x-auto scrollbar-thin">
        <table class="w-full min-w-[52rem]">
          <thead>
            <tr>
              <th class="th">Key</th>
              <th class="th">归属</th>
              <th class="th">角色</th>
              <th class="th hidden lg:table-cell">Profile</th>
              <th class="th">状态</th>
              <th class="th hidden md:table-cell">有效期</th>
              <th class="th hidden md:table-cell">最近使用</th>
              <th class="th text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="k in visibleRows" :key="k.id" class="tr-hover">
              <td class="td">
                <div class="text-fg text-[13px]">{{ k.name || '（未命名）' }}</div>
                <div class="flex items-center gap-1.5 mt-0.5">
                  <code class="mono text-[11px] text-muted">{{ k.prefix }}…</code>
                  <button type="button"
                    class="inline-flex items-center justify-center appearance-none bg-transparent border-0 p-0 m-0 leading-none text-faint hover:text-fg transition-colors cursor-pointer"
                    title="复制前缀" @click="copyPrefix(k)">
                    <Icon name="copy" :size="12" />
                  </button>
                </div>
              </td>
              <td class="td">
                <div class="text-fg text-[13px]">{{ k.userName }}</div>
                <div v-if="k.team" class="text-[11px] text-faint">{{ k.team }}</div>
              </td>
              <td class="td"><span class="chip-on mono">{{ k.role }}</span></td>
              <td class="td hidden lg:table-cell">
                <span class="text-xs text-muted">{{ k.profile || '—' }}</span>
              </td>
              <td class="td">
                <span
                  :class="statusOf(k) === 'active' ? 'chip-ok' : statusOf(k) === 'expired' ? 'chip-warn' : 'chip-err'">
                  {{ statusOf(k) === 'active' ? '有效' : statusOf(k) === 'expired' ? '已过期' : '已吊销' }}
                </span>
                <div v-if="k.revoked && k.revokeReason" class="text-[10px] text-faint mt-1">{{ k.revokeReason }}
                </div>
              </td>
              <td class="td hidden md:table-cell">
                <span class="text-xs tabular-nums" :class="k.expiresAt ? 'text-muted' : 'text-faint'">
                  {{ k.expiresAt ? fmtTime(k.expiresAt) : '永不过期' }}
                </span>
              </td>
              <td class="td hidden md:table-cell">
                <span class="text-xs text-muted">{{ k.lastUsedAt ? fmtAgo(k.lastUsedAt) : '从未使用' }}</span>
              </td>
              <td class="td">
                <div class="flex items-center justify-end gap-1.5">
                  <button class="btn-ghost btn-sm" :disabled="!!k.revoked" title="轮换密钥" @click="openRotate(k)">
                    <Icon name="refresh" :size="13" /> 轮换
                  </button>
                  <button v-if="!k.revoked" class="btn-danger btn-sm" title="吊销" @click="openRevoke(k)">
                    <Icon name="power" :size="13" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 签发弹窗 -->
    <Modal v-model:open="issueOpen" title="签发 API Key" width="34rem" subtitle="明文密钥只在签发成功后展示一次，请立即妥善保存。">
      <div class="space-y-4">
        <div>
          <label class="label">Key 名称</label>
          <input v-model="form.name" class="input" placeholder="如：客服机器人-生产" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">使用者名 *</label>
            <input v-model="form.userName" class="input" placeholder="如：bot-support" />
          </div>
          <div>
            <label class="label">团队</label>
            <input v-model="form.team" class="input" placeholder="如：客服中台" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">角色 *</label>
            <select v-model="form.role" class="select">
              <option value="" disabled>选择角色</option>
              <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
            </select>
          </div>
          <div>
            <label class="label">Profile（用途标记）</label>
            <input v-model="form.profile" class="input" placeholder="如：internal-read" />
          </div>
        </div>
        <div>
          <label class="label">有效期（天）</label>
          <input v-model.number="form.expiresInDays" type="number" min="1" class="input" placeholder="留空或 0 表示永不过期" />
          <p class="text-[10px] text-faint mt-1">建议为长期凭据设置到期时间，到期自动失效。</p>
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="issueOpen = false">取消</button>
        <button class="btn-primary" :disabled="issuing" @click="doIssue">
          <Icon name="key" :size="15" /> {{ issuing ? '签发中…' : '签发' }}
        </button>
      </template>
    </Modal>

    <!-- 明文一次性展示 -->
    <Modal v-model:open="revealOpen" :title="revealTitle" width="36rem" :close-on-mask="false">
      <div v-if="revealed" class="space-y-4">
        <div class="flex items-start gap-2.5 bg-warn-soft border border-warn-line rounded-xl p-3">
          <span class="text-warn shrink-0 mt-0.5">
            <Icon name="alert" :size="16" />
          </span>
          <p class="text-xs text-warn leading-relaxed">
            明文密钥<strong class="text-warn">仅此一次</strong>展示，关闭后无法再次查看。请立即复制到安全位置（密钥管理器 / CI Secret）。
          </p>
        </div>
        <div>
          <div class="text-[11px] text-faint mb-1.5">明文密钥</div>
          <div class="glass-inset p-3 flex items-center gap-3">
            <code class="mono text-[13px] text-fg break-all flex-1 select-all">{{ revealed.raw }}</code>
            <button class="btn-ghost btn-sm shrink-0" @click="copyRaw">
              <Icon name="copy" :size="13" /> 复制
            </button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3 text-xs">
          <div class="glass-inset p-2.5">
            <div class="text-faint mb-0.5">前缀</div>
            <div class="mono text-fg">{{ revealed.prefix }}</div>
          </div>
          <div class="glass-inset p-2.5">
            <div class="text-faint mb-0.5">使用者</div>
            <div class="text-fg truncate">{{ revealed.userName || '—' }}</div>
          </div>
          <div class="glass-inset p-2.5">
            <div class="text-faint mb-0.5">角色</div>
            <div class="mono text-fg truncate">{{ revealed.role || '—' }}</div>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-primary" @click="revealOpen = false">我已妥善保存</button>
      </template>
    </Modal>

    <!-- 吊销确认 -->
    <Modal :open="!!revokeTarget" title="吊销 API Key" width="30rem"
      :subtitle="revokeTarget ? `${revokeTarget.name || revokeTarget.prefix} · ${revokeTarget.userName}` : ''"
      @update:open="revokeTarget = null">
      <div class="space-y-3">
        <p class="text-sm text-muted">吊销后该 Key 立即失效，持有者的在线会话将在下一次调用时被拒绝。此操作不可撤销。</p>
        <div>
          <label class="label">吊销原因</label>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="r in REASONS" :key="r.v" type="button"
              :class="revokeReason === r.v ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'" @click="revokeReason = r.v">{{
                r.label }}</button>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="revokeTarget = null">取消</button>
        <button class="btn-danger" @click="doRevoke">
          <Icon name="power" :size="15" /> 确认吊销
        </button>
      </template>
    </Modal>

    <!-- 轮换 -->
    <Modal :open="!!rotateTarget" title="轮换 API Key" width="32rem"
      :subtitle="rotateTarget ? `${rotateTarget.name || rotateTarget.prefix} · ${rotateTarget.userName}` : ''"
      @update:open="rotateTarget = null">
      <div class="space-y-4">
        <p class="text-sm text-muted leading-relaxed">
          轮换会生成一把新密钥并吊销旧密钥。设置宽限期可让旧密钥在一段时间内仍可用，便于调用方平滑切换。
        </p>
        <div>
          <label class="label">旧密钥宽限期（分钟）</label>
          <input v-model.number="graceMinutes" type="number" min="0" class="input" placeholder="0 表示立即失效" />
          <p class="text-[10px] text-faint mt-1">0 = 旧密钥立即失效；&gt;0 = 新旧密钥在宽限期内并存。</p>
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="rotateTarget = null">取消</button>
        <button class="btn-primary" @click="doRotate">
          <Icon name="refresh" :size="15" /> 生成新密钥
        </button>
      </template>
    </Modal>

    <!-- 按使用者吊销全部 -->
    <Modal v-model:open="bulkOpen" title="按使用者吊销全部 Key" width="32rem" subtitle="离职 / 封禁场景：一次吊销该使用者名下所有有效 Key">
      <div class="space-y-4">
        <div class="flex items-start gap-2.5 bg-warn-soft border border-warn-line rounded-xl p-3">
          <span class="text-warn shrink-0 mt-0.5">
            <Icon name="alert" :size="16" />
          </span>
          <p class="text-xs text-warn leading-relaxed">
            吊销后该使用者名下所有有效 Key 立即失效，在线 MCP 会话下一次调用即被拒绝。此操作不可撤销。
            员工离职时请先在 Logto 停用账号，再在此吊销 Key。
          </p>
        </div>
        <div>
          <label class="label">使用者名 *</label>
          <input v-model="bulkUser" class="input" placeholder="与 Key 归属的使用者名完全一致" @keyup.enter="doBulk" />
        </div>
        <div>
          <label class="label">吊销原因</label>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="r in REASONS" :key="r.v" type="button"
              :class="bulkReason === r.v ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'" @click="bulkReason = r.v">{{
              r.label
              }}</button>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn-ghost" @click="bulkOpen = false">取消</button>
        <button class="btn-danger" :disabled="bulkBusy" @click="doBulk">
          <Icon name="power" :size="15" /> {{ bulkBusy ? '吊销中…' : '全部吊销' }}
        </button>
      </template>
    </Modal>
  </div>
</template>
