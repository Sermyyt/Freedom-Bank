import { dismiss, reveal } from './motion.js';

const intentions = new WeakMap();

// A later click wins, including when an exit animation is still running.
export function setExpanded(element, open) {
  const intent = { open };
  intentions.set(element, intent);
  if (open) {
    element.hidden = false;
    return reveal(element);
  }
  return dismiss(element).then(() => {
    if (intentions.get(element) === intent) element.hidden = true;
  });
}

export function bindDetailsMotion(container) {
  container.addEventListener('click', (event) => {
    const summary = event.target.closest('summary');
    if (!summary || !container.contains(summary) || event.target.closest('a, button, input, select')) return;
    const details = summary.parentElement;
    if (details.tagName !== 'DETAILS') return;
    event.preventDefault();
    const open = !(intentions.get(details)?.open ?? details.open);
    const intent = { open };
    intentions.set(details, intent);
    const content = [...details.children].filter(child => child !== summary);
    if (open) details.open = true;
    Promise.all(content.map(child => open ? reveal(child) : dismiss(child))).then(() => {
      if (intentions.get(details) !== intent) return;
      details.open = open;
      intentions.delete(details);
    });
    details.dispatchEvent(new CustomEvent('cqa:disclosure', { detail: { open } }));
  });
}
