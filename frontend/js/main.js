// Точка входа: шапка, всплывающие сообщения, health, маршруты.
import { createHeader } from './components/header.js';
import { initToasts } from './components/toast.js';
import { h } from './dom.js';
import { bindDetailsMotion } from './lib/disclosure.js';
import { startRouter } from './router.js';
import { startHealthPolling } from './state.js';
import * as appeals from './views/appeals.js';
import * as checklist from './views/checklist.js';
import * as compare from './views/compare.js';
import * as conversation from './views/conversation.js';
import * as conversations from './views/conversations.js';
import { notFound, placeholder } from './views/placeholder.js';

const root = document.getElementById('cqa-root');
const header = createHeader();
const main = h('main', { class: 'cqa-main', id: 'cqa-main', tabindex: '-1' });
const skip = h('button', {
  type: 'button', class: 'cqa-skip', text: 'К содержимому',
  on: { click: () => {
    const target = main.querySelector('h1') || main;
    target.tabIndex = -1;
    target.focus();
  } },
});
root.replaceChildren(skip, header.el, main);
bindDetailsMotion(main);
header.trackHeight(root);
initToasts(root);
startHealthPolling();

startRouter(
  main,
  {
    conversations,
    conversation,
    checklist,
    appeals,
    compare,
    history: placeholder('История', 'F5'),
  },
  { notFound, onChange: (route) => header.setActive(route.name) },
);
