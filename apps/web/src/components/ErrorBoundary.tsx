import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { withTranslation, type WithTranslation } from "react-i18next";

interface Props extends WithTranslation {
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
 *
 * Class component -- useTranslation() (a hook) can't be called here directly, so this uses
 * react-i18next's withTranslation() HOC instead, which injects the same `t` function as a prop.
 */
class ErrorBoundaryImpl extends Component<Props, State> {
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
    const { t } = this.props;
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback" role="alert">
          <div className="error-boundary-card">
            <AlertTriangle size={40} className="error-boundary-icon" />
            <h2>{t("errorBoundary.title")}</h2>
            <p>{t("errorBoundary.body")}</p>
            {this.state.error && (
              <details className="error-boundary-details">
                <summary>{t("errorBoundary.technicalDetails")}</summary>
                <pre>{this.state.error.message}</pre>
              </details>
            )}
            <div className="error-boundary-actions">
              <button className="primary-action" onClick={this.handleReset} type="button">
                <RotateCcw size={16} />
                {t("errorBoundary.tryAgain")}
              </button>
              <button
                className="secondary-action"
                onClick={() => window.location.reload()}
                type="button"
              >
                {t("errorBoundary.reloadPage")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryImpl);
