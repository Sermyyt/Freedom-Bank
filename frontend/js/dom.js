// Создание элементов без innerHTML: строки всегда становятся текстовыми узлами,
// поэтому серверные данные не исполняются как разметка.

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'multiple']);

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) element.addEventListener(event, handler);
    } else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (PROPERTIES.has(key)) element[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(element) {
  element.replaceChildren();
  return element;
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
