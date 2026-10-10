/**
 * Run an action once even if the same request arrives twice in quick succession (double-click,
 * shortcut plus button). Identical requests in flight, or within `settleMs` after succeeding, share
 * one result. Different requests never share a result; they run one after another, so two saves
 * can't race to close the same tabs. A failed run is forgotten at once, so retrying works.
 */
export function singleFlight<T>(settleMs = 800) {
  const recent = new Map<string, Promise<T>>();
  let queue: Promise<unknown> = Promise.resolve();

  /** `settle` overrides settleMs for this request (0: share only while it runs). */
  return (key: string, run: () => Promise<T>, settle = settleMs): Promise<T> => {
    const existing = recent.get(key);
    if (existing) return existing;

    const promise = queue.then(run, run);
    recent.set(key, promise);
    queue = promise.catch(() => undefined);
    const forget = () => {
      if (recent.get(key) === promise) recent.delete(key);
    };
    promise.then(
      () => (settle > 0 ? setTimeout(forget, settle) : forget()),
      () => forget(),
    );
    return promise;
  };
}
