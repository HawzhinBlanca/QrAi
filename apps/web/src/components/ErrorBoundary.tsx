import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level React error boundary. Catches uncaught render errors and shows a
 * friendly recovery UI instead of a blank screen. Does NOT catch errors in
 * event handlers or async code — only errors thrown during rendering.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to structured output (console for now; integrates with any logging layer).
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback" role="alert">
          <div className="error-boundary-card">
            <AlertTriangle size={40} className="error-boundary-icon" />
            <h2>Something went wrong</h2>
            <p>
              An unexpected error occurred. Your progress is safe — try refreshing
              or click the button below to recover.
            </p>
            {this.state.error && (
              <details className="error-boundary-details">
                <summary>Technical details</summary>
                <pre>{this.state.error.message}</pre>
              </details>
            )}
            <div className="error-boundary-actions">
              <button className="primary-action" onClick={this.handleReset} type="button">
                <RotateCcw size={16} />
                Try again
              </button>
              <button
                className="secondary-action"
                onClick={() => window.location.reload()}
                type="button"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
