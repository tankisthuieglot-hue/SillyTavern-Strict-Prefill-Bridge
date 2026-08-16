export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: 'two-pass',
    prefix: '<think>',
    minimumContentCharacters: 0,
    cotResponseTokens: 16384,
    answerPrefix: '',
});

export const HTML_QUOTE_TOKEN = '__SP_DQ__';

const ELIGIBLE_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const GOOGLE_SOURCES = new Set(['makersuite', 'vertexai']);
const INCOMPATIBLE_SOURCES = new Set([
    '',
    'claude',
    'ai21',
    'deepseek',
    'moonshot',
    'zai',
    'siliconflow',
    'cometapi',
]);

export function normalizePrefix(value) {
    return typeof value === 'string' ? value : String(value ?? '');
}

export function normalizeMinimumContentCharacters(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(200000, parsed)) : 0;
}

export function normalizeMode(value) {
    return value === 'schema-only' ? 'schema-only' : 'two-pass';
}

export function normalizeCotResponseTokens(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(1024, Math.min(65536, parsed)) : 16384;
}

export function deriveEnderTag(prefix) {
    const match = /<([A-Za-z][\w:-]*)[^>]*>\s*$/.exec(normalizePrefix(prefix));
    return match ? `</${match[1]}>` : '';
}

export function buildCotInstruction(prefix) {
    const exactPrefix = normalizePrefix(prefix);
    const ender = deriveEnderTag(exactPrefix);
    const closing = ender || 'the end of your thinking';
    return `Complete the thinking template required by the conversation instructions for the reply the assistant must now write. Fill every step in order, one step at a time, without skipping, merging, or summarizing steps. Obey the depth the template itself demands: where it asks for analysis, paragraphs, or in-depth checks, write them in full — terse one-line fill-ins like "Done" or "Checks passed" are a FAILURE, not a completed step. Reason specifically about the current scene: names, positions, motivations, what each character knows and does not know, sensory details, causes and consequences. A step with genuinely nothing to note gets a dash and nothing more. Wrap the completed thinking exactly as: ${exactPrefix} filled steps ${ender}. Stop immediately after ${closing}. Do not write the final reply itself, do not add any commentary outside the block.`;
}

export function buildNudgeInstruction(answerPrefix) {
    const forced = normalizePrefix(answerPrefix);
    const start = forced ? ` Begin the reply with: ${forced}` : '';
    return `[System] Your previous message contains your completed thinking block. Treat it as your own finished reasoning for this reply: follow its conclusions and every conversation rule. Write the final reply now. Do not open a new thinking block, do not repeat or summarize the reasoning, do not add meta commentary.${start}`;
}

function encodeHtmlTrackerQuotes(value) {
    const input = String(value ?? '').replace(
        /<info\b[\s\S]*?<\/info\s*>/gi,
        block => block.replaceAll('"', HTML_QUOTE_TOKEN),
    );
    let output = '';
    let insideTag = false;
    let insideDoubleQuotedAttribute = false;
    let insideSingleQuotedAttribute = false;

    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];

        if (!insideTag) {
            if (character === '<' && /[A-Za-z/!?]/.test(input[index + 1] ?? '')) {
                insideTag = true;
            }
            output += character;
            continue;
        }

        if (character === '"' && !insideSingleQuotedAttribute) {
            insideDoubleQuotedAttribute = !insideDoubleQuotedAttribute;
            output += HTML_QUOTE_TOKEN;
            continue;
        }

        if (character === "'" && !insideDoubleQuotedAttribute) {
            insideSingleQuotedAttribute = !insideSingleQuotedAttribute;
        } else if (character === '>' && !insideDoubleQuotedAttribute && !insideSingleQuotedAttribute) {
            insideTag = false;
        }

        output += character;
    }

    return output;
}

export function protectGoogleHtmlTrackerQuotes(messages, source) {
    if (!GOOGLE_SOURCES.has(String(source ?? '').toLowerCase()) || !Array.isArray(messages)) {
        return false;
    }

    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }

        if (typeof message.content === 'string') {
            message.content = encodeHtmlTrackerQuotes(message.content);
            continue;
        }

        if (Array.isArray(message.content)) {
            for (let index = 0; index < message.content.length; index += 1) {
                const part = message.content[index];
                if (typeof part === 'string') {
                    message.content[index] = encodeHtmlTrackerQuotes(part);
                } else if (part && typeof part.text === 'string') {
                    part.text = encodeHtmlTrackerQuotes(part.text);
                }
            }
        }
    }

    return true;
}

export function isEligibleGenerationType(type) {
    return ELIGIBLE_TYPES.has(String(type ?? '').toLowerCase());
}

