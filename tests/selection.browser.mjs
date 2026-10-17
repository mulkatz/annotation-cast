import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundled = await build({
  entryPoints: ['src/capture/selection.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'AnnotationCastSelection',
  write: false,
});
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(
    '<!doctype html><p id="partial">prefix selected suffix</p><div id="mixed">before<span contenteditable>synthetic private value</span>after</div><div id="huge"></div><div id="nodes"></div>',
  );
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const partial = await page.evaluate(() => {
    const text = document.querySelector('#partial').firstChild;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 15);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return window.AnnotationCastSelection.captureSelectedText(
      selection,
      document.activeElement,
    );
  });
  assert.deepEqual(partial, {
    selection: 'selected',
    selectionTruncated: false,
    selectionOmittedFormContent: false,
    selectionOmittedHiddenContent: false,
  });
  const mixed = await page.evaluate(() => {
    const container = document.querySelector('#mixed');
    const range = document.createRange();
    range.setStart(container.firstChild, 2);
    range.setEnd(container.lastChild, 3);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return window.AnnotationCastSelection.captureSelectedText(
      selection,
      document.activeElement,
    );
  });
  assert.equal(mixed.selection, 'fore[form content omitted]aft');
  assert.equal(mixed.selectionOmittedFormContent, true);
  assert.equal(mixed.selection.includes('synthetic private value'), false);
  const visible = await page.evaluate(() => {
    const container = document.createElement('div');
    container.innerHTML =
      '<span>Public start.</span><span style="display:none">synthetic-hidden-private-data</span><script type="application/json">{"userData":"synthetic-internal-private-data"}</script><span style="visibility:hidden">synthetic-invisible-private-data<span style="visibility:visible">Visible override.</span></span><span style="display:contents">Contents text.</span><span>Public end.</span>';
    document.body.append(container);
    const range = document.createRange();
    range.setStart(container.firstChild.firstChild, 0);
    range.setEnd(container.lastChild.firstChild, 11);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      native: selection.toString(),
      captured: window.AnnotationCastSelection.captureSelectedText(
        selection,
        document.activeElement,
      ),
    };
  });
  assert.equal(visible.captured.selection, visible.native);
  assert.equal(visible.captured.selection.includes('private-data'), false);
  assert.equal(visible.captured.selection.includes('Contents text.'), true);
  assert.equal(visible.captured.selection.includes('Visible override.'), true);
  assert.equal(visible.captured.selectionOmittedHiddenContent, true);
  const huge = await page.evaluate(() => {
    const container = document.querySelector('#huge');
    container.textContent = 'x'.repeat(100_000);
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    selection.toString = () => {
      throw new Error('Full selection text must not be read.');
    };
    Range.prototype.cloneContents = () => {
      throw new Error('Selected DOM must not be cloned.');
    };
    return window.AnnotationCastSelection.captureSelectedText(
      selection,
      document.activeElement,
    );
  });
  assert.equal(huge.selection.length, 2000);
  assert.equal(huge.selectionTruncated, true);
  const nodes = await page.evaluate(() => {
    const container = document.querySelector('#nodes');
    for (let index = 0; index < 1000; index++)
      container.append(document.createElement('span'));
    container.append('unvisited tail');
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return window.AnnotationCastSelection.captureSelectedText(
      selection,
      document.activeElement,
    );
  });
  assert.equal(nodes.selection, '');
  assert.equal(nodes.selectionTruncated, true);
  console.log(
    'Real Chromium: partial selection offsets, editable subtree omission, bounded text slices and bounded DOM traversal verified.',
  );
} finally {
  await browser.close();
}
