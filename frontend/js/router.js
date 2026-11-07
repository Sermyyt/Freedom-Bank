// Hash-маршруты. Экран — модуль с mount(container, route) → { update?(route), destroy?() }.
// При уходе с экрана вызывается destroy: он останавливает опросы и отменяет запросы.
import { DEFAULT_ROUTE, parseHash } from './lib/route.js';

export function startRouter(container, routes, { notFound, onChange } = {}) {
  let current = null;

  function render() {
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      location.replace(`#/${DEFAULT_ROUTE}`);
      return;
    }
    const route = parseHash(location.hash);
    const view = routes[route.name] || notFound;

    if (current && current.view === view && current.instance && typeof current.instance.update === 'function') {
      if (current.instance.update(route) !== false) {
        if (onChange) onChange(route);
        return;
      }
    }
    if (current && current.instance && typeof current.instance.destroy === 'function') current.instance.destroy();
    container.replaceChildren();
    current = { view, instance: view.mount(container, route) || null };
    if (onChange) onChange(route);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  render();
}
