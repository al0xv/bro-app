import { useRef, useState } from 'react';
import { hapticImpact, hapticNotification } from './haptics';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// оплата подтверждается сервером асинхронно (successful_payment приходит боту
// через long polling), поэтому после "paid" от Telegram короткое время сервер
// ещё может считать лимит исчерпанным. Опрашиваем /api/sync, пока подписка
// не подтвердится — иначе следующая проверка снова покажет старый статус
async function waitForServerConfirmation(initData: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      const data = await res.json();
      if (data.ok && !data.needsPayment) return true;
    } catch {
      // сеть мигнула — просто пробуем ещё раз
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// общая логика покупки подписки за Telegram Stars — используется и в
// пейволле (при упоре в лимит), и в настройках (когда человек сам решил
// оформить подписку заранее, не дожидаясь лимита)
export function usePurchase(onSuccess: () => void) {
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const buy = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError(null);
    hapticImpact('light');

    const finish = () => {
      busyRef.current = false;
      setLoading(false);
      setConfirming(false);
    };

    try {
      const tg = (window as any).Telegram?.WebApp;
      const initData = tg?.initData;

      const res = await fetch(`${API_BASE_URL}/api/payment/invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      });
      const data = await res.json();

      if (!data.ok || !data.invoiceUrl) {
        throw new Error(data.error || 'не получилось создать счёт');
      }

      if (tg?.openInvoice) {
        tg.openInvoice(data.invoiceUrl, (status: string) => {
          if (status === 'paid') {
            setConfirming(true);
            void waitForServerConfirmation(initData).then(() => {
              hapticNotification('success');
              finish();
              onSuccess();
            });
          } else if (status === 'failed') {
            hapticNotification('error');
            setError('платёж не прошёл — попробуй ещё раз');
            finish();
          } else {
            // cancelled — человек передумал, молча возвращаем кнопку
            finish();
          }
        });
      } else {
        setError('оплата доступна только внутри Telegram');
        finish();
      }
    } catch (err: any) {
      setError(err.message || 'ошибка сети — попробуй ещё раз');
      finish();
    }
  };

  return { buy, loading, confirming, error };
}
