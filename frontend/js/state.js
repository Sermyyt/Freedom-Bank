// Общее состояние интерфейса: health, активная версия чек-листа, демо-отметка, фильтры.
// В localStorage — только настройки интерфейса (размер страницы, недавние группы для фильтра).
import { api } from './api.js';
import { DEFAULT_PAGE_SIZE, normalizePageSize } from './lib/filters.js';

const PREFIX = 'cqa.';
const listeners = new Set();
const versionCache = new Map();

function readPref(key, fallback) {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(PREFIX + key);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    if (globalThis.localStorage) localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Хранилище может быть недоступно (приватный режим, политика) — интерфейс работает и без него.
  }
}

export const state = {
  health: null,
  healthError: null,
  activeVersion: null,
  viewDemo: false,
  lastListHash: '#/conversations',
  lastAppealsHash: '#/appeals',
  // Последний открытый разговор: после новой версии чек-листа его предлагают переоценить и сравнить.
  // Только ID и внешний ID — без транскрипта и аудио.
  lastConversation: null,
  // Задание «Оценить всю группу» живёт в памяти вкладки: вернувшись к списку, человек видит его ход.
  groupJob: null,
  focusImport: false,
  pageSize: normalizePageSize(readPref('pageSize', DEFAULT_PAGE_SIZE)),
  // null — человек ещё не сворачивал и не разворачивал блок импорта.
  importOpen: (() => {
    const value = readPref('importOpen', null);
    return typeof value === 'boolean' ? value : null;
  })(),
  recentGroups: (() => {
    const value = readPref('recentGroups', []);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 10) : [];
  })(),
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) listener(state);
}

// Плашка «Демо» видна, если demo сообщает health или данные на текущем экране.
export function isDemo() {
  return Boolean((state.health && state.health.is_demo === true) || state.viewDemo);
}

export function setViewDemo(value) {
  const next = value === true;
  if (state.viewDemo !== next) setState({ viewDemo: next });
}

export function getChecklistVersion(versionId) {
  // Версии чек-листа неизменяемы, поэтому их можно держать в памяти до перезагрузки страницы.
  if (!versionCache.has(versionId)) {
    const pending = api.getChecklistVersion(versionId).catch((error) => {
      versionCache.delete(versionId);
      throw error;
    });
    versionCache.set(versionId, pending);
  }
  return versionCache.get(versionId);
}

export async function refreshHealth() {
  try {
    const health = await api.getHealth();
    let activeVersion = null;
    if (health.active_checklist_version_id) {
      activeVersion = await getChecklistVersion(health.active_checklist_version_id).catch(() => null);
    }
    setState({ health, healthError: null, activeVersion });
    return health;
  } catch (error) {
    setState({ healthError: error });
    return null;
  }
}

export function startHealthPolling(intervalMs = 30000) {
  refreshHealth();
  const timer = setInterval(refreshHealth, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') refreshHealth();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

export function setPageSize(size) {
  const pageSize = normalizePageSize(size);
  writePref('pageSize', pageSize);
  setState({ pageSize });
}

export function setImportOpen(open) {
  writePref('importOpen', Boolean(open));
  state.importOpen = Boolean(open);
}

// Кнопка «Импортировать набор» на главной: список откроется с развёрнутой панелью импорта и фокусом в ней.
export function requestImport() {
  setImportOpen(true);
  state.focusImport = true;
}

export function takeImportFocus() {
  const requested = state.focusImport === true;
  state.focusImport = false;
  return requested;
}

export function rememberGroup(groupId) {
  if (typeof groupId !== 'string' || !groupId) return;
  const recentGroups = [groupId, ...state.recentGroups.filter((item) => item !== groupId)].slice(0, 10);
  writePref('recentGroups', recentGroups);
  setState({ recentGroups });
}

export function setLastListHash(hash) {
  state.lastListHash = hash;
}

export function setLastAppealsHash(hash) {
  state.lastAppealsHash = hash;
}

export function setLastConversation(conversation) {
  state.lastConversation = conversation;
}

export function setGroupJob(groupJob) {
  state.groupJob = groupJob;
}
