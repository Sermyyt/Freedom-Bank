// Точка входа: шапка, всплывающие сообщения, health, маршруты.
import { createHeader } from './components/header.js';
import { initToasts } from './components/toast.js';
import { h } from './dom.js';
import { startRouter } from './router.js';
import { startHealthPolling } from './state.js';
import * as conversation from './views/conversation.js';
import * as conversations from './views/conversations.js';
import { notFound, placeholder } from './views/placeholder.js';

const root = document.getElementById('cqa-root');
const header = createHeader();
const main = h('main', { class: 'cqa-main' });
root.replaceChildren(header.el, main);
header.trackHeight(root);
initToasts(root);
startHealthPolling();

startRouter(
  main,
  {
    conversations,
    conversation,
    checklist: placeholder('Чек-лист', 'F4'),
    appeals: placeholder('Апелляции', 'F3'),
    compare: placeholder('Сравнение оценок', 'F4'),
    history: placeholder('История', 'F5'),
  },
  { notFound, onChange: (route) => header.setActive(route.name) },
);
