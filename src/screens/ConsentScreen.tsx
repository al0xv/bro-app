import { setConsentGiven } from '../storage';

interface ConsentScreenProps {
  onAccept: () => void;
}

export default function ConsentScreen({ onAccept }: ConsentScreenProps) {
  const handleAccept = () => {
    setConsentGiven();
    onAccept();
  };

  return (
    <div className="consent-screen">
      <div className="consent-body">
        <h1 className="serif-heading page-title">
          <em>привет, я бро</em>
        </h1>
        <p className="page-subtitle">пара слов, прежде чем начнём</p>

        <div className="settings-list">
          <div className="settings-card">
            <div className="settings-label">я запоминаю мелочи о тебе</div>
            <p className="settings-hint">
              имя, что тебе важно, о чём мы говорили — всё это хранится прямо на твоём
              устройстве, а не где-то у меня в голове.
            </p>
          </div>

          <div className="settings-card">
            <div className="settings-label">текст переписки обрабатывает сервис</div>
            <p className="settings-hint">
              чтобы я мог тебе ответить, твои сообщения уходят сервису, который их
              обрабатывает и присылает ответ обратно — без этого я не смогу прочитать,
              что ты написал.
            </p>
          </div>

          <div className="settings-card">
            <div className="settings-label">всё можно стереть</div>
            <p className="settings-hint">
              память и всю историю переписки можно удалить в любой момент — в настройках,
              одной кнопкой.
            </p>
          </div>

          <a
            className="settings-card settings-card--row settings-link help-link"
            href="tel:88002000122"
          >
            <span className="settings-label">если станет тяжело — помощь всегда рядом</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </a>
        </div>
      </div>

      <button className="btn-primary consent-btn" onClick={handleAccept}>
        понятно, погнали
      </button>
    </div>
  );
}
