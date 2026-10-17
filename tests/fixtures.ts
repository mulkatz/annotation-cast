import { MODELS, type Session } from '../src/core/schema';
export function fixtureSession(id = crypto.randomUUID()): Session {
  return {
    schemaVersion: 1,
    id,
    createdAt: 10,
    tabId: 1,
    url: 'https://example.test/',
    notes: { project: '', objective: '', environment: '', reference: '' },
    status: 'stopped',
    startedAt: 10,
    duration: 5000,
    diagnostics: false,
    models: MODELS,
    audio: [],
    transcript: [],
    frames: [],
    findings: [],
    completedSegments: [],
    completedBatches: [],
    error: '',
    recordingPath: `${id}/recording.webm`,
    sanitization: {},
  };
}
