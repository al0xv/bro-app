import { useLayoutEffect, useRef, useState } from 'react';
import BroMascot from '../components/BroMascot';
import { getMemoryFacts, setMemoryFacts, type MemoryFact } from '../storage';

const INITIAL_MEMORIES: MemoryFact[] = [];

const REMOVE_MS = 180; // держим в синхроне с --dur-snap
const ENTER_MS = 240; // держим в синхроне с --dur-base

function loadMemories(): MemoryFact[] {
  const stored = getMemoryFacts();
  if (stored) return stored;
  setMemoryFacts(INITIAL_MEMORIES);
  return INITIAL_MEMORIES;
}

export default function Memory() {
  const [memories, setMemoriesState] = useState<MemoryFact[]>(loadMemories);
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());
  const [enteringIds, setEnteringIds] = useState<Set<number>>(new Set());
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const prevRects = useRef(new Map<number, DOMRect>());
  const knownIds = useRef(new Set(memories.map((m) => m.id)));

  const setMemories = (updater: (prev: MemoryFact[]) => MemoryFact[]) => {
    setMemoriesState((prev) => {
      const next = updater(prev);
      setMemoryFacts(next);
      return next;
    });
  };

  const remove = (id: number) => {
    prevRects.current = new Map();
    cardRefs.current.forEach((el, key) => {
      if (key !== id) prevRects.current.set(key, el.getBoundingClientRect());
    });

    setRemovingIds((prev) => new Set(prev).add(id));

    window.setTimeout(() => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, REMOVE_MS);
  };

  // FLIP: соседние карточки плавно занимают освободившееся место
  useLayoutEffect(() => {
    cardRefs.current.forEach((el, id) => {
      const prev = prevRects.current.get(id);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) return;

      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = `transform var(--dur-base) var(--ease-out)`;
        el.style.transform = '';
      });
    });
    prevRects.current = new Map();
  }, [memories]);

  // новые карточки (например, когда бро что-то запомнил) появляются с scale+fade,
  // а не выскакивают мгновенно
  useLayoutEffect(() => {
    const newIds = memories.map((m) => m.id).filter((id) => !knownIds.current.has(id));
    if (newIds.length) {
      setEnteringIds((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => next.add(id));
        return next;
      });
      window.setTimeout(() => {
        setEnteringIds((prev) => {
          const next = new Set(prev);
          newIds.forEach((id) => next.delete(id));
          return next;
        });
      }, ENTER_MS);
    }
    knownIds.current = new Set(memories.map((m) => m.id));
  }, [memories]);

  return (
    <div className="page">
      <h1 className="serif-heading page-title">
        <em>помню</em>
      </h1>
      <p className="page-subtitle">можно удалить всё, что хочешь</p>

      {memories.length === 0 ? (
        <div className="memory-empty">
          <BroMascot pose="empty" size={260} />
          <p>пока ничего не помню — расскажи мне что-нибудь в чате</p>
        </div>
      ) : (
        <div className="memory-grid">
          {memories.map((mem, i) => (
            <div
              key={mem.id}
              ref={(el) => {
                if (el) cardRefs.current.set(mem.id, el);
                else cardRefs.current.delete(mem.id);
              }}
              className={
                (i % 2 === 1 ? 'memory-card memory-card--tinted' : 'memory-card') +
                (removingIds.has(mem.id) ? ' memory-card--removing' : '') +
                (enteringIds.has(mem.id) ? ' memory-card--entering' : '')
              }
            >
              <span className="memory-text">{mem.text}</span>
              <button
                className="memory-delete"
                onClick={() => remove(mem.id)}
                aria-label="удалить"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
