import { z } from 'zod';

export const MODELS = {
  transcription: 'openai/whisper-large-v3',
  analysis: 'google/gemini-2.5-flash',
} as const;
export const NotesSchema = z.object({
  project: z.string().max(500),
  objective: z.string().max(2000),
  environment: z.string().max(500),
  reference: z.string().max(500),
});
export const ShiftTapIntervalSchema = z
  .number()
  .int()
  .min(100)
  .max(350)
  .default(180);
export const SettingsSchema = z.object({
  key: z.string().max(500),
  diagnostics: z.boolean(),
  shiftTapIntervalMs: ShiftTapIntervalSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
export const EventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  time: z.number().nonnegative(),
  type: z.enum([
    'point',
    'rectangle',
    'pointer',
    'click',
    'scroll',
    'navigation',
    'context',
    'console',
    'network',
    'gap',
    'status',
  ]),
  url: z.string().max(4000),
  data: z.record(z.string(), z.json()),
});
export type SessionEvent = z.infer<typeof EventSchema>;
export const TranscriptSchema = z.object({
  id: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string().max(16000),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
export const FrameSchema = z.object({
  id: z.string(),
  time: z.number().nonnegative(),
  path: z.string().regex(/^screenshots\/[a-zA-Z0-9_-]+\.jpg$/),
  eventIds: z.array(z.string()),
});
export type Frame = z.infer<typeof FrameSchema>;
export const FindingSchema = z.object({
  id: z.string().regex(/^issue-\d+$/),
  title: z.string().max(300),
  description: z.string().max(8000),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  page: z.string().max(4000),
  evidenceIds: z.array(z.string()).max(40),
  quoteIds: z.array(z.string()).max(40),
  hypotheses: z.array(z.string().max(2000)).max(10),
  expectedBehavior: z.string().max(2000).nullable(),
  reproduction: z.array(z.string().max(1000)).max(15),
  association: z.enum(['supported', 'uncertain', 'incomplete']),
});
export type Finding = z.infer<typeof FindingSchema>;
export const AudioSegmentSchema = z.object({
  id: z.string(),
  path: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type AudioSegment = z.infer<typeof AudioSegmentSchema>;
export const FailureSchema = z.object({
  phase: z.enum([
    'setup',
    'capture',
    'finalization',
    'transcription',
    'analysis',
    'validation',
    'export',
  ]),
  code: z.string().max(80),
  message: z.string().max(1800),
  retryable: z.boolean(),
  occurredAt: z.number().nonnegative(),
  stepId: z.string().max(120).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export type Failure = z.infer<typeof FailureSchema>;
export const SessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  createdAt: z.number(),
  tabId: z.number().int(),
  url: z.string(),
  notes: NotesSchema,
  status: z.enum([
    'recording',
    'stopped',
    'processing',
    'failed',
    'complete',
    'interrupted',
  ]),
  startedAt: z.number(),
  duration: z.number().nonnegative(),
  diagnostics: z.boolean(),
  models: z.object({ transcription: z.string(), analysis: z.string() }),
  audio: z.array(AudioSegmentSchema),
  transcript: z.array(TranscriptSchema),
  frames: z.array(FrameSchema),
  findings: z.array(FindingSchema),
  completedSegments: z.array(z.string()),
  completedBatches: z.array(z.string()),
  error: z.string(),
  failures: z.array(FailureSchema).max(20).optional(),
  recordingPath: z.string(),
  sanitization: z.record(z.string(), z.number()),
});
export type Session = z.infer<typeof SessionSchema>;

export const ReplySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export const MessageSchema = z.discriminatedUnion('type', [
  z.object({
    target: z.literal('background'),
    type: z.literal('start'),
    notes: NotesSchema,
    diagnostics: z.boolean(),
    requestId: z.string().uuid().optional(),
  }),
  z.object({ target: z.literal('background'), type: z.literal('stop') }),
  z.object({
    target: z.literal('background'),
    type: z.literal('cancel-start'),
    requestId: z.string().uuid(),
  }),
  z.object({
    target: z.literal('background'),
    type: z.literal('event'),
    event: EventSchema,
  }),
  z.object({
    target: z.literal('background'),
    type: z.literal('recording-ended'),
    sessionId: z.string(),
  }),
  z.object({
    target: z.literal('background'),
    type: z.literal('grant-context'),
  }),
  z.object({ target: z.literal('background'), type: z.literal('check-tab') }),
  z.object({
    target: z.literal('background'),
    type: z.literal('open-controls'),
  }),
  z.object({
    target: z.literal('content'),
    type: z.literal('capture-notice'),
    severity: z.enum(['warning', 'error']),
    message: z.enum([
      'capture-stopped',
      'microphone-muted',
      'video-muted',
      'context-unavailable',
    ]),
  }),
  z.object({
    target: z.literal('content'),
    type: z.literal('clear-media-notice'),
  }),
  z.object({
    target: z.literal('background'),
    type: z.literal('check-diagnostics'),
  }),
  z.object({
    target: z.literal('background'),
    type: z.literal('capture-status'),
    sessionId: z.string(),
    microphone: z.enum(['recording', 'muted', 'stopped']),
    recording: z.enum(['recording', 'muted', 'stopped']),
  }),
  z.object({
    target: z.literal('offscreen'),
    type: z.literal('record'),
    sessionId: z.string(),
    streamId: z.string(),
  }),
  z.object({ target: z.literal('offscreen'), type: z.literal('finish') }),
  z.object({
    target: z.literal('content'),
    type: z.literal('initialize'),
    sessionId: z.string(),
    startedAt: z.number(),
    shiftTapIntervalMs: ShiftTapIntervalSchema,
  }),
  z.object({
    target: z.literal('content'),
    type: z.literal('marker'),
    mode: z.enum(['point', 'rectangle']),
  }),
  z.object({ target: z.literal('content'), type: z.literal('cleanup') }),
]);
export type Message = z.infer<typeof MessageSchema>;
export async function send(message: Message): Promise<void> {
  const reply = ReplySchema.parse(await chrome.runtime.sendMessage(message));
  if (!reply.ok) throw new Error(reply.error ?? 'Extension operation failed.');
}
