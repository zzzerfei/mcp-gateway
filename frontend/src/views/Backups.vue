<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { api, type BackupItem, type BackupSummary, type Paged } from '../api';
import { fmtTime, fmtAgo, fmtBytes, fmtDuration, fmtNum } from '../utils/format';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import Icon from '../components/Icon.vue';
import Spinner from '../components/Spinner.vue';
import Empty from '../components/Empty.vue';

/**
 * P1-A・数据库备份面板。
 * 展示：策略概览 + 手动触发 + 历史列表 + 下载。
 * 数据源：/admin/api/backups/summary（顶部）+ /admin/api/backups（分页列表）。
 */

const toast = useToast();
const loading = ref(true);
const running = ref(false);
const summary = ref<BackupSummary | null>(null);
const data = ref<Paged<BackupItem>>({ total: 0, page: 1, size: 20, rows: [] });
const f = reactive({ status: '' as '' | 'ok' | 'failed' });
const page = ref(1);

async function loadSummary(): Promise<void> {
  try {
    summary.value = await api.backup.summary();
  } catch (e) {
    toast.error((e as Error).message);
  }
}
async function loadList(): Promise<void> {
  try {
    const q: Record<string, unknown> = { page: page.value, size: 20 };
    if (f.status) q.status = f.status;
    data.value = await api.backup.list(q);
  } catch (e) {
    toast.error((e as Error).message);
  }
}
async function refreshAll(): Promise<void> {
  loading.value = true;
  await Promise.all([loadSummary(), loadList()]);
  loading.value = false;
}
onMounted(refreshAll);

async function doRun(): Promise<void> {
  if (running.value) return;
  running.value = true;
  try {
    const row = await api.backup.run();
    if (row.status === 'ok') toast.success(`备份完成 · ${fmtBytes(row.bytes)} · ${fmtDuration(row.durationMs)}`);
    else toast.error(`备份失败：${row.errorMsg ?? '未知错误'}`);
    await refreshAll();
  } catch (e) {
    toast.error((e as Error).message);
  }
  running.value = false;
}

