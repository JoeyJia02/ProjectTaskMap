import { Component, type ReactNode } from 'react';

export class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="app-shell" role="alert">
      <h1>地图显示遇到问题</h1>
      <p>已保存的任务仍在服务器中。可以尝试恢复界面；未保存的输入需要重新填写。</p>
      <button className="button primary" onClick={() => this.setState(state => ({ failed: false, attempt: state.attempt + 1 }))}>恢复地图显示</button>
    </main>;
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}
