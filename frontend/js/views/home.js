// Главная: обложка, живые показатели, карусель возможностей и пять шагов работы проверяющего.
// Все числа — из API (total страниц) и health; тексты слайдов — из docs/PITCH_FACTS.md.
import { api } from '../api.js';
import { heroArt, icon, slideArt } from '../components/art.js';
import { showError } from '../components/toast.js';
import { h } from '../dom.js';
import { AUTOPLAY_MS, createAutoplayClock, keyToIndex, slideLabel, swipeIntent, wrapIndex } from '../lib/carousel.js';
import { animateCount } from '../lib/count-up.js';
import { isAbortError } from '../lib/errors.js';
import { homeStats, providerLabel } from '../lib/home.js';
import { prefersReducedMotion } from '../lib/motion.js';
import { revealOnScroll } from '../lib/reveal.js';
import { buildHash } from '../lib/route.js';
import { requestImport, setViewDemo, state, subscribe } from '../state.js';

const COUNT = new Intl.NumberFormat('ru-RU');
const formatCount = (value) => COUNT.format(value);

const SLIDES = [
  {
    art: 'evidence',
    title: 'Каждая оценка — с доказательством',
    lead: 'Балл критерия ведёт к реплике, на которой он основан.',
    action: 'Открыть разговоры',
    href: () => '#/conversations',
  },
  {
    art: 'hold',
    title: 'Видно, что клиент не слышал',
    lead: 'Удержание и консультация с коллегой не засчитываются как ответ клиенту.',
    action: 'Открыть звонки',
    href: () => buildHash('conversations', [], { channel: 'voice call' }),
  },
  {
    art: 'appeal',
    title: 'Апелляция без потери истории',
    lead: 'Итог пересчитывается сразу, исходная оценка остаётся в истории.',
    action: 'К апелляциям',
    href: () => '#/appeals',
  },
  {
    art: 'rule',
    title: 'Новое правило без кода за секунды',
    lead: 'Замена критерия с переоценкой — 4,964 с в замере на настоящей модели.',
    action: 'Открыть чек-лист',
    href: () => '#/checklist',
  },
  {
    art: 'batch',
    title: 'Контрольный набор за минуты',
    lead: 'Импорт группы и «Оценить всю группу»: 65 разговоров DEV — за 636,954 с.',
    action: 'Импортировать набор',
    href: () => '#/conversations',
    importing: true,
  },
];

