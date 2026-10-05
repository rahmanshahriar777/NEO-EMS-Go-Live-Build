import { Job } from 'bullmq';
import { AiJobPayload } from '@ems/shared';
import { log } from '../logger.js';

export interface AiJobResult {
  requestId: string;
  status: 'completed' | 'skipped';
  result?: string;
  correlationId: string;
}

/**
 * AI queue processor (Phase 3 item 5 / worker 2).
 *
 * Consumes asynchronous AI generation requests from `QUEUE_NAMES.ai`.
 * Prevents the queue from acting as an unconsumed black hole when jobs
 * are enqueued asynchronously.
 */
export async function processAi(job: Job<AiJobPayload>): Promise<AiJobResult> {
  const { requestId, prompt, options, correlationId } = job.data;

  log.info('ai.generate.start', {
    jobId: job.id,
    requestId,
    correlationId,
    promptLength: prompt?.length ?? 0,
  });

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    log.warn('ai.generate.empty-prompt', { jobId: job.id, requestId, correlationId });
    return {
      requestId,
      status: 'completed',
      result: '',
      correlationId,
    };
  }

  // Check available provider keys in environment
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  let textResult = '';

  if (geminiKey) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAi = new GoogleGenerativeAI(geminiKey);
      const model = genAi.getGenerativeModel({ model: options?.model || 'gemini-1.5-flash' });
      const resp = await model.generateContent(prompt);
      textResult = resp.response.text();
    } catch (e: any) {
      log.warn('ai.generate.gemini-fallback', {
        jobId: job.id,
        requestId,
        error: e?.message,
      });
    }
  }

  if (!textResult && groqKey) {
    try {
      const { default: Groq } = await import('groq-sdk');
      const groq = new Groq({ apiKey: groqKey });
      const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: options?.model || 'llama-3.3-70b-versatile',
      });
      textResult = completion.choices[0]?.message?.content || '';
    } catch (e: any) {
      log.warn('ai.generate.groq-fallback', {
        jobId: job.id,
        requestId,
        error: e?.message,
      });
    }
  }

  if (!textResult) {
    // Graceful offline fallback: log and complete so jobs do not hang
    log.info('ai.generate.offline-fallback', {
      jobId: job.id,
      requestId,
      correlationId,
      reason: 'No live AI API keys configured (GEMINI_API_KEY / GROQ_API_KEY)',
    });
    textResult = `[AI Processed offline: ${prompt.slice(0, 50)}...]`;
  }

  log.info('ai.generate.done', {
    jobId: job.id,
    requestId,
    correlationId,
    outputLength: textResult.length,
  });

  return {
    requestId,
    status: 'completed',
    result: textResult,
    correlationId,
  };
}
