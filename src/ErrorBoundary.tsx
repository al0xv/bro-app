import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      // технические детали (this.state.error/errorInfo) уже ушли в console.error
      // в componentDidCatch — здесь показываем только дружелюбное сообщение,
      // не палим стектрейс и внутренности приложения обычному пользователю
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            padding: '32px 24px',
            minHeight: '100vh',
            textAlign: 'center',
            fontFamily: '-apple-system, sans-serif',
            background: '#F5F0E6',
            color: '#33302A',
          }}
        >
          <p style={{ fontSize: '17px', fontWeight: 500, margin: 0 }}>ой, что-то сломалось</p>
          <p style={{ fontSize: '14px', color: '#837C6C', margin: 0, maxWidth: '280px' }}>
            попробуй обновить страницу — обычно это помогает. память и история переписки никуда не денутся.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '8px',
              padding: '12px 24px',
              borderRadius: '999px',
              border: 'none',
              background: '#4F7FA6',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            обновить
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
