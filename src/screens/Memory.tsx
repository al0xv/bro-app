import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import BroMascot from '../components/BroMascot';
import { hapticImpact } from '../haptics';
import { getMemoryFacts, setMemoryFacts, type MemoryFact } from '../storage';

const INITIAL_MEMORIES: MemoryFact[] = [];

function loadMemories(): MemoryFact[] {
  const stored = getMemoryFacts();
  if (stored) return stored;
  setMemoryFacts(INITIAL_MEMORIES);
  return INITIAL_MEMORIES;
}

export default function Memory() {
  const [memories, setMemoriesState] = useState<MemoryFact[]>(loadMemories);
  const [editingId, setEditingId] = useState<number | null>(null);

  const subtitle = `можно удалить всё, что хочешь`;

  const commitEdit = (id: number, newText: string) => {
    if (newText.trim()) {
      hapticImpact('light');
      setMemories((prev) => prev.map((m) => (m.id === id ? { ...m, text: newText.trim() } : m)));
    }
    setEditingId(null);
  };

  const setMemories = (updater: (prev: MemoryFact[]) => MemoryFact[]) => {
    setMemoriesState((prev) => {
      const next = updater(prev);
      setMemoryFacts(next);
      return next;
    });
  };

  const remove = (id: number) => {
    hapticImpact('medium');
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  return (
    <div className="page">
      <h1 className="serif-heading page-title">
        <em>помню</em>
      </h1>
      <p className="page-subtitle">{subtitle}</p>

      {memories.length === 0 ? (
        <div className="memory-empty">
          <BroMascot pose="empty" size={260} />
          <p>пока ничего не помню — расскажи мне что-нибудь в чате</p>
        </div>
      ) : (
        <div className="memory-grid">
          <AnimatePresence mode="popLayout">
            {memories.map((mem, i) => (
              <motion.div
                layout
                key={mem.id}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ type: "spring", stiffness: 350, damping: 25 }}
                className={`memory-card ${i % 2 === 1 ? 'memory-card--tinted' : ''}`}
              >
                {editingId === mem.id ? (
                  <input
                    autoFocus
                    defaultValue={mem.text}
                    style={{ flex: 1, background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', outline: 'none', minWidth: 0 }}
                    onBlur={(e) => commitEdit(mem.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit(mem.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <span className="memory-text" onClick={() => setEditingId(mem.id)}>{mem.text}</span>
                )}
                <motion.button
                  whileTap={{ scale: 0.8 }}
                  className="memory-delete"
                  onClick={() => remove(mem.id)}
                  aria-label="удалить"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </motion.button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
