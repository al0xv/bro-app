import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'motion/react';
import { hapticSelection } from '../haptics';

function ChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5c0 4.14-4.03 7.5-9 7.5-1.06 0-2.08-.15-3.02-.44L4 20l1.14-3.42C3.8 15.24 3 13.45 3 11.5 3 7.36 7.03 4 12 4s9 3.36 9 7.5Z" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M9 9h6M9 13h6M9 17h3" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51.97Z" />
    </svg>
  );
}

const tabs = [
  { to: '/chat', label: 'чат', icon: <ChatIcon /> },
  { to: '/memory', label: 'память', icon: <MemoryIcon /> },
  { to: '/settings', label: 'настройки', icon: <SettingsIcon /> },
];

export default function TabBar() {
  const location = useLocation();
  const rawIndex = tabs.findIndex((tab) => location.pathname.startsWith(tab.to));
  const activeIndex = rawIndex === -1 ? null : rawIndex;

  return (
    <nav className="tabbar">
      {activeIndex !== null && (
        <motion.span
          className="tab-indicator"
          initial={false}
          animate={{ x: `${activeIndex * 100}%` }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
        />
      )}
      {tabs.map((tab, i) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          onClick={() => {
            if (i !== activeIndex) hapticSelection();
          }}
          className={({ isActive }) => (isActive ? 'tab tab--active' : 'tab')}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
