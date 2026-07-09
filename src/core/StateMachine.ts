import type { ScannerState } from './types';

const TRANSITIONS: Record<ScannerState, ScannerState[]> = {
  idle: ['starting'],
  starting: ['scanning', 'stopped', 'error'],
  scanning: ['detected', 'stopped', 'error'],
  detected: ['awaiting_dismissal', 'stopped', 'error'],
  awaiting_dismissal: ['scanning', 'stopped', 'error'],
  stopped: ['starting'],
  error: ['starting', 'stopped'],
};

/**
 * Guards all scanner transitions so "dismiss before scanning resumes" and
 * similar invariants can never be bypassed by a stray call, race condition,
 * or a future contributor adding a shortcut.
 */
export class ScannerStateMachine {
  private _state: ScannerState = 'idle';

  get state(): ScannerState {
    return this._state;
  }

  canTransition(to: ScannerState): boolean {
    return TRANSITIONS[this._state].includes(to);
  }

  /** Returns true if the transition was applied, false if it was rejected as invalid. */
  transition(to: ScannerState): boolean {
    if (!this.canTransition(to)) {
      return false;
    }
    this._state = to;
    return true;
  }
}
