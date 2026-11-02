import {
  defineConfig,
  presetUno,
  presetAttributify,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss';

/**
 * 黑白毛玻璃（Monochrome Glassmorphism）主题。
 *
 * 设计语言：
 * - 底：近黑 (#08080a) + 两处极低透明度白色径向光晕，营造纵深而非死黑
 * - 面：半透明白 (white/4~8) + backdrop-blur + 1px white/10 描边 + 内高光，即「磨砂玻璃」
 * - 字：白/90 主、白/50 次、白/30 弱，纯单色阶，不用彩色
 * - 强调：纯白作为唯一「主色」，主按钮=白底黑字，与玻璃面形成强对比
 *
 * 所有可复用观感沉淀为 shortcuts，页面只写语义类名（glass / btn-primary），
 * 保证 8 个页面视觉一致，改主题只动这一处。
 */
export default defineConfig({
  presets: [presetUno({ dark: 'class' }), presetAttributify()],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    colors: {
      // 单色阶：ink = 黑侧，mist = 白侧
      ink: {
        900: '#08080a',
        800: '#0d0d10',
        700: '#141418',
        600: '#1c1c22',
      },
    },
  },
  shortcuts: {
    // ── 玻璃面 ──
    glass: 'bg-white/[0.045] backdrop-blur-xl border border-white/10 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.45)]',
    'glass-hover': 'transition-all duration-200 hover:bg-white/[0.08] hover:border-white/20',
    'glass-panel': 'bg-white/[0.03] backdrop-blur-2xl border border-white/[0.08]',
    'glass-inset': 'bg-black/20 border border-white/[0.06] rounded-xl',
    // 顶部内高光，玻璃质感的关键一笔
    'glass-sheen': 'before:content-empty before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/25 before:to-transparent',
    // 玻璃卡片 = 玻璃面 + 内高光 + 定位上下文 + 溢出裁剪（伪元素高光需 relative）。shortcut 可递归引用其他 shortcut
    'glass-card': 'glass glass-sheen relative overflow-hidden',

    // ── 文本 ──
    'text-title': 'text-white/90 font-semibold tracking-tight',
    'text-body': 'text-white/70',
    'text-muted': 'text-white/40',
    'text-faint': 'text-white/25',

    // ── 按钮 ──
    btn: 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-all duration-150 cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap',
    'btn-primary': 'btn bg-white text-black hover:bg-white/85 active:scale-[0.98] shadow-[0_2px_12px_rgba(255,255,255,0.15)]',
    'btn-ghost': 'btn bg-white/[0.04] text-white/80 border border-white/10 hover:bg-white/[0.09] hover:text-white active:scale-[0.98]',
    'btn-danger': 'btn bg-white/[0.06] text-red-300 border border-red-400/20 hover:bg-red-500/15 hover:border-red-400/40',
    'btn-sm': 'btn px-2.5 py-1 text-xs rounded-md',
    'btn-icon': 'btn px-2 py-2',

    // ── 分段控件（右上角 tab 切换专用）──
    // 一个内缩容器 + N 个 seg-item；active 项白底黑字 + 微光，inactive 默认低透，hover 逐层高亮
    'seg-group': 'inline-flex items-center gap-0.5 p-1 rounded-xl glass-inset shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]',
    'seg-item':
      'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer select-none whitespace-nowrap transition-all duration-180 text-white/45 hover:text-white/80 hover:bg-white/[0.05]',
    'seg-item-active':
      'seg-item !text-black !bg-white hover:!bg-white shadow-[0_1px_10px_rgba(255,255,255,0.18)]',

    // ── 表单 ──
    input: 'w-full bg-black/25 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 placeholder-white/25 outline-none transition-colors focus:border-white/35 focus:bg-black/35',
    'input-sm': 'input px-2.5 py-1.5 text-xs rounded-md',
    label: 'block text-xs font-medium text-white/45 mb-1.5 tracking-wide',
    select: 'input appearance-none cursor-pointer',

    // ── 表格 ──
    th: 'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-white/35 border-b border-white/[0.08]',
    td: 'px-4 py-3 text-sm text-white/75 border-b border-white/[0.05]',
    'tr-hover': 'transition-colors hover:bg-white/[0.035]',

    // ── 标签/徽章 ──
    chip: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border',
    'chip-on': 'chip bg-white/10 text-white/85 border-white/15',
    'chip-off': 'chip bg-white/[0.03] text-white/35 border-white/[0.08]',
    'chip-ok': 'chip bg-emerald-400/10 text-emerald-300/90 border-emerald-400/20',
    'chip-err': 'chip bg-red-400/10 text-red-300/90 border-red-400/20',
    'chip-warn': 'chip bg-amber-400/10 text-amber-300/90 border-amber-400/20',

    // ── 布局 ──
    'nav-item': 'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-white/55 transition-all duration-150 cursor-pointer hover:bg-white/[0.06] hover:text-white/90',
    'nav-item-active': 'nav-item bg-white/[0.09] text-white border border-white/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]',
    'page-title': 'text-xl font-semibold text-white/90 tracking-tight',
    'stat-num': 'text-3xl font-bold text-white tracking-tight tabular-nums',
    'scrollbar-thin': '[scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.15)_transparent]',
  },
});
