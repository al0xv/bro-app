import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import BroMascot, { type BroPose } from '../components/BroMascot';
import Paywall from './Paywall';
import { hapticImpact, hapticNotification } from '../haptics';
import {
  addMemoryFacts,
  appendChatMessage,
  getCalibrationTopicsCovered,
  getChatHistory,
  getMemoryFacts,
  getRemindersEnabled,
  hasGreeted,
  isCalibrationDone,
  setCalibrationDone,
  setCalibrationTopicsCovered,
  setHasGreeted,
  setChatHistory,
} from '../storage';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface Message {
  id: number;
  from: 'bro' | 'user';
  text: string;
  timestamp: number;
}

// подгружаем сохранённую историю один раз при монтировании — если она уже
// есть, рендерим как есть и не запускаем приветствие/калибровку заново
function loadInitialState() {
  const stored = getChatHistory();
  const messages: Message[] = stored.map((m, i) => ({
    id: i + 1,
    from: m.role === 'user' ? 'user' : 'bro',
    text: m.content,
    timestamp: m.timestamp,
  }));
  return { messages, hadHistory: messages.length > 0 };
}

// разделители дат в ленте ("сегодня"/"вчера"/дата) — как в обычных мессенджерах
function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDateLabel(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'сегодня';
  if (diffDays === 1) return 'вчера';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' });
}

type ApiMessage = { role: 'user' | 'assistant'; content: string };

interface ReplyOptions {
  calibrating: boolean;
  reconnecting?: boolean;
  calibrationJustFinished?: boolean;
}

// не показывается пользователю — только инструкция модели в истории API,
// чтобы бро сам сформулировал первое приветствие
const KICKOFF_PROMPT =
  'Это самое первое сообщение в нашей переписке, мы ещё не знакомы. Поприветствуй меня коротко и по-дружески, представься.';

// не показывается пользователю — триггер для проактивного сообщения, когда
// человек вернулся после перерыва (см. RECONNECT_SUPPLEMENT на сервере)
const RECONNECT_TRIGGER_PROMPT =
  'Прошло время с последнего разговора. Напиши первым, как будто просто вспомнил про меня.';

// порог "давно не общались" — больше 3 часов ИЛИ сменился календарный день
const RECONNECT_GAP_MS = 3 * 60 * 60 * 1000;

function shouldReconnect(lastTimestamp: number): boolean {
  const now = Date.now();
  if (now - lastTimestamp >= RECONNECT_GAP_MS) return true;
  return new Date(lastTimestamp).toDateString() !== new Date(now).toDateString();
}

// склонение для подсказки об остатке ("осталось 3 сообщения", "1 сообщение")
function messagesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сообщение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сообщения';
  return 'сообщений';
}

// порядок калибровочных тем — должен совпадать с CALIBRATION_TOPIC_ORDER на сервере
const CALIBRATION_TOPIC_ORDER = ['name', 'life', 'interests', 'support_style'] as const;

// если одна и та же тема не закрывается столько раз подряд — считаем, что
// человек не хочет отвечать, и мягко переходим дальше, не блокируя прогресс
const CALIBRATION_STALL_LIMIT = 2;

// каждое слово живого ответа монтируется один раз и само проигрывает
// CSS-анимацию появления. пробел выносим из инлайн-блока наружу, иначе
// браузер схлопывает его на границе бокса
function LiveStreamWords({ words }: { words: string[] }) {
  return (
    <>
      {words.map((word, i) => {
        const match = word.match(/^(\S*)(\s*)$/);
        const core = match ? match[1] : word;
        const trailing = match ? match[2] : '';
        return (
          <Fragment key={i}>
            <span className="stream-word stream-word--visible">{core}</span>
            {trailing}
          </Fragment>
        );
      })}
    </>
  );
}

