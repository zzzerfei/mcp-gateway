import { reactive } from 'vue';

/**
 * 极简全局 Toast。用一个模块级 reactive 数组承载消息，
 * <ToastHost> 订阅渲染。避免为通知引第三方库。
 */
export type ToastKind = 'success' | 'error' | 'info' | 'warn';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const state = reactive<{ list: Toast[] }>({ list: [] });
let seq = 0;

export function useToast() {
  function push(kind: ToastKind, message: string, duration = 3200): void {
    const id = ++seq;
    state.list.push({ id, kind, message });
    setTimeout(() => dismiss(id), duration);
  }
  function dismiss(id: number): void {
    const i = state.list.findIndex((t) => t.id === id);
    if (i >= 0) state.list.splice(i, 1);
  }
  return {
    list: state.list,
    dismiss,
    success: (m: string) => push('success', m),
    error: (m: string) => push('error', m, 4200),
    info: (m: string) => push('info', m),
    warn: (m: string) => push('warn', m, 4000),
  };
}
