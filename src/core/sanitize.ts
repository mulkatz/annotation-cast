/** Pattern-based text sanitation does not inspect or anonymize images or audio. */
export function sanitize<T>(
  input: T,
  knownValues: string[] = [],
): { value: T; counts: Record<string, number> } {
  const holder = structuredClone({ value: input });
  const counts: Record<string, number> = {};
  const count = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const replace = (text: string, pattern: RegExp, name: string): string =>
    text.replace(pattern, () => {
      count(name);
      return '[REDACTED]';
    });
  const clean = (original: string, field: string): string => {
    if (
      /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access_token|refresh_token|api[_-]?key|private[_-]?key|client[_-]?secret)$/i.test(
        field,
      ) &&
      original
    ) {
      count('sensitive field');
      return '[REDACTED]';
    }
    let text = original;
    for (const value of knownValues.filter((entry) => entry.length > 0)) {
      if (text.includes(value)) {
        const parts = text.split(value);
        counts['configured key'] =
          (counts['configured key'] ?? 0) + parts.length - 1;
        text = parts.join('[REDACTED]');
      }
    }
    text = replace(
      text,
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g,
      'private key',
    );
    text = replace(text, /\bBearer\s+[^\s"'<>;,]+/gi, 'bearer token');
    text = replace(
      text,
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      'JWT',
    );
    text = replace(
      text,
      /\b(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/g,
      'API key',
    );
    // Match whole URLs before named assignments, so credential-like query names
    // cannot be rewritten after URL normalization on a second sanitation pass.
    const assignments =
      /["']?\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;&}\]"']+)/;
    const urlsAndAssignments = new RegExp(
      String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|${assignments.source}`,
      'gi',
    );
    const cleanUrl = (match: string): string => {
      try {
        const url = new URL(match);
        if (url.username || url.password) {
          count('URL credentials');
          url.username = '';
          url.password = '';
        }
        for (const name of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(name);
          counts['URL query'] = (counts['URL query'] ?? 0) + values.length;
          url.searchParams.delete(name);
          for (let index = 0; index < values.length; index++)
            url.searchParams.append(name, '[REDACTED]');
        }
        if (url.hash) {
          count('URL fragment');
          url.hash = '';
        }
        return url.href;
      } catch {
        return '[INVALID URL]';
      }
    };
    if (
      /^(?:url|uri|page|href|src|sourceUrl)$/i.test(field) &&
      /^[a-z][a-z0-9+.-]*:/i.test(text) &&
      !/^(?:data|blob):/i.test(text)
    )
      return cleanUrl(text);
    text = text.replace(urlsAndAssignments, (match) => {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match)) return cleanUrl(match);
      count('credential assignment');
      return '[REDACTED]';
    });
    return text;
  };
  const visit = (object: object): void => {
    for (const field of Object.keys(object)) {
      const value: unknown = Reflect.get(object, field);
      if (typeof value === 'string')
        Reflect.set(object, field, clean(value, field));
      else if (value !== null && typeof value === 'object') visit(value);
    }
  };
  visit(holder);
  return { value: holder.value, counts };
}
