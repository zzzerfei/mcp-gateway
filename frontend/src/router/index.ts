import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from "vue-router";
import { useAuthStore } from "../stores/auth";

/**
 * 路由。用 history 模式：OIDC 回调是 `/callback?code=...`（真实路径 + query），
 * hash 路由接不住；生产环境 Nginx 需配 `try_files $uri $uri/ /index.html`。
 * 除登录页/回调页外全部包在 AdminLayout 下，视图懒加载（首屏只下载登录+布局+仪表盘）。
 */
const adminRoutes: RouteRecordRaw[] = [
  { path: "", redirect: "/dashboard" },
  {
    path: "dashboard",
    name: "dashboard",
    component: () => import("../views/Dashboard.vue"),
    meta: { title: "仪表盘", icon: "gauge" },
  },
  {
    path: "upstreams",
    name: "upstreams",
    component: () => import("../views/Upstreams.vue"),
    meta: { title: "上游服务", icon: "server" },
  },
  {
    path: "tools",
    name: "tools",
    component: () => import("../views/Tools.vue"),
    meta: { title: "工具目录", icon: "tool" },
  },
  {
    path: "permissions",
    name: "permissions",
    component: () => import("../views/Permissions.vue"),
    meta: { title: "权限矩阵", icon: "shield" },
  },
  {
    path: "keys",
    name: "keys",
    component: () => import("../views/Keys.vue"),
    meta: { title: "API Key", icon: "key", sensitive: true },
  },
  {
    path: "audit",
    name: "audit",
    component: () => import("../views/Audit.vue"),
    meta: { title: "审计日志", icon: "list", sensitive: true },
  },
  {
    path: "changes",
    name: "changes",
    component: () => import("../views/Changes.vue"),
    meta: { title: "变更记录", icon: "history", sensitive: true },
  },
  {
    path: "reports",
    name: "reports",
    component: () => import("../views/Reports.vue"),
    meta: { title: "数据报表", icon: "chart" },
  },
  {
    path: "breaker",
    name: "breaker",
    component: () => import("../views/Breaker.vue"),
    meta: { title: "熔断事件", icon: "shield" },
  },
  {
    path: "backups",
    name: "backups",
    component: () => import("../views/Backups.vue"),
    meta: { title: "数据库备份", icon: "box", sensitive: true },
  },
  {
    path: "cases",
    name: "cases",
    component: () => import("../views/Cases.vue"),
    meta: { title: "冒烟用例", icon: "check" },
  },
];

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("../views/Login.vue"),
    meta: { public: true },
  },
  {
    path: "/callback",
    name: "callback",
    component: () => import("../views/Callback.vue"),
    meta: { public: true },
  },
  {
    path: "/pending",
    name: "pending",
    component: () => import("../views/Pending.vue"),
    meta: { title: "待开通" },
  },
  {
    path: "/",
    component: () => import("../layouts/AdminLayout.vue"),
    children: adminRoutes,
  },
  { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.init();
  if (to.meta.public) {
    // 已登录还去登录页 → 回仪表盘（未开通则去待开通页）
    if (to.name === "login" && auth.authenticated)
      return auth.hasAccess ? { name: "dashboard" } : { name: "pending" };
    return true;
  }
  if (!auth.authenticated)
    return { name: "login", query: { redirect: to.fullPath } };
  // 已登录但没有任何网关 scope：只能停在待开通页
  if (to.name === "pending")
    return auth.hasAccess ? { name: "dashboard" } : true;
  if (!auth.hasAccess) return { name: "pending" };
  // 敏感页面（审计/变更/Key/备份）要求 gateway:sensitive
  if (to.meta.sensitive && !auth.canSensitive) return { name: "dashboard" };
  return true;
});

/** 侧边栏导航项（从路由表派生，避免两处维护） */
export const navItems = adminRoutes
  .filter((r) => r.meta?.title)
  .map((r) => ({
    name: r.name as string,
    path: `/${r.path}`,
    title: r.meta!.title as string,
    icon: r.meta!.icon as string,
    sensitive: !!r.meta!.sensitive,
  }));
