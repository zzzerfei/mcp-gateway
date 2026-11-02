/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// UnoCSS 虚拟模块
declare module 'virtual:uno.css' {
  const css: string;
  export default css;
}