export default function Chat() {
  const [initial] = useState(loadInitialState);
  const [messages, setMessages] = useState<Message[]>(initial.messages);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false); // ждём начала ответа (точки)
  const [streamWords, setStreamWords] = useState<string[] | null>(null); // идёт живой стрим
  // маленький баннер снизу над полем ввода — и для сетевых ошибок, и для
  // подтверждения копирования, единый механизм вместо двух похожих кусков состояния
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = (message: string, duration = 2000) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), duration);
  };
  const [headerPose, setHeaderPose] = useState<BroPose>('default');
  const [calibrating, setCalibrating] = useState(() => !isCalibrationDone());
  const [calibrationJustFinished, setCalibrationJustFinished] = useState(false);
  const [isFirstEverInstall] = useState(() => !hasGreeted());
  const [needsPayment, setNeedsPayment] = useState(false);
  // сколько бесплатных сообщений осталось на сегодня; null = неизвестно
  // (вне Telegram) или безлимит по подписке — подсказка не показывается
  const [freeRemaining, setFreeRemaining] = useState<number | null>(null);
  // ref, а не state: send() проверяет причину сбоя сразу после await, когда
  // обновление состояния ещё не видно — чтобы не показывать "не получилось
  // отправить" поверх пейволла (это не сетевая ошибка)
  const paymentBlockedRef = useRef(false);
  const nextId = useRef(initial.messages.length + 1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasTriggeredHappyFactRef = useRef(false);
  const isStreaming = typing || streamWords !== null;

  // единая точка добавления сообщения — сразу в состояние И в персистентную
  // историю, чтобы не потерять последнее сообщение при внезапном закрытии вкладки
  const pushMessage = (msg: Omit<Message, 'timestamp'>) => {
    const timestamp = Date.now();
    setMessages((prev) => [...prev, { ...msg, timestamp }]);
    appendChatMessage({
      role: msg.from === 'user' ? 'user' : 'assistant',
      content: msg.text,
      timestamp,
    });
  };

  // троттлинг memory/extract: не после каждой реплики, а раз в 3 сообщения
  // пользователя + один раз при уходе со страницы, чтобы не терять хвост сессии
  // (кроме периода калибровки — там извлекаем сразу после каждого обмена)
  const userMsgCountRef = useRef(0);
  const lastExchangeRef = useRef<{ user: string; bro: string } | null>(null);
  const exchangeFlushedRef = useRef(true);
  const calibrationStallRef = useRef(0);


  // Claude-style scroll:
  // При добавлении слов стрима скроллим "в лоб" без CSS-сглаживания (auto).
  // Поскольку слова добавляются очень часто, браузерное сглаживание 'smooth'
  // просто не успевает дойти до конца и дёргается. 'auto' же выглядит как
  // идеально плавное выталкивание текста вверх.
  useEffect(() => {
    const isStreaming = streamWords !== null || typing;
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({
        behavior: isStreaming ? 'auto' : 'smooth',
        block: 'end',
      });
    });
  }, [messages, typing, streamWords]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea synchronously to prevent visual jumping
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el) {
      const currentScrollTop = el.scrollTop;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
      el.scrollTop = currentScrollTop;
    }
  }, [draft]);

  const triggerHappyPose = () => {
    setHeaderPose('happy');
    setTimeout(() => {
      setHeaderPose('default');
    }, 2000);
  };

  const extractMemory = async (
    exchange: { user: string; bro: string },
    currentTopic?: string,
  ): Promise<{ facts: string[]; topicCovered: boolean }> => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/memory/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange, currentTopic }),
      });
      if (!res.ok) return { facts: [], topicCovered: false };
      const data = await res.json();
      const facts: string[] = Array.isArray(data.facts) ? data.facts : [];
      if (facts.length) {
        addMemoryFacts(facts);
        if (!calibrating && !hasTriggeredHappyFactRef.current) {
          hasTriggeredHappyFactRef.current = true;
          triggerHappyPose();
        }
      }
      return { facts, topicCovered: Boolean(data.topicCovered) };
    } catch {
      // фоновая задача — тихо игнорируем сбой
      return { facts: [], topicCovered: false };
    }
  };

  // при закрытии вкладки/обновлении — best-effort пинг сервера маячком
  // (ответ обработать уже не успеем, но хотя бы попытаемся не потерять хвост)
  useEffect(() => {
    const flushOnUnload = () => {
      if (exchangeFlushedRef.current || !lastExchangeRef.current) return;
      try {
        const blob = new Blob([JSON.stringify({ exchange: lastExchangeRef.current })], {
          type: 'application/json',
        });
        navigator.sendBeacon(`${API_BASE_URL}/api/memory/extract`, blob);
        exchangeFlushedRef.current = true;
      } catch {
        // best effort
      }
    };
    window.addEventListener('beforeunload', flushOnUnload);
    return () => {
      window.removeEventListener('beforeunload', flushOnUnload);
      // уход со страницы чата внутри приложения (смена таба) — можем спокойно
      // дождаться нормального ответа и записать факты в память
      if (!exchangeFlushedRef.current && lastExchangeRef.current) {
        exchangeFlushedRef.current = true;
        void extractMemory(lastExchangeRef.current);
      }
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // общая логика запроса к /api/chat: стримит слова по мере прихода,
  // финализирует сообщение и возвращает итоговый текст (или null при ошибке).
  // поза маскота в шапке теперь статичная (см. рендер) — стрим отражается
  // текстом статус-строки ("печатает…"), не сменой позы
  const requestReply = async (
    apiMessages: ApiMessage[],
    options: ReplyOptions,
  ): Promise<string | null> => {
    setTyping(true);
    setHeaderPose('thinking');
    const memoryFacts = (getMemoryFacts() ?? []).map((f) => f.text);
    const controller = new AbortController();
    abortRef.current = controller;

    let full = '';
    let pending = '';
    let firstToken = true;

    try {
      const tg = (window as any).Telegram?.WebApp;
      const initData = tg?.initData;

      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          memory: memoryFacts,
          calibrating: options.calibrating,
          reconnecting: options.reconnecting,
          calibrationJustFinished: options.calibrationJustFinished,
          initData,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        if (res.status === 402) {
          throw new Error('PAYMENT_REQUIRED');
        }
        throw new Error(`сервер ответил ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const block of events) {
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;

          let evt: { text?: string; done?: boolean; error?: string; meta?: { freeRemaining?: number } };
          try {
            evt = JSON.parse(raw);
          } catch {
            continue;
          }

          if (evt.error) throw new Error(evt.error);
          if (evt.done) continue;

          // сервер первым событием шлёт остаток бесплатных сообщений на сегодня
          if (evt.meta && typeof evt.meta.freeRemaining === 'number') {
            setFreeRemaining(evt.meta.freeRemaining);
            continue;
          }

          if (typeof evt.text === 'string' && evt.text) {
            if (firstToken) {
              firstToken = false;
              setTyping(false);
              setStreamWords([]);
              setHeaderPose('default');
            }
            full += evt.text;
            pending += evt.text;
            const matches = pending.match(/\S+\s+/g);
            if (matches) {
              const flushed = matches.join('');
              pending = pending.slice(flushed.length);
              setStreamWords((prev) => [...(prev ?? []), ...matches]);
            }
          }
        }
      }

      if (pending) {
        setStreamWords((prev) => [...(prev ?? []), pending]);
      }

      const finalText = full.trim();
      pushMessage({ id: nextId.current++, from: 'bro', text: finalText });
      setStreamWords(null);
      setTyping(false);

      return finalText;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      if ((err as Error).message === 'PAYMENT_REQUIRED') {
        setTyping(false);
        setStreamWords(null);
        paymentBlockedRef.current = true;
        setNeedsPayment(true);
        return null;
      }
      setTyping(false);
      setStreamWords(null);
      return null;
    }
  };

  // бро сам генерирует первую реплику при открытии чата — не хардкодим текст,
  // с калибровочной надстройкой, если знакомство ещё не завершено.
  // если история уже есть (продолжаем существующий разговор) — не здороваемся
  // заново, просто рендерим загруженное и ждём ввода
  useEffect(() => {
    if (initial.hadHistory) return;
    if (isFirstEverInstall) setHeaderPose('wave'); // разовый жест на самом первом привете
    void requestReply([{ role: 'user', content: KICKOFF_PROMPT }], { calibrating }).then(() => {
      if (isFirstEverInstall) {
        setHasGreeted();
        setHeaderPose('default');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // проактивное сообщение при возвращении: при ЛЮБОМ открытии чата с уже
  // существующей историей (не только пустой) — если с последнего сообщения
  // прошло много времени и тумблер "напоминания о себе" включён, бро сам
  // пишет первым, опираясь на факты из памяти. во время калибровки не
  // вмешиваемся — там свой сценарий первого сообщения
  useEffect(() => {
    async function checkPendingAndReconnect() {
      // Сначала проверяем, не прислал ли сервер push-уведомление пока мы спали
      const tg = (window as any).Telegram?.WebApp;
      const initData = tg?.initData;
      if (initData) {
        try {
          const res = await fetch(`${API_BASE_URL}/api/pending`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData }),
          });
          const data = await res.json();
          if (data.needsPayment) {
            setNeedsPayment(true);
          }
          if (typeof data.freeRemaining === 'number') {
            setFreeRemaining(data.freeRemaining);
          }
          if (data.messages && data.messages.length > 0) {
            data.messages.forEach((m: any) => {
              pushMessage({ id: nextId.current++, from: 'bro', text: m.content });
            });
            hapticNotification('success');
            // Если сервер уже прислал сообщение, сами ничего не генерируем
            return;
          }
        } catch (e) {
          console.error('Failed to fetch pending messages:', e);
        }
      }

      if (!initial.hadHistory) return;
      if (calibrating) return;
      if (!getRemindersEnabled()) return;

      const history = getChatHistory();
      const last = history[history.length - 1];
      if (!last || !shouldReconnect(last.timestamp)) return;

      const apiHistory: ApiMessage[] = [
        ...initial.messages.map((m) => ({
          role: (m.from === 'user' ? 'user' : 'assistant') as ApiMessage['role'],
          content: m.text,
        })),
        { role: 'user', content: RECONNECT_TRIGGER_PROMPT },
      ];
      void requestReply(apiHistory, { calibrating: false, reconnecting: true });
    }
    
    checkPendingAndReconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || typing || streamWords !== null) return;
    setDraft('');

    hapticImpact('light');

    const userMsg: Omit<Message, 'timestamp'> = { id: nextId.current++, from: 'user', text };
    const apiHistory: ApiMessage[] = [...messages, userMsg].map((m) => ({
      role: m.from === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
    pushMessage(userMsg);
    userMsgCountRef.current += 1;

    const options: ReplyOptions = { calibrating, calibrationJustFinished };
    if (calibrationJustFinished) {
      setCalibrationJustFinished(false);
    }

    const finalText = await requestReply(apiHistory, options);
    if (!finalText) {
      // Restore user message
      setMessages((prev) => prev.slice(0, -1));
      const history = getChatHistory();
      setChatHistory(history.slice(0, -1));
      setDraft(text);
      userMsgCountRef.current -= 1;
      if (paymentBlockedRef.current) {
        // упёрлись в лимит — объяснение даёт пейволл, тост про "ошибку" только запутает
        paymentBlockedRef.current = false;
      } else {
        showToast('не получилось отправить — попробуй ещё раз', 3000);
      }
      return;
    }

    hapticImpact('rigid');

    lastExchangeRef.current = { user: text, bro: finalText };

    if (calibrating) {
      // во время калибровки извлекаем сразу после каждого обмена, не дожидаясь
      // троттлинга — иначе знакомство растянется на несколько лишних реплик
      exchangeFlushedRef.current = true;
      const topicIndex = getCalibrationTopicsCovered();
      const currentTopic = CALIBRATION_TOPIC_ORDER[topicIndex];
      const { topicCovered } = await extractMemory(lastExchangeRef.current, currentTopic);

      let nextTopicIndex = topicIndex;
      if (topicCovered) {
        nextTopicIndex = topicIndex + 1;
        calibrationStallRef.current = 0;
      } else {
        calibrationStallRef.current += 1;
        if (calibrationStallRef.current >= CALIBRATION_STALL_LIMIT) {
          // человек явно не хочет отвечать на эту тему — не блокируем прогресс,
          // мягко пропускаем и идём дальше
          nextTopicIndex = topicIndex + 1;
          calibrationStallRef.current = 0;
        }
      }
      setCalibrationTopicsCovered(nextTopicIndex);
      if (nextTopicIndex >= CALIBRATION_TOPIC_ORDER.length) {
        setCalibrationDone(true);
        setCalibrating(false);
        setCalibrationJustFinished(true);
        triggerHappyPose();
      }
    } else if (userMsgCountRef.current % 3 === 0) {
      exchangeFlushedRef.current = true;
      void extractMemory(lastExchangeRef.current);
    } else {
      exchangeFlushedRef.current = false;
    }
  };

  // аватар бро — только у самого последнего сообщения во всём чате,
  // ни у одного из предыдущих
  const showAvatar = (index: number) => {
    const msg = messages[index];
    if (msg.from !== 'bro') return false;
    if (index !== messages.length - 1) return false;
    if (typing || streamWords !== null) return false; // индикатор/стрим несёт свой аватар
    return true;
  };

  // задержка появления бабблов внутри одной группы подряд идущих сообщений
  const groupStagger = (index: number) => {
    let count = 0;
    let i = index;
    while (i > 0 && messages[i].from === messages[i - 1].from) {
      count += 1;
      i -= 1;
    }
    return Math.min(count, 3) * 60;
  };

  // долгое нажатие на реплику бро — копирует текст. Отменяется, если палец
  // за это время сместился (значит это скролл, а не долгое нажатие)
  const longPressTimerRef = useRef<number | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);

  const handleBubblePointerDown = (e: React.PointerEvent, text: string) => {
    longPressPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          hapticNotification('success');
          showToast('скопировано', 1500);
        })
        .catch(() => {
          hapticNotification('error');
          showToast('не получилось скопировать', 1500);
        });
    }, 500);
  };

  const cancelLongPressIfMoved = (e: React.PointerEvent) => {
    if (!longPressPosRef.current || longPressTimerRef.current === null) return;
    const dx = e.clientX - longPressPosRef.current.x;
    const dy = e.clientY - longPressPosRef.current.y;
    if (Math.hypot(dx, dy) > 10) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const endLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // маскот в шапке "прислушивается" пока человек набирает — не мешает уже
  // идущим переходам (thinking/happy/wave), включается только поверх дефолтной позы
  const displayHeaderPose: BroPose =
    draft.trim() && headerPose === 'default' && !isStreaming ? 'listening' : headerPose;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // маленький секрет: 5 тапов по аватарке подряд (в пределах ~2с) — бро радуется.
  // не подсказываем это нигде в интерфейсе, просто награда для тех, кто потыкает
  const mascotTapCountRef = useRef(0);
  const mascotTapTimerRef = useRef<number | null>(null);
  const handleMascotTap = () => {
    mascotTapCountRef.current += 1;
    if (mascotTapTimerRef.current) window.clearTimeout(mascotTapTimerRef.current);
    mascotTapTimerRef.current = window.setTimeout(() => {
      mascotTapCountRef.current = 0;
    }, 2000);

    if (mascotTapCountRef.current >= 5) {
      mascotTapCountRef.current = 0;
      if (mascotTapTimerRef.current) {
        window.clearTimeout(mascotTapTimerRef.current);
        mascotTapTimerRef.current = null;
      }
      triggerHappyPose();
      hapticNotification('success');
    }
  };

  return (
    <div className="chat" style={{ position: 'relative' }}>
      <div style={{ display: needsPayment ? 'none' : 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
        <header
          className="chat-header"
          onClick={() => {
            hapticImpact('medium');
            handleMascotTap();
          }}
          style={{ cursor: 'pointer' }}
        >
          <div className={`chat-avatar ${isFirstEverInstall ? 'mascot-intro' : ''}`}>
            <BroMascot pose={displayHeaderPose} size={52} idle="sway" />
          </div>
          <div className="chat-header-text">
            <span className="chat-title">бро</span>
            <span className="chat-status">
              {!isStreaming && <span className="chat-status-dot" />}
              {isStreaming ? 'печатает…' : 'онлайн'}
            </span>
          </div>
        </header>

        <div className="chat-feed" style={{ padding: 0 }}>
          <Virtuoso
            ref={virtuosoRef}
            className="chat-feed-scroller"
            style={{ height: '100%' }}
            data={messages}
            initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
            followOutput="smooth"
            alignToBottom
            atBottomStateChange={(atBottom) => setShowScrollButton(!atBottom)}
            itemContent={(i, msg) => {
              const isNew = i >= messages.length - 2;
              const showDateDivider = i === 0 || !isSameDay(messages[i - 1].timestamp, msg.timestamp);
              return (
                <div>
                  {showDateDivider && (
                    <div className="chat-date-divider">
                      <span>{formatDateLabel(msg.timestamp)}</span>
                    </div>
                  )}
                  <motion.div
                    layout="position"
                    initial={isNew ? { opacity: 0, y: 12, scale: 0.95 } : false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 28, delay: isNew ? groupStagger(i) / 1000 : 0 }}
                    className={msg.from === 'bro' ? 'msg-row msg-row--bro' : 'msg-row msg-row--user'}
                    style={{ padding: '4px 16px' }}
                  >
                    {msg.from === 'bro' && (
                      <div className="msg-avatar">
                        {showAvatar(i) && <BroMascot pose="default" size={46} idle="bounce" />}
                      </div>
                    )}
                    <motion.div
                      whileTap={msg.from === 'bro' ? { scale: 0.98 } : undefined}
                      className={msg.from === 'bro' ? 'bubble bubble--bro' : 'bubble bubble--user'}
                      onPointerDown={msg.from === 'bro' ? (e) => handleBubblePointerDown(e, msg.text) : undefined}
                      onPointerMove={msg.from === 'bro' ? cancelLongPressIfMoved : undefined}
                      onPointerUp={msg.from === 'bro' ? endLongPress : undefined}
                      onPointerCancel={msg.from === 'bro' ? endLongPress : undefined}
                      onPointerLeave={msg.from === 'bro' ? endLongPress : undefined}
                    >
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    </motion.div>
                  </motion.div>
                </div>
              );
            }}
            components={{
              Header: () => <div style={{ height: 18 }} />,
              Footer: () => (
                <div style={{ padding: '0 16px 10px' }}>
                  <AnimatePresence>
                    {typing && (
                      <motion.div
                        layout="position"
                        initial={{ opacity: 0, y: 12, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                        transition={{ type: "spring", stiffness: 400, damping: 28 }}
                        className="msg-row msg-row--bro"
                        style={{ padding: '4px 0' }}
                      >
                        <div className="msg-avatar">
                          <BroMascot pose="thinking" size={46} idle="bounce" />
                        </div>
                        <div className="bubble bubble--bro bubble--typing">
                          <div className="typing-dots-goo">
                            <span className="typing-dot" />
                            <span className="typing-dot" />
                            <span className="typing-dot" />
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {streamWords !== null && (
                      <motion.div
                        layout="position"
                        initial={{ opacity: 0, y: 12, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 28 }}
                        className="msg-row msg-row--bro"
                        style={{ padding: '4px 0' }}
                      >
                        <div className="msg-avatar">
                          <BroMascot pose="typing" size={46} idle="bounce" />
                        </div>
                        <div className="bubble bubble--bro">
                          <LiveStreamWords words={streamWords} />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div ref={bottomRef} />
                </div>
              ),
            }}
          />

          <AnimatePresence>
            {showScrollButton && (
              <motion.button
                initial={{ opacity: 0, y: 8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                whileTap={{ scale: 0.9 }}
                className="scroll-to-bottom-btn"
                onClick={() => {
                  hapticImpact('light');
                  virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' });
                }}
                aria-label="к последним сообщениям"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {toast && <div className="chat-toast">{toast}</div>}

        {/* мягкое предупреждение, когда дневной бесплатный лимит на исходе —
            чтобы пейволл не сваливался как гром среди ясного неба */}
        {!toast && !needsPayment && freeRemaining !== null && freeRemaining > 0 && freeRemaining <= 3 && (
          <div className="chat-toast">
            сегодня осталось {freeRemaining} бесплатных {messagesWord(freeRemaining)}
          </div>
        )}

        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="pill-input chat-input"
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                const tg = (window as any).Telegram?.WebApp;
                const isMobile = tg?.platform === 'ios' || tg?.platform === 'android';
                if (!isMobile) {
                  e.preventDefault();
                  send();
                }
              }
            }}
            placeholder="напиши что-нибудь…"
            spellCheck={false}
            disabled={needsPayment}
          />
          <motion.button
            whileTap={{ scale: 0.9 }}
            className={draft.trim() ? 'send-btn send-btn--active' : 'send-btn'}
            onClick={send}
            aria-label="отправить"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </motion.button>
        </div>
      </div>

      {/* Окно оплаты поверх чата. Закрытие возвращает к истории (перечитать
          переписку можно всегда), но следующая отправка снова упрётся в 402 */}
      {needsPayment && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 9999, background: 'var(--bg)' }}>
          <Paywall
            onSuccess={() => setNeedsPayment(false)}
            onClose={() => setNeedsPayment(false)}
          />
        </div>
      )}
    </div>
  );
}
