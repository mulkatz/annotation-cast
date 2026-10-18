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
type Modifier = 'Shift' | 'Control';
interface GestureOptions {
  intervalMs: number;
  point(): void;
  rectangle(): void;
  now?: () => number;
}
const isModifier = (key: string): key is Modifier =>
  key === 'Shift' || key === 'Control';

/** Retains only transient held-key identities and modifier timing; nothing is persisted. */
export class ModifierGesture {
  private intervalMs: number;
  private readonly heldOtherKeys = new Set<string>();
  private readonly heldModifiers = new Set<string>();
  private previous: Modifier | undefined;
  private lastRelease = 0;
  private pressed: { key: Modifier; code: string; time: number } | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: GestureOptions) {
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? (() => performance.now());
  }
  configure(intervalMs: number): void {
    this.reset();
    this.intervalMs = intervalMs;
  }
  reset(): void {
    this.heldOtherKeys.clear();
    this.heldModifiers.clear();
    this.clearSequence();
  }
  private clearSequence(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.pressed = undefined;
    this.previous = undefined;
    this.lastRelease = 0;
  }
  private isolated(event: GestureKey): boolean {
    return (
      isModifier(event.key) &&
      !event.repeat &&
      !event.altKey &&
      !event.metaKey &&
      !(event.key === 'Shift' ? event.ctrlKey : event.shiftKey) &&
      !event.isComposing
    );
  }
  keydown(event: GestureKey): void {
    const code = event.code || event.key;
    if (!isModifier(event.key)) {
      this.heldOtherKeys.add(code);
      this.clearSequence();
      return;
    }
    this.heldModifiers.add(code);
    if (
      !this.isolated(event) ||
      this.pressed !== undefined ||
      this.heldModifiers.size !== 1 ||
      this.heldOtherKeys.size
    ) {
      this.clearSequence();
      return;
    }
    const now = this.now();
    if (
      this.previous &&
      (this.previous !== event.key || now - this.lastRelease >= this.intervalMs)
    )
      this.clearSequence();
    this.pressed = { key: event.key, code, time: now };
    this.holdTimer = setTimeout(() => this.clearSequence(), this.intervalMs);
  }
  keyup(event: GestureKey): void {
    const code = event.code || event.key;
    if (!isModifier(event.key)) {
      this.heldOtherKeys.delete(code);
      this.clearSequence();
      return;
    }
    this.heldModifiers.delete(code);
    const pressed = this.pressed;
    if (
      !this.isolated(event) ||
      event.shiftKey ||
      event.ctrlKey ||
      !pressed ||
      pressed.key !== event.key ||
      pressed.code !== code ||
      this.heldModifiers.size ||
      this.heldOtherKeys.size
    ) {
      this.clearSequence();
      return;
    }
    const now = this.now();
    const held = now - pressed.time;
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.pressed = undefined;
    if (held < 0 || held >= this.intervalMs) {
      this.clearSequence();
      return;
    }
    // Both the hold and completed keyup-to-keyup gap must be shorter than the interval.
    if (
      this.previous === event.key &&
      now - this.lastRelease >= 0 &&
      now - this.lastRelease < this.intervalMs
    ) {
      this.clearSequence();
      if (event.key === 'Control') this.options.point();
      else this.options.rectangle();
    } else {
      this.previous = event.key;
      this.lastRelease = now;
    }
  }
}
