type Listener<T> = (payload: T) => void;

/**
 * Minimal typed pub/sub base class. No external dependency, so the library
 * stays framework-agnostic and embeddable in any environment (React, Vue,
 * a game engine's own event loop, plain scripts, ...).
 */
export class EventEmitter<EventMap extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<never>>>();

  /** Returns an unsubscribe function. */
  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  protected emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<EventMap[K]>)(payload);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
