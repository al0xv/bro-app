// тонкая обёртка над Telegram WebApp Haptics — единая точка вместо
// повторяющегося `(window as any).Telegram?.WebApp?.HapticFeedback` по всему коду.
// Вне Telegram (обычный браузер) тихо ничего не делает — там этого API просто нет

type ImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
type NotificationType = 'success' | 'warning' | 'error';

function webApp(): any {
  return (window as any).Telegram?.WebApp;
}

export function hapticImpact(style: ImpactStyle = 'light') {
  webApp()?.HapticFeedback?.impactOccurred(style);
}

export function hapticNotification(type: NotificationType) {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}

// специально для переключения между вариантами (сегменты, табы) — более
// лёгкий "тик", чем impact, так задумано самим Telegram API
export function hapticSelection() {
  webApp()?.HapticFeedback?.selectionChanged();
}
