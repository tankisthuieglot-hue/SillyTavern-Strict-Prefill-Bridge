import {
    buildStructuredSchema,
    getProviderMode,
    isEligibleGenerationType,
    normalizePrefix,
    protectGoogleHtmlTrackerQuotes,
    unwrapStructuredOutput,
} from './bridge-core.js';

const STRICT_CONTINUATION_PROMPT = 'Continue the immediately preceding assistant message from its exact final character. It is the unfinished beginning of your current response, not a previous completed turn. Do not restart, summarize, replace, quote, or repeat it. If it ends with an opening tag or incomplete structure, write substantial content inside that structure before closing it, then continue the response.';

function idleState() {
    return {
        active: false,
        mode: null,
        expectedPrefix: '',
        baseText: '',
        latestRaw: '',
        generationType: '',
        trackedSwipeId: -1,
        htmlQuoteEncoding: false,
    };
}

function findLastAssistantMessage(chat) {
    if (!Array.isArray(chat)) {
        return null;
    }

    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message && message.is_user !== true && message.is_system !== true && typeof message.mes === 'string') {
            return { index, message };
        }
    }

    return null;
}

function appendHistoryPrefillAndContinue(messages, prefix) {
    if (!Array.isArray(messages)) {
        return false;
    }

    const lastMessage = messages.at(-1);
    if (lastMessage?.role === 'assistant' && typeof lastMessage.content === 'string') {
        if (!lastMessage.content.endsWith(prefix)) {
            lastMessage.content += prefix;
        }
    } else if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.content)) {
        lastMessage.content.push({ type: 'text', text: prefix });
    } else {
        messages.push({ role: 'assistant', content: prefix });
    }

    messages.push({ role: 'user', content: STRICT_CONTINUATION_PROMPT });
    return true;
}

export function createBridgeController({ getContext, getSettings, notifyWarning }) {
    let state = idleState();

    function reset() {
        state = idleState();
    }

    function warn(message) {
        if (typeof notifyWarning === 'function') {
            notifyWarning(message);
        }
    }

    function onSettingsReady(payload) {
        reset();

        const settings = getSettings();
        const prefix = normalizePrefix(settings?.prefix);
        const generationType = String(payload?.type ?? '').toLowerCase();
        if (!payload || settings?.enabled !== true || prefix.length === 0 || !isEligibleGenerationType(generationType)) {
            return false;
        }
        if (payload.json_schema || (Array.isArray(payload.tools) && payload.tools.length > 0)) {
            return false;
        }

        const historyContinue = settings?.prefillFirstCot === true;
        const providerMode = historyContinue
            ? null
            : getProviderMode(payload.chat_completion_source, payload.model);
        if (!historyContinue && !providerMode) {
            warn(`Structured prefill is not available for the direct ${String(payload.chat_completion_source ?? 'unknown')} route in this SillyTavern version.`);
            return false;
        }

        let baseText = '';
        let trackedSwipeId = -1;

        if (generationType === 'continue') {
            const assistant = findLastAssistantMessage(getContext()?.chat);
            if (!assistant) {
                return false;
            }
            baseText = assistant.message.mes;
            trackedSwipeId = Number.isInteger(assistant.message.swipe_id) ? assistant.message.swipe_id : -1;
        }

        let htmlQuoteEncoding = false;

        if (historyContinue) {
            if (!appendHistoryPrefillAndContinue(payload.messages, prefix)) {
                return false;
            }
        } else {
            htmlQuoteEncoding = protectGoogleHtmlTrackerQuotes(
                payload.messages,
                payload.chat_completion_source,
            );
            payload.json_schema = buildStructuredSchema({
                source: payload.chat_completion_source,
                model: payload.model,
                prefix,
                minimumContentCharacters: settings?.minimumContentCharacters,
            });
        }
        delete payload.assistant_prefill;

        state = {
            active: true,
            mode: historyContinue ? 'history-continue' : providerMode,
            expectedPrefix: prefix,
            baseText,
            latestRaw: '',
            generationType,
            trackedSwipeId,
            htmlQuoteEncoding,
        };
        return true;
    }

    function decode(rawText) {
        if (!state.active) {
            return null;
        }
        return unwrapStructuredOutput(rawText, state);
    }

    function onStream(rawText) {
        if (!state.active) {
            return null;
        }
        state.latestRaw = String(rawText ?? '');
        return decode(state.latestRaw);
    }

    function applyDecoded(messageId, decodedText) {
        if (!state.active || typeof decodedText !== 'string') {
            return false;
        }

        const context = getContext();
        const message = context?.chat?.[messageId];
        if (!message || message.is_user === true) {
            return false;
        }
        if (state.trackedSwipeId !== -1 && Number.isInteger(message.swipe_id) && message.swipe_id !== state.trackedSwipeId) {
            return false;
        }

        if (state.trackedSwipeId === -1 && Number.isInteger(message.swipe_id)) {
            state.trackedSwipeId = message.swipe_id;
        }

        message.mes = decodedText;
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
            message.swipes[message.swipe_id] = decodedText;
        }
        if (typeof context.updateMessageBlock === 'function') {
            context.updateMessageBlock(messageId, message, { rerenderMessage: true });
        }
        return true;
    }

    function onMessageReceived(messageId) {
        if (!state.active) {
            return null;
        }

        const context = getContext();
        const message = context?.chat?.[messageId];
        const raw = state.latestRaw || message?.mes || '';
        const decoded = decode(raw);
        if (typeof decoded === 'string') {
            applyDecoded(messageId, decoded);
        }
        reset();
        return decoded;
    }

    function getActiveMessageId() {
        return findLastAssistantMessage(getContext()?.chat)?.index ?? -1;
    }

    return {
        onSettingsReady,
        onStream,
        onMessageReceived,
        applyDecoded,
        decode,
        getActiveMessageId,
        reset,
        getSnapshot: () => ({ ...state }),
    };
}
