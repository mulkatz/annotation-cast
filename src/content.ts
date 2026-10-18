import { MessageSchema, type SessionEvent } from './core/schema';
import { sessionTime } from './capture/timeline';
import { captureSelectedText } from './capture/selection';
import { ModifierGesture } from './capture/shift-gesture';

const isolatedGlobal = globalThis as typeof globalThis & {
  annotationCastInstalled?: boolean;
};
if (!isolatedGlobal.annotationCastInstalled) {
  isolatedGlobal.annotationCastInstalled = true;
  install();
}
function install(): void {
  let sessionId = '';
  let startedAt = 0;
  let pointer: { x: number; y: number } | undefined;
  let lastPointer = 0;
  let lastScroll = 0;
  let overlay: HTMLDivElement | undefined;
  let cancelDrawing: (() => void) | undefined;
  let noticeHost: HTMLDivElement | undefined;
  let noticeKind = '';
  function showCaptureNotice(
    message:
      | 'capture-stopped'
      | 'microphone-muted'
      | 'video-muted'
      | 'context-unavailable',
    severity: 'warning' | 'error',
  ): void {
    noticeHost?.remove();
    noticeKind = message;
    const host = document.createElement('div');
    noticeHost = host;
    host.dataset.annotationCastNotice = 'true';
    host.style.cssText =
      'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:calc(100vw - 40px);';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      ':host{color-scheme:light}section{font:14px/1.5 system-ui,sans-serif;color:#182e2a;background:#fff;border:1px solid #dac5ba;border-left:4px solid #a8402c;border-radius:9px;padding:16px 18px;width:340px;max-width:calc(100vw - 80px);box-shadow:0 8px 28px #182e2a22}p{margin:6px 0 12px}strong{font-size:14px}button{font:600 12px system-ui;color:#216956;background:#f4f6f2;border:1px solid #dce3dc;border-radius:5px;padding:7px 10px;cursor:pointer;margin-right:8px}button:focus-visible{outline:2px solid #216956;outline-offset:2px}';
    const section = document.createElement('section');
    section.setAttribute('role', severity === 'error' ? 'alert' : 'status');
    const title = document.createElement('strong');
    title.textContent =
      message === 'capture-stopped'
        ? 'Annotation Cast · Recording interrupted'
        : 'Annotation Cast · Recording warning';
    const copy = document.createElement('p');
    const messages = {
      'capture-stopped':
        'Recording stopped unexpectedly. Existing evidence was retained where possible. Open the session for the reason and recovery options.',
      'microphone-muted':
        'The microphone is not delivering audio. Video may continue; check your input device. This gap is recorded.',
      'video-muted':
        'The tab is not delivering video. Check the recorded tab. This gap is recorded.',
      'context-unavailable':
        'Page context is unavailable. Video and microphone continue. Use the extension toolbar to restore page access.',
    };
    copy.textContent = messages[message];
    const open = document.createElement('button');
    open.textContent = 'Open session';
    open.type = 'button';
    open.onclick = () => {
      void chrome.runtime
        .sendMessage({ target: 'background', type: 'open-controls' })
        .catch(() => undefined);
    };
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.type = 'button';
    dismiss.onclick = () => host.remove();
    section.append(title, copy, open, dismiss);
    shadow.append(style, section);
    document.documentElement.append(host);
  }
  const viewport = () => ({
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    devicePixelRatio,
    scale: visualViewport?.scale ?? 1,
  });
  const createEvent = (
    type: SessionEvent['type'],
    data: SessionEvent['data'],
  ): SessionEvent | undefined => {
    if (!sessionId) return undefined;
    return {
      id: crypto.randomUUID(),
      sessionId,
      type,
      time: sessionTime(startedAt),
      url: location.href.slice(0, 4000),
      data,
    };
  };
  const deliver = (event: SessionEvent) => {
    void chrome.runtime
      .sendMessage({ target: 'background', type: 'event', event })
      .catch(() => undefined);
  };
  const emit = (type: SessionEvent['type'], data: SessionEvent['data']) => {
    const event = createEvent(type, data);
    if (event) deliver(event);
  };
  function label(element: Element): string {
    if (element.matches('input,textarea,select,[contenteditable]'))
      return (element.getAttribute('aria-label') ?? '').slice(0, 300);
    const explicit = element.getAttribute('aria-label');
    if (explicit) return explicit.slice(0, 300);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let result = '';
    let seen = 0;
    for (
      let node = walker.nextNode();
      node && result.length < 300 && seen < 500;
      node = walker.nextNode()
    ) {
      seen++;
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          'input,textarea,select,[contenteditable],script,style,[hidden],[aria-hidden="true"]',
        )
      )
        continue;
      if (!parent.getClientRects().length) continue;
      result += `${node.textContent ?? ''} `;
    }
    return result.replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  function candidate(element: Element) {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    let selector = element.tagName.toLowerCase();
    if (element.id) selector += `#${CSS.escape(element.id.slice(0, 150))}`;
    else {
      const classes = [...element.classList]
        .slice(0, 2)
        .map((name) => CSS.escape(name.slice(0, 80)));
      if (classes.length) selector += `.${classes.join('.')}`;
    }
    return {
      tag: element.tagName.toLowerCase(),
      selector,
      role: (element.getAttribute('role') ?? '').slice(0, 100),
      label: label(element),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      styles: {
        display: style.display,
        flexDirection: style.flexDirection,
        gap: style.gap,
        padding: style.padding,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        color: style.color,
      },
    };
  }
  function context(points: { x: number; y: number }[]) {
    const elements = new Set<Element>();
    for (const point of points) {
      let element = document.elementFromPoint(point.x, point.y);
      for (
        let depth = 0;
        element && depth < 3 && elements.size < 6;
        depth++, element = element.parentElement
      ) {
        if (
          element === overlay ||
          element === noticeHost ||
          element === document.documentElement
        )
          break;
        elements.add(element);
      }
    }
    return {
      candidates: [...elements].map(candidate),
      limitations: [...elements].some((element) =>
        element.matches('iframe,frame,object,embed'),
      )
        ? [
            'Embedded content internals are unavailable; the captured frame boundary and image remain the evidence.',
          ]
        : [],
      ...captureSelectedText(getSelection(), document.activeElement),
      viewport: viewport(),
      pageTheme: {
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        dataTheme: (
          document.documentElement.getAttribute('data-theme') ?? ''
        ).slice(0, 100),
      },
      systemColorPreference: matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
    };
  }
  function makeOverlay(): { host: HTMLDivElement; box: HTMLDivElement } {
    cancelDrawing?.();
    overlay?.remove();
    const host = document.createElement('div');
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;box-sizing:border-box;border:2px solid #ff3b30;background:transparent;pointer-events:none;';
    shadow.append(box);
    document.documentElement.append(host);
    overlay = host;
    return { host, box };
  }
  function freezePoint(): SessionEvent | undefined {
    const position = pointer;
    const event = createEvent(position ? 'point' : 'gap', {});
    if (!event) return undefined;
    if (!position) {
      event.data = {
        reason:
          'Point marker unavailable: move the pointer on this page before marking.',
      };
      return event;
    }
    cancelDrawing?.();
    overlay?.remove();
    event.data = { x: position.x, y: position.y, ...context([position]) };
    return event;
  }
  function publishPoint(event: SessionEvent): void {
    deliver(event);
    const x = event.data.x,
      y = event.data.y;
    if (
      event.type !== 'point' ||
      typeof x !== 'number' ||
      typeof y !== 'number'
    )
      return;
    const { host, box } = makeOverlay();
    box.style.left = `${x - 5}px`;
    box.style.top = `${y - 5}px`;
    box.style.width = '10px';
    box.style.height = '10px';
    box.style.borderRadius = '50%';
    setTimeout(() => host.remove(), 1000);
  }
  function pointMarker(): void {
    const event = freezePoint();
    if (event) publishPoint(event);
  }
  function rectangleMarker(): void {
    const { host, box } = makeOverlay();
    host.style.setProperty('pointer-events', 'auto', 'important');
    host.style.setProperty('cursor', 'crosshair', 'important');
    let origin: { x: number; y: number } | undefined;
    const draw = (point: { x: number; y: number }) => {
      if (!origin) return;
      box.style.left = `${Math.min(origin.x, point.x)}px`;
      box.style.top = `${Math.min(origin.y, point.y)}px`;
      box.style.width = `${Math.abs(origin.x - point.x)}px`;
      box.style.height = `${Math.abs(origin.y - point.y)}px`;
    };
    const cancel = () => {
      removeEventListener('keydown', escape, true);
      host.remove();
      if (overlay === host) overlay = undefined;
      cancelDrawing = undefined;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    host.addEventListener('pointerdown', (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.button !== 0) return;
      origin = { x: event.clientX, y: event.clientY };
      host.setPointerCapture(event.pointerId);
      draw(origin);
    });
    host.addEventListener('pointermove', (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      draw({ x: event.clientX, y: event.clientY });
    });
    host.addEventListener('pointerup', (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!origin) return;
      const x = Math.min(origin.x, event.clientX),
        y = Math.min(origin.y, event.clientY);
      const width = Math.abs(origin.x - event.clientX),
        height = Math.abs(origin.y - event.clientY);
      host.style.setProperty('pointer-events', 'none', 'important');
      if (host.hasPointerCapture(event.pointerId))
        host.releasePointerCapture(event.pointerId);
      removeEventListener('keydown', escape, true);
      cancelDrawing = undefined;
      if (width >= 2 && height >= 2)
        emit('rectangle', {
          x,
          y,
          width,
          height,
          ...context([
            { x: x + width / 2, y: y + height / 2 },
            { x, y },
            { x: x + width, y: y + height },
          ]),
        });
      setTimeout(() => host.remove(), 2000);
    });
    host.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    addEventListener('keydown', escape, true);
    cancelDrawing = cancel;
  }
  const gesture = new ModifierGesture({
    intervalMs: 180,
    point: pointMarker,
    rectangle: rectangleMarker,
  });
  const keyboard = (event: KeyboardEvent, down: boolean) => {
    if (!event.isTrusted) return;
    if (!sessionId || document.hidden) {
      gesture.reset();
      return;
    }
    if (down) gesture.keydown(event);
    else gesture.keyup(event);
  };
  window.addEventListener('keydown', (event) => keyboard(event, true), {
    capture: true,
  });
  window.addEventListener('keyup', (event) => keyboard(event, false), {
    capture: true,
  });
  window.addEventListener('blur', () => gesture.reset(), { capture: true });
  window.addEventListener('focusin', () => gesture.reset(), { capture: true });
  window.addEventListener('compositionstart', () => gesture.reset(), {
    capture: true,
  });
  window.addEventListener('compositionend', () => gesture.reset(), {
    capture: true,
  });
  window.addEventListener('pagehide', () => gesture.reset(), { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) gesture.reset();
  });
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.isTrusted && (event.shiftKey || event.ctrlKey)) gesture.reset();
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!event.isTrusted) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (
        performance.now() - lastPointer >= 500 &&
        !overlay?.matches(':active')
      ) {
        lastPointer = performance.now();
        emit('pointer', { ...pointer, viewport: viewport() });
      }
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      if (
        (overlay && event.composedPath().includes(overlay)) ||
        (noticeHost && event.composedPath().includes(noticeHost))
      )
        return;
      emit('click', {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        viewport: viewport(),
      });
    },
    { passive: true, capture: true },
  );
  addEventListener(
    'scroll',
    () => {
      if (performance.now() - lastScroll >= 500) {
        lastScroll = performance.now();
        emit('scroll', viewport());
      }
    },
    { passive: true, capture: true },
  );
  addEventListener(
    'resize',
    () => emit('context', { reason: 'viewport changed', viewport: viewport() }),
    { passive: true },
  );
  addEventListener('popstate', () =>
    emit('navigation', {
      navigation: 'history traversal',
      viewport: viewport(),
    }),
  );
  addEventListener('hashchange', () =>
    emit('navigation', {
      navigation: 'fragment changed',
      viewport: viewport(),
    }),
  );
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    const parsed = MessageSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.target !== 'content' ||
      sender.id !== chrome.runtime.id
    )
      return false;
    const message = parsed.data;
    switch (message.type) {
      case 'clear-media-notice':
        if (noticeKind === 'microphone-muted' || noticeKind === 'video-muted')
          noticeHost?.remove();
        break;
      case 'capture-notice':
        showCaptureNotice(message.message, message.severity);
        break;
      case 'initialize':
        noticeHost?.remove();
        gesture.configure(message.shiftTapIntervalMs);
        cancelDrawing?.();
        overlay?.remove();
        pointer = undefined;
        sessionId = message.sessionId;
        startedAt = message.startedAt;
        emit('context', {
          reason: 'page context initialized',
          viewport: viewport(),
        });
        break;
      case 'marker':
        gesture.reset();
        if (sessionId) {
          if (message.mode === 'point') pointMarker();
          else rectangleMarker();
        }
        break;
      case 'cleanup':
        gesture.reset();
        sessionId = '';
        cancelDrawing?.();
        overlay?.remove();
        break;
    }
    reply({ ok: true });
    return false;
  });
}
