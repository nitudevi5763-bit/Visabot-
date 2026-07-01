/**
 * =================================================================
 * api/chat.js — Vercel Edge Function
 * =================================================================
 * Backend for Aria (VisaPath Consultants AI receptionist), powered by
 * Google's gemini-3.5-flash— Google's fastest current-generation
 * model, GA since May 19, 2026.
 *
 * REQUIRED ENV VAR (Vercel → Project → Settings → Environment Variables):
 *   GEMINI_API_KEY = your Google AI Studio / Gemini API key
 *
 * REQUEST CONTRACT
 *   POST /api/chat
 *   Content-Type: application/json
 *   {
 *     "message": string,                 // required, 1-2000 chars
 *     "history": [                       // optional, max 20 entries
 *       { "role": "user" | "assistant", "content": string }
 *     ],
 *     "sessionId": string                // optional, for ephemeral
 *                                         // server-side memory continuity
 *   }
 *
 * RESPONSE CONTRACT — success (200)
 *   {
 *     "success": true,
 *     "reply": string,
 *     "model": "gemini-3.5-flash",
 *     "sessionId": string,
 *     "usage": { "promptTokens": number, "responseTokens": number, "totalTokens": number },
 *     "timestamp": string (ISO 8601)
 *   }
 *
 * RESPONSE CONTRACT — error (4xx / 5xx)
 *   {
 *     "success": false,
 *     "error": string,          // safe, human-readable — never leaks upstream detail
 *     "code": string            // machine-readable error code for client branching
 *   }
 *
 * ARCHITECTURE NOTES
 *   - Runs on the Edge runtime for minimal cold-start latency.
 *   - Request building, API invocation, and response parsing are
 *     isolated into pure functions (buildGeminiPayload / callGemini /
 *     parseGeminiResponse) so a streaming variant can be introduced
 *     later by swapping callGemini's endpoint + response handling
 *     without touching validation, memory, or the outer handler.
 *   - Session memory (getSessionContext / appendSessionTurn) is a real,
 *     working in-memory store scoped to a single Edge instance's
 *     lifetime. It is intentionally ephemeral — Edge instances are
 *     stateless and recycled by the platform — and exists to smooth
 *     over brief gaps in client-supplied history within one instance's
 *     lifetime. Swapping it for a durable store (Redis, Vercel KV,
 *     Postgres) later only requires reimplementing these two
 *     functions; nothing else in the file depends on the storage
 *     mechanism.
 * =================================================================
 */

export const config = { runtime: 'edge' };

/* ==================================================================
   CONSTANTS
================================================================== */

const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_CONTENT_LENGTH = 2000;
const MAX_CONTEXT_TURNS_SENT_TO_MODEL = 10; // trims token usage on long sessions
const REQUEST_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 512; // keeps replies concise and fast

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_MAX_ENTRIES = 500; // hard cap on in-memory session map size

const SYSTEM_PROMPT = `You are Aria, the AI immigration receptionist for VisaPath Consultants, a visa and immigration consultancy based in Chandigarh, India.

Your role:
- Warmly greet and assist prospective clients with questions about Canada, Australia, UK, and USA visas, student visas, work visas, and visitor visas.
- Give clear, accurate, general guidance on eligibility, required documents, typical timelines, and fee structures — but always make clear that exact details depend on individual circumstances and a consultation is recommended.
- Naturally encourage the visitor to book a consultation or share their contact details when they show genuine interest, without being pushy.
- Keep replies concise (3-6 sentences typically), warm, and professional. Use simple formatting (short paragraphs, occasional bullet points with "-") — avoid walls of text.
- If asked something outside immigration/visa topics, politely redirect back to how you can help with their visa journey.
- Never invent specific case outcomes, guaranteed approval odds, or legal guarantees. You provide informational guidance, not legal advice.
- If the visitor shares an email or phone number, thank them and confirm a consultant will reach out soon.`;

/* ==================================================================
   ERROR TYPES
================================================================== */

class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = code || 'VALIDATION_ERROR';
  }
}

class UpstreamError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status || 502;
    this.code = code || 'UPSTREAM_ERROR';
  }
}

/* ==================================================================
   EPHEMERAL SESSION MEMORY
   In-memory Map scoped to this Edge instance's lifetime. Real,
   functioning storage — not a stub — used to retain the last few
   turns of a conversation when a sessionId is supplied, reducing
   how much history the client needs to resend on every request.
================================================================== */

