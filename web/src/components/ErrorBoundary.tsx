import { Component, type ReactNode } from 'react';

interface Props {
  /** What failed, e.g. "This page" or "This board". */
  what: string;
  /** A change of this key (e.g. the route) clears the error. */
  resetKey?: string;
  /** Show the message as the page itself (a <main>), for a boundary around a whole route. */
  asPage?: boolean;
  children: ReactNode;
}
interface State { error: unknown; key: string | undefined }

/**
 * Catches a render error below it and shows a recoverable message instead of unmounting the whole app.
 * Shared data (another user's board, a stored query) drives rendering, so one bad row must not blank the page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('render failed') };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { key: props.resetKey, error: null } : null;
  }

  componentDidCatch(error: unknown): void {
    console.error('[jt] render failed', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const notice = (
      <div className="notice notice-danger" role="alert">
        {this.props.what} couldn't be shown because of an unexpected error.
        <span>
          <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
        </span>
      </div>
    );
    return this.props.asPage ? <main className="page" id="main">{notice}</main> : notice;
  }
}
