import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth';

/**
 * 路由。用 hash 模式：静态托管（Nginx/任意静态服务器）无需 rewrite 规则即可直达子路由。
 * 除登录页外全部包在 AdminLayout 下，视图懒加载（首屏只下载登录+布局+仪表盘）。
 */
const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('../views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: () => import('../layouts/AdminLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/Dashboard.vue'), meta: { title: '仪表盘', icon: 'gauge' } },
      { path: 'upstreams', name: 'upstreams', component: () => import('../views/Upstreams.vue'), meta: { title: '上游服务', icon: 'server' } },
      { path: 'tools', name: 'tools', component: () => import('../views/Tools.vue'), meta: { title: '工具目录', icon: 'tool' } },
      { path: 'permissions', name: 'permissions', component: () => import('../views/Permissions.vue'), meta: { title: '权限矩阵', icon: 'shield' } },
      { path: 'keys', name: 'keys', component: () => import('../views/Keys.vue'), meta: { title: 'API Key', icon: 'key' } },
      { path: 'audit', name: 'audit', component: () => import('../views/Audit.vue'), meta: { title: '审计日志', icon: 'list' } },
      { path: 'changes', name: 'changes', component: () => import('../views/Changes.vue'), meta: { title: '变更记录', icon: 'history' } },
      { path: 'reports', name: 'reports', component: () => import('../views/Reports.vue'), meta: { title: '数据报表', icon: 'chart' } },
      { path: 'breaker', name: 'breaker', component: () => import('../views/Breaker.vue'), meta: { title: '熔断事件', icon: 'shield' } },
      { path: 'backups', name: 'backups', component: () => import('../views/Backups.vue'), meta: { title: '数据库备份', icon: 'box' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.public) {
    // 已登录还去登录页 → 回仪表盘
    if (to.name === 'login' && auth.authenticated) return { name: 'dashboard' };
    return true;
  }
  if (!auth.authenticated) return { name: 'login', query: { redirect: to.fullPath } };
  return true;
});

/** 侧边栏导航项（从路由表派生，避免两处维护） */
export const navItems = routes[1].children!
  .filter((r) => r.meta?.title)
  .map((r) => ({
    name: r.name as string,
    path: `/${r.path}`,
    title: r.meta!.title as string,
    icon: r.meta!.icon as string,
  }));
