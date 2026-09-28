import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last-resort screen for a rendering error, so the reviewer sees what happened and a way
 * back instead of a blank page. Their data is untouched: it lives in the browser's database.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Wagebench screen error', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page page-narrow" role="alert" style={{ margin: '48px auto' }}>
        <section className="panel">
          <div className="panel-body">
            <h1 style={{ marginTop: 0 }}>This screen could not be shown</h1>
            <p>
              Something in the data for this screen was not what Wagebench expected. Your projects are still stored in this
              browser; nothing has been deleted.
            </p>
            <p className="small muted" style={{ fontFamily: 'var(--mono)' }}>{error.message}</p>
            <div className="row" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  window.location.hash = '#/';
                  this.setState({ error: null });
                }}
              >
                Go to all projects
              </button>
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        </section>
      </div>
    );
  }
}
