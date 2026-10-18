import assert from 'node:assert/strict';

/** Cold extension startup is observable before its event listeners are registered. */
export async function openAcceptanceControls(context, worker, testedPage) {
  await worker.evaluate(async () => {
    const until = performance.now() + 10_000;
    while (
      !chrome.action.onClicked.hasListeners() ||
      !chrome.runtime.onMessage.hasListeners()
    ) {
      if (performance.now() >= until)
        throw new Error(
          'The extension worker did not register its action/message listeners within ten seconds.',
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
  await testedPage.bringToFront();
  const id = new URL(worker.url()).host;
  const cdp = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', {
      filter: [{}],
    });
    const tab = targetInfos.find(
      (target) => target.type === 'tab' && target.url === testedPage.url(),
    );
    assert.ok(tab, 'Synthetic fixture tab target is unavailable.');
    // Observe rejection immediately, even if triggerAction itself fails. Never
    // leave a detached waitForEvent timeout or silently trigger the action twice.
    const opened = context.waitForEvent('page', { timeout: 15_000 }).then(
      (page) => ({ page }),
      (error) => ({ error }),
    );
    await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
    const result = await opened;
    if ('error' in result) throw result.error;
    const app = result.page;
    await app.waitForLoadState('domcontentloaded');
    await app.getByRole('heading', { name: 'New recording' }).waitFor();
    return app;
  } finally {
    await cdp.detach();
  }
}
