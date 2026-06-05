'use strict';

const App = (() => {
  const routes = {
    '/': { title: 'dashboard', component: DashboardComponent },
    '/system': { title: 'system', component: SystemMonitorComponent },
    '/services': { title: 'services', component: ServicesComponent },
    '/docker': { title: 'docker', component: DockerComponent },
    '/clickhouse': { title: 'clickhouse', component: ClickHouseComponent },
    '/network': { title: 'network', component: NetworkCheckComponent },
    '/trading-bot': { title: 'trading bot', component: TradingBotComponent },
    '/backtest': { title: 'backtest', component: BacktestComponent },
    '/nanobot-service': { title: 'nanobot service', component: NanobotServiceComponent },
    '/nanobot-cron': { title: 'nanobot cron', component: NanobotCronComponent },
    '/nanobot-logs': { title: 'nanobot logs', component: NanobotClickhouseLogsComponent },
    '/explore-workspace': { title: 'explore workspace', component: ExploreWorkspaceComponent },
    '/navidrome-music': { title: 'navidrome music', component: NavidromeMusicComponent },
    '/receipt-scanner-logs': { title: 'receipt scanner', component: ReceiptScannerLogsComponent },
    '/settings': { title: 'settings', component: SettingsComponent },
  };

  const SIDEBAR_COLLAPSED_KEY = 'alapaap-sidebar-collapsed';

  let currentComponent = null;
  let overlay = null;

  function init() {
    overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    document.body.appendChild(overlay);

    document.getElementById('hamburger').addEventListener('click', toggleSidebar);
    document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
    overlay.addEventListener('click', closeSidebar);
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('sidebar-collapse-btn').addEventListener('click', toggleSidebarCollapse);

    window.addEventListener('hashchange', onRoute);
    window.addEventListener('resize', onResize);

    checkAuth();
    restoreSidebarState();
  }

  async function checkAuth() {
    const token = Api.getToken();
    if (!token) {
      showLogin();
      return;
    }
    try {
      const user = await Api.get('/api/auth/me');
      document.getElementById('user-display').textContent = user.username || 'admin';
      showMain();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    Api.clearToken();
    WsClient.disconnect();
    document.getElementById('login-view').classList.remove('hidden');
    document.getElementById('main-view').classList.add('hidden');
    LoginComponent.render(document.getElementById('login-view'));
  }

  async function showMain() {
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('main-view').classList.remove('hidden');

    try {
      const user = await Api.get('/api/auth/me');
      document.getElementById('user-display').textContent = user.username || 'admin';
    } catch { /* ignore */ }

    WsClient.connect();
    onRoute();
  }

  function onRoute() {
    const hash = window.location.hash.slice(1) || '/';
    const route = routes[hash] || routes['/'];

    if (currentComponent && currentComponent.destroy) {
      currentComponent.destroy();
    }

    document.getElementById('page-title').textContent = `>_ ${route.title}`;

    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.route === hash || (hash === '' && link.dataset.route === '/'));
    });

    const content = document.getElementById('content');
    content.innerHTML = '';
    currentComponent = route.component;
    currentComponent.render(content);
    PanelCollapse.init(content);

    closeSidebar();
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    overlay.classList.remove('active');
  }

  function toggleSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const btn = document.getElementById('sidebar-collapse-btn');
    const isCollapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed ? '1' : '0');
    btn.innerHTML = isCollapsed ? '&#x00BB;' : '&#x00AB;';
  }

  function restoreSidebarState() {
    if (window.innerWidth < 768) return;
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
      const sidebar = document.getElementById('sidebar');
      const btn = document.getElementById('sidebar-collapse-btn');
      sidebar.classList.add('collapsed');
      btn.innerHTML = '&#x00BB;';
    }
  }

  function onResize() {
    const sidebar = document.getElementById('sidebar');
    if (window.innerWidth < 768) {
      sidebar.classList.remove('collapsed');
    } else {
      restoreSidebarState();
    }
  }

  async function handleLogout() {
    try { await Api.post('/api/auth/logout'); } catch { /* ignore */ }
    Api.clearToken();
    WsClient.disconnect();
    showLogin();
  }

  function toast(message, type = 'ok') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showLogin, showMain, toast };
})();
