const FORM_CONTENT = 'input,textarea,select,[contenteditable]';
export interface SelectedQuote {
  selection: string;
  selectionTruncated: boolean;
  selectionOmittedFormContent: boolean;
  selectionOmittedHiddenContent: boolean;
}

/** Read only selected text slices; never clone the selected DOM or materialize its full text. */
export function captureSelectedText(
  selection: Selection | null,
  focused: Element | null,
): SelectedQuote {
  const result: SelectedQuote = {
    selection: '',
    selectionTruncated: false,
    selectionOmittedFormContent: false,
    selectionOmittedHiddenContent: false,
  };
  if (!selection?.rangeCount) return result;
  if (focused?.closest(FORM_CONTENT)) {
    result.selectionOmittedFormContent = true;
    return result;
  }
  const maxCharacters = 2000;
  const maxSteps = 500;
  let steps = 0;
  const hidden = (element: Element): boolean => {
    if (
      element.matches(
        'script,style,template,noscript,[hidden],[aria-hidden="true"]',
      )
    )
      return true;
    const style = getComputedStyle(element);
    return (
      style.display === 'none' ||
      style.contentVisibility === 'hidden' ||
      style.opacity === '0'
    );
  };
  const append = (text: string) => {
    const available = maxCharacters - result.selection.length;
    result.selection += text.slice(0, available);
    if (text.length > available) result.selectionTruncated = true;
  };
  for (let index = 0; index < Math.min(selection.rangeCount, 4); index++) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const root = range.commonAncestorContainer;
    const blockedStart = (
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(FORM_CONTENT);
    if (
      blockedStart &&
      (blockedStart === root || blockedStart.contains(root))
    ) {
      result.selectionOmittedFormContent = true;
      continue;
    }
    let hiddenStart: Element | undefined;
    for (
      let element =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement;
      element && steps < maxSteps;
      element = element.parentElement
    ) {
      steps++;
      if (hidden(element)) hiddenStart = element;
    }
    if (steps >= maxSteps) {
      result.selectionTruncated = true;
      break;
    }
    if (hiddenStart && (hiddenStart === root || hiddenStart.contains(root))) {
      result.selectionOmittedHiddenContent = true;
      continue;
    }
    const next = (current: Node, skipChildren: boolean): Node | null => {
      if (!skipChildren && current.firstChild) return current.firstChild;
      let node: Node | null = current;
      while (node && node !== root && steps < maxSteps) {
        if (node.nextSibling) return node.nextSibling;
        steps++;
        node = node.parentNode;
      }
      if (node && node !== root && steps >= maxSteps)
        result.selectionTruncated = true;
      return null;
    };
    let node: Node | null =
      (blockedStart && hiddenStart && blockedStart.contains(hiddenStart)
        ? blockedStart
        : (hiddenStart ?? blockedStart)) ??
      (range.startContainer instanceof Text
        ? range.startContainer
        : range.startContainer.childNodes.item(range.startOffset));
    if (!node) node = next(range.startContainer, true);
    while (
      node &&
      steps < maxSteps &&
      result.selection.length < maxCharacters
    ) {
      steps++;
      if (!range.intersectsNode(node)) break;
      if (node instanceof Element && hidden(node)) {
        result.selectionOmittedHiddenContent = true;
        if (node.contains(range.endContainer)) break;
        node = next(node, true);
        continue;
      }
      if (node instanceof Element && node.matches(FORM_CONTENT)) {
        result.selectionOmittedFormContent = true;
        append('[form content omitted]');
        if (node.contains(range.endContainer)) break;
        node = next(node, true);
        continue;
      }
      if (node instanceof Text) {
        if (
          !node.parentElement ||
          getComputedStyle(node.parentElement).visibility !== 'visible'
        ) {
          result.selectionOmittedHiddenContent = true;
          if (node === range.endContainer) break;
          node = next(node, false);
          continue;
        }
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        const count = Math.max(0, end - start);
        const take = Math.min(count, maxCharacters - result.selection.length);
        result.selection += node.substringData(start, take);
        if (take < count) result.selectionTruncated = true;
        if (node === range.endContainer) {
          node = null;
          break;
        }
      }
      node = next(node, false);
    }
    if (node && (steps >= maxSteps || result.selection.length >= maxCharacters))
      result.selectionTruncated = true;
    if (result.selectionTruncated) break;
  }
  if (selection.rangeCount > 4) result.selectionTruncated = true;
  return result;
}
