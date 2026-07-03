/**
 * =================================================================
 * Aurenn AI — chat.js
 * =================================================================
 * Production chat controller for the Aria / VisaPath AI receptionist
 * widget. Pairs with index.html's window.VisaBot UI shell.
 *
 * RESPONSIBILITIES
 *   - Owns the conversation lifecycle: send → stream → render → finalize
 *   - Renders AI message bubbles with streaming text, copy + retry actions
 *   - Talks to a server endpoint over fetch with streaming (SSE) support
 *     and a non-streaming JSON fallback
 *   - Renders lightweight markdown (bold, italic, code, links, lists)
 *   - Surfaces network/API errors with a retry affordance
 *   - Generates contextual follow-up suggestion chips
 *   - Tracks conversation history for multi-turn context
 *   - Cleans up in-flight requests, timers, and listeners (no leaks)
 *
 * API CONTRACT (server-side, e.g. /api/chat on Vercel)
 *   Request:  POST {API_ENDPOINT}
 *             Content-Type: application/json
 *             Body: { message: string, history: ChatTurn[] }
 *             ChatTurn = { role: 'user' | 'assistant', content: string }
 *
 *   Response — streaming (preferred):
 *             Content-Type: text/event-stream
 *             Each event:  "data: {\"text\":\"<chunk>\"}\n\n"
 *             Terminator:  "data: [DONE]\n\n"
 *
 *   Response — non-streaming fallback:
 *             Content-Type: application/json
 *             Body: { reply: string }
 *
 *   Error responses should return a non-2xx status with an optional
 *   JSON body: { error: string } for a human-readable message.
 *
 * INTEGRATION
 *   Include after index.html's inline UI script:
 *     <script src="chat.js" defer></script>
 *
 *   Depends on window.VisaBot, exposed by index.html:
 *     appendUserMessage, setTyping, setChipsVisible, setInputDisabled,
 *     scrollToBottom, timeNow, esc
 *
 *   Depends on these DOM nodes existing (defined in index.html):
 *     #chat-messages, #chat-body, #message-input, #send-btn
 *
 * =================================================================
 */
