import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundled = await build({
  entryPoints: ['src/content.ts'],
  bundle: true,
  format: 'iife',
  write: false,
});
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const problems = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  await context.route('**/*', async (route) => {
    if (route.request().url() === 'https://annotation-cast.test/fixture') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Synthetic marker fixture</title><style>body{font:20px sans-serif;padding:30px}#target{color:rgb(0,0,255);padding:20px}#target:hover{background:yellow}</style></head><body><button id="target">Original hover target</button><p id="quote">Original selected statement</p><input id="typing" aria-label="Synthetic text field"><script>window.nativePrevented=[];window.shiftReleases=[];addEventListener("keyup",event=>{window.nativePrevented.push(event.defaultPrevented);if(event.key==="Shift")window.shiftReleases.push(Date.now())});</script></body></html>',
      });
    } else {
      problems.push('Unexpected network request in marker test.');
      await route.abort();
    }
  });
  context.on('weberror', (error) => problems.push(error.error().message));
  const page = await context.newPage();
  await page.goto('https://annotation-cast.test/fixture');
  await page.evaluate(() => {
    window.markerMessages = [];
    window.chrome.runtime = {
      id: 'synthetic',
      sendMessage: async (message) => {
        if (message.event)
          window.markerMessages.push({
            event: structuredClone(message.event),
            receivedAt: Date.now(),
          });
        return { ok: true };
      },
      onMessage: {
        addListener: (listener) => {
          window.markerListener = listener;
        },
      },
    };
  });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const initialize = async (interval = 180) => {
    await page.evaluate((shiftTapIntervalMs) => {
      window.markerStartedAt = Date.now() - 1000;
      window.markerListener(
        {
          target: 'content',
          type: 'initialize',
          sessionId: 'synthetic-session',
          startedAt: window.markerStartedAt,
          shiftTapIntervalMs,
        },
        { id: 'synthetic' },
        () => undefined,
      );
      window.markerMessages = [];
      window.nativePrevented = [];
      window.shiftReleases = [];
    }, interval);
    await page.locator('#target').hover();
  };
  const tap = async (gap = 25) => {
    await page.keyboard.press('Shift');
    await page.waitForTimeout(gap);
  };
  const marked = () =>
    page.evaluate(() =>
      window.markerMessages.filter(({ event }) =>
        ['point', 'rectangle'].includes(event.type),
      ),
    );
  await initialize();
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#quote'));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await tap();
  await page.keyboard.press('Shift');
  assert.equal(
    (await marked()).length,
    0,
    'The tentative point must wait for a possible third tap.',
  );
  const releasedAt = await page.evaluate(() => window.shiftReleases.at(-1));
  await page.evaluate(() => {
    document.querySelector('#target').textContent = 'Changed after second tap';
    document.querySelector('#target').style.color = 'red';
    document.querySelector('#quote').textContent = 'Changed selection';
    history.pushState({}, '', '#changed');
  });
  await page.mouse.move(900, 500);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.waitForTimeout(220);
  const [frozen] = await marked();
  assert.equal((await marked()).length, 1);
  assert.equal(frozen.event.type, 'point');
  assert.equal(frozen.event.url, 'https://annotation-cast.test/fixture');
  assert.equal(frozen.event.data.viewport.width, 1280);
  assert.equal(frozen.event.data.selection, 'Original selected statement');
  assert.ok(frozen.event.data.x < 400);
  assert.ok(
    frozen.event.data.candidates.some(
      (candidate) =>
        candidate.label === 'Original hover target' &&
        candidate.styles.color === 'rgb(0, 0, 255)',
    ),
  );
  assert.ok(
    frozen.receivedAt - releasedAt >= 155,
    'Point delivery must be deferred.',
  );
  const expectedTime =
    releasedAt - (await page.evaluate(() => window.markerStartedAt));
  assert.ok(
    Math.abs(frozen.event.time - expectedTime) < 30,
    'The point timestamp must match the second tap, not its later delivery.',
  );

  await initialize();
  await tap();
  await tap();
  await tap();
  await page.waitForTimeout(220);
  assert.equal(
    (await marked()).length,
    0,
    'Triple Shift must not publish its tentative point.',
  );
  await page.mouse.move(60, 160);
  await page.mouse.down();
  await page.mouse.move(260, 250);
  await page.mouse.up();
  const [rectangle] = await marked();
  assert.equal(rectangle.event.type, 'rectangle');
  assert.equal(rectangle.event.data.width, 200);

  await initialize();
  await page.locator('#typing').focus();
  await page.locator('#target').hover();
  await tap();
  await tap();
  await page.waitForTimeout(200);
  assert.equal(
    (await marked()).filter(({ event }) => event.type === 'point').length,
    1,
  );
  assert.equal(await page.evaluate(() => document.activeElement.id), 'typing');
  assert.equal(await page.locator('#typing').inputValue(), '');
  assert.ok(
    (await page.evaluate(() => window.nativePrevented)).every(
      (value) => !value,
    ),
  );

  await initialize();
  await page.locator('#typing').focus();
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(220);
  assert.equal(await page.locator('#typing').inputValue(), 'A');
  assert.equal((await marked()).length, 0);
  for (const held of ['a', 'ArrowLeft']) {
    await initialize();
    await page.locator('#typing').focus();
    const before = await page.locator('#typing').inputValue();
    await page.keyboard.down(held);
    await tap();
    await tap();
    await page.waitForTimeout(220);
    await page.keyboard.up(held);
    assert.equal(
      (await marked()).length,
      0,
      `${held}+Shift must remain an editing chord.`,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'typing',
    );
    assert.equal(
      await page.locator('#typing').inputValue(),
      held === 'a' ? `${before}a` : before,
    );
  }
  await initialize();
  await page.locator('#target').focus();
  await tap();
  await tap();
  await page.locator('#typing').focus();
  await page.waitForTimeout(220);
  assert.equal(
    (await marked()).length,
    0,
    'A focus change must clear the pending point.',
  );

  await initialize(300);
  await tap(230);
  await page.keyboard.press('Shift');
  await page.waitForTimeout(220);
  assert.equal((await marked()).length, 0);
  await page.waitForTimeout(120);
  assert.equal((await marked()).length, 1);
  await initialize(100);
  await tap(140);
  await tap();
  await page.waitForTimeout(150);
  assert.equal((await marked()).length, 0);

  await initialize();
  await page.evaluate(() => {
    for (let tap = 0; tap < 2; tap++) {
      dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Shift',
          code: 'ShiftLeft',
          shiftKey: true,
        }),
      );
      dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }),
      );
    }
  });
  await page.waitForTimeout(220);
  assert.equal(
    (await marked()).length,
    0,
    'Untrusted keyboard events must be ignored.',
  );
  await tap();
  await tap();
  await page.evaluate(() =>
    window.markerListener(
      { target: 'content', type: 'cleanup' },
      { id: 'synthetic' },
      () => undefined,
    ),
  );
  await page.waitForTimeout(220);
  assert.equal(
    (await marked()).length,
    0,
    'Cleanup must clear the pending point.',
  );

  await initialize();
  await tap();
  await tap();
  await tap();
  await page.keyboard.press('Escape');
  await page.mouse.move(80, 180);
  await page.mouse.down();
  await page.mouse.move(240, 260);
  await page.mouse.up();
  assert.equal(
    (await marked()).length,
    0,
    'Escape must cancel rectangle drawing.',
  );
  assert.deepEqual(problems, []);
  console.log(
    'Real Chromium: trusted Shift double/triple gestures, frozen point evidence, rectangle drawing/Escape, focused forms, native typing/chords, custom timing, focus/cleanup resets and untrusted input rejection verified. Synthetic session context only; no recording or provider compatibility claim.',
  );
} finally {
  await browser.close();
}
