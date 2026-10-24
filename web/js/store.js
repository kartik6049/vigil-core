/**
 * One store for the whole console. Components never talk to each other:
 * they read state, and ask for changes through set(patch).
 * Subscribers are told which keys actually changed, so each view can skip work that is not its business.
 */
export function createStore(initial) {
  let state = { ...initial };
  const subscribers = new Set();

  return {
    get: () => state,

    set(patch) {
      const changed = Object.keys(patch).filter((k) => !Object.is(state[k], patch[k]));
      if (changed.length === 0) return;
      state = { ...state, ...patch };
      subscribers.forEach((fn) => fn(state, changed));
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
