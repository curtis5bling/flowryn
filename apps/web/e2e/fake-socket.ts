type Listener = (...values: unknown[]) => void;

class FakeSocket {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  timeout() {
    return this;
  }
  emit(event: string, ...values: unknown[]) {
    if (event.endsWith(':join')) {
      const callback = values.at(-1);
      if (typeof callback === 'function') callback(null, { ok: true });
      return this;
    }
    this.listeners.get(event)?.forEach((listener) => listener(...values));
    return this;
  }
  connect() {
    queueMicrotask(() => this.emit('connect'));
    return this;
  }
  disconnect() {
    return this;
  }
  testDisconnect() {
    this.emit('disconnect', 'transport close');
  }
  testReconnect() {
    this.emit('connect');
  }
  testEvent(event: string, message: unknown) {
    this.emit(event, message);
  }
}

export type Socket = FakeSocket;
export const io = () => {
  const socket = new FakeSocket();
  (globalThis as typeof globalThis & { __m11Socket?: FakeSocket }).__m11Socket = socket;
  return socket;
};
