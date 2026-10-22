import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useThemeStore } from './stores/theme';
import './styles/base.css';
import 'virtual:uno.css';

/**
 * 应用入口。装配顺序：Pinia（状态）→ Router（路由）→ 全局样式 → UnoCSS 原子化。
 * UnoCSS 的 virtual:uno.css 必须在 base.css 之后引入，保证原子类优先级覆盖基础样式。
 */
const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
useThemeStore(pinia).init();
app.use(router);
app.mount('#app');
