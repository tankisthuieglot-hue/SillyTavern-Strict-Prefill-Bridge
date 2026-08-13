import {
    buildStructuredSchema,
    getProviderMode,
    isEligibleGenerationType,
    normalizePrefix,
    protectGoogleHtmlTrackerQuotes,
    unwrapStructuredOutput,
} from './bridge-core.js';

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

    function onSettingsReady(payload, { generatedPrefix = '' } = {}) {
        reset();

        const settings = getSettings();
        const configuredPrefix = normalizePrefix(settings?.prefix);
        const twoPassPrefix = normalizePrefix(generatedPrefix);
        const prefix = settings?.prefillFirstCot === true && twoPassPrefix.length > 0
            ? twoPassPrefix
            : configuredPrefix;
        const generationType = String(payload?.type ?? '').toLowerCase();
        if (!payload || settings?.enabled !== true || prefix.length === 0 || !isEligibleGenerationType(generationType)) {
            return false;
        }
        if (payload.json_schema || (Array.isArray(payload.tools) && payload.tools.length > 0)) {
            return false;
        }

        const providerMode = getProviderMode(payload.chat_completion_source, payload.model);
        if (!providerMode) {
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

        const htmlQuoteEncoding = protectGoogleHtmlTrackerQuotes(
            payload.messages,
            payload.chat_completion_source,
        );
        payload.json_schema = buildStructuredSchema({
            source: payload.chat_completion_source,
            model: payload.model,
            prefix,
            minimumContentCharacters: settings?.minimumContentCharacters,
        });
        delete payload.assistant_prefill;

        state = {
            active: true,
            mode: providerMode,
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
