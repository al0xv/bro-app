export default function HelpNow() {
  return (
    <div className="page">
      <h1 className="serif-heading page-title">
        <em>если прямо сейчас тяжело</em>
      </h1>
      <p className="page-subtitle">
        ничего страшного, если ты просто заглянул посмотреть — эта страница всегда здесь,
        без вопросов и без осуждения
      </p>

      <div className="settings-list">
        <div className="settings-card help-card">
          <div className="settings-label">бесплатная горячая линия</div>
          <a className="help-phone" href="tel:88002000122">
            8-800-2000-122
          </a>
          <p className="settings-hint">
            анонимно, круглосуточно, по всей России. там просто выслушают — не обязательно
            знать, с чего начать разговор.
          </p>
        </div>

        <div className="settings-card">
          <p className="help-text">
            если сейчас трудно — это не навсегда, и не обязательно проходить через это одному.
            рядом есть живые люди, которые умеют помогать именно в такие моменты.
          </p>
          <p className="help-text">
            бро тоже рядом, но иногда важнее поговорить с человеком, который может побыть
            с тобой не только в переписке.
          </p>
        </div>
      </div>
    </div>
  );
}
