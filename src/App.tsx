import { useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { BrowserRouter, Navigate, useOutlet, useLocation, Route, Routes } from 'react-router-dom';
import TabBar from './components/TabBar';
import Chat from './screens/Chat';
import Memory from './screens/Memory';
import Settings from './screens/Settings';
import HelpNow from './screens/HelpNow';
import Splash from './components/Splash';
import { syncWithServer, getMemoryFacts, getRemindersEnabled, getThemeMode } from './storage';

function TabLayout() {
  const currentOutlet = useOutlet();
  const location = useLocation();
  const isChat = location.pathname === '/chat' || location.pathname === '/';
  
  return (
    <div className="screen">
      <div className="screen-body" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: isChat ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
          <Chat />
        </div>
        {!isChat && currentOutlet}
      </div>
      <TabBar />
    </div>
  );
}

export default function App() {
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;

    const applyTheme = () => {
      const savedTheme = getThemeMode();
      let isDark: boolean;
      if (savedTheme === 'auto') {
        isDark = tg?.colorScheme === 'dark' || (!tg && window.matchMedia('(prefers-color-scheme: dark)').matches);
      } else {
        isDark = savedTheme === 'dark';
      }
      document.documentElement.className = isDark ? 'theme-dark' : 'theme-light';

      // цвет хрома браузера/статус-бара Telegram синхронизирован с темой —
      // без этого при переключении на тёмную тему сверху остаётся светлая полоса
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) themeColorMeta.setAttribute('content', isDark ? '#18181A' : '#F5F0E6');

      if (tg) {
        try {
          tg.setHeaderColor('bg_color');
          tg.setBackgroundColor('bg_color');
        } catch (e) {}
      }
    };

    applyTheme();

    if (tg) {
      tg.ready();
      tg.expand();
      tg.onEvent('themeChanged', applyTheme);
    }
    
    window.addEventListener('theme-updated', applyTheme);

    syncWithServer({ memoryFacts: getMemoryFacts(), remindersEnabled: getRemindersEnabled() });

    return () => {
      if (tg) tg.offEvent('themeChanged', applyTheme);
      window.removeEventListener('theme-updated', applyTheme);
    };
  }, []);

  return (
    // reducedMotion="user" — все motion/react-анимации в приложении сами
    // подстраиваются под системную настройку "уменьшить движение", без
    // ручного аудита каждого motion.div
    <MotionConfig reducedMotion="user">
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        {/* AnimatePresence придерживает Splash в дереве, пока не доиграет его
            exit-фейд (см. Splash.tsx) — без этого showSplash=false снимал бы
            сплэш с экрана мгновенно, обрывая финальный кадр анимации */}
        <AnimatePresence>
          {showSplash && <Splash key="splash" onComplete={() => setShowSplash(false)} />}
        </AnimatePresence>
        <div className="phone">
          <Routes>
            <Route element={<TabLayout />}>
              <Route path="/chat" element={null} />
              <Route path="/memory" element={<Memory />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/help" element={<HelpNow />} />
            </Route>
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </div>
      </BrowserRouter>
    </MotionConfig>
  );
}
