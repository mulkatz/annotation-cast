import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { ModifierGesture } from '../src/capture/shift-gesture';

const shift = {
  key: 'Shift',
  code: 'ShiftLeft',
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: true,
  isComposing: false,
};
const control = {
  ...shift,
  key: 'Control',
  code: 'ControlLeft',
  ctrlKey: true,
  shiftKey: false,
};
const release = (event: typeof shift) => ({
  ...event,
  shiftKey: false,
  ctrlKey: false,
});
describe('isolated modifier gestures', () => {
  let gesture: ModifierGesture;
  let point: Mock<() => void>;
  let rectangle: Mock<() => void>;
  const tap = (key = control, gap = 20, hold = 10) => {
    vi.advanceTimersByTime(gap);
    gesture.keydown(key);
    vi.advanceTimersByTime(hold);
    gesture.keyup(release(key));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    point = vi.fn();
    rectangle = vi.fn();
    gesture = new ModifierGesture({
      intervalMs: 180,
      point,
      rectangle,
      now: () => Date.now(),
    });
  });
  afterEach(() => vi.useRealTimers());
  it('publishes a point immediately on the second Control release', () => {
    tap();
    expect(point).not.toHaveBeenCalled();
    tap();
    expect(point).toHaveBeenCalledTimes(1);
    expect(rectangle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(point).toHaveBeenCalledTimes(1);
  });
  it('enters rectangle mode on double Shift and never turns a late third Shift into a point', () => {
    tap(shift);
    tap(shift);
    expect(rectangle).toHaveBeenCalledTimes(1);
    tap(shift, 170);
    vi.advanceTimersByTime(500);
    expect(rectangle).toHaveBeenCalledTimes(1);
    expect(point).not.toHaveBeenCalled();
  });
  it('does not share a prefix between Shift and Control gestures', () => {
    tap(shift);
    tap(control);
    tap(shift);
    tap(control);
    expect(point).not.toHaveBeenCalled();
    expect(rectangle).not.toHaveBeenCalled();
    tap(control);
    expect(point).toHaveBeenCalledTimes(1);
  });
  it.each([shift, control])(
    'rejects invalid activity between $key taps',
    (key) => {
      for (const override of [
        { key: 'a', code: 'KeyA' },
        { repeat: true },
        { altKey: true },
        { metaKey: true },
        { isComposing: true },
        key.key === 'Shift' ? { ctrlKey: true } : { shiftKey: true },
      ]) {
        gesture.reset();
        tap(key);
        gesture.keydown({ ...key, ...override });
        gesture.keyup(release({ ...key, ...override }));
        tap(key);
        expect(point).not.toHaveBeenCalled();
        expect(rectangle).not.toHaveBeenCalled();
      }
    },
  );
  it.each([shift, control])(
    'rejects held/repeated/simultaneous $key and orphan releases',
    (key) => {
      gesture.keyup(release(key));
      tap(key);
      gesture.keydown(key);
      gesture.keydown({ ...key, repeat: true });
      gesture.keyup(release(key));
      tap(key, 20, 180);
      gesture.keydown(key);
      const other = { ...key, code: `${key.key}Right` };
      gesture.keydown(other);
      gesture.keyup({
        ...release(other),
        [key.key === 'Shift' ? 'shiftKey' : 'ctrlKey']: true,
      });
      gesture.keyup(release(key));
      tap(key);
      expect(point).not.toHaveBeenCalled();
      expect(rectangle).not.toHaveBeenCalled();
    },
  );
  it('rejects simultaneous Control and Shift even after the first modifier is released', () => {
    gesture.keydown(control);
    gesture.keydown({ ...shift, ctrlKey: true });
    gesture.keyup({ ...release(control), shiftKey: true });
    gesture.keyup(release(shift));
    tap(shift);
    expect(point).not.toHaveBeenCalled();
    expect(rectangle).not.toHaveBeenCalled();
  });
  it.each([shift, control])(
    'blocks $key taps while an ordinary key pressed earlier remains held',
    (key) => {
      const letter = { ...release(shift), key: 'a', code: 'KeyA' };
      gesture.keydown(letter);
      tap(key);
      tap(key);
      expect(point).not.toHaveBeenCalled();
      expect(rectangle).not.toHaveBeenCalled();
      gesture.keyup(letter);
      tap(key);
      tap(key);
      expect(key.key === 'Control' ? point : rectangle).toHaveBeenCalledTimes(
        1,
      );
    },
  );
  it.each([shift, control])(
    'reset clears the partial $key pair and held state',
    (key) => {
      tap(key);
      gesture.reset();
      gesture.keyup(release(key));
      tap(key);
      expect(point).not.toHaveBeenCalled();
      expect(rectangle).not.toHaveBeenCalled();
      gesture.reset();
      gesture.keydown(key);
      gesture.reset();
      tap(key);
      tap(key);
      expect(key.key === 'Control' ? point : rectangle).toHaveBeenCalledTimes(
        1,
      );
    },
  );
  it('uses strict completed-release timing including the second hold and resets on configuration', () => {
    tap(control);
    tap(control, 170, 10);
    expect(point).not.toHaveBeenCalled();
    gesture.configure(350);
    tap(control);
    tap(control, 300, 10);
    expect(point).toHaveBeenCalledTimes(1);
    tap(control);
    gesture.configure(100);
    tap(control);
    expect(point).toHaveBeenCalledTimes(1);
    gesture.reset();
    tap(control);
    tap(control, 89, 10);
    expect(point).toHaveBeenCalledTimes(2);
    gesture.reset();
    tap(control);
    tap(control, 90, 10);
    expect(point).toHaveBeenCalledTimes(2);
  });
});
