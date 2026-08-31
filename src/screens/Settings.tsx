import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { hapticImpact, hapticNotification, hapticSelection } from '../haptics';
import { usePurchase } from '../usePurchase';
import {
  clearMemoryAndHistory,
  getRemindersEnabled,
  setRemindersEnabled,
  getChatHistory,
  getMemoryFacts,
  getThemeMode,
  setThemeMode,
  type ThemeMode
} from '../storage';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// статус тарифа для карточки в настройках; null = ещё не загружен / вне Telegram
interface BillingStatus {
  freeRemaining: number | null; // null = безлимит по подписке
  subscriptionExpiresAt: number | null;
  founderSlotsRemaining: number;
}

interface ReferralStatus {
  link: string | null; // null, пока не пришёл юзернейм бота с сервера
  count: number;
}

function formatSubDate(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' });
}

// склонение "друга/друзей" для счётчика приглашённых
function friendsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'друга';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'друзей';
  return 'друзей';
}

export default function Settings() {
  const [reminders, setReminders] = useState(getRemindersEnabled());
  const [cleared, setCleared] = useState(false);
  const [exported, setExported] = useState(false);
  const [theme, setThemeState] = useState<ThemeMode>(getThemeMode());
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [referral, setReferral] = useState<ReferralStatus>({ link: null, count: 0 });
  const [linkCopied, setLinkCopied] = useState(false);
  // известно синхронно при монтировании и не меняется за жизнь компонента —
  // на этом можно безопасно завязать САМО наличие карточки в разметке (не её
  // содержимое). Раньше карточка появлялась только после ответа сервера, а
  // до этого — то её не было, то она была короче/выше итоговой, и её приход
  // сдвигал всё остальное. Теперь карточка с первого кадра занимает финальное
  // место, меняется только текст внутри — сдвигаться уже нечему
  const [isInTelegram] = useState(() => Boolean((window as any).Telegram?.WebApp?.initData));

  // к моменту onSuccess сервер уже подтвердил оплату (usePurchase сам
  // дожидается этого), так что переспрашивать /api/sync можно сразу —
  // придёт уже актуальный subscriptionExpiresAt
  const { buy, loading: buying, confirming, error: buyError } = usePurchase(() => {
    void refreshBilling();
  });

  const refreshBilling = () => {
    const initData = (window as any).Telegram?.WebApp?.initData;
    if (!initData) return Promise.resolve();
    return fetch(`${API_BASE_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) throw new Error('bad response');
        setBilling({
          freeRemaining: typeof data.freeRemaining === 'number' ? data.freeRemaining : null,
          subscriptionExpiresAt: data.subscriptionExpiresAt ?? null,
          founderSlotsRemaining: typeof data.founderSlotsRemaining === 'number' ? data.founderSlotsRemaining : 0,
        });
        setReferral({
          link: typeof data.referralLink === 'string' ? data.referralLink : null,
          count: typeof data.referralCount === 'number' ? data.referralCount : 0,
        });
      })
      .catch(() => {
        // сеть мигнула — не оставляем карточку в вечной загрузке, откатываемся
        // к предположению "бесплатный тариф", кнопка всё равно бьёт в реальный
        // сервер при нажатии, так что неверное предположение здесь не страшно
        setBilling((prev) => prev ?? { freeRemaining: null, subscriptionExpiresAt: null, founderSlotsRemaining: 0 });
      });
  };

  // подписка и остаток лимита живут на сервере и есть только у Telegram-юзеров —
  // вне Telegram карточка тарифа вообще не рендерится
  useEffect(() => {
    void refreshBilling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleThemeChange = (mode: ThemeMode) => {
    hapticSelection();
    setThemeState(mode);
    setThemeMode(mode);
    window.dispatchEvent(new Event('theme-updated'));
  };

  const toggleReminders = () => {
    hapticImpact('light');
    setReminders((prev) => {
      const next = !prev;
      setRemindersEnabled(next);
      return next;
    });
  };

  const handleClearAll = () => {
    const confirmed = window.confirm(
      'Удалить всю память и начать заново? Это действие нельзя отменить.',
    );
    if (!confirmed) return;
    clearMemoryAndHistory();
    setCleared(true);
    hapticNotification('warning');
    window.setTimeout(() => setCleared(false), 2000);
  };

  const handleExport = () => {
    const data = {
      history: getChatHistory(),
      memory: getMemoryFacts() || []
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bro_data_export.json';
    // некоторые браузеры игнорируют click() на <a download>, если элемент не
    // в DOM — на всякий случай временно вставляем
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExported(true);
    hapticNotification('success');
    window.setTimeout(() => setExported(false), 2000);
  };

  const handleShare = () => {
    if (!referral.link) return;
    hapticImpact('light');
    const tg = (window as any).Telegram?.WebApp;
    const shareText = 'зашёл сюда — бро реально помнит, что у тебя происходит, а не как обычный бот';
    if (tg?.openTelegramLink) {
      // открывает нативный экран "переслать в чат" — не требует доступа
      // к буферу обмена и привычнее для Telegram, чем просто копирование
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referral.link)}&text=${encodeURIComponent(shareText)}`;
      tg.openTelegramLink(shareUrl);
      return;
    }
    void navigator.clipboard
      .writeText(referral.link)
      .then(() => {
        hapticNotification('success');
        setLinkCopied(true);
        window.setTimeout(() => setLinkCopied(false), 2000);
      })
      .catch(() => {
        hapticNotification('error');
      });
  };

  return (
    <div className="page">
      <h1 className="serif-heading page-title">
        <em>настройки</em>
      </h1>
      <p className="page-subtitle">пара мелочей, чтобы было удобнее</p>

      <div className="settings-list">

        {/* Тариф — только внутри Telegram, где есть подписка и лимит.
            Карточка и кнопка внутри неё смонтированы с первого кадра и больше
            никогда не появляются/исчезают и не меняют состав — меняется
            только текст. Кнопка не пропадает даже для подписчиков: сервер
            умеет складывать новые 30 дней поверх ещё активной подписки, так
            что это превращается в "продлить заранее", а не мёртвый элемент */}
        {isInTelegram && (
          <div className="settings-card">
            <div className="settings-label">тариф</div>
            <p className="settings-hint">
              {billing === null
                ? 'загружаем статус подписки…'
                : billing.subscriptionExpiresAt
                ? `подписка активна до ${formatSubDate(billing.subscriptionExpiresAt)}`
                : `бесплатно: осталось ${billing.freeRemaining ?? 15} из 15 сообщений на сегодня`}
            </p>
            {/* оффер для первых подписчиков — элемент смонтирован всегда,
                меняется только текст (та же логика, что и у карточки выше),
                чтобы появление оффера после ответа сервера не двигало layout */}
            <p className="settings-hint settings-hint--founder">
              {billing && !billing.subscriptionExpiresAt && billing.founderSlotsRemaining > 0
                ? `🎉 осталось ${billing.founderSlotsRemaining} из 20 мест: первые подписчики получают 90 дней вместо 30 за те же 150 ⭐`
                : ' '}
            </p>
            {buyError && <p className="settings-hint settings-hint--error">{buyError}</p>}
            <motion.button
              whileTap={{ scale: 0.96 }}
              className="settings-buy-btn"
              onClick={buy}
              disabled={buying || billing === null}
            >
              {confirming
                ? 'подтверждаем оплату…'
                : buying
                ? 'открываем счёт…'
                : billing === null
                ? '…'
                : billing.subscriptionExpiresAt
                ? 'продлить ещё на 30 дней за 150 ⭐'
                : billing.founderSlotsRemaining > 0
                ? 'подписаться на 90 дней за 150 ⭐'
                : 'подписаться за 150 ⭐'}
            </motion.button>
          </div>
        )}

        {/* Реферальная программа — та же логика, что и карточка тарифа:
            структура неизменна с первого кадра, меняется только текст */}
        {isInTelegram && (
          <div className="settings-card">
            <div className="settings-label">пригласи друга</div>
            <p className="settings-hint">
              {referral.count > 0
                ? `ты пригласил ${referral.count} ${friendsWord(referral.count)} — бонусные дни уже начислены`
                : 'за каждого друга, который зайдёт по твоей ссылке и откроет бро — день подписки в подарок'}
            </p>
            <motion.button
              whileTap={{ scale: 0.96 }}
              className="settings-buy-btn"
              onClick={handleShare}
              disabled={!referral.link}
            >
              {linkCopied ? 'ссылка скопирована' : referral.link ? 'поделиться ссылкой' : '…'}
            </motion.button>
          </div>
        )}

        {/* Тема */}
        <div className="settings-card">
          <div className="settings-label" style={{ marginBottom: 12 }}>тема оформления</div>
          <div className="segmented-control">
            <button
              onClick={() => handleThemeChange('auto')}
              className={theme === 'auto' ? 'segment active' : 'segment'}
            >
              Авто
            </button>
            <button
              onClick={() => handleThemeChange('light')}
              className={theme === 'light' ? 'segment active' : 'segment'}
            >
              Светлая
            </button>
            <button
              onClick={() => handleThemeChange('dark')}
              className={theme === 'dark' ? 'segment active' : 'segment'}
            >
              Темная
            </button>
          </div>
        </div>

        {/* Поведение */}
        <div className="settings-card settings-card--row">
          <div>
            <div className="settings-label">писать первым</div>
            <div className="settings-hint">бро может написать тебе сам</div>
          </div>
          <motion.button
            whileTap={{ scale: 0.9 }}
            className={reminders ? 'toggle toggle--on' : 'toggle'}
            onClick={toggleReminders}
            role="switch"
            aria-checked={reminders}
            aria-label="разрешить писать первым"
          >
            <span className="toggle-knob" />
          </motion.button>
        </div>

        {/* Поддержка */}
        <a href="https://t.me/kkkorean" target="_blank" rel="noopener noreferrer" className="settings-card settings-card--row settings-link" style={{ textDecoration: 'none' }}>
          <span className="settings-label">написать фидбек</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <path d="M10 5l7 7-7 7" />
          </svg>
        </a>

        {/* Данные */}
        <motion.button whileTap={{ scale: 0.98 }} className="settings-card settings-card--row settings-link" onClick={handleExport}>
          <span className="settings-label">{exported ? 'сохранено' : 'сохранить данные'}</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            {exported ? (
              <path d="M20 6L9 17l-5-5" />
            ) : (
              <>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </>
            )}
          </svg>
        </motion.button>

        <motion.button whileTap={{ scale: 0.98 }} className="settings-card settings-card--row settings-link settings-link--danger" onClick={handleClearAll}>
          <span className="settings-label" style={{ margin: 'auto' }}>{cleared ? 'готово, всё чисто' : 'сбросить контекст (забыть всё)'}</span>
        </motion.button>
      </div>

      <p className="settings-footer">бро · v0.1</p>
    </div>
  );
}
