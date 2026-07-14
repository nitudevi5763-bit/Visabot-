const SYSTEM_PROMPT = `You are Aria, the AI immigration receptionist for VisaPath Consultants, a visa and immigration consultancy based in Chandigarh, India.

STYLE RULES (follow strictly, every reply):
- Maximum 3 short sentences OR 3 bullet points. Never both. Never more.
- Write like a fast WhatsApp reply, not an essay — no long paragraphs, no restating the question.
- Wrap the 2-4 most important words per reply in **double asterisks** (exact visa subclass/code, fee figure, deadline, or document name) so they render bold. Do not bold whole sentences.
- Skip disclaimers and filler ("It's important to note that...", "I'd be happy to help..."). Get straight to the answer.
- One specific fact beats a general overview. If the visitor's question is broad, give the single most relevant fact and ask ONE clarifying question instead of listing every visa category.
-  Only mention booking a consultation when the visitor shows real interest or asks something requiring case-specific advice — don't append it to every message.';

const MODEL_NAME = 'gemini-3.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
const TIMEOUT_MS = 25000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_ENTRIES = 20;

function sendJson(res, statusCode, data) {
  res.setHeader('Content-Type', 'application/json');
  res.status(statusCode).json(data);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { success: false, error: message });
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Invalid or missing JSON body' };
  }

  const { message, history } = body;

  if (message === undefined || message === null) {
    return { valid: false, error: 'The "message" field is required' };
  }

  if (typeof message !== 'string') {
    return { valid: false, error: 'The "message" field must be a string' };
  }

  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0) {
    return { valid: false, error: 'The "message" field cannot be empty' };
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `The "message" field exceeds the maximum limit of ${MAX_MESSAGE_LENGTH} characters` };
  }

  if (history !== undefined) {
    if (!Array.isArray(history)) {
      return { valid: false, error: 'The "history" field must be an array' };
    }

    if (history.length > MAX_HISTORY_ENTRIES) {
      return { valid: false, error: `The "history" field cannot exceed ${MAX_HISTORY_ENTRIES} entries` };
    }

    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      if (!item || typeof item !== 'object') {
        return { valid: false, error: `History item at index ${i} must be an object` };
      }
      if (item.role !== 'user' && item.role !== 'assistant') {
        return { valid: false, error: `History item at index ${i} must have a role of either "user" or "assistant"` };
      }
      if (typeof item.content !== 'string' || item.content.trim() === '') {
        return { valid: false, error: `History item at index ${i} must contain a valid non-empty string in "content"` };
      }
      if (item.content.length > MAX_MESSAGE_LENGTH) {
        return { valid: false, error: `History item at index ${i} content exceeds the maximum limit of ${MAX_MESSAGE_LENGTH} characters` };
      }
    }
  }

  return { valid: true, sanitizedMessage: trimmedMessage };
}

function buildGeminiContents(history, currentMessage) {
  const contents = [];

  if (history && history.length > 0) {
    history.forEach(item => {
      const apiRole = item.role === 'assistant' ? 'model' : 'user';
      contents.push({
        role: apiRole,
        parts: [{ text: item.content }]
      });
    });
  }

  contents.push({
    role: 'user',
    parts: [{ text: currentMessage }]
  });

  return contents;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method Not Allowed');
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    return sendError(res, 400, 'Unsupported Media Type. Content-Type must be application/json');
  }

  const { valid, error, sanitizedMessage } = validatePayload(req.body);
  if (!valid) {
    return sendError(res, 400, error);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendError(res, 500, 'API key missing from server environment configuration');
  }

  const contents = buildGeminiContents(req.body.history, sanitizedMessage);

  const requestBody = {
    contents,
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      topK: 32,
      maxOutputTokens: 400,
      thinkingConfig: {
        thinkingLevel: 'minimal'
      }
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const apiResponse = await fetch(`${API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text().catch(() => '');
      console.error('[api/chat] Gemini API error:', apiResponse.status, errText.slice(0, 500));
      return sendError(res, 502, 'AI service is temporarily unavailable.');
    }

    const data = await apiResponse.json();

    if (!data || !data.candidates || data.candidates.length === 0) {
      if (data.promptFeedback && data.promptFeedback.blockReason) {
        return sendError(res, 400, `Content blocked by safety policies: ${data.promptFeedback.blockReason}`);
      }
      return sendError(res, 502, 'AI service is temporarily unavailable.');
    }

    const firstCandidate = data.candidates[0];

    if (firstCandidate.finishReason && firstCandidate.finishReason !== 'STOP') {
      if (firstCandidate.finishReason === 'SAFETY' || firstCandidate.finishReason === 'RECITATION') {
        return sendError(res, 400, `Generation finished prematurely due to: ${firstCandidate.finishReason}`);
      }
      if (firstCandidate.finishReason === 'MAX_TOKENS') {
        console.error('[api/chat] Response truncated by MAX_TOKENS — increase maxOutputTokens.');
        return sendError(res, 502, 'AI service produced an incomplete response. Please try again.');
      }
    }

    const parts = firstCandidate.content && firstCandidate.content.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return sendError(res, 502, 'AI service is temporarily unavailable.');
    }

    const replyText = parts.map(part => part.text || '').join('').trim();
    if (replyText.length === 0) {
      return sendError(res, 502, 'AI service is temporarily unavailable.');
    }

    return sendJson(res, 200, {
      success: true,
      reply: replyText
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      return sendError(res, 504, 'Gateway Timeout. Upstream server took too long to reply');
    }

    console.error(err);
    return sendError(res, 500, 'An internal error occurred while processing your request');

  } finally {
    clearTimeout(timeoutId);
  }
}
