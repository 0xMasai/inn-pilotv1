/**
 * Error boundary for the concierge page.
 *
 * Catches unexpected errors in any concierge component (message bubbles,
 * cards, the composer, the home section) and shows a guest-safe message
 * with a retry button, instead of React's unhandled error white screen.
 *
 * The boundary does not wrap the whole-page states (LoadingScreen,
 * LoadErrorScreen, NotFoundScreen) — those already handle their own
 * failures at the `HotelConcierge` level. It wraps the live chat area,
 * so a crash in one message bubble never hides earlier messages.
 */
import { Component, ErrorInfo, ReactNode, createElement } from "react";

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  readonly state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log for operators; never send to the guest.
    console.error("[concierge] component error:", error, errorInfo.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-[100dvh] flex items-center justify-center px-5" style={{ background: "var(--app-bg)" }}>
          <div className="card p-8 max-w-md w-full text-center space-y-3">
            <span className="empty-icon mx-auto">⚠️</span>
            <h1 className="font-poppins text-xl font-semibold">The concierge hit an error</h1>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              The concierge hit an error. Your earlier messages are still here — send again to continue.
            </p>
            <button type="button" className="btn btn-primary" onClick={this.reset}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return createElement(this.props.children);
  }
}
