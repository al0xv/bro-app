import { Fragment, useEffect, useRef, useState } from 'react';
import BroMascot, { type BroPose } from '../components/BroMascot';
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
} from '../storage';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface Message {
  id: number;
  from: 'bro' | 'user';
  text: string;
}

// подгружаем сохранённую историю один раз при монтировании — если она уже
// есть, рендерим как есть и не запускаем приветствие/калибровку заново
function loadInitialState() {
  const stored = getChatHistory();
  const messages: Message[] = stored.map((m, i) => ({
    id: i + 1,
    from: m.role === 'user' ? 'user' : 'bro',
    text: m.content,
  }));
  return { messages, hadHistory: messages.length > 0 };
}

type ApiMessage = { role: 'user' | 'assistant'; content: string };

interface ReplyOptions {
  calibrating: boolean;
  reconnecting?: boolean;
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
  const [headerPose, setHeaderPose] = useState<BroPose>('default');
  const [calibrating, setCalibrating] = useState(() => !isCalibrationDone());
  const [isFirstEverInstall] = useState(() => !hasGreeted());
  const nextId = useRef(initial.messages.length + 1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isStreaming = typing || streamWords !== null;

  // единая точка добавления сообщения — сразу в состояние И в персистентную
  // историю, чтобы не потерять последнее сообщение при внезапном закрытии вкладки
  const pushMessage = (msg: Message) => {
    setMessages((prev) => [...prev, msg]);
    appendChatMessage({
      role: msg.from === 'user' ? 'user' : 'assistant',
      content: msg.text,
      timestamp: Date.now(),
    });
  };

  // троттлинг memory/extract: не после каждой реплики, а раз в 3 сообщения
  // пользователя + один раз при уходе со страницы, чтобы не терять хвост сессии
  // (кроме периода калибровки — там извлекаем сразу после каждого обмена)
  const userMsgCountRef = useRef(0);
  const lastExchangeRef = useRef<{ user: string; bro: string } | null>(null);
  const exchangeFlushedRef = useRef(true);
  const calibrationStallRef = useRef(0);
  const scrollScheduledRef = useRef(false);

  // во время живого стрима streamWords меняется на каждое слово (каждые
  // 60-90мс) — если дёргать scrollIntoView smooth на каждое изменение,
  // браузер без конца перезапускает анимацию скролла и она никогда не
  // доезжает до конца (ощущается как дёрганье). троттлим (не дебаунсим —
  // иначе скролл будет ждать паузы в стриме, а не ехать вместе с ним) до
  // одного вызова за ~180мс, этого достаточно, чтобы плавно "ехать" за текстом
  useEffect(() => {
    if (scrollScheduledRef.current) return;
    scrollScheduledRef.current = true;
    window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      scrollScheduledRef.current = false;
    }, 180);
  }, [messages, typing, streamWords]);

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
      if (facts.length) addMemoryFacts(facts);
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
        navigator.sendBeacon('/api/memory/extract', blob);
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

    const memoryFacts = (getMemoryFacts() ?? []).map((f) => f.text);
    const controller = new AbortController();
    abortRef.current = controller;

    let full = '';
    let pending = '';
    let firstToken = true;

    try {
      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          memory: memoryFacts,
          calibrating: options.calibrating,
          reconnecting: options.reconnecting,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
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

          let evt: { text?: string; done?: boolean; error?: string };
          try {
            evt = JSON.parse(raw);
          } catch {
            continue;
          }

          if (evt.error) throw new Error(evt.error);
          if (evt.done) continue;

          if (typeof evt.text === 'string' && evt.text) {
            if (firstToken) {
              firstToken = false;
              setTyping(false);
              setStreamWords([]);
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
      setTyping(false);
      setStreamWords(null);
      pushMessage({
        id: nextId.current++,
        from: 'bro',
        text: 'что-то не так у меня со связью… попробуешь написать ещё раз?',
      });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || typing || streamWords !== null) return;
    setDraft('');

    const userMsg: Message = { id: nextId.current++, from: 'user', text };
    const apiHistory: ApiMessage[] = [...messages, userMsg].map((m) => ({
      role: m.from === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
    pushMessage(userMsg);
    userMsgCountRef.current += 1;

    const finalText = await requestReply(apiHistory, { calibrating });
    if (!finalText) return;

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

  return (
    <div className="chat">
      <header className="chat-header">
        {isFirstEverInstall ? (
          <div className="chat-avatar mascot-intro">
            <BroMascot pose={headerPose} size={52} idle="sway" />
          </div>
        ) : (
          <div className="chat-avatar">
            <BroMascot pose="default" size={52} idle="sway" />
          </div>
        )}
        <div className="chat-header-text">
          <span className="chat-title">бро</span>
          <span className="chat-status">
            {!isStreaming && <span className="chat-status-dot" />}
            {isStreaming ? 'печатает…' : 'онлайн'}
          </span>
        </div>
      </header>

      <div className="chat-feed">
        {messages.map((msg, i) => (
          <div
            key={msg.id}
            className={msg.from === 'bro' ? 'msg-row msg-row--bro' : 'msg-row msg-row--user'}
            style={{ animationDelay: `${groupStagger(i)}ms` }}
          >
            {msg.from === 'bro' && (
              <div className="msg-avatar">
                {showAvatar(i) && <BroMascot pose="default" size={46} idle="bounce" />}
              </div>
            )}
            <div className={msg.from === 'bro' ? 'bubble bubble--bro' : 'bubble bubble--user'}>
              {msg.text}
            </div>
          </div>
        ))}

        {typing && (
          <div className="msg-row msg-row--bro">
            <div className="msg-avatar">
              <BroMascot pose="thinking" size={46} idle="bounce" />
            </div>
            <div className="bubble bubble--bro bubble--typing">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}

        {streamWords !== null && (
          <div className="msg-row msg-row--bro">
            <div className="msg-avatar">
              <BroMascot pose="typing" size={46} idle="bounce" />
            </div>
            <div className="bubble bubble--bro">
              <LiveStreamWords words={streamWords} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <input
          className="pill-input chat-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="напиши что-нибудь…"
          spellCheck={false}
        />
        <button
          className={draft.trim() ? 'send-btn send-btn--active' : 'send-btn'}
          onClick={send}
          aria-label="отправить"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
