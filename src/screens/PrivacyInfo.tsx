export default function PrivacyInfo() {
  return (
    <div className="page">
      <h1 className="serif-heading page-title">
        <em>приватность</em>
      </h1>
      <p className="page-subtitle">что где хранится, простыми словами</p>

      <div className="settings-list">
        <div className="settings-card">
          <div className="settings-label">хранится только на этом устройстве</div>
          <p className="settings-hint">
            твоё имя, всё из раздела «память» и вся история переписки лежат в локальном
            хранилище браузера. это никуда не уходит на сервер сами по себе — только
            когда ты отправляешь сообщение.
          </p>
        </div>

        <div className="settings-card">
          <div className="settings-label">уходит к ИИ-провайдеру для обработки</div>
          <p className="settings-hint">
            чтобы бро мог ответить, текст твоего сообщения и факты из памяти отправляются
            провайдеру, который генерирует ответ. это нужно для самого ответа — без этого
            бро не сможет прочитать, что ты написал.
          </p>
        </div>

        <div className="settings-card">
          <div className="settings-label">можно удалить в любой момент</div>
          <p className="settings-hint">
            и память, и историю переписки можно стереть полностью — в настройках, внизу.
          </p>
        </div>
      </div>
    </div>
  );
}
