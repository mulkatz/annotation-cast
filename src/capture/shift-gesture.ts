interface GestureKey {
  key: string;
  code: string;
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}
interface GestureOptions<T> {
  intervalMs: number;
  freezePoint(): T | undefined;
  point(snapshot: T): void;
  rectangle(): void;
  now?: () => number;
}

/** Only transient modifier timing and one frozen marker are retained. No keyboard events are saved. */
export class ShiftGesture<T> {
  private intervalMs: number;
  private count = 0;
  private readonly heldOtherKeys = new Set<string>();
  private lastRelease = 0;
  private pressedAt: number | undefined;
  private snapshot: T | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private pointTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: GestureOptions<T>) {
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? (() => performance.now());
  }
  configure(intervalMs: number): void {
    this.reset();
    this.intervalMs = intervalMs;
  }
  reset(): void {
    this.heldOtherKeys.clear();
    this.clearSequence();
  }
  private clearSequence(): void {
    clearTimeout(this.holdTimer);
    clearTimeout(this.pointTimer);
    this.holdTimer = undefined;
    this.pointTimer = undefined;
    this.pressedAt = undefined;
    this.snapshot = undefined;
    this.count = 0;
    this.lastRelease = 0;
  }
  private isolated(event: GestureKey): boolean {
    return (
      event.key === 'Shift' &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing
    );
  }
  keydown(event: GestureKey): void {
    if (event.key !== 'Shift') {
      this.heldOtherKeys.add(event.code || event.key);
      this.clearSequence();
      return;
    }
    if (
      !this.isolated(event) ||
      this.pressedAt !== undefined ||
      this.heldOtherKeys.size
    ) {
      this.clearSequence();
      return;
    }
    const now = this.now();
    if (this.count && now - this.lastRelease >= this.intervalMs)
      this.clearSequence();
    // A third press suspends the point; its release must still meet the original release deadline.
    clearTimeout(this.pointTimer);
    this.pointTimer = undefined;
    this.pressedAt = now;
    this.holdTimer = setTimeout(() => this.clearSequence(), this.intervalMs);
  }
  keyup(event: GestureKey): void {
    if (event.key !== 'Shift') {
      this.heldOtherKeys.delete(event.code || event.key);
      this.clearSequence();
      return;
    }
    const pressedAt = this.pressedAt;
    if (
      !this.isolated(event) ||
      event.shiftKey ||
      pressedAt === undefined ||
      this.heldOtherKeys.size
    ) {
      this.clearSequence();
      return;
    }
    const now = this.now();
    const held = now - pressedAt;
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.pressedAt = undefined;
    if (held < 0 || held >= this.intervalMs) {
      this.clearSequence();
      return;
    }
    if (this.count && now - this.lastRelease >= this.intervalMs)
      this.clearSequence();
    this.lastRelease = now;
    this.count++;
    if (this.count === 2) {
      this.snapshot = this.options.freezePoint();
      this.pointTimer = setTimeout(() => {
        const snapshot = this.snapshot;
        this.clearSequence();
        if (snapshot !== undefined) this.options.point(snapshot);
      }, this.intervalMs);
    } else if (this.count === 3) {
      this.clearSequence();
      this.options.rectangle();
    }
  }
}
