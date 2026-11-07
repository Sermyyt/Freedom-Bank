// Minimal DOM for view lifecycle and form state tests. Layout, native focus and
// assistive technology behavior are checked separately in the browser.
export function viewDocument(t) {
  const doc = {};
  class Element extends EventTarget {
    constructor(tag = '') {
      super();
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.dataset = {};
      this.style = {};
      this.className = '';
      this.disabled = false;
      this.hidden = false;
      this.value = '';
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].filter(Boolean).join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => {
          const on = force ?? !this.classList.contains(name);
          this.classList[on ? 'add' : 'remove'](name);
          return on;
        },
      };
    }
    get isConnected() { return this === doc.body || Boolean(this.parentElement?.isConnected); }
    get childElementCount() { return this.children.filter(child => child.tagName).length; }
    get textContent() { return this.tagName ? this.children.map(child => child.textContent).join('') : this.text || ''; }
    set textContent(value) {
      if (!this.tagName) this.text = String(value);
      else this.replaceChildren(doc.createTextNode(String(value)));
    }
    append(...nodes) {
      for (let node of nodes) {
        if (!(node instanceof Element)) node = doc.createTextNode(String(node));
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
    prepend(...nodes) { const previous = [...this.children]; this.replaceChildren(...nodes, ...previous); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id' || name === 'type') this[name] = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim();
        if (value === ':disabled') return this.disabled;
        if (value.startsWith('#')) return this.id === value.slice(1);
        if (value.startsWith('.')) return this.classList.contains(value.slice(1));
        const attr = /^\[([^=]+)="([^"]*)"\]$/.exec(value);
        if (attr) return this.getAttribute(attr[1]) === attr[2];
        return this.tagName.toLowerCase() === value;
      });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    focus() { if (!this.disabled) doc.activeElement = this; }
    scrollIntoView() {}
    select() {}
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  doc.createElement = tag => new Element(tag);
  doc.createTextNode = text => Object.assign(new Element(), { text: String(text) });
  doc.body = new Element('body');
  doc.activeElement = doc.body;
  doc.getElementById = id => doc.body.querySelector(`#${id}`);
  doc.querySelector = selector => doc.body.querySelector(selector);
  const root = doc.createElement('main');
  doc.body.append(root);
  for (const [key, value] of Object.entries({ Node: Element, document: doc, location: { hash: '#/conversations', replace(hash) { this.hash = hash; } } })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
  return { root, doc };
}

export const flush = () => new Promise(resolve => setImmediate(resolve));

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function button(root, label) {
  const found = root.querySelectorAll('button').find(node => node.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
