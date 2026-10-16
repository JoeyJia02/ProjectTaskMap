/** Measure content, never mutate the iframe viewport to discover its height. */
export function observeContentSize(root: HTMLElement, report: (size: { width: number; height: number }) => Promise<unknown>) {
  let frame = 0;
  let closed = false;
  let last = '';
  const schedule = () => {
    if (closed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (closed || document.visibilityState === 'hidden') return;
      const height = Math.ceil(root.getBoundingClientRect().height);
      const width = Math.ceil(window.innerWidth);
      // A hidden/reparenting widget must not collapse its host to zero.
      if (height <= 0 || width <= 0) return;
      const key = `${width}:${height}`;
      if (key === last) return;
      last = key;
      void report({ width, height }).catch(() => { if (!closed && last === key) last = ''; });
    });
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(root);
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return () => {
    closed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('visibilitychange', schedule);
  };
}
