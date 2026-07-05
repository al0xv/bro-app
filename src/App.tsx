import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import TabBar from './components/TabBar';
import Chat from './screens/Chat';
import Memory from './screens/Memory';
import Settings from './screens/Settings';
import PrivacyInfo from './screens/PrivacyInfo';
import HelpNow from './screens/HelpNow';

function TabLayout() {
  const location = useLocation();
  return (
    <div className="screen">
      <div className="screen-body">
        {/* key на pathname форсит ремаунт при смене вкладки/страницы, чтобы
            fade+translateY анимация проигрывалась заново при каждом переходе */}
        <div className="route-fade" key={location.pathname}>
          <Outlet />
        </div>
      </div>
      <TabBar />
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      
      // Optionally adjust theme here, or just keep it default
      // tg.setHeaderColor('bg_color'); // e.g., to hide the header seam
    }
  }, []);

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="phone">
        <Routes>
          <Route element={<TabLayout />}>
            <Route path="/chat" element={<Chat />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/privacy" element={<PrivacyInfo />} />
            <Route path="/help" element={<HelpNow />} />
          </Route>
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
