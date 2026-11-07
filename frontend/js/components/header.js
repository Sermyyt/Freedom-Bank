// Шапка: вкладки, активная версия чек-листа, состояние сервера, постоянная плашка демо.
import { h } from '../dom.js';
import { isDemo, state, subscribe } from '../state.js';

const TABS = [
  { route: 'conversations', label: 'Разговоры', also: ['conversation', 'compare'] },
  { route: 'checklist', label: 'Чек-лист' },
  { route: 'appeals', label: 'Апелляции' },
];

function healthView(current) {
  if (current.healthError && !current.health) {
    return { text: 'Сервер недоступен', tone: 'bad', title: current.healthError.message };
  }
  if (!current.health) return { text: 'Проверка сервера…', tone: 'neutral', title: '' };
  const health = current.health;
  const stale = current.healthError ? ' Последняя проверка не удалась.' : '';
  const details = [
    `Провайдер: ${health.provider}${health.model ? ` (${health.model})` : ''}`,
    `Оценка: ${health.evaluation_ready ? 'доступна' : 'недоступна'}`,
    `Импорт группы с сервера: ${health.dataset_ready ? 'настроен' : 'не настроен'}`,
    `База данных: ${health.database_ready ? 'готова' : 'не готова'}`,
  ].join('\n');
  if (current.healthError) return { text: 'Сервер не отвечает', tone: 'bad', title: details + stale };
  if (health.status === 'ok') return { text: 'Сервер работает', tone: 'good', title: details };
  return { text: 'Сервер работает с ограничениями', tone: 'warn', title: details };
}

export function createHeader() {
  const tabLinks = TABS.map((tab) =>
    h('a', { class: 'cqa-tab', href: `#/${tab.route}`, dataset: { route: tab.route }, text: tab.label }),
  );
  const version = h('span', { class: 'cqa-header-version' });
  const health = h('span', { class: 'cqa-health' });
  const demo = h(
    'div',
    { class: 'cqa-demo-banner', role: 'status', hidden: true },
    h('strong', { text: 'Демо: оценки синтетические.' }),
    ' Сервер работает на демо-провайдере: баллы и обоснования не отражают качество разговора.',
  );

  const el = h(
    'div',
    { class: 'cqa-top' },
    h(
      'header',
      { class: 'cqa-header' },
      h('div', { class: 'cqa-brand' }, h('strong', { text: 'CQA' }), h('span', { text: 'Контроль качества разговоров' })),
      h('nav', { class: 'cqa-tabs', 'aria-label': 'Разделы' }, tabLinks),
      h('div', { class: 'cqa-header-status' }, version, health),
    ),
    demo,
  );

  function render(current) {
    const view = healthView(current);
    health.className = `cqa-health cqa-health--${view.tone}`;
    health.textContent = view.text;
    health.title = view.title;

    if (current.activeVersion) {
      version.textContent = `Чек-лист v${current.activeVersion.version}`;
      version.title = current.activeVersion.definition ? current.activeVersion.definition.name : '';
    } else if (current.health && !current.health.active_checklist_version_id) {
      version.textContent = 'Нет активного чек-листа';
      version.title = '';
    } else {
      version.textContent = '';
    }
    demo.hidden = !isDemo();

    const listTab = tabLinks[0];
    listTab.setAttribute('href', current.lastListHash || '#/conversations');
  }

  function setActive(routeName) {
    for (const [index, link] of tabLinks.entries()) {
      const tab = TABS[index];
      const active = tab.route === routeName || (tab.also || []).includes(routeName);
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    render(state);
  }

  // Высота закреплённой шапки (с плашкой демо) — для «липких» колонок карточки разговора.
  function trackHeight(root) {
    const apply = () => root.style.setProperty('--cqa-top-offset', `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(el);
  }

  subscribe(render);
  render(state);
  return { el, setActive, trackHeight };
}
