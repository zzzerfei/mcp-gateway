import {
  defineConfig,
  presetUno,
  presetAttributify,
  transformerDirectives,
  transformerVariantGroup,
} from "unocss";

/**
 * 语义 token 主题（与 Logto 控制台观感对齐）。
 *
 * 颜色全部指向 styles/base.css 里的 CSS 变量，亮/暗两套值在那里切换：
 * - 基底：page / surface / surface-2 / inset / overlay
 * - 文字：fg / muted / faint
 * - 描边：line / line-strong
 * - 品牌：#398FF6 仅作填充与图形；文字态用 accent-text（亮 #1873D6 / 暗 #5AA4F8），
 *   实心按钮用 accent-solid（白字 4.71:1）
 * - 状态：ok / warn / danger，各带 -soft 底与 -line 描边
 *
 * 页面只写语义类名，禁止再出现 white/xx、black/xx 这类透明度色。
 */
export default defineConfig({
  presets: [presetUno({ dark: "class" }), presetAttributify()],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    colors: {
      page: "var(--mgw-bg)",
      surface: "var(--mgw-surface)",
      "surface-2": "var(--mgw-surface-2)",
      inset: "var(--mgw-inset)",
      overlay: "var(--mgw-overlay)",
      glass: "var(--mgw-glass-bg)",
      fg: "var(--mgw-fg)",
      muted: "var(--mgw-muted)",
      faint: "var(--mgw-faint)",
      line: "var(--mgw-line)",
      "line-strong": "var(--mgw-line-strong)",
      accent: "var(--mgw-accent)",
      "accent-solid": "var(--mgw-accent-solid)",
      "accent-solid-hover": "var(--mgw-accent-solid-hover)",
      "accent-text": "var(--mgw-accent-text)",
      "accent-soft": "var(--mgw-accent-soft)",
      "accent-line": "var(--mgw-accent-line)",
      "accent-fg": "var(--mgw-accent-fg)",
      ok: "var(--mgw-ok)",
      "ok-soft": "var(--mgw-ok-soft)",
      "ok-line": "var(--mgw-ok-line)",
      warn: "var(--mgw-warn)",
      "warn-soft": "var(--mgw-warn-soft)",
      "warn-line": "var(--mgw-warn-line)",
      danger: "var(--mgw-danger)",
      "danger-soft": "var(--mgw-danger-soft)",
      "danger-line": "var(--mgw-danger-line)",
    },
    boxShadow: {
      card: "var(--mgw-shadow-card)",
    },
  },
  shortcuts: {
    // ── 面 ──
    glass:
      "bg-glass backdrop-blur-xl border border-line rounded-2xl shadow-card",
    "glass-hover":
      "transition-all duration-200 hover:border-line-strong hover:shadow-md",
    "glass-panel": "bg-glass backdrop-blur-2xl border border-line",
    "glass-inset": "bg-inset border border-line rounded-xl",
    "glass-sheen":
      "before:content-empty before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-[var(--mgw-sheen)] before:to-transparent",
    "glass-card": "glass glass-sheen relative overflow-hidden",

    // ── 文本 ──
    "text-title": "text-fg font-semibold tracking-tight",
    "text-body": "text-muted",

    // ── 按钮 ──
    btn: "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-all duration-150 cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap",
    "btn-primary":
      "btn bg-accent-solid text-accent-fg hover:bg-accent-solid-hover active:scale-[0.98]",
    "btn-ghost":
      "btn bg-surface text-fg border border-line hover:bg-surface-2 hover:border-line-strong active:scale-[0.98]",
    "btn-danger":
      "btn bg-danger-soft text-danger border border-danger-line hover:border-danger",
    "btn-sm": "btn px-2.5 py-1 text-xs rounded-md",
    "btn-icon": "btn px-2 py-2",

    // ── 分段控件 ──
    "seg-group":
      "inline-flex items-center gap-0.5 p-1 rounded-xl bg-inset border border-line",
    "seg-item":
      "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer select-none whitespace-nowrap transition-all duration-180 text-muted hover:text-fg hover:bg-surface",
    "seg-item-active":
      "seg-item !text-accent-fg !bg-accent-solid hover:!bg-accent-solid",

    // ── 表单 ──
    input:
      "w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-fg placeholder-faint outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent-soft",
    "input-sm": "input px-2.5 py-1.5 text-xs rounded-md",
    label: "block text-xs font-medium text-muted mb-1.5 tracking-wide",
    select: "input appearance-none cursor-pointer",

    // ── 表格 ──
    th: "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-faint border-b border-line",
    td: "px-4 py-3 text-sm text-fg border-b border-line",
    "tr-hover": "transition-colors hover:bg-surface-2",

    // ── 标签/徽章 ──
    chip: "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border",
    "chip-on": "chip bg-accent-soft text-accent-text border-accent-line",
    "chip-off": "chip bg-surface-2 text-faint border-line",
    "chip-ok": "chip bg-ok-soft text-ok border-ok-line",
    "chip-err": "chip bg-danger-soft text-danger border-danger-line",
    "chip-warn": "chip bg-warn-soft text-warn border-warn-line",

    // ── 布局 ──
    "nav-item":
      "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-muted transition-all duration-150 cursor-pointer hover:bg-surface-2 hover:text-fg",
    "nav-item-active":
      "nav-item bg-accent-soft text-accent-text border border-accent-line",
    "page-title": "text-xl font-semibold text-fg tracking-tight",
    "stat-num": "text-3xl font-bold text-fg tracking-tight tabular-nums",
    "scrollbar-thin":
      "[scrollbar-width:thin] [scrollbar-color:var(--mgw-line-strong)_transparent]",
  },
});
