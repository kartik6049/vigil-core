import { CONFIG } from '../config.js';

/**
 * Server-Sent Events over fetch. The browser's EventSource cannot send an Authorization header,
 * and putting the token in the URL would leak it into logs, so we read the stream ourselves.
 * Reconnects with backoff. Returns { stop }.
 */
export function startStream({ getToken, onEvent, onStatus }) {
  let stopped = false;
  let controller = null;
  let delay = 1000;

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      try {
        onStatus('connecting');
        const res = await fetch(`${CONFIG.API_BASE}/stream`, {
          headers: { Authorization: `Bearer ${getToken()}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (res.status === 401) {
          onStatus('off'); // token expired: the API layer signs the user out on its next call
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onStatus('live');
        delay = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            dispatch(frame);
          }
        }
      } catch {
        /* network drop or abort: fall through to reconnect */
      }
      if (stopped) return;
      onStatus('reconnecting');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }

  function dispatch(frame) {
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat or comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    try {
      onEvent(event, JSON.parse(data.join('\n')));
    } catch {
      /* ignore a malformed frame */
    }
  }

  run();
  return {
    stop() {
      stopped = true;
      controller?.abort();
      onStatus('off');
    },
  };
}