async function doDownload(row: BackupItem): Promise<void> {
  try {
    await api.backup.download(row.id, row.filename);
    toast.success('已开始下载');
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function onFilter(): void {
  page.value = 1;
  loadList();
}
const totalPages = computed(() => Math.max(1, Math.ceil(data.value.total / 20)));
function goPage(p: number): void {
  const c = Math.min(Math.max(1, p), totalPages.value);
  if (c === page.value) return;
  page.value = c;
  loadList();
}
</script>

<template>
  <div>
    <PageHeader
      title="数据库备份"
      subtitle="使用 better-sqlite3 官方在线备份 API（WAL 下不丢数据），默认每天 03:00 自动执行，滚动保留。备份文件位于 <dataDir>/backup/ 目录。"
    >
      <template #actions>
        <button class="btn-ghost" @click="refreshAll"><Icon name="refresh" :size="15" /> 刷新</button>
        <button class="btn-primary" :disabled="running" @click="doRun">
          <Icon name="box" :size="15" /> {{ running ? '备份中…' : '立即备份' }}
        </button>
      </template>
    </PageHeader>

    <Spinner v-if="loading" label="加载备份数据…" />

    <template v-else>
      <!-- 概览 4 张卡 -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="power" :size="13" /> 自动备份
          </div>
          <div class="stat-num" :class="summary?.enabled ? '' : 'text-muted'">
            {{ summary?.enabled ? '已启用' : '已禁用' }}
          </div>
          <div class="text-[11px] text-faint mt-1 mono truncate" :title="`${summary?.cron ?? ''} · ${summary?.tz ?? ''}`">
            {{ summary?.cron }} · {{ summary?.tz }}
          </div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="check" :size="13" /> 最近成功备份
          </div>
          <div class="stat-num text-base truncate" :title="summary?.latest?.filename">
            {{ summary?.latest ? fmtAgo(summary.latest.ts) : '—' }}
          </div>
          <div class="text-[11px] text-faint mt-1">
            <template v-if="summary?.latest">
              {{ fmtBytes(summary.latest.bytes) }} · {{ fmtDuration(summary.latest.durationMs) }} ·
              {{ summary.latest.trigger === 'cron' ? '定时' : '手动' }}
            </template>
            <template v-else>尚未执行过备份</template>
          </div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="alert" :size="13" /> 最近一次失败
          </div>
          <div class="stat-num text-base" :class="summary?.lastFailed ? 'text-danger' : 'text-muted'">
            {{ summary?.lastFailed ? fmtAgo(summary.lastFailed.ts) : '无' }}
          </div>
          <div class="text-[11px] text-faint mt-1 truncate" :title="summary?.lastFailed?.errorMsg ?? ''">
            {{ summary?.lastFailed?.errorMsg ?? '所有备份均正常' }}
          </div>
        </div>
        <div class="glass-card p-5">
          <div class="text-[11px] text-faint mb-2 flex items-center gap-1.5">
            <Icon name="box" :size="13" /> 保留 / 占用
          </div>
          <div class="stat-num">{{ fmtNum(summary?.totalCount ?? 0) }}</div>
          <div class="text-[11px] text-faint mt-1">
            保留 {{ summary?.keep }} 份 · 累计 {{ fmtBytes(summary?.totalBytes ?? 0) }}
          </div>
        </div>
      </div>

      <!-- 历史列表 -->
      <div class="glass-card overflow-hidden">
        <div class="px-5 pt-4 pb-3 flex flex-wrap items-center gap-3 border-b border-line">
          <Icon name="history" :size="15" class="text-muted" />
          <h3 class="text-sm font-semibold text-fg">备份历史</h3>
          <div class="ml-auto flex items-center gap-2">
            <select v-model="f.status" class="select !w-auto !py-1.5 !text-xs" @change="onFilter">
              <option value="">全部状态</option>
              <option value="ok">仅成功</option>
              <option value="failed">仅失败</option>
            </select>
          </div>
        </div>
        <div v-if="data.rows.length" class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr>
                <th class="th w-40">时间</th>
                <th class="th">文件名</th>
                <th class="th w-20">触发</th>
                <th class="th w-24 text-right">大小</th>
                <th class="th w-20 text-right">耗时</th>
                <th class="th w-20">状态</th>
                <th class="th w-20 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rows" :key="r.id" class="tr-hover">
                <td class="td">
                  <div class="text-fg text-xs tabular-nums">{{ fmtTime(r.ts) }}</div>
                  <div class="text-[10px] text-faint">{{ fmtAgo(r.ts) }}</div>
                </td>
                <td class="td mono text-xs text-fg break-all">{{ r.filename }}</td>
                <td class="td">
                  <span :class="r.trigger === 'cron' ? 'chip-off' : 'chip-on'">
                    {{ r.trigger === 'cron' ? '定时' : '手动' }}
                  </span>
                </td>
                <td class="td text-right tabular-nums text-xs text-fg">{{ fmtBytes(r.bytes) }}</td>
                <td class="td text-right tabular-nums text-xs text-muted">{{ fmtDuration(r.durationMs) }}</td>
                <td class="td">
                  <span v-if="r.status === 'ok'" class="chip-ok">成功</span>
                  <span v-else class="chip-err" :title="r.errorMsg ?? ''">失败</span>
                </td>
                <td class="td text-right">
                  <button
                    class="btn-ghost btn-sm"
                    :disabled="r.status !== 'ok'"
                    :title="r.status === 'ok' ? '下载' : '不可下载'"
                    @click="doDownload(r)"
                  >
                    <Icon name="download" :size="13" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Empty v-else text="暂无备份记录。点击右上「立即备份」生成第一份。" icon="box" />

        <div v-if="data.total > 20" class="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-line">
          <div class="text-xs text-faint tabular-nums">共 {{ data.total }} 条</div>
          <div class="flex items-center gap-1.5">
            <button class="btn-ghost btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
            <span class="text-xs text-muted tabular-nums px-2">{{ page }} / {{ totalPages }}</span>
            <button class="btn-ghost btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
          </div>
        </div>
      </div>

      <!-- 使用说明 -->
      <div class="glass-inset px-4 py-3 mt-5 text-[11px] text-muted leading-relaxed">
        <div class="flex items-center gap-1.5 mb-1">
          <Icon name="info" :size="12" /> 恢复流程
        </div>
        <ol class="list-decimal list-inside space-y-0.5">
          <li>停止网关：<code class="mono text-fg">Ctrl+C</code> 或 <code class="mono text-fg">systemctl stop mgw</code></li>
          <li>把当前 <code class="mono text-fg">data/gateway.db</code> 移走（保险起见保留一份）</li>
          <li>把要恢复的备份文件复制为 <code class="mono text-fg">data/gateway.db</code>；同名 <code class="mono text-fg">-wal</code> / <code class="mono text-fg">-shm</code> 若存在请一并清理</li>
          <li>重启网关即可（WAL 会重新生成，历史数据完整）</li>
        </ol>
      </div>
    </template>
  </div>
</template>
