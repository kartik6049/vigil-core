import type { Response } from 'express';

/**
 * Fan-out hub for Server-Sent Events. Routes publish; every connected
 * /stream client receives the event. In-memory, so it assumes one API instance.
 */
export class EventHub {
  private clients = new Set<Response>();
  private timer?: NodeJS.Timeout;

  get size(): number {
    return this.clients.size;
  }

  add(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stop proxies from buffering the stream
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  publish(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  /** Comment lines keep idle connections open through proxies. */
  startHeartbeat(ms = 25_000): void {
    this.timer = setInterval(() => {
      for (const client of this.clients) client.write(': ping\n\n');
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