export function mount(container) {
  const controller = new AbortController();
  const cleanups = [];
  let stats = null;
  let statsError = null;
  const counted = new WeakSet();
  setViewDemo(false);

  // ---------- Обложка ----------
  const importLink = (cls, text) => h('a', { class: cls, href: '#/conversations', on: { click: requestImport } }, text);
  const hero = h(
    'section',
    { class: 'cqa-hero', 'aria-labelledby': 'cqa-home-title' },
    h('div', { class: 'cqa-hero-text' },
      h('h1', { id: 'cqa-home-title', class: 'cqa-hero-title' }, 'CQA — контроль качества разговоров'),
      h('p', { class: 'cqa-hero-lead', text: 'Оценка по чек-листу с доказательствами, апелляции и новые правила без правки кода.' }),
      h('div', { class: 'cqa-hero-actions' },
        h('a', { class: 'cqa-button cqa-button--light cqa-button--lg', href: '#/conversations' }, 'Открыть разговоры', icon('arrow')),
        importLink('cqa-button cqa-button--outline-light cqa-button--lg', 'Импортировать набор'))),
    h('div', { class: 'cqa-hero-art' }, heroArt()),
  );

  // ---------- Живые показатели ----------
  const kpiNodes = new Map();
  function kpi(key, label, href) {
    const value = h('span', { class: 'cqa-kpi-value' }, h('span', { class: 'cqa-skel cqa-skel--value', 'aria-hidden': 'true' }));
    const sub = h('span', { class: 'cqa-kpi-sub' });
    const body = [h('span', { class: 'cqa-kpi-label', text: label }), value, sub];
    const node = h('li', { class: 'cqa-kpi' }, href ? h('a', { class: 'cqa-kpi-link', href }, body) : h('div', { class: 'cqa-kpi-link' }, body));
    kpiNodes.set(key, { node, value, sub });
    return node;
  }
  const kpiError = h('div', { class: 'cqa-alert cqa-alert--bad cqa-kpi-error', role: 'alert', hidden: true });
  const kpis = h(
    'section',
    { class: 'cqa-kpis', 'aria-label': 'Показатели', 'aria-busy': 'true' },
    h('ul', { class: 'cqa-kpi-list' },
      kpi('conversations', 'Разговоров', '#/conversations'),
      kpi('evaluated', 'Оценено', '#/conversations'),
      kpi('manualReview', 'На ручной проверке', buildHash('conversations', [], { evaluation_status: 'manual_review' })),
      kpi('openAppeals', 'Открытых апелляций', '#/appeals'),
      kpi('version', 'Активный чек-лист', '#/checklist'),
      kpi('provider', 'Провайдер', null)),
    kpiError,
  );

  // ---------- Карусель ----------
  const slideNodes = [];
  const dots = [];
  const viewport = h('div', { class: 'cqa-carousel-viewport', 'aria-live': 'off' });
  SLIDES.forEach((slide, index) => {
    const titleId = `cqa-slide-title-${index}`;
    const action = h('a', {
      class: 'cqa-button cqa-button--primary',
      href: slide.href(),
      on: slide.importing ? { click: requestImport } : undefined,
    }, slide.action, icon('arrow'));
    const node = h(
      'div',
      { class: `cqa-slide cqa-slide--${slide.art}`, role: 'group', 'aria-roledescription': 'слайд', 'aria-labelledby': titleId, dataset: { index: String(index) } },
      h('div', { class: 'cqa-slide-text' },
        h('p', { class: 'cqa-slide-count', text: slideLabel(index, SLIDES.length) }),
        h('h3', { id: titleId, class: 'cqa-slide-title', text: slide.title }),
        h('p', { class: 'cqa-slide-lead', text: slide.lead }),
        action),
      h('div', { class: 'cqa-slide-art' }, slideArt(slide.art)),
    );
    slideNodes.push(node);
    viewport.append(node);
    dots.push(h('button', {
      type: 'button', class: 'cqa-carousel-dot', 'aria-label': `Слайд ${index + 1}: ${slide.title}`,
      on: { click: () => go(index) },
    }, h('span', { class: 'cqa-carousel-dot-fill' })));
  });
  const toggle = h('button', { type: 'button', class: 'cqa-carousel-button cqa-carousel-toggle', on: { click: toggleAutoplay } });
  const prev = h('button', { type: 'button', class: 'cqa-carousel-button', 'aria-label': 'Предыдущий слайд', on: { click: () => go(index - 1, -1) } }, icon('prev'));
  const next = h('button', { type: 'button', class: 'cqa-carousel-button', 'aria-label': 'Следующий слайд', on: { click: () => go(index + 1, 1) } }, icon('next'));
  const carousel = h(
    'section',
    { class: 'cqa-carousel', 'aria-roledescription': 'карусель', 'aria-label': 'Возможности CQA' },
    // Кнопка паузы — первой в порядке Tab: по рекомендации WAI-ARIA для автосмены.
    h('div', { class: 'cqa-carousel-controls' },
      toggle,
      h('div', { class: 'cqa-carousel-dots' }, dots),
      h('div', { class: 'cqa-carousel-arrows' }, prev, next)),
    viewport,
  );
  carousel.style.setProperty('--cqa-autoplay', `${AUTOPLAY_MS}ms`);

  // ---------- Пять шагов ----------
  const stepLive = new Map();
  function step(number, title, lead, href, liveKey, liveLabel, extra, onClick) {
    const value = h('strong', { class: 'cqa-step-live-value' }, h('span', { class: 'cqa-skel cqa-skel--inline', 'aria-hidden': 'true' }));
    stepLive.set(liveKey, value);
    return h(
      'li',
      { class: 'cqa-step' },
      h('span', { class: 'cqa-step-num', 'aria-hidden': 'true', text: String(number) }),
      h('h3', { class: 'cqa-step-title' }, h('a', { class: 'cqa-step-link', href, on: onClick ? { click: onClick } : undefined }, title)),
      h('p', { class: 'cqa-step-lead', text: lead }),
      h('div', { class: 'cqa-step-live' }, h('span', {}, `${liveLabel}: `, value), extra || null),
    );
  }
  const steps = h(
    'ol',
    { class: 'cqa-steps' },
    step(1, 'Импорт набора', 'Группа по ID или JSON-файл организаторов.', '#/conversations', 'conversations', 'Разговоров', null, requestImport),
    step(2, 'Оценка и доказательства', 'Балл по каждому критерию со ссылкой на реплику.', '#/conversations', 'evaluated', 'Оценено'),
    step(3, 'Апелляции', 'Оператор оспаривает, проверяющий решает рядом с перепиской.', '#/appeals', 'openAppeals', 'Открытых'),
    step(4, 'Правила без кода', 'Замените критерий — новая версия сразу в работе.', '#/checklist', 'version', 'Активна'),
    step(5, 'Контроль группы и история', '«Оценить всю группу» и журнал всех событий.', '#/conversations', 'events', 'Событий',
      h('a', { class: 'cqa-step-extra', href: '#/history' }, 'Открыть историю', icon('arrow'))),
  );

  const featuresSection = h('section', { class: 'cqa-home-section', 'aria-labelledby': 'cqa-features-title' },
    h('div', { class: 'cqa-section-head' }, h('h2', { id: 'cqa-features-title', text: 'Возможности' })),
    carousel);
  const stepsSection = h('section', { class: 'cqa-home-section', 'aria-labelledby': 'cqa-steps-title' },
    h('div', { class: 'cqa-section-head' }, h('h2', { id: 'cqa-steps-title', text: 'Как это работает: 5 шагов' })),
    steps);

  container.append(h('div', { class: 'cqa-page cqa-home' }, hero, kpis, featuresSection, stepsSection));

  // ---------- Обложка «дышит», только пока видна и вкладка открыта ----------
  let heroVisible = true;
  const syncHero = () => hero.classList.toggle('is-live', heroVisible && document.visibilityState !== 'hidden');
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; syncHero(); });
    observer.observe(hero);
    cleanups.push(() => observer.disconnect());
  }
  syncHero();

  // ---------- Числа: досчёт при первом показе ----------
  function setNumber(target, value, format = formatCount) {
    const finalText = value === null || value === undefined ? '—' : format(value);
    const willCount = typeof value === 'number' && value > 0 && !counted.has(target) && Boolean(countObserver) && !prefersReducedMotion();
    // Пока блок не на экране, видна стартовая цифра; итог сразу доступен скринридеру.
    const digits = h('span', { class: 'cqa-count', 'aria-hidden': 'true', text: willCount ? format(0) : finalText });
    target.replaceChildren(h('span', { class: 'cqa-sr-only', text: finalText }), digits);
    if (willCount) {
      counted.add(target);
      pendingCounts.set(digits, { value, format });
      countObserver.observe(digits);
    }
  }

  const pendingCounts = new Map();
  const countObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        countObserver.unobserve(entry.target);
        const job = pendingCounts.get(entry.target);
        pendingCounts.delete(entry.target);
        if (job) cleanups.push(animateCount(entry.target, job.value, job.format));
      }
    })
    : null;
  if (countObserver) cleanups.push(() => countObserver.disconnect());

  function renderStats() {
    const values = stats || {};
    for (const key of ['conversations', 'evaluated', 'manualReview', 'openAppeals']) {
      const entry = kpiNodes.get(key);
      if (stats || statsError) setNumber(entry.value, values[key] ?? null);
    }
    if (stats && stats.conversations !== null) kpiNodes.get('evaluated').sub.textContent = `из ${formatCount(stats.conversations)}`;
    for (const key of ['conversations', 'evaluated', 'openAppeals', 'events']) {
      const node = stepLive.get(key);
      if (stats || statsError) setNumber(node, values[key] ?? null);
    }
  }

  function renderHealth(current) {
    const version = kpiNodes.get('version');
    const provider = kpiNodes.get('provider');
    const versionNode = stepLive.get('version');
    if (current.activeVersion) {
      version.value.replaceChildren(h('span', { text: `v${current.activeVersion.version}` }));
      version.sub.textContent = current.activeVersion.definition ? current.activeVersion.definition.name : '';
      versionNode.replaceChildren(`v${current.activeVersion.version}`);
    } else if (current.health && !current.health.active_checklist_version_id) {
      version.value.replaceChildren('—');
      version.sub.textContent = 'нет активного';
      versionNode.replaceChildren('—');
    } else if (current.healthError) {
      version.value.replaceChildren('—');
      versionNode.replaceChildren('—');
    }
    const label = providerLabel(current.health);
    if (label.value) {
      provider.value.replaceChildren(h('span', { class: current.health.is_demo ? 'cqa-kpi-demo' : null, text: label.value }));
      provider.sub.textContent = label.note;
    } else if (current.healthError) {
      provider.value.replaceChildren('—');
      provider.sub.textContent = 'сервер недоступен';
    }
  }

  async function loadStats() {
    kpis.setAttribute('aria-busy', 'true');
    kpiError.hidden = true;
    const { signal } = controller;
    try {
      const [all, notEvaluated, manual, openAppeals, events] = await Promise.all([
        api.listConversations({ limit: 1 }, { signal }),
        api.listConversations({ evaluation_status: 'not_evaluated', limit: 1 }, { signal }),
        api.listConversations({ evaluation_status: 'manual_review', limit: 1 }, { signal }),
        api.listAppeals({ status: 'open', limit: 1 }, { signal }),
        api.listHistory({ limit: 1 }, { signal }),
      ]);
      stats = homeStats({ all, notEvaluated, manual, openAppeals, events });
      statsError = null;
    } catch (error) {
      if (isAbortError(error)) return;
      statsError = error;
      kpiError.replaceChildren(
        h('span', { text: `Показатели не загружены: ${error.message}` }),
        h('button', { type: 'button', class: 'cqa-button cqa-button--small', text: 'Повторить', on: { click: loadStats } }),
      );
      kpiError.hidden = false;
      showError(error);
    } finally {
      if (!controller.signal.aborted) {
        kpis.setAttribute('aria-busy', 'false');
        renderStats();
      }
    }
  }

  // ---------- Карусель: автосмена, клавиатура, свайп ----------
  let index = 0;
  let timer = null;
  const now = () => (globalThis.performance ? performance.now() : Date.now());
  const clock = createAutoplayClock(AUTOPLAY_MS, now());

  function syncSlides(direction = 1) {
    slideNodes.forEach((node, i) => {
      const active = i === index;
      node.classList.toggle('is-active', active);
      node.style.setProperty('--cqa-dir', String(active ? -direction : direction));
      node.setAttribute('aria-hidden', active ? 'false' : 'true');
      node.inert = !active;
    });
    dots.forEach((dot, i) => {
      if (i === index) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
      dot.classList.toggle('is-active', i === index);
    });
    restartProgress();
  }

  function restartProgress() {
    const fill = dots[index].querySelector('.cqa-carousel-dot-fill');
    for (const dot of dots) dot.classList.remove('is-running');
    void fill.offsetWidth; // перезапуск CSS-анимации полосы времени
    dots[index].classList.add('is-running');
  }

  function syncPaused() {
    const running = clock.running();
    carousel.classList.toggle('is-paused', !running);
    // Пока слайды меняются сами, скринридер их не зачитывает; на паузе — объявляет смену.
    viewport.setAttribute('aria-live', running ? 'off' : 'polite');
    const user = clock.has('user');
    toggle.replaceChildren(icon(user ? 'play' : 'pause'));
    toggle.setAttribute('aria-label', user ? 'Запустить автосмену слайдов' : 'Остановить автосмену слайдов');
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!clock.running()) return;
    timer = setTimeout(() => go(index + 1, 1), clock.remaining(now()));
  }

  function pause(reason) {
    clock.pause(reason, now());
    syncPaused();
    schedule();
  }

  function resume(reason) {
    clock.resume(reason, now());
    syncPaused();
    schedule();
  }

  function go(target, direction) {
    const nextIndex = wrapIndex(target, SLIDES.length);
    if (nextIndex === index) return;
    const dir = direction || (nextIndex > index ? 1 : -1);
    index = nextIndex;
    clock.reset(now());
    syncSlides(dir);
    schedule();
  }

  function toggleAutoplay() {
    if (clock.has('user')) resume('user');
    else pause('user');
  }

  carousel.addEventListener('pointerenter', () => pause('hover'));
  carousel.addEventListener('pointerleave', () => resume('hover'));
  carousel.addEventListener('focusin', () => pause('focus'));
  carousel.addEventListener('focusout', (event) => {
    if (!carousel.contains(event.relatedTarget)) resume('focus');
  });
  // Стрелки, Home и End работают на кнопках управления: фокус не теряется в скрытом слайде.
  carousel.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !event.target.closest('.cqa-carousel-controls')) return;
    const target = keyToIndex(event.key, index, SLIDES.length);
    if (target === null) return;
    event.preventDefault();
    go(target, event.key === 'ArrowLeft' || event.key === 'Home' ? -1 : 1);
    if (event.target.classList.contains('cqa-carousel-dot')) dots[index].focus();
  });

  let pointer = null;
  viewport.addEventListener('pointerdown', (event) => {
    delete viewport.dataset.swiped;
    if (event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener('pointerup', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const intent = swipeIntent(event.clientX - pointer.x, event.clientY - pointer.y);
    pointer = null;
    if (intent) viewport.dataset.swiped = '1';
    if (intent === 'next') go(index + 1, 1);
    else if (intent === 'prev') go(index - 1, -1);
  });
  viewport.addEventListener('pointercancel', () => { pointer = null; });
  // После свайпа мышью не переходим по ссылке, над которой отпустили кнопку.
  viewport.addEventListener('click', (event) => {
    if (viewport.dataset.swiped === '1') {
      event.preventDefault();
      delete viewport.dataset.swiped;
    }
  }, true);

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') pause('hidden');
    else resume('hidden');
    syncHero();
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  // Карусель вне экрана тоже не листается: человек не пропустит слайды, пока смотрит шаги.
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) resume('offscreen');
      else pause('offscreen');
    });
    observer.observe(carousel);
    cleanups.push(() => observer.disconnect());
  }

  if (prefersReducedMotion()) clock.pause('user', now());
  if (document.visibilityState === 'hidden') clock.pause('hidden', now());
  syncSlides(1);
  syncPaused();
  schedule();

  // ---------- Появление при прокрутке ----------
  cleanups.push(revealOnScroll([kpis, featuresSection, stepsSection.querySelector('.cqa-section-head'), ...steps.children]));

  const unsubscribe = subscribe(renderHealth);
  renderHealth(state);
  loadStats();

  return {
    destroy() {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
      for (const cleanup of cleanups) cleanup();
    },
  };
}
