import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * What the window shows when drawing it threw, instead of nothing (React
 * takes everything down): the error, and a way back. Outside every
 * provider, so it has its own plain styles. The error goes to the console,
 * which the Mac app keeps (UI/renderer.log) and the iOS app's log has.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${error.stack ?? error}\nIn:${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          colorScheme: "light dark",
          boxSizing: "border-box",
          height: "100%",
          padding: "48px 32px",
          overflow: "auto",
          background: "Canvas",
          color: "CanvasText",
          font: "14px/1.5 -apple-system, system-ui, sans-serif",
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 17 }}>This window ran into a problem</h2>
        <p style={{ margin: "0 0 16px", opacity: 0.7 }}>
          Your terminals are fine: they keep running in the background. Reload to get back to them.
        </p>
        <button onClick={() => location.reload()} style={{ font: "inherit", padding: "4px 14px" }}>
          Reload
        </button>
        <pre style={{ marginTop: 24, fontSize: 12, whiteSpace: "pre-wrap", userSelect: "text", opacity: 0.8 }}>
          {error.stack ?? String(error)}
        </pre>
      </div>
    );
  }
}
