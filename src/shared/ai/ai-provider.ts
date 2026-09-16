import { logger } from '../logging/logger';
import { getEffectiveAiConfig, type AiProviderKind } from '../integrations/integration-config';

/**
 * One text model behind one function, whichever vendor is configured.
 *
 * The requirement was not to be tightly coupled to any one of them, so nothing
 * above this file names a vendor. A caller asks for text and gets text; the
 * settings screen decides who produced it, and switching is a form change
 * rather than a deployment.
 *
 * Four named vendors and a fifth slot. `custom` speaks the OpenAI
 * chat-completions shape against any base URL, which is what self-hosted
 * runtimes and most smaller vendors expose — so "our own model, later" needs a
 * URL and a key rather than an adapter written here.
 *
 * Deliberately not the vendor SDKs. Each one pulls a dependency tree, pins its
 * own fetch behaviour and ages differently; the four request shapes below are a
 * page of code between them and they are the parts that would have to be
 * understood anyway when one of them returns something unexpected.
 */

export interface CompletionRequest {
  /** Standing instruction — who the model is and what it must not do. */
  system: string;
  /** The actual job. */
  prompt: string;
  /** A ceiling, not a target. Descriptions are four or five lines. */
  maxTokens: number;
  /** Low for translation, higher for drafting. */
  temperature: number;
}

export interface CompletionResult {
  text: string;
  /** Recorded on every generation so cost can be attributed later. */
  provider: AiProviderKind;
  model: string;
}

/** Raised when the caller can do something about it — no key, no model. */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/** The model each vendor gets when the settings screen names none. */
const DEFAULT_MODEL: Record<AiProviderKind, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  'azure-openai': 'gpt-4o-mini',
  custom: 'default',
};

async function readError(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '(no body)';
  }
}

/* ------------------------------------------------------------------ */
/* Vendor shapes                                                       */
/* ------------------------------------------------------------------ */

/**
 * OpenAI chat completions, and everything that copies it.
 *
 * Shared by `openai`, `azure-openai` and `custom` because the three differ only
 * in where the request goes and how the key is presented — which is exactly why
 * `custom` can serve a model this codebase has never heard of.
 */
async function openAiShaped(
  url: string,
  headers: Record<string, string>,
  model: string,
  request: CompletionRequest
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
    }),
  });

  if (!response.ok) throw new Error(`${response.status} ${await readError(response)}`);

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? '';
}

async function anthropic(
  apiKey: string,
  model: string,
  request: CompletionRequest
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      // The system prompt is its own field here rather than a message.
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    }),
  });

  if (!response.ok) throw new Error(`${response.status} ${await readError(response)}`);

  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

async function google(
  apiKey: string,
  model: string,
  request: CompletionRequest
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
      },
    }),
  });

  if (!response.ok) throw new Error(`${response.status} ${await readError(response)}`);

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
}

/* ------------------------------------------------------------------ */
/* The one function above it                                           */
/* ------------------------------------------------------------------ */

/**
 * Asks whichever model is configured, and reports plainly when none is.
 *
 * `AiUnavailableError` is separated from a vendor failure on purpose: the first
 * is a settings problem an operator fixes in a minute, the second is somebody
 * else's outage. Rendering both as "generation failed" is what makes a feature
 * look broken when it is merely switched off.
 */
export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const cfg = await getEffectiveAiConfig();

  if (!cfg.enabled) {
    throw new AiUnavailableError('AI features are turned off for this deployment.');
  }

  const provider = (cfg.provider ?? 'anthropic') as AiProviderKind;
  const model = cfg.model || DEFAULT_MODEL[provider];
  const apiKey = cfg.apiKey;

  if (!apiKey && provider !== 'custom') {
    throw new AiUnavailableError('No API key is configured for the selected AI provider.');
  }
  if ((provider === 'custom' || provider === 'azure-openai') && !cfg.baseUrl) {
    throw new AiUnavailableError('This provider needs a base URL before it can be used.');
  }

  try {
    let text: string;
    switch (provider) {
      case 'anthropic':
        text = await anthropic(apiKey!, model, request);
        break;
      case 'google':
        text = await google(apiKey!, model, request);
        break;
      case 'openai':
        text = await openAiShaped(
          'https://api.openai.com/v1/chat/completions',
          { Authorization: `Bearer ${apiKey}` },
          model,
          request
        );
        break;
      case 'azure-openai':
        // Azure addresses a deployment rather than a model, and the model name
        // is that deployment's name.
        text = await openAiShaped(
          `${cfg.baseUrl!.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(
            model
          )}/chat/completions?api-version=2024-10-21`,
          { 'api-key': apiKey! },
          model,
          request
        );
        break;
      case 'custom':
        text = await openAiShaped(
          `${cfg.baseUrl!.replace(/\/$/, '')}/chat/completions`,
          apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          model,
          request
        );
        break;
    }

    const trimmed = text.trim();
    if (!trimmed) throw new Error('the provider returned no text');
    return { text: trimmed, provider, model };
  } catch (cause) {
    // The prompt is not logged. A listing description is a publisher's own
    // words about their own property, and an error log is the wrong place for
    // it to end up.
    logger.error('AI completion failed', {
      provider,
      model,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    throw new Error('The AI provider could not be reached. Try again in a moment.');
  }
}

/** Whether the feature can run at all, for callers that degrade rather than fail. */
export async function aiIsAvailable(): Promise<boolean> {
  const cfg = await getEffectiveAiConfig();
  if (!cfg.enabled) return false;
  if (cfg.provider === 'custom') return Boolean(cfg.baseUrl);
  return Boolean(cfg.apiKey);
}
