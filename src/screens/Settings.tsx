import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clearMemoryAndHistory,
  getRemindersEnabled,
  getUserName,
  setRemindersEnabled,
  setUserName,
} from '../storage';

const STYLES = ['обычный', 'дружеский', 'с юмором'];

export default function Settings() {
  const [name, setName] = useState(getUserName());
  const [style, setStyle] = useState(STYLES[1]);
  const [reminders, setReminders] = useState(getRemindersEnabled());
  const [cleared, setCleared] = useState(false);

  const changeName = (value: string) => {
    setName(value);
    setUserName(value);
  };

  const toggleReminders = () => {
    setReminders((prev) => {
      const next = !prev;
      setRemindersEnabled(next);
      return next;
    });
  };

  const handleClearAll = () => {
    const confirmed = window.confirm(
      'Удалить всю память и историю переписки? Это действие нельзя отменить.',
    );
    if (!confirmed) return;
    clearMemoryAndHistory();
    setCleared(true);
    window.setTimeout(() => setCleared(false), 2000);
  };

  return (
    <div className="page">
      <h1 className="serif-heading page-title">
        <em>настройки</em>
      </h1>
      <p className="page-subtitle">пара мелочей, чтобы было удобнее</p>

      <div className="settings-list">
        <div className="settings-card">
          <label className="settings-label" htmlFor="settings-name">имя</label>
          <input
            id="settings-name"
            className="pill-input"
            type="text"
            value={name}
            onChange={(e) => changeName(e.target.value)}
            placeholder="как к тебе обращаться"
            spellCheck={false}
          />
        </div>

        <div className="settings-card">
          <label className="settings-label" htmlFor="settings-style">стиль общения</label>
          <select
            id="settings-style"
            className="pill-select"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          >
            {STYLES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <p className="settings-hint">
            бро сам подстраивается под то, как ты пишешь — это только если хочешь задать явно
          </p>
        </div>

        <div className="settings-card settings-card--row">
          <div>
            <div className="settings-label">напоминания о себе</div>
            <div className="settings-hint">бро иногда напишет первым</div>
          </div>
          <button
            className={reminders ? 'toggle toggle--on' : 'toggle'}
            onClick={toggleReminders}
            role="switch"
            aria-checked={reminders}
            aria-label="напоминания о себе"
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <Link to="/settings/privacy" className="settings-card settings-card--row settings-link">
          <span className="settings-label">приватность</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </Link>

        <Link to="/help" className="settings-card settings-card--row settings-link help-link">
          <span className="settings-label">нужна помощь прямо сейчас</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </Link>

        <button className="settings-card settings-card--row settings-link settings-link--danger" onClick={handleClearAll}>
          <span className="settings-label">{cleared ? 'готово, всё чисто' : 'очистить всю память и историю чата'}</span>
        </button>
      </div>

      <p className="settings-footer">бро · v0.1</p>
    </div>
  );
}
