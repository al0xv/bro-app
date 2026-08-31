const KEY_MEMORY = 'bro:memory:v2';
const KEY_CALIBRATION_DONE = 'bro:calibrationDone:v2';
const KEY_CALIBRATION_TOPICS = 'bro:calibrationTopicsCovered:v2';
const KEY_HAS_GREETED = 'bro:hasGreeted:v2';
const KEY_CHAT_HISTORY = 'bro:chatHistory:v2';
const KEY_REMINDERS_ENABLED = 'bro:remindersEnabled';
const KEY_CONSENT_GIVEN = 'bro:consentGiven';
const KEY_THEME = 'bro:theme:v1';

export type ThemeMode = 'auto' | 'light' | 'dark';

export function getThemeMode(): ThemeMode {
  return (localStorage.getItem(KEY_THEME) as ThemeMode) || 'auto';
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(KEY_THEME, mode);
}

// потолок хранимой истории — при превышении отбрасываем самые старые сообщения,
// чтобы localStorage не рос бесконечно
const MAX_STORED_MESSAGES = 200;

// калибровка — короткое знакомство прямо в чате (имя + один открытый вопрос
// о жизни) вместо формы-онбординга. Переживает перезапуск, как остальная память.
export function isCalibrationDone(): boolean {
  return localStorage.getItem(KEY_CALIBRATION_DONE) === 'true';
}

export function setCalibrationDone(done: boolean) {
  localStorage.setItem(KEY_CALIBRATION_DONE, done ? 'true' : 'false');
}

// сколько из 4 калибровочных тем уже содержательно закрыто (0-4) — надёжнее,
// чем полагаться только на качество извлечения фактов
export function getCalibrationTopicsCovered(): number {
  const raw = Number(localStorage.getItem(KEY_CALIBRATION_TOPICS));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 4) : 0;
}

export function setCalibrationTopicsCovered(count: number) {
  localStorage.setItem(KEY_CALIBRATION_TOPICS, String(Math.max(0, Math.min(count, 4))));
}

// был ли уже показан самый первый привет новой установки (для pose="wave" в шапке)
export function hasGreeted(): boolean {
  return localStorage.getItem(KEY_HAS_GREETED) === 'true';
}

export function setHasGreeted() {
  localStorage.setItem(KEY_HAS_GREETED, 'true');
}

// тумблер "напоминания о себе" (настройки) — по умолчанию включён, пока
// человек явно не выключил
export function getRemindersEnabled(): boolean {
  return localStorage.getItem(KEY_REMINDERS_ENABLED) !== 'false';
}

export function setRemindersEnabled(enabled: boolean) {
  localStorage.setItem(KEY_REMINDERS_ENABLED, enabled ? 'true' : 'false');
  syncWithServer({ remindersEnabled: enabled });
}

// экран согласия при самом первом запуске — показывается один раз, раньше
// калибровки и раньше Chat.tsx. Переживает перезапуск, как остальные флаги
export function hasConsentGiven(): boolean {
  return localStorage.getItem(KEY_CONSENT_GIVEN) === 'true';
}

export function setConsentGiven() {
  localStorage.setItem(KEY_CONSENT_GIVEN, 'true');
}

export interface MemoryFact {
  id: number;
  text: string;
}

// null = память ещё не инициализирована (первый запуск, нужно засеять дефолтом)
export function getMemoryFacts(): MemoryFact[] | null {
  try {
    const raw = localStorage.getItem(KEY_MEMORY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setMemoryFacts(facts: MemoryFact[]) {
  localStorage.setItem(KEY_MEMORY, JSON.stringify(facts));
  syncWithServer({ memoryFacts: facts });
}

// добавляет факты, извлечённые /api/memory/extract, в общее хранилище
export function addMemoryFacts(texts: string[]): MemoryFact[] {
  const current = getMemoryFacts() ?? [];
  let nextId = current.reduce((max, f) => Math.max(max, f.id), 0) + 1;
  const added = texts.map((text) => ({ id: nextId++, text }));
  const updated = [...current, ...added];
  setMemoryFacts(updated);
  return updated;
}

export function deleteMemoryFact(id: number): MemoryFact[] {
  const current = getMemoryFacts() ?? [];
  const updated = current.filter((f) => f.id !== id);
  setMemoryFacts(updated);
  return updated;
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// постоянная история переписки — один непрерывный чат, переживает перезапуск,
// как остальная память
export function getChatHistory(): StoredMessage[] {
  try {
    const raw = localStorage.getItem(KEY_CHAT_HISTORY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function setChatHistory(history: StoredMessage[]) {
  const trimmed =
    history.length > MAX_STORED_MESSAGES
      ? history.slice(history.length - MAX_STORED_MESSAGES)
      : history;
  localStorage.setItem(KEY_CHAT_HISTORY, JSON.stringify(trimmed));
}

export function appendChatMessage(message: StoredMessage): StoredMessage[] {
  const updated = [...getChatHistory(), message];
  setChatHistory(updated);
  return updated;
}

// полная очистка памяти, истории переписки и калибровки (Начать заново)
export function clearMemoryAndHistory() {
  localStorage.removeItem(KEY_MEMORY);
  localStorage.removeItem(KEY_CHAT_HISTORY);
  localStorage.removeItem(KEY_CALIBRATION_DONE);
  localStorage.removeItem(KEY_CALIBRATION_TOPICS);
  localStorage.removeItem(KEY_HAS_GREETED);
  syncWithServer({ memoryFacts: [] });
}

export function syncWithServer(updates: { memoryFacts?: MemoryFact[] | null, remindersEnabled?: boolean } = {}) {
  const tg = (window as any).Telegram?.WebApp;
  // initData (не initDataUnsafe!) — сырая подписанная строка, сервер сам
  // проверяет подпись и достаёт из неё id. Присланному "голому" id доверять
  // нельзя — Telegram сам называет initDataUnsafe небезопасным
  const initData = tg?.initData;
  if (!initData) return;

  const payload: any = { initData };
  if (updates.memoryFacts !== undefined) payload.memoryFacts = updates.memoryFacts;
  if (updates.remindersEnabled !== undefined) payload.remindersEnabled = updates.remindersEnabled;

  // We use relative path so it hits the same host
  fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(console.error);
}
