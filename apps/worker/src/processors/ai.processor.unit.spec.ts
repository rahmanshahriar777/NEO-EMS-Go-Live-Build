import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processAi } from './ai.processor.js';

describe('AI queue processor (processAi)', () => {
  it('handles empty prompt gracefully without throwing', async () => {
    const job: any = {
      id: 'job-ai-1',
      data: {
        requestId: 'req-1',
        prompt: '',
        correlationId: 'corr-1',
      },
    };

    const res = await processAi(job);
    assert.equal(res.status, 'completed');
    assert.equal(res.requestId, 'req-1');
    assert.equal(res.result, '');
    assert.equal(res.correlationId, 'corr-1');
  });

  it('processes text prompt and completes in offline mode', async () => {
    const job: any = {
      id: 'job-ai-2',
      data: {
        requestId: 'req-2',
        prompt: 'Summarize attendance records for September',
        options: { model: 'test-model' },
        correlationId: 'corr-2',
      },
    };

    const res = await processAi(job);
    assert.equal(res.status, 'completed');
    assert.equal(res.requestId, 'req-2');
    assert.ok(typeof res.result === 'string');
    assert.equal(res.correlationId, 'corr-2');
  });
});
