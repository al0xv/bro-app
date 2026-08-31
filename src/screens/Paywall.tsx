import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import BroMascot from '../components/BroMascot';
import { usePurchase } from '../usePurchase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

interface PaywallProps {
  onSuccess: () => void;
  onClose: () => void;
}

export default function Paywall({ onSuccess, onClose }: PaywallProps) {
  const { buy, loading, confirming, error } = usePurchase(onSuccess);
  // пейволл — свежесмонтированное модальное окно с собственной анимацией
  // появления, а не персистентный элемент вкладки, так что не действует
  // правило "финальная позиция с первого кадра" — короткое появление
  // баннера оффера после ответа сервера здесь ничего не сдвигает
  const [founderSlotsRemaining, setFounderSlotsRemaining] = useState<number | null>(null);

  useEffect(() => {
    const initData = (window as any).Telegram?.WebApp?.initData;
    if (!initData) return;
    fetch(`${API_BASE_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && typeof data.founderSlotsRemaining === 'number') {
          setFounderSlotsRemaining(data.founderSlotsRemaining);
        }
      })
      .catch(() => {
        // не критично — просто не покажем оффер в этот раз
      });
  }, []);

  const isFounderOffer = (founderSlotsRemaining ?? 0) > 0;

  return (
    <motion.div
      className="paywall-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <motion.div
        className="paywall-card"
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      >
        <button className="paywall-close-btn" onClick={onClose} aria-label="закрыть">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="paywall-mascot">
          <BroMascot pose="happy" size={96} />
        </div>
        <h2>
          <em>на сегодня сообщения закончились</em>
        </h2>
        <p>
          бесплатно — 15 сообщений в день. завтра лимит обновится, а с подпиской
          можно не ждать: 30 дней общения без ограничений.
        </p>

        <ul className="paywall-features">
          <li>сообщения без дневного лимита</li>
          <li>память и история никуда не денутся</li>
          <li>и ты поддерживаешь развитие бро</li>
        </ul>

        {isFounderOffer && (
          <p className="paywall-founder-note">
            🎉 осталось {founderSlotsRemaining} из 20 мест: первые подписчики получают 90 дней вместо 30 за те же 150 ⭐
          </p>
        )}

        {error && <div className="paywall-error">{error}</div>}

        <button className="paywall-btn" onClick={buy} disabled={loading}>
          {confirming
            ? 'подтверждаем оплату…'
            : loading
            ? 'открываем счёт…'
            : isFounderOffer
            ? 'подписаться на 90 дней за 150 ⭐'
            : 'подписаться за 150 ⭐'}
        </button>
      </motion.div>
    </motion.div>
  );
}