const sessionStore = new Map(); // sessionId -> { turns: ChatTurn[], updatedAt: number }

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, entry] of sessionStore) {
    if (now - entry.updatedAt > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
  // Hard cap: if still oversized after TTL pruning, evict oldest entries.
  if (sessionStore.size > SESSION_MAX_ENTRIES) {
    const sortedByAge = [...sessionStore.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt
    );
    const overflow = sortedByAge.slice(0, sessionStore.size - SESSION_MAX_ENTRIES);
    for (const [id] of overflow) sessionStore.delete(id);
  }
}

function getSessionContext(sessionId) {
  if (!sessionId) return [];
  const entry = sessionStore.get(sessionId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    sessionStore.delete(sessionId);
    return [];
  }
  return entry.turns;
}

function appendSessionTurns(sessionId, userText, assistantText) {
  if (!sessionId) return;
  pruneExpiredSessions();

  const existing = sessionStore.get(sessionId);
  const turns = existing ? existing.turns.slice() : [];
  turns.push({ role: 'user', content: userText });
  turns.push({ role: 'assistant', content: assistantText });

  const trimmed = turns.slice(-MAX_HISTORY_ENTRIES);
  sessionStore.set(sessionId, { turns: trimmed, updatedAt: Date.now() });
}

/* ==================================================================
   VALIDATION
================================================================== */

function validateRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.', 'INVALID_BODY');
  }

  const { message, history, sessionId } = body;

  if (typeof message !== 'string') {
    throw new ValidationError('"message" is required and must be a string.', 'MISSING_MESSAGE');
  }
  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0) {
    throw new ValidationError('"message" cannot be empty.', 'EMPTY_MESSAGE');
  }
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(
      `"message" must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
      'MESSAGE_TOO_LONG'
    );
  }

  let normalizedHistory = [];
  if (history !== undefined && history !== null) {
    if (!Array.isArray(history)) {
      throw new ValidationError('"history" must be an array when provided.', 'INVALID_HISTORY');
    }
    if (history.length > MAX_HISTORY_ENTRIES) {
      throw new ValidationError(
        `"history" cannot exceed ${MAX_HISTORY_ENTRIES} entries.`,
        'HISTORY_TOO_LONG'
      );
    }
    normalizedHistory = history.map((turn, index) => {
      if (!turn || typeof turn !== 'object') {
        throw new ValidationError(`"history[${index}]" must be an object.`, 'INVALID_HISTORY_ENTRY');
      }
      if (turn.role !== 'user' && turn.role !== 'assistant') {
        throw new ValidationError(
          `"history[${index}].role" must be "user" or "assistant".`,
          'INVALID_HISTORY_ROLE'
        );
      }
      if (typeof turn.content !== 'string' || turn.content.trim().length === 0) {
        throw new ValidationError(
          `"history[${index}].content" must be a non-empty string.`,
          'INVALID_HISTORY_CONTENT'
        );
      }
      if (turn.content.length > MAX_HISTORY_CONTENT_LENGTH) {
        throw new ValidationError(
          `"history[${index}].content" exceeds ${MAX_HISTORY_CONTENT_LENGTH} characters.`,
          'HISTORY_CONTENT_TOO_LONG'
        );
      }
      return { role: turn.role, content: turn.content.trim() };
    });
  }

  let normalizedSessionId;
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new ValidationError(
        '"sessionId" must be a non-empty string of 128 characters or fewer.',
        'INVALID_SESSION_ID'
      );
    }
    normalizedSessionId = sessionId;
  }

  return {
    message: trimmedMessage,
    history: normalizedHistory,
    sessionId: normalizedSessionId,
  };
}

/* ==================================================================
   GEMINI REQUEST / RESPONSE HANDLING
================================================================== */

/**
 * Merge client-supplied history with any server-side session memory,
 * de-duplicate a trivial overlap at the seam, and cap to the most
 * recent turns actually sent to the model (token-usage optimization).
 */
function resolveConversationContext(clientHistory, sessionId) {
  const sessionTurns = getSessionContext(sessionId);

  // Prefer whichever source has more context; avoid double-counting
  // by only falling back to session memory when the client sent none.
  const combined = clientHistory.length > 0 ? clientHistory : sessionTurns;

  return combined.slice(-MAX_CONTEXT_TURNS_SENT_TO_MODEL);
}

function buildGeminiPayload(message, contextTurns) {
  const contents = contextTurns.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));

  contents.push({ role: 'user', parts: [{ text: message }] });

  return {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      topP: 0.9,
      thinking_level: 'low', // optimizes for speed/cost on a conversational task
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
}

/**
 * Calls the Gemini generateContent endpoint with a hard timeout.
 * Never includes the API key in any thrown error message.
 */
async function callGemini(payload, apiKey) {
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new UpstreamError('The AI provider took too long to respond.', 504, 'UPSTREAM_TIMEOUT');
    }
    throw new UpstreamError('Failed to reach the AI provider.', 502, 'UPSTREAM_UNREACHABLE');
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // Deliberately do not forward raw upstream error bodies to the
    // client — they may echo back request details. Log server-side
    // only, return a safe generic message.
    let upstreamDetail = '';
    try {
      upstreamDetail = await response.text();
    } catch {
      /* ignore parse failure */
    }
    console.error(
      `[api/chat] Gemini API error — status ${response.status}: ${upstreamDetail.slice(0, 500)}`
    );

    if (response.status === 429) {
      throw new UpstreamError(
        'Aria is receiving a high volume of requests right now. Please try again shortly.',
        429,
        'UPSTREAM_RATE_LIMITED'
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new UpstreamError(
        'The AI service is temporarily unavailable. Please try again later.',
        502,
        'UPSTREAM_AUTH_ERROR'
      );
    }
    throw new UpstreamError(
      'The AI provider returned an error. Please try again.',
      502,
      'UPSTREAM_ERROR'
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new UpstreamError('Received an invalid response from the AI provider.', 502, 'UPSTREAM_BAD_JSON');
  }

  return data;
}

/**
 * Extracts plain text and usage metadata from a Gemini generateContent
 * response, handling missing candidates and safety-blocked responses.
 */
function parseGeminiResponse(data) {
  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;

  if (!candidate) {
    throw new UpstreamError(
      'Aria did not return a response. Please try rephrasing your message.',
      502,
      'EMPTY_CANDIDATE'
    );
  }

  if (candidate.finishReason === 'SAFETY') {
    return {
      text:
        "I'm not able to help with that particular request. Could you rephrase, or ask me about visa eligibility, documents, or fees?",
      usage: extractUsage(data),
    };
  }

  const parts = candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  const text = parts.map((part) => part.text || '').join('').trim();

  if (!text) {
    throw new UpstreamError(
      'Aria did not return any text. Please try again.',
      502,
      'EMPTY_TEXT'
    );
  }

  return { text, usage: extractUsage(data) };
}

function extractUsage(data) {
  const usage = data && data.usageMetadata;
  if (!usage) return null;
  return {
    promptTokens: usage.promptTokenCount ?? 0,
    responseTokens: usage.candidatesTokenCount ?? 0,
    totalTokens: usage.totalTokenCount ?? 0,
  };
}

/* ==================================================================
   RESPONSE HELPERS
================================================================== */

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(err) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message =
    status >= 500 && !(err instanceof UpstreamError) && !(err instanceof ValidationError)
      ? 'Something went wrong while processing your request. Please try again.'
      : err.message;

  return jsonResponse({ success: false, error: message, code }, status);
}

function generateFallbackSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ==================================================================
   HANDLER
================================================================== */

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonResponse(
      { success: false, error: 'Only POST requests are supported.', code: 'METHOD_NOT_ALLOWED' },
      405
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Never expose the fact that this is a missing-key issue to the client
    // in more detail than necessary — log the specifics server-side only.
    console.error('[api/chat] GEMINI_API_KEY is not set in the environment.');
    return jsonResponse(
      { success: false, error: 'The AI service is not configured correctly. Please try again later.', code: 'SERVER_MISCONFIGURED' },
      500
    );
  }

  let rawBody;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(
      { success: false, error: 'Request body must be valid JSON.', code: 'INVALID_JSON' },
      400
    );
  }

  let validated;
  try {
    validated = validateRequestBody(rawBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResponse(err);
    }
    console.error('[api/chat] Unexpected validation failure:', err);
    return jsonResponse(
      { success: false, error: 'Invalid request.', code: 'VALIDATION_ERROR' },
      400
    );
  }

  const { message, history, sessionId: incomingSessionId } = validated;
  const sessionId = incomingSessionId || generateFallbackSessionId();

  try {
    const contextTurns = resolveConversationContext(history, sessionId);
    const payload = buildGeminiPayload(message, contextTurns);
    const geminiData = await callGemini(payload, apiKey);
    const { text, usage } = parseGeminiResponse(geminiData);

    appendSessionTurns(sessionId, message, text);

    return jsonResponse(
      {
        success: true,
        reply: text,
        model: GEMINI_MODEL,
        sessionId,
        usage,
        timestamp: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    if (err instanceof UpstreamError || err instanceof ValidationError) {
      return errorResponse(err);
    }
    console.error('[api/chat] Unexpected error:', err);
    return jsonResponse(
      { success: false, error: 'An unexpected error occurred. Please try again.', code: 'INTERNAL_ERROR' },
      500
    );
  }
}
