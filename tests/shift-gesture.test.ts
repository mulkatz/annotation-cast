import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { ShiftGesture } from '../src/capture/shift-gesture';

const down = {
  key: 'Shift',
  code: 'ShiftLeft',
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: true,
  isComposing: false,
};
const up = { ...down, shiftKey: false };
describe('isolated Shift gestures', () => {
  let gesture: ShiftGesture<{ time: number; context: string }>;
  let context: string;
  let freeze: Mock<() => { time: number; context: string }>;
  let point: Mock<(snapshot: { time: number; context: string }) => void>;
  let rectangle: Mock<() => void>;
  const tap = (gap = 20, hold = 10) => {
    vi.advanceTimersByTime(gap);
    gesture.keydown(down);
    vi.advanceTimersByTime(hold);
    gesture.keyup(up);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    context = 'original';
    freeze = vi.fn(() => ({ time: Date.now(), context }));
    point = vi.fn();
    rectangle = vi.fn();
    gesture = new ShiftGesture({
      intervalMs: 180,
      freezePoint: freeze,
      point,
      rectangle,
      now: () => Date.now(),
    });
  });
  afterEach(() => vi.useRealTimers());
  it('freezes on the second completed tap and publishes that exact snapshot only after the window', () => {
    tap();
    tap();
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(point).not.toHaveBeenCalled();
    context = 'changed';
    vi.advanceTimersByTime(179);
    expect(point).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(point).toHaveBeenCalledWith({ time: 60, context: 'original' });
    expect(rectangle).not.toHaveBeenCalled();
  });
  it('gives a completed triple priority without publishing its tentative point', () => {
    tap();
    tap();
    tap();
    vi.advanceTimersByTime(500);
    expect(rectangle).toHaveBeenCalledTimes(1);
    expect(point).not.toHaveBeenCalled();
  });
  it('suspends the point during a third press but rejects a late third release', () => {
    tap();
    tap();
    vi.advanceTimersByTime(170);
    gesture.keydown(down);
    vi.advanceTimersByTime(20);
    expect(point).not.toHaveBeenCalled();
    gesture.keyup(up);
    vi.advanceTimersByTime(500);
    expect(point).not.toHaveBeenCalled();
    expect(rectangle).not.toHaveBeenCalled();
  });
  it.each([
    { key: 'a', shiftKey: true },
    { repeat: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
  ])(
    'invalidates pending points on disallowed keyboard activity %j',
    (override) => {
      tap();
      tap();
      gesture.keydown({ ...down, ...override });
      gesture.keyup(up);
      vi.advanceTimersByTime(500);
      expect(point).not.toHaveBeenCalled();
      expect(rectangle).not.toHaveBeenCalled();
    },
  );
  it('rejects held Shift, simultaneous Shift keys and keyup without a recording-local keydown', () => {
    gesture.keyup(up);
    tap();
    gesture.keydown(down);
    gesture.keydown(down);
    gesture.keyup({ ...up, shiftKey: true });
    gesture.keyup(up);
    gesture.keydown(down);
    vi.advanceTimersByTime(180);
    gesture.keyup(up);
    vi.advanceTimersByTime(500);
    expect(point).not.toHaveBeenCalled();
    expect(rectangle).not.toHaveBeenCalled();
  });
  it('reset discards held keys, pending snapshots and stale timers', () => {
    tap();
    tap();
    gesture.reset();
    vi.advanceTimersByTime(500);
    gesture.keyup(up);
    tap();
    vi.advanceTimersByTime(500);
    expect(point).not.toHaveBeenCalled();
    expect(rectangle).not.toHaveBeenCalled();
  });
  it('uses the configured completed-tap gap and resets on configuration changes', () => {
    gesture.configure(350);
    tap();
    tap(250);
    vi.advanceTimersByTime(349);
    expect(point).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(point).toHaveBeenCalledTimes(1);
    tap();
    tap();
    gesture.configure(100);
    vi.advanceTimersByTime(400);
    expect(point).toHaveBeenCalledTimes(1);
    tap();
    tap(110);
    vi.advanceTimersByTime(200);
    expect(point).toHaveBeenCalledTimes(1);
  });
  it('blocks Shift taps while an ordinary key pressed earlier is still held', () => {
    const letter = { ...up, key: 'a', code: 'KeyA' };
    gesture.keydown(letter);
    tap();
    tap();
    vi.advanceTimersByTime(200);
    expect(point).not.toHaveBeenCalled();
    expect(rectangle).not.toHaveBeenCalled();
    gesture.keyup(letter);
    tap();
    tap();
    vi.advanceTimersByTime(180);
    expect(point).toHaveBeenCalledTimes(1);
  });
});