(function () {
    'use strict';

    /* =============================================================
       CONFIG
    ============================================================= */
    var CONFIG = {
        API_ENDPOINT: '/api/chat',
        REQUEST_TIMEOUT_MS: 30000,
        MAX_HISTORY_TURNS: 12,        // turns (user+assistant messages) sent as context
        COPY_FEEDBACK_MS: 1600,
        MAX_FOLLOWUPS: 3,
        RETRY_BACKOFF_MS: 600,
    };

    /**
     * =============================================================
     * EMAILJS LEAD CAPTURE — fill in your own credentials below.
     * =============================================================
     * Get these from https://dashboard.emailjs.com/admin
     *   SERVICE_ID  → Email Services tab
     *   TEMPLATE_ID → Email Templates tab
     *   PUBLIC_KEY  → Account → General (this is safe to expose client-side;
     *                 EmailJS has no separate "private key" for browser use —
     *                 do NOT put your EmailJS API private key here, it is
     *                 server-only and must never ship in front-end code)
     *
     * Requires the EmailJS browser SDK loaded in index.html BEFORE chat.js:
     *   <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
     *
     * Leads are captured automatically when a visitor's message contains
     * an email address or an Indian phone number — no extra UI needed.
     * =============================================================
     */
    var EMAILJS_CONFIG = {
        ENABLED:     true,                  // set false to disable lead capture entirely
        SERVICE_ID:  'service_xmzpo7h',
        TEMPLATE_ID: 'template_imy3ypj',
        PUBLIC_KEY:  'J09sX-M5eqwPj4Qik',
    };

    /* =============================================================
       CUSTOM ERROR TYPE
    ============================================================= */
    function ChatAPIError(message, status, serverMessage) {
        var err = new Error(message);
        err.name = 'ChatAPIError';
        err.status = status || 0;
        err.serverMessage = serverMessage || '';
        return err;
    }
    ChatAPIError.prototype = Object.create(Error.prototype);

    /* =============================================================
       UTILITIES
    ============================================================= */

    /** Escape raw text for safe HTML insertion. */
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(String(str == null ? '' : str)));
        return div.innerHTML;
    }

    /** Generate a reasonably unique id, with a fallback for older engines. */
    function generateId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * Lightweight, dependency-free markdown renderer.
     * Escapes HTML first, then applies a constrained set of safe
     * transforms: **bold**, *italic*, `code`, [text](https://url),
     * "- " bullet lists, and newline → <br>.
     */
    function renderMarkdownLite(raw) {
        var html = escapeHtml(raw);

        // Inline code spans
        html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

        // Bold
        html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

        // Italic (single asterisk, not part of a ** pair)
        html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

        // Links — only allow http(s) targets, force safe rel/target
        html = html.replace(
            /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
        );

        // Bullet list lines ("- item" or "• item") → <li>
        html = html.replace(/(^|\n)[-•]\s+([^\n]+)/g, '$1<li>$2</li>');
        if (/<li>/.test(html)) {
            html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, function (block) {
                return '<ul>' + block + '</ul>';
            });
            // Merge adjacent ul blocks created by the per-line wrap above
            html = html.replace(/<\/ul>\s*<ul>/g, '');
        }

        // Remaining newlines → <br>, but not directly around list markup
        html = html.replace(/\n(?!<\/?(?:ul|li)>)/g, '<br>');

        return html;
    }

    /**
     * Copy plain text to the clipboard with a textarea-based fallback
     * for non-secure contexts or browsers without the Clipboard API.
     */
    function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.top = '-9999px';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(ta);
                ok ? resolve() : reject(new Error('execCommand copy failed'));
            } catch (err) {
                reject(err);
            }
        });
    }

    /** rAF-debounced scheduler — collapses rapid calls into one per frame. */
    function createFrameScheduler(callback) {
        var scheduled = false;
        var latestArgs = null;
        return function () {
            latestArgs = arguments;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(function () {
                scheduled = false;
                callback.apply(null, latestArgs);
            });
        };
    }

    /* =============================================================
       EMAILJS LEAD CAPTURE
       Detects an email address or Indian phone number in a visitor's
       message and fires a non-blocking EmailJS notification so a
       consultant can follow up. Also attempts best-effort extraction
       of the visitor's name and the visa service they're interested
       in, scanning the full conversation (not just the triggering
       message) since those details are often mentioned earlier.
       Failures are logged, never shown to the visitor or allowed to
       interrupt the chat flow.
    ============================================================= */
    var EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    var PHONE_RE = /(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}\b/;

    // Matches explicit self-introduction patterns only ("my name is X",
    // "name: X", "i am called X") — deliberately excludes looser phrases
    // like "this is X", which is indistinguishable from ordinary speech
    // ("this is really helpful") and produced false-positive name matches
    // in testing. Each candidate word is checked against a stopword
    // lookahead so a greedy multi-word capture can't swallow connector
    // words like "and" or "here" from the rest of the sentence.
    var NAME_STOPWORDS = 'and|here|speaking|from|calling|writing|interested|looking|want|need|you|the|is|am|for|to|in|on|with|a|an';
    var NAME_WORD_PATTERN = "(?!(?:" + NAME_STOPWORDS + ")\\b)[a-zA-Z][a-zA-Z'.]*";
    var NAME_RE = new RegExp(
        '\\b(?:my\\s+name\\s+is|name\\s+is|name\\s*[:\\-]\\s*|i\\s*am\\s+called)\\s+(' +
        NAME_WORD_PATTERN + '(?:\\s+' + NAME_WORD_PATTERN + '){0,2})',
        'i'
    );

    var SERVICE_RULES = [
        { label: 'Canada PR / Express Entry', test: /canada|express entry|\bpr\b/i },
        { label: 'Australia Visa',            test: /australia/i },
        { label: 'UK Visa',                   test: /\buk\b|united kingdom/i },
        { label: 'USA Visa',                  test: /\busa\b|united states/i },
        { label: 'Student Visa',              test: /student visa|study (visa|abroad)/i },
        { label: 'Work Visa',                 test: /work visa|employment visa/i },
        { label: 'Visitor Visa',              test: /visitor visa|tourist visa/i },
        { label: 'Eligibility Check',         test: /eligib/i },
        { label: 'General Consultation',      test: /consult/i },
    ];

    var leadState = {
        emailJsReady: false,
        alreadyCapturedThisSession: false,
    };

    function initEmailJs() {
        if (!EMAILJS_CONFIG.ENABLED) return;
        if (typeof window.emailjs === 'undefined') {
            console.warn('[Aurenn] EmailJS SDK not found. Add the EmailJS <script> tag to index.html before chat.js to enable lead capture.');
            return;
        }
        if (EMAILJS_CONFIG.PUBLIC_KEY === 'YOUR_EMAILJS_PUBLIC_KEY') {
            console.warn('[Aurenn] EmailJS PUBLIC_KEY is still a placeholder — lead capture is inactive until you fill in EMAILJS_CONFIG in chat.js.');
            return;
        }
        try {
            window.emailjs.init({ publicKey: EMAILJS_CONFIG.PUBLIC_KEY });
            leadState.emailJsReady = true;
        } catch (err) {
            console.error('[Aurenn] EmailJS init failed:', err);
        }
    }

    /** Title-case a raw name match, preserving capitalization after
     *  apostrophes ("o'brien" -> "O'Brien", not "O'brien"). */
    function titleCaseName(raw) {
        return raw
            .split(/\s+/)
            .map(function (word) {
                return word
                    .split("'")
                    .map(function (part) {
                        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
                    })
                    .join("'");
            })
            .join(' ');
    }

    /** Concatenate all visitor turns (history + current message) for
     *  scanning name/service mentions that may have been shared
     *  earlier in the conversation rather than in the triggering
     *  message itself. */
    function getVisitorConversationText(currentText) {
        var pastUserTurns = state.history
            .filter(function (t) { return t.role === 'user'; })
            .map(function (t) { return t.content; });
        pastUserTurns.push(currentText);
        return pastUserTurns.join('\n');
    }

    /** Scans one line/sentence at a time so a name pattern can never
     *  bleed across a newline or sentence boundary into unrelated text
     *  ("my name is Rohan\nyou can reach me..." must not capture "You"). */
    function extractLeadName(fullText) {
        var segments = fullText.split(/[\n.!?]+/);
        for (var i = 0; i < segments.length; i++) {
            var match = segments[i].match(NAME_RE);
            if (match && match[1]) {
                var raw = match[1].trim();
                if (raw.length >= 2 && raw.length <= 60) {
                    return titleCaseName(raw);
                }
            }
        }
        return '';
    }

    function extractServiceInterest(fullText) {
        for (var i = 0; i < SERVICE_RULES.length; i++) {
            if (SERVICE_RULES[i].test.test(fullText)) {
                return SERVICE_RULES[i].label;
            }
        }
        return '';
    }

    function extractLeadInfo(triggeringText, fullConversationText) {
        var emailMatch = triggeringText.match(EMAIL_RE) || fullConversationText.match(EMAIL_RE);
        var phoneMatch = triggeringText.match(PHONE_RE) || fullConversationText.match(PHONE_RE);
        if (!emailMatch && !phoneMatch) return null;

        return {
            email:   emailMatch ? emailMatch[0] : '',
            phone:   phoneMatch ? phoneMatch[0] : '',
            name:    extractLeadName(fullConversationText),
            service: extractServiceInterest(fullConversationText),
        };
    }

    /**
     * Renders a distinct "high-tech" green confirmation card in the
     * chat stream once a consultation/lead has actually been captured.
     */
    function renderBookingConfirmation(leadName) {
        if (!dom.chatMessages) return;
        var card = document.createElement('div');
        card.className = 'booking-confirm';
        card.setAttribute('role', 'status');
        var greeting = leadName ? (', ' + leadName) : '';
        card.innerHTML =
            '<div class="booking-confirm-icon" aria-hidden="true">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">' +
                    '<path d="M20 6L9 17l-5-5" stroke="#04140D" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
            '</div>' +
            '<div class="booking-confirm-body">' +
                '<div class="booking-confirm-title">Consultation Request Received</div>' +
                '<div class="booking-confirm-text">Thanks' + escapeHtml(greeting) + '! Our visa expert team has been notified and will reach out shortly to confirm your session.</div>' +
            '</div>';
        dom.chatMessages.appendChild(card);
        if (window.VisaBot && typeof window.VisaBot.scrollToBottom === 'function') {
            window.VisaBot.scrollToBottom(true);
        }
    }

    /**
     * Fire-and-forget lead notification. Never throws, never blocks
     * or delays the chat send flow.
     */
    function maybeCaptureLead(userText) {     
    
        if (!EMAILJS_CONFIG.ENABLED || !leadState.emailJsReady) return;
        if (leadState.alreadyCapturedThisSession) return;

        var fullConversationText = getVisitorConversationText(userText);
        var lead = extractLeadInfo(userText, fullConversationText);
        if (!lead) return;

        leadState.alreadyCapturedThisSession = true;

        var conversationSnippet = state.history
            .slice(-6)
            .map(function (t) { return (t.role === 'user' ? 'Visitor: ' : 'Aria: ') + t.content; })
            .join('\n');

        var templateParams = {
            visitor_name:    lead.name    || 'Not provided',
            visitor_email:   lead.email   || 'Not provided',
            visitor_phone:   lead.phone   || 'Not provided',
            service_interested: lead.service || 'Not specified',
            visitor_message: userText,
            conversation_snippet: conversationSnippet,
            captured_at: new Date().toLocaleString('en-IN'),
            source: 'VisaPath Consultants — Aria AI Receptionist',
        };

        window.emailjs.send(EMAILJS_CONFIG.SERVICE_ID, EMAILJS_CONFIG.TEMPLATE_ID, templateParams)
            .then(function () {
                console.info('[Aurenn] Lead notification sent successfully.');
                renderBookingConfirmation(lead.name);
            })
            .catch(function (err) {
                console.error('[Aurenn] EmailJS lead notification failed:', err);
                leadState.alreadyCapturedThisSession = false; // allow retry on next message
            });
    }

    /* =============================================================
       FOLLOW-UP SUGGESTION HEURISTICS
       Lightweight keyword matching against the AI's reply text to
       surface 2-3 relevant next-step prompts. No network call.
    ============================================================= */
    var FOLLOWUP_RULES = [
        {
            test: /canada|pr\b|express entry/i,
            suggestions: [
                'What is the Express Entry CRS score requirement?',
                'How long does Canada PR processing take?',
                'What documents do I need for Canada PR?',
            ],
        },
        {
            test: /australia|skilled migration/i,
            suggestions: [
                'What is the points test for Australia Skilled Migration?',
                'Which occupations are in-demand for Australia?',
                'How much does an Australia visa application cost?',
            ],
        },
        {
            test: /\buk\b|united kingdom/i,
            suggestions: [
                'What is the UK Skilled Worker visa salary threshold?',
                'Can I bring my family on a UK visa?',
                'How long does a UK visa take to process?',
            ],
        },
        {
            test: /\busa\b|united states/i,
            suggestions: [
                'What is the difference between a US work visa and study visa?',
                'How do I apply for a US visa interview?',
                'What is the H-1B visa process?',
            ],
        },
        {
            test: /student visa|study/i,
            suggestions: [
                'What is the minimum IELTS score required?',
                'Do I need a financial sponsor for a student visa?',
                'Can I work while studying abroad?',
            ],
        },
        {
            test: /work visa|employment/i,
            suggestions: [
                'Do I need a job offer before applying?',
                'What is the validity period of a work visa?',
                'Can a work visa lead to permanent residency?',
            ],
        },
        {
            test: /document|paperwork|checklist/i,
            suggestions: [
                'How long are these documents valid for?',
                'Do documents need to be translated?',
                'Can you check my visa eligibility?',
            ],
        },
        {
            test: /fee|cost|price|charge/i,
            suggestions: [
                'Are there any hidden charges?',
                'Do you offer instalment payment plans?',
                'I\'d like to book a consultation with a visa expert',
            ],
        },
        {
            test: /eligib/i,
            suggestions: [
                'What documents do I need to confirm eligibility?',
                'How accurate is this eligibility check?',
                'I\'d like to book a consultation with a visa expert',
            ],
        },
    ];

    var DEFAULT_FOLLOWUPS = [
        'What documents are required?',
        'What are the visa fees?',
        'I\'d like to book a consultation with a visa expert',
    ];

    function getFollowupSuggestions(replyText) {
        for (var i = 0; i < FOLLOWUP_RULES.length; i++) {
            if (FOLLOWUP_RULES[i].test.test(replyText)) {
                return FOLLOWUP_RULES[i].suggestions.slice(0, CONFIG.MAX_FOLLOWUPS);
            }
        }
        return DEFAULT_FOLLOWUPS.slice(0, CONFIG.MAX_FOLLOWUPS);
    }

    /* =============================================================
       SCOPED STYLES
       Injected once. Reuses the CSS custom properties already
       defined on :root by index.html (--accent-a, --glass-fill, etc.)
       so visuals stay consistent without duplicating design tokens.
    ============================================================= */
    function injectStyles() {
        if (document.getElementById('aurenn-chatjs-styles')) return;

        var style = document.createElement('style');
        style.id = 'aurenn-chatjs-styles';
        style.textContent =
            '.msg-bubble-content a{color:var(--accent-c, #22D3EE);text-decoration:underline;text-underline-offset:2px;}' +
            '.msg-bubble-content code{background:rgba(255,255,255,0.08);padding:1px 6px;border-radius:4px;' +
                'font-size:0.9em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}' +
            '.msg-bubble-content ul{margin:6px 0 6px 18px;padding:0;}' +
            '.msg-bubble-content li{margin-bottom:3px;}' +
            '.streaming-cursor{display:inline-block;width:2px;height:1em;background:var(--accent-a,#6366F1);' +
                'margin-left:2px;vertical-align:text-bottom;animation:aurennCursorBlink 0.9s steps(1) infinite;}' +
            '@keyframes aurennCursorBlink{0%,49%{opacity:1;}50%,100%{opacity:0;}}' +
            '.msg-actions{display:flex;align-items:center;gap:6px;margin-top:6px;padding:0 4px;opacity:0;' +
                'transform:translateY(-2px);transition:opacity 0.15s ease,transform 0.15s ease;}' +
            '.msg-ai:hover .msg-actions,.msg-ai:focus-within .msg-actions,.msg-actions.is-visible{' +
                'opacity:1;transform:translateY(0);}' +
            '.msg-action-btn{display:inline-flex;align-items:center;gap:4px;background:transparent;' +
                'border:1px solid var(--glass-stroke,rgba(255,255,255,0.08));color:var(--text-lo,#4B5563);' +
                'font-size:11px;font-family:inherit;padding:4px 9px;border-radius:9999px;cursor:pointer;' +
                'transition:background 0.15s ease,color 0.15s ease,border-color 0.15s ease;}' +
            '.msg-action-btn:hover{background:var(--glass-fill,rgba(255,255,255,0.04));' +
                'color:var(--text-md,#94A3B8);border-color:var(--glass-stroke-md,rgba(255,255,255,0.13));}' +
            '.msg-action-btn.is-success{color:var(--accent-green,#10B981);border-color:rgba(16,185,129,0.35);}' +
            '.msg-ai.msg-error-state .msg-bubble{border-color:rgba(239,68,68,0.35);' +
                'background:rgba(239,68,68,0.06);}' +
            '.msg-error-text{display:flex;align-items:flex-start;gap:8px;color:#FCA5A5;font-size:13.5px;' +
                'line-height:1.55;}' +
            '.msg-error-text svg{flex-shrink:0;margin-top:2px;}' +
            '.msg-retry-btn{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:7px 14px;' +
                'background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#FCA5A5;' +
                'font-size:12.5px;font-weight:600;font-family:inherit;border-radius:9999px;cursor:pointer;' +
                'transition:background 0.15s ease,transform 0.12s ease;}' +
            '.msg-retry-btn:hover{background:rgba(239,68,68,0.2);transform:translateY(-1px);}' +
            '.msg-retry-btn:active{transform:translateY(0);}' +
            '.followup-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding:0 4px;}' +
            '.followup-chip{font-size:12px;font-weight:500;font-family:inherit;color:var(--text-md,#94A3B8);' +
                'background:var(--glass-fill,rgba(255,255,255,0.04));border:1px solid var(--glass-stroke,rgba(255,255,255,0.08));' +
                'border-radius:9999px;padding:6px 13px;cursor:pointer;white-space:nowrap;' +
                'transition:background 0.15s ease,border-color 0.15s ease,color 0.15s ease,transform 0.12s ease;}' +
            '.followup-chip:hover{background:rgba(99,102,241,0.1);border-color:rgba(99,102,241,0.28);' +
                'color:var(--text-hi,#F1F5F9);transform:translateY(-1px);}' +
            '.followup-chip:active{transform:translateY(0);}' +
            '.conn-banner{display:flex;align-items:center;justify-content:center;gap:8px;' +
                'background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:#FCD34D;' +
                'font-size:12.5px;font-weight:500;padding:9px 14px;border-radius:12px;margin-bottom:14px;' +
                'animation:aurennFadeIn 0.2s ease both;}' +
            '@keyframes aurennFadeIn{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:translateY(0);}}' +
            '.msg-bubble[data-streaming="true"]{position:relative;}';
        document.head.appendChild(style);
    }

    /* =============================================================
       STATE
    ============================================================= */
    var state = {
        initialized: false,
        isLoading: false,
        controller: null,        // current AbortController
        timeoutHandle: null,
        history: [],             // [{ role, content }]
        rawTextById: Object.create(null), // messageId -> raw AI text (for copy)
        isOnline: navigator.onLine !== false,
        listeners: [],           // [{ target, type, fn }] for cleanup
    };

    function addListener(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        state.listeners.push({ target: target, type: type, fn: fn, opts: opts });
    }

    function removeAllListeners() {
        state.listeners.forEach(function (l) {
            l.target.removeEventListener(l.type, l.fn, l.opts);
        });
        state.listeners = [];
    }

    function pushHistory(role, content) {
        state.history.push({ role: role, content: content });
        var maxLen = CONFIG.MAX_HISTORY_TURNS;
        if (state.history.length > maxLen) {
            state.history = state.history.slice(state.history.length - maxLen);
        }
    }

    function getHistoryForRequest() {
        // Send everything except the just-appended trailing user turn is fine;
        // server is expected to append the new "message" itself, so we send
        // history up to (but not including) the current outgoing message.
        return state.history.slice();
    }

    /* =============================================================
       DOM REFERENCES (resolved at init time)
    ============================================================= */
    var dom = {
        chatMessages: null,
        chatBody: null,
    };

    /* =============================================================
       MESSAGE RENDERING — AI BUBBLES
    ============================================================= */

    function buildAIBubbleSkeleton(messageId) {
        var article = document.createElement('article');
        article.className = 'msg msg-ai';
        article.setAttribute('aria-label', 'Message from Aria');
        article.setAttribute('data-message-id', messageId);

        article.innerHTML =
            '<div class="msg-avatar" aria-hidden="true">🤖</div>' +
            '<div class="msg-inner">' +
                '<div class="msg-sender-label">Aria · AI Receptionist</div>' +
                '<div class="msg-bubble" data-streaming="true">' +
                    '<span class="msg-bubble-content"></span>' +
                    '<span class="streaming-cursor" aria-hidden="true"></span>' +
                '</div>' +
                '<div class="msg-timestamp"></div>' +
            '</div>';

        return article;
    }

    /**
     * Create (or reset, for retries) the AI message bubble shell.
     * Returns the <article> element.
     */
    function createAIMessageBubble(messageId) {
        var existing = dom.chatMessages.querySelector('[data-message-id="' + messageId + '"]');
        if (existing) {
            existing.classList.remove('msg-error-state');
            var bubble = existing.querySelector('.msg-bubble');
            bubble.setAttribute('data-streaming', 'true');
            bubble.innerHTML =
                '<span class="msg-bubble-content"></span>' +
                '<span class="streaming-cursor" aria-hidden="true"></span>';
            var ts = existing.querySelector('.msg-timestamp');
            if (ts) ts.textContent = '';
            var actions = existing.querySelector('.msg-actions');
            if (actions) actions.remove();
            var followups = existing.querySelector('.followup-row');
            if (followups) followups.remove();
            return existing;
        }

        var article = buildAIBubbleSkeleton(messageId);
        dom.chatMessages.appendChild(article);
        return article;
    }

    var scheduleContentUpdate = createFrameScheduler(function (messageId, rawText) {
        var article = dom.chatMessages.querySelector('[data-message-id="' + messageId + '"]');
        if (!article) return;
        var contentEl = article.querySelector('.msg-bubble-content');
        if (!contentEl) return;
        contentEl.innerHTML = renderMarkdownLite(rawText);
        if (window.VisaBot && typeof window.VisaBot.scrollToBottom === 'function') {
            window.VisaBot.scrollToBottom(false);
        }
    });

    function updateAIMessageContent(messageId, rawText) {
        state.rawTextById[messageId] = rawText;
        scheduleContentUpdate(messageId, rawText);
    }

    function buildActionsRow(messageId) {
        var row = document.createElement('div');
        row.className = 'msg-actions';

        var copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'msg-action-btn msg-copy-btn';
        copyBtn.setAttribute('aria-label', 'Copy response');
        copyBtn.innerHTML =
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
                '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
                '<path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
            '</svg><span>Copy</span>';

        addListener(copyBtn, 'click', function () {
            var raw = state.rawTextById[messageId] || '';
            copyToClipboard(raw).then(function () {
                flashCopySuccess(copyBtn);
            }).catch(function (err) {
                console.error('[Aurenn] Copy failed:', err);
            });
        });

        row.appendChild(copyBtn);
        return row;
    }

    function flashCopySuccess(buttonEl) {
        var original = buttonEl.innerHTML;
        buttonEl.classList.add('is-success');
        buttonEl.innerHTML =
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
                '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg><span>Copied</span>';
        setTimeout(function () {
            buttonEl.classList.remove('is-success');
            buttonEl.innerHTML = original;
        }, CONFIG.COPY_FEEDBACK_MS);
    }

    function finalizeAIMessage(messageId, rawText) {
        var article = dom.chatMessages.querySelector('[data-message-id="' + messageId + '"]');
        if (!article) return;

        var bubble = article.querySelector('.msg-bubble');
        bubble.setAttribute('data-streaming', 'false');
        var cursor = bubble.querySelector('.streaming-cursor');
        if (cursor) cursor.remove();

        var ts = article.querySelector('.msg-timestamp');
        if (ts) {
            ts.textContent = (window.VisaBot && typeof window.VisaBot.timeNow === 'function')
                ? window.VisaBot.timeNow()
                : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        var inner = article.querySelector('.msg-inner');
        inner.appendChild(buildActionsRow(messageId));

        if (window.VisaBot && typeof window.VisaBot.scrollToBottom === 'function') {
            window.VisaBot.scrollToBottom(false);
        }
    }

    function renderFollowUpSuggestions(rawText) {
        var suggestions = getFollowupSuggestions(rawText);
        if (!suggestions.length) return;

        var lastArticle = dom.chatMessages.querySelector('.msg-ai:last-child');
        if (!lastArticle) return;

        var row = document.createElement('div');
        row.className = 'followup-row';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Suggested follow-up questions');

        suggestions.forEach(function (text) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'followup-chip';
            chip.textContent = text;
            addListener(chip, 'click', function () {
                if (state.isLoading) return;
                handleSend(text);
            });
            row.appendChild(chip);
        });

        var inner = lastArticle.querySelector('.msg-inner');
        inner.appendChild(row);

        if (window.VisaBot && typeof window.VisaBot.scrollToBottom === 'function') {
            window.VisaBot.scrollToBottom(false);
        }
    }

    /* =============================================================
       ERROR BUBBLE
    ============================================================= */

    function describeError(err) {
        if (!state.isOnline) {
            return 'You appear to be offline. Please check your connection and try again.';
        }
        if (err && err.name === 'AbortError') {
            return 'The request timed out. Please try again.';
        }
        if (err && err.status === 429) {
            return 'Aria is receiving a lot of requests right now. Please wait a moment and try again.';
        }
        if (err && err.status >= 500) {
            return 'Something went wrong on our end. Please try again in a moment.';
        }
        if (err && err.serverMessage) {
            return err.serverMessage;
        }
        return 'I couldn\'t process that message. Please try again.';
    }

    function showAIMessageError(messageId, err, originalUserText) {
        var article = dom.chatMessages.querySelector('[data-message-id="' + messageId + '"]');
        if (!article) return;

        article.classList.add('msg-error-state');

        var bubble = article.querySelector('.msg-bubble');
        bubble.setAttribute('data-streaming', 'false');

        var message = describeError(err);
        bubble.innerHTML =
            '<div class="msg-error-text">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
                    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>' +
                    '<path d="M12 8v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
                    '<circle cx="12" cy="16" r="1" fill="currentColor"/>' +
                '</svg>' +
                '<span>' + escapeHtml(message) + '</span>' +
            '</div>';

        var retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'msg-retry-btn';
        retryBtn.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
                '<path d="M4 4v6h6M20 20v-6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
                '<path d="M5.5 14a8 8 0 0 0 14.78 2.5M18.5 10A8 8 0 0 0 3.72 7.5" ' +
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg><span>Retry</span>';
        addListener(retryBtn, 'click', function () {
            retryBtn.disabled = true;
            setTimeout(function () {
                handleSend(originalUserText, { isRetry: true, replaceMessageId: messageId });
            }, CONFIG.RETRY_BACKOFF_MS);
        });

        bubble.appendChild(retryBtn);

        var ts = article.querySelector('.msg-timestamp');
        if (ts) {
            ts.textContent = (window.VisaBot && typeof window.VisaBot.timeNow === 'function')
                ? window.VisaBot.timeNow()
                : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        if (window.VisaBot && typeof window.VisaBot.scrollToBottom === 'function') {
            window.VisaBot.scrollToBottom(true);
        }
    }

    /* =============================================================
       CONNECTION BANNER
    ============================================================= */
    var connBannerEl = null;

    function showConnectionBanner(message) {
        if (connBannerEl) return;
        connBannerEl = document.createElement('div');
        connBannerEl.className = 'conn-banner';
        connBannerEl.setAttribute('role', 'status');
        connBannerEl.textContent = message;
        dom.chatMessages.parentNode.insertBefore(connBannerEl, dom.chatMessages);
        if (window.VisaBot && typeof window.VisaBot.scrollToBottom === 'function') {
            window.VisaBot.scrollToBottom(true);
        }
    }

    function hideConnectionBanner() {
        if (connBannerEl && connBannerEl.parentNode) {
            connBannerEl.parentNode.removeChild(connBannerEl);
        }
        connBannerEl = null;
    }

    function handleOnline() {
        state.isOnline = true;
        hideConnectionBanner();
    }

    function handleOffline() {
        state.isOnline = false;
        showConnectionBanner('You\'re offline — messages will fail to send until your connection is restored.');
    }

    /* =============================================================
       NETWORK LAYER — streaming-first with JSON fallback
    ============================================================= */

    /**
     * Async generator yielding text deltas as they arrive.
     * Supports text/event-stream (SSE-style) and a single-shot
     * JSON { reply } fallback for non-streaming backends.
     */
    function streamResponseChunks(userText, signal) {
        var historyForRequest = getHistoryForRequest();

        return (async function* () {
            var response;
            try {
                response = await fetch(CONFIG.API_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: userText,
                        history: historyForRequest,
                    }),
                    signal: signal,
                });
            } catch (networkErr) {
                if (networkErr.name === 'AbortError') throw networkErr;
                throw new ChatAPIError('Network request failed', 0);
            }

            if (!response.ok) {
                var serverMessage = '';
                try {
                    var errBody = await response.clone().json();
                    serverMessage = errBody && errBody.error ? String(errBody.error) : '';
                } catch (parseErr) {
                    /* response body wasn't JSON — ignore, use generic message */
                }
                throw new ChatAPIError(
                    'Request failed with status ' + response.status,
                    response.status,
                    serverMessage
                );
            }

            var contentType = response.headers.get('content-type') || '';

            if (contentType.indexOf('text/event-stream') !== -1 && response.body) {
                var reader = response.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';

                try {
                    while (true) {
                        var result = await reader.read();
                        if (result.done) break;

                        buffer += decoder.decode(result.value, { stream: true });
                        var lines = buffer.split('\n');
                        buffer = lines.pop(); // retain any partial trailing line

                        for (var i = 0; i < lines.length; i++) {
                            var line = lines[i].trim();
                            if (!line || line.indexOf('data:') !== 0) continue;

                            var payload = line.slice(5).trim();
                            if (payload === '[DONE]') {
                                return;
                            }

                            var delta = '';
                            try {
                                var parsed = JSON.parse(payload);
                                delta = parsed.text || parsed.delta || parsed.content || '';
                            } catch (jsonErr) {
                                // Non-JSON SSE payload — treat the raw payload as text
                                delta = payload;
                            }

                            if (delta) yield delta;
                        }
                    }
                } finally {
                    try { reader.releaseLock(); } catch (e) { /* already released */ }
                }
                return;
            }

            // Non-streaming JSON fallback
            var data;
            try {
                data = await response.json();
            } catch (parseErr2) {
                throw new ChatAPIError('Received an invalid response from the server', response.status);
            }

            var text = (data && (data.reply || data.message || data.text)) || '';
            if (!text) {
                throw new ChatAPIError('Empty response from server', response.status);
            }
            yield text;
        })();
    }

    /* =============================================================
       SEND FLOW
    ============================================================= */

    function abortInFlightRequest() {
        if (state.controller) {
            state.controller.abort();
            state.controller = null;
        }
        if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
            state.timeoutHandle = null;
        }
    }

    async function handleSend(userText, options) {
        var opts = options || {};
        var isRetry = !!opts.isRetry;
        var replaceMessageId = opts.replaceMessageId || null;

        if (!userText || !userText.trim()) return;
        if (state.isLoading) return;

        if (!state.isOnline) {
            showConnectionBanner('You\'re offline — please reconnect before sending a message.');
            return;
        }

        state.isLoading = true;
        abortInFlightRequest();

        if (!isRetry) {
            if (window.VisaBot && typeof window.VisaBot.appendUserMessage === 'function') {
                window.VisaBot.appendUserMessage(userText);
            }
            pushHistory('user', userText);
            maybeCaptureLead(userText);
        }

        if (window.VisaBot) {
            if (typeof window.VisaBot.setInputDisabled === 'function') window.VisaBot.setInputDisabled(true);
            if (typeof window.VisaBot.setChipsVisible === 'function') window.VisaBot.setChipsVisible(false);
            if (typeof window.VisaBot.setTyping === 'function') window.VisaBot.setTyping(true);
        }

        var messageId = replaceMessageId || generateId();
        var bubbleCreated = false;
        var accumulated = '';

        state.controller = new AbortController();
        state.timeoutHandle = setTimeout(function () {
            if (state.controller) state.controller.abort();
        }, CONFIG.REQUEST_TIMEOUT_MS);

        try {
            var iterator = streamResponseChunks(userText, state.controller.signal);

            for await (var chunk of iterator) {
                if (!bubbleCreated) {
                    if (window.VisaBot && typeof window.VisaBot.setTyping === 'function') {
                        window.VisaBot.setTyping(false);
                    }
                    createAIMessageBubble(messageId);
                    bubbleCreated = true;
                }
                accumulated += chunk;
                updateAIMessageContent(messageId, accumulated);
            }

            if (!bubbleCreated || !accumulated) {
                throw new ChatAPIError('No response received from Aria', 0);
            }

            finalizeAIMessage(messageId, accumulated);
            pushHistory('assistant', accumulated);
            renderFollowUpSuggestions(accumulated);

        } catch (err) {
            if (window.VisaBot && typeof window.VisaBot.setTyping === 'function') {
                window.VisaBot.setTyping(false);
            }

            if (err && err.name === 'AbortError') {
                // Superseded by a newer request, or user-triggered cancel — no UI noise.
            } else {
                console.error('[Aurenn] Chat request failed:', err);
                if (bubbleCreated) {
                    showAIMessageError(messageId, err, userText);
                } else {
                    createAIMessageBubble(messageId);
                    showAIMessageError(messageId, err, userText);
                }
            }
        } finally {
            if (state.timeoutHandle) {
                clearTimeout(state.timeoutHandle);
                state.timeoutHandle = null;
            }
            state.controller = null;
            state.isLoading = false;
            if (window.VisaBot && typeof window.VisaBot.setInputDisabled === 'function') {
                window.VisaBot.setInputDisabled(false);
            }
        }
    }

    /* =============================================================
       INIT
    ============================================================= */

    function init() {
        if (state.initialized) return;

        dom.chatMessages = document.getElementById('chat-messages');
        dom.chatBody = document.getElementById('chat-body');

        if (!dom.chatMessages || !dom.chatBody) {
            console.error('[Aurenn] Required DOM elements not found. chat.js did not initialize.');
            return;
        }

        if (!window.VisaBot) {
            console.error('[Aurenn] window.VisaBot is not available. Ensure index.html\'s inline UI script loaded before chat.js.');
            return;
        }

        injectStyles();
        initEmailJs();

        // Claim ownership of message rendering so index.html's fallback
        // bubble-render path is skipped (we render via the event below).
        window._visabotHandled = true;

        addListener(document, 'visabot:send', function (e) {
            var text = e && e.detail && e.detail.message;
            if (typeof text === 'string' && text.trim()) {
                handleSend(text.trim());
            }
        });

        addListener(window, 'online', handleOnline);
        addListener(window, 'offline', handleOffline);

        state.isOnline = navigator.onLine !== false;
        if (!state.isOnline) {
            handleOffline();
        }

        state.initialized = true;
    }

    /* =============================================================
       PUBLIC API + LIFECYCLE
    ============================================================= */
    window.AurennChat = {
        /** Programmatically send a message (e.g. from custom UI). */
        send: function (text) {
            handleSend(text);
        },
        /** Cancel any in-flight request and reset the loading state. */
        cancel: function () {
            abortInFlightRequest();
            state.isLoading = false;
            if (window.VisaBot && typeof window.VisaBot.setTyping === 'function') {
                window.VisaBot.setTyping(false);
            }
            if (window.VisaBot && typeof window.VisaBot.setInputDisabled === 'function') {
                window.VisaBot.setInputDisabled(false);
            }
        },
        /** Clear in-memory conversation history (does not touch the DOM). */
        resetHistory: function () {
            state.history = [];
        },
        /** Reset the lead-capture session flag (e.g. for manual testing). */
        resetLeadCapture: function () {
            leadState.alreadyCapturedThisSession = false;
        },
        /** Tear down listeners and in-flight requests (e.g. on SPA unmount). */
        destroy: function () {
            abortInFlightRequest();
            removeAllListeners();
            state.initialized = false;
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

}());
