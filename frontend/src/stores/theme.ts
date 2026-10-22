import { defineStore } from "pinia";
import { ref, computed } from "vue";

const STORAGE_KEY = "mgw-theme";

type Theme = "light" | "dark";

/** 首次进入跟随系统；用户手动切换后记住选择 */
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * 亮/暗主题。真正的配色由 styles/base.css 里的 CSS 变量承担，
 * 这里只负责切换 html.dark 并持久化。
 */
export const useThemeStore = defineStore("theme", () => {
  const theme = ref<Theme>(initialTheme());
  const isDark = computed(() => theme.value === "dark");

  function apply(next: Theme): void {
    theme.value = next;
    document.documentElement.classList.toggle("dark", next === "dark");
  }

  function toggle(): void {
    const next: Theme = theme.value === "dark" ? "light" : "dark";
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 忽略持久化失败 */
    }
  }

  /** 首屏防闪烁由 index.html 内联脚本完成，这里只做状态与 DOM 对齐 */
  function init(): void {
    apply(theme.value);
  }

  return { theme, isDark, toggle, init };
});
