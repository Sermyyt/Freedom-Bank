// Шапка: марка, вкладки со скользящим индикатором, активная версия чек-листа, состояние сервера,
// постоянная плашка демо. При прокрутке шапка уплотняется и получает тень (класс на .cqa-top).
import { h } from '../dom.js';
import { isDemo, state, subscribe } from '../state.js';
import { brandMark } from './art.js';

const TABS = [
  { route: 'home', label: 'Главная' },
  { route: 'conversations', label: 'Разговоры', also: ['conversation', 'compare'] },
  { route: 'checklist', label: 'Чек-лист' },
  { route: 'appeals', label: 'Апелляции' },
  { route: 'history', label: 'История' },
];

// Ширина индикатора в CSS; на вкладку он растягивается через scaleX.
const INDICATOR_BASE = 40;

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
    `Импорт группы по ID: ${health.dataset_ready ? 'настроен' : 'не настроен'}`,
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
  const indicator = h('span', { class: 'cqa-tab-indicator', 'aria-hidden': 'true' });
  const track = h('div', { class: 'cqa-tabs-track' }, tabLinks, indicator);
  const nav = h('nav', { class: 'cqa-tabs', 'aria-label': 'Разделы' }, track);
  const version = h('a', { class: 'cqa-header-version', href: '#/checklist', hidden: true });
  const health = h('span', { class: 'cqa-health' });
  const demo = h(
    'div',
    { class: 'cqa-demo-banner', role: 'status', hidden: true },
    h('strong', { text: 'Демо: оценки синтетические.' }),
    h('span', { text: ' Баллы и обоснования не отражают качество разговора.' }),
  );

  const el = h(
    'div',
    { class: 'cqa-top' },
    h(
      'header',
      { class: 'cqa-header' },
      h('div', { class: 'cqa-header-inner' },
        h('a', { class: 'cqa-brand', href: '#/home', 'aria-label': 'CQA — главная' },
          brandMark(),
          h('span', { class: 'cqa-brand-text' }, h('strong', { text: 'CQA' }), h('span', { class: 'cqa-brand-sub', text: 'Контроль качества разговоров' }))),
        nav,
        h('div', { class: 'cqa-header-status' }, version, health)),
    ),
    demo,
  );

  let activeIndex = -1;

  function placeIndicator() {
    const link = tabLinks[activeIndex];
    if (!link || !link.offsetWidth) {
      indicator.style.opacity = '0';
      return;
    }
    indicator.style.opacity = '1';
    indicator.style.transform = `translateX(${link.offsetLeft}px) scaleX(${link.offsetWidth / INDICATOR_BASE})`;
    // Первое положение ставится без анимации; дальше индикатор скользит между вкладками.
    if (!indicator.classList.contains('is-ready')) requestAnimationFrame(() => indicator.classList.add('is-ready'));
  }

  // На узком экране вкладки прокручиваются внутри полосы: активная должна быть видна.
  function keepActiveVisible() {
    const link = tabLinks[activeIndex];
    if (!link || nav.scrollWidth <= nav.clientWidth) return;
    const left = link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
  }

  function render(current) {
    const view = healthView(current);
    health.className = `cqa-health cqa-health--${view.tone}`;
    health.textContent = view.text;
    health.title = view.title;

    if (current.activeVersion) {
      version.textContent = `Чек-лист v${current.activeVersion.version}`;
      version.title = current.activeVersion.definition ? current.activeVersion.definition.name : '';
      version.hidden = false;
    } else if (current.health && !current.health.active_checklist_version_id) {
      version.textContent = 'Нет активного чек-листа';
      version.title = '';
      version.hidden = false;
    } else {
      version.hidden = true;
    }
    demo.hidden = !isDemo();
    tabLinks[1].setAttribute('href', current.lastListHash || '#/conversations');
  }

  function setActive(routeName) {
    activeIndex = TABS.findIndex((tab) => tab.route === routeName || (tab.also || []).includes(routeName));
    for (const [index, link] of tabLinks.entries()) {
      const active = index === activeIndex;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    render(state);
    placeIndicator();
    keepActiveVisible();
  }

  // Высота закреплённой шапки (с плашкой демо) — для «липких» колонок карточки разговора.
  function trackHeight(root) {
    const apply = () => {
      root.style.setProperty('--cqa-top-offset', `${el.offsetHeight}px`);
      placeIndicator();
    };
    apply();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(apply);
      observer.observe(el);
      observer.observe(track);
    }
  }

  // Уплотнение при прокрутке: только класс, сами изменения — transform и opacity в CSS.
  function trackScroll() {
    let frame = 0;
    const update = () => {
      frame = 0;
      el.classList.toggle('is-condensed', window.scrollY > 8);
    };
    window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
    update();
  }

  subscribe(render);
  render(state);
  return { el, setActive, trackHeight, trackScroll };
}