export function getProviderMode(source, model) {
    const normalizedSource = String(source ?? '').toLowerCase();
    const normalizedModel = String(model ?? '').toLowerCase();

    if (GOOGLE_SOURCES.has(normalizedSource)) {
        return 'split-enum';
    }

    if (normalizedSource === 'openrouter' && /(?:^|\/)google\/gemini/.test(normalizedModel)) {
        return 'split-enum';
    }

    if (normalizedSource === 'nanogpt') {
        return 'split-enum';
    }

    if (INCOMPATIBLE_SOURCES.has(normalizedSource)) {
        return null;
    }

    return 'regex';
}

function escapeRegexLiteral(value) {
    let escaped = '';

    for (const character of String(value ?? '')) {
        const codePoint = character.codePointAt(0);

        if (character === '\n') {
            escaped += '\\n';
        } else if (character === '\r') {
            escaped += '\\r';
        } else if (character === '\t') {
            escaped += '\\t';
        } else if (/[\\^$.*+?()[\]{}|/]/.test(character)) {
            escaped += `\\${character}`;
        } else if (codePoint > 0x7f) {
            for (let index = 0; index < character.length; index += 1) {
                escaped += `\\u${character.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
            }
        } else {
            escaped += character;
        }
    }

    return escaped;
}

function buildGeminiEnumSchema(prefix, includePropertyOrdering, minimumContentCharacters) {
    const googleHtmlQuoteGuidance = `Inside every <info> HTML tracker, output ${HTML_QUOTE_TOKEN} instead of each double-quote character and preserve existing ${HTML_QUOTE_TOKEN} tokens exactly. Never output a literal double quote inside an <info> tracker.`;
    const prefixProperty = {
        type: 'string',
        enum: [prefix],
    };
    const content = {
        type: 'string',
        description: includePropertyOrdering
            ? `Continue the response immediately after the required prefix. ${googleHtmlQuoteGuidance}`
            : 'Continue the response immediately after the required prefix.',
    };

    const minimum = normalizeMinimumContentCharacters(minimumContentCharacters);
    if (includePropertyOrdering && minimum > 0) {
        content.minLength = minimum;
    }

    const value = {
        type: 'object',
        properties: {
            prefix: prefixProperty,
            content,
        },
        required: ['prefix', 'content'],
        additionalProperties: false,
    };

    if (includePropertyOrdering) {
        value.propertyOrdering = ['prefix', 'content'];
        const orderedValue = {
            type: value.type,
            propertyOrdering: value.propertyOrdering,
            properties: value.properties,
            required: value.required,
            additionalProperties: value.additionalProperties,
        };
        return orderedValue;
    }

    return value;
}

function buildRegexSchema(prefix) {
    const escapedPrefix = escapeRegexLiteral(prefix);

    return {
        type: 'object',
        properties: {
            response: {
                type: 'string',
                pattern: `^(?:${escapedPrefix})(?:.|\\n)+$`,
            },
        },
        required: ['response'],
        additionalProperties: false,
    };
}

export function buildStructuredSchema({ source, model, prefix, minimumContentCharacters = 0 }) {
    const exactPrefix = normalizePrefix(prefix);
    const mode = getProviderMode(source, model);

    if (!mode) {
        throw new Error(`Structured prefill is not supported for source: ${String(source ?? '')}`);
    }
    if (exactPrefix.length === 0) {
        throw new Error('Structured prefill requires a non-empty prefix.');
    }

    return {
        name: 'strict_prefill_response',
        description: 'A response with an exact required prefix followed by the continuation.',
        strict: true,
        value: mode === 'split-enum'
            ? buildGeminiEnumSchema(
                exactPrefix,
                GOOGLE_SOURCES.has(String(source ?? '').toLowerCase()),
                minimumContentCharacters,
            )
            : buildRegexSchema(exactPrefix),
    };
}

function extractJsonStringField(rawText, fieldName, { tolerateUnescapedQuotes = false } = {}) {
    const raw = String(rawText ?? '');
    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(raw);
    if (!match) {
        return null;
    }

    let value = '';
    let escaped = false;
    let unicodeDigits = '';
    let readingUnicode = false;

    for (let index = match.index + match[0].length; index < raw.length; index += 1) {
        const character = raw[index];

        if (readingUnicode) {
            unicodeDigits += character;
            if (unicodeDigits.length === 4) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
                    value += String.fromCharCode(Number.parseInt(unicodeDigits, 16));
                }
                readingUnicode = false;
                unicodeDigits = '';
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            if (character === 'u') {
                readingUnicode = true;
                continue;
            }

            const replacements = {
                '"': '"',
                '\\': '\\',
                '/': '/',
                b: '\b',
                f: '\f',
                n: '\n',
                r: '\r',
                t: '\t',
            };
            value += replacements[character] ?? character;
            continue;
        }

        if (character === '\\') {
            escaped = true;
            continue;
        }

        if (character === '"') {
            if (tolerateUnescapedQuotes) {
                let nextIndex = index + 1;
                while (nextIndex < raw.length && /\s/.test(raw[nextIndex])) {
                    nextIndex += 1;
                }

                const nextCharacter = raw[nextIndex] ?? '';
                if (nextCharacter && nextCharacter !== '}') {
                    value += '"';
                    continue;
                }
            }
            return { value, complete: true };
        }

        value += character;
    }

    return { value, complete: false };
}

function parseCompleteObject(rawText) {
    const raw = String(rawText ?? '').trim();
    const firstBrace = raw.indexOf('{');
    if (firstBrace === -1) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw.slice(firstBrace));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function appendToContinuedMessage(decoded, { baseText, generationType }) {
    const base = String(baseText ?? '');
    return generationType === 'continue' ? base + decoded : decoded;
}

function unwrapGeminiEnum(rawText, expectedPrefix) {
    const parsed = parseCompleteObject(rawText);
    if (parsed) {
        if (parsed.prefix !== expectedPrefix || typeof parsed.content !== 'string') {
            return null;
        }
        return expectedPrefix + parsed.content;
    }

    const prefix = extractJsonStringField(rawText, 'prefix');
    if (!prefix?.complete || prefix.value !== expectedPrefix) {
        return null;
    }

    const content = extractJsonStringField(rawText, 'content', { tolerateUnescapedQuotes: true });
    return expectedPrefix + (content?.value ?? '');
}

function unwrapRegex(rawText, expectedPrefix) {
    const parsed = parseCompleteObject(rawText);
    const extractedValue = parsed && typeof parsed.response === 'string'
        ? parsed.response
        : extractJsonStringField(rawText, 'response', { tolerateUnescapedQuotes: true })?.value;

    if (typeof extractedValue !== 'string') {
        return null;
    }

    if (!expectedPrefix.startsWith(extractedValue) && !extractedValue.startsWith(expectedPrefix)) {
        return null;
    }

    return extractedValue;
}

export function unwrapStructuredOutput(rawText, state) {
    const expectedPrefix = normalizePrefix(state?.expectedPrefix);
    if (!expectedPrefix) {
        return null;
    }

    let decoded = state?.mode === 'split-enum'
        ? unwrapGeminiEnum(rawText, expectedPrefix)
        : state?.mode === 'regex'
            ? unwrapRegex(rawText, expectedPrefix)
            : null;

    if (typeof decoded === 'string' && state?.htmlQuoteEncoding === true) {
        decoded = decoded.replaceAll(HTML_QUOTE_TOKEN, '"');
    }

    return typeof decoded === 'string' ? appendToContinuedMessage(decoded, state) : null;
}

export function finalizeThinkBlock(rawText, expectedPrefix) {
    const prefix = normalizePrefix(expectedPrefix);
    if (!prefix) {
        return null;
    }

    const raw = String(rawText ?? '').trim();
    if (!raw) {
        return null;
    }

    let text = unwrapGeminiEnum(raw, prefix) ?? unwrapRegex(raw, prefix);
    if (typeof text !== 'string') {
        let candidate = raw;
        const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(candidate);
        if (fenced) {
            candidate = fenced[1].trim();
        }
        // An unparsed structured-output wrapper (e.g. "{}" or a malformed
        // {"prefix": ... fragment) is provider garbage, not thinking content.
        if (/^\{\s*\}/.test(candidate) || /^\{\s*"/.test(candidate)) {
            return null;
        }
        const prefixIndex = candidate.indexOf(prefix);
        candidate = prefixIndex > 0 ? candidate.slice(prefixIndex) : candidate;
        text = candidate;
    }

    if (!text) {
        return null;
    }

    if (!text.startsWith(prefix)) {
        text = `${prefix}\n${text}`;
    }

    const ender = deriveEnderTag(prefix);
    let closed = text;
    if (ender) {
        const enderIndex = text.indexOf(ender, prefix.length);
        closed = enderIndex === -1
            ? `${text.trimEnd()}\n${ender}`
            : text.slice(0, enderIndex + ender.length);
    }

    const body = ender
        ? closed.slice(prefix.length, closed.length - ender.length)
        : closed.slice(prefix.length);
    return body.trim() ? closed : null;
}
