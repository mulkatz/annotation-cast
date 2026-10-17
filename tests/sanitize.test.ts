import { describe, expect, it } from 'vitest';
import { sanitize } from '../src/core/sanitize';

describe('text sanitation', () => {
  it('removes supported secrets throughout nested evidence without mutating input', () => {
    const known = 'synthetic-configured-credential';
    const input = {
      text: `Bearer synthetic-bearer-value ${known}`,
      items: [
        { text: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoic3ludGhldGljIn0.signature' },
      ],
      apiKey: 'synthetic-field-value',
    };
    const result = sanitize(input, [known]);
    expect(JSON.stringify(result.value)).not.toContain(known);
    expect(JSON.stringify(result.value)).not.toContain(
      'synthetic-bearer-value',
    );
    expect(JSON.stringify(result.value)).not.toContain('eyJ');
    expect(result.value.apiKey).toBe('[REDACTED]');
    expect(input.apiKey).toBe('synthetic-field-value');
    expect(result.counts['configured key']).toBe(1);
  });
  it('removes every URL query value, fragments, and URL user credentials', () => {
    const result = sanitize({
      url: 'https://synthetic:password@example.test/path?name=Alice&name=Bob&innocent=hidden#private-state',
      message: 'See https://example.test/?value=hidden#secret',
    });
    expect(result.value.url).toContain(
      'example.test/path?name=%5BREDACTED%5D&name=%5BREDACTED%5D',
    );
    expect(JSON.stringify(result.value)).not.toMatch(
      /Alice|Bob|hidden|private-state|synthetic:password/,
    );
    expect(result.counts['URL query']).toBe(4);
    expect(result.counts['URL fragment']).toBe(2);
  });
  it('removes private-key blocks and supported credential assignments', () => {
    const result = sanitize(
      [
        '-----BEGIN ',
        'PRIVATE KEY-----\nsynthetic-material\n-----END ',
        'PRIVATE KEY-----\npassword=synthetic-password',
      ].join(''),
    );
    expect(result.value).toBe('[REDACTED]\n[REDACTED]');
  });
  it('preserves safe evidence, scalar types, and array structure', () => {
    const input = {
      text: 'The menu is too narrow.',
      at: 1234,
      visible: true,
      optional: null,
      items: ['expected'],
    };
    expect(sanitize(input)).toEqual({ value: input, counts: {} });
  });
});

it.each([
  '{"apiKey":"synthetic-sensitive-value"}',
  '{"password": "synthetic-sensitive-value"}',
  "{'clientSecret': 'synthetic-sensitive-value'}",
  '{"apiKey":"synthetic-sensitive-value with \\"quoted\\" text"}',
])('sanitizes named credentials in stringified JSON: %s', (text) => {
  const result = sanitize({ message: text });
  expect(JSON.stringify(result.value)).not.toContain(
    'synthetic-sensitive-value',
  );
  expect(result.counts['credential assignment']).toBe(1);
});

it('keeps sensitive query names and page references stable across repeated sanitation', () => {
  const source = {
    url: 'https://example.test/?password=synthetic-value&apiKey=synthetic-key&mode=demo#private',
    text: 'password=synthetic-value; see https://example.test/?client.secret=synthetic-value',
  };
  const once = sanitize(source).value;
  expect(once.url).toContain('password=%5BREDACTED%5D');
  expect(sanitize(once).value).toEqual(once);
  expect(JSON.stringify(once)).not.toContain('synthetic-value');
});

it('removes query values and fragments from WebSocket, stack and explicit URL fields without changing media', () => {
  const media = 'data:image/jpeg;base64,AAAA';
  const source = {
    text: 'Socket wss://example.test/events?auth=synthetic-private-value#synthetic-private-fragment',
    url: 'webpack-internal:///src/app.ts?session=synthetic-private-value#synthetic-private-fragment',
    href: 'mailto:user@example.test?subject=synthetic-private-value#synthetic-private-fragment',
    dataUrl: media,
  };
  const clean = sanitize(source).value;
  expect(JSON.stringify(clean)).not.toContain('synthetic-private');
  expect(clean.dataUrl).toBe(media);
  expect(sanitize(clean).value).toEqual(clean);
});
