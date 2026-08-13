import {
    DEFAULT_SETTINGS,
    getProviderMode,
    isEligibleGenerationType,
    normalizeMinimumContentCharacters,
    normalizePrefix,
} from './src/bridge-core.js';
import { createBridgeController } from './src/bridge-controller.js';

const MODULE_NAME = 'strict_prefill_bridge';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
const PREFILL_GENERATOR_TOKENS = 512;
const PREFILL_GENERATOR_SYSTEM_PROMPT = `You generate the unfinished opening of an assistant response. Use the supplied conversation as context. Return only text that continues the exact required prefix, without repeating that prefix or adding a preamble. If the prefix ends with an opening tag or incomplete structure, write substantial, context-specific planning inside it, close the structure, and stop immediately after it. Do not write the final answer outside that structure. For a plain-text prefix, produce a substantial continuation that gives the main model a strong starting direction.`;

let streamObserver = null;
let observedMessageId = -1;
let renderFrame = null;
let stopCleanupTimer = null;
let twoPassGeneratorActive = false;

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME] ??= {};

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        extensionSettings[MODULE_NAME][key] ??= value;
    }

    return extensionSettings[MODULE_NAME];
}

function updatePreview(enabledControl, prefixControl, previewControl, statusControl) {
    previewControl.textContent = prefixControl.value || '∅';

    if (!enabledControl.checked) {
        statusControl.textContent = 'Выключен';
    } else if (prefixControl.value.length === 0) {
        statusControl.textContent = 'Пустой префилл';
    } else {
        statusControl.textContent = 'Включён';
    }
}

export function updateSettingsFromControls(settings, enabledControl, prefixControl, minimumContentControl, prefillFirstCotControl, saveSettings) {
    settings.enabled = enabledControl.checked;
    settings.prefix = prefixControl.value;
    settings.minimumContentCharacters = normalizeMinimumContentCharacters(minimumContentControl.value);
    settings.prefillFirstCot = prefillFirstCotControl.checked;
    saveSettings();
}

export async function initializeSettingsUi() {
    if (document.getElementById('strict-prefill-settings')) {
        return;
    }

    const context = SillyTavern.getContext();
    const html = await context.renderExtensionTemplateAsync(`third-party/${EXTENSION_FOLDER}`, 'settings');
    const settingsContainer = document.querySelector('#extensions_settings');
    if (!settingsContainer) {
        return;
    }

    settingsContainer.insertAdjacentHTML('beforeend', html);

    const enabledControl = document.getElementById('strict-prefill-enabled');
    const prefixControl = document.getElementById('strict-prefill-prefix');
    const minimumContentControl = document.getElementById('strict-prefill-minimum-content');
    const prefillFirstCotControl = document.getElementById('strict-prefill-first-cot');
    const previewControl = document.getElementById('strict-prefill-preview');
    const statusControl = document.getElementById('strict-prefill-status');
    if (!enabledControl || !prefixControl || !minimumContentControl || !prefillFirstCotControl || !previewControl || !statusControl) {
        return;
    }

    const settings = getSettings();
    enabledControl.checked = settings.enabled === true;
    prefixControl.value = typeof settings.prefix === 'string'
        ? settings.prefix
        : String(settings.prefix ?? '');
    minimumContentControl.value = String(normalizeMinimumContentCharacters(settings.minimumContentCharacters));
    prefillFirstCotControl.checked = settings.prefillFirstCot === true;
    updatePreview(enabledControl, prefixControl, previewControl, statusControl);

    const persist = () => {
        updateSettingsFromControls(settings, enabledControl, prefixControl, minimumContentControl, prefillFirstCotControl, context.saveSettingsDebounced);
        updatePreview(enabledControl, prefixControl, previewControl, statusControl);
    };

    enabledControl.addEventListener('change', persist);
    prefixControl.addEventListener('input', persist);
    minimumContentControl.addEventListener('input', persist);
    prefillFirstCotControl.addEventListener('change', persist);
}

const controller = createBridgeController({
    getContext: () => SillyTavern.getContext(),
    getSettings,
    notifyWarning: message => toastr.warning(message, 'Strict Prefill Bridge'),
});

function cancelScheduledRender() {
    if (renderFrame !== null) {
        const cancel = window.cancelAnimationFrame ?? window.clearTimeout;
        cancel(renderFrame);
        renderFrame = null;
    }
}

function disconnectStreamObserver() {
    cancelScheduledRender();
    streamObserver?.disconnect?.();
    streamObserver = null;
    observedMessageId = -1;
}

function clearStopCleanup() {
    if (stopCleanupTimer !== null) {
        window.clearTimeout(stopCleanupTimer);
        stopCleanupTimer = null;
    }
}

function shouldGenerateTwoPassPrefix(payload, settings) {
    const generationType = String(payload?.type ?? '').toLowerCase();
    return settings?.enabled === true
        && settings?.prefillFirstCot === true
        && normalizePrefix(settings?.prefix).length > 0
        && isEligibleGenerationType(generationType)
        && !payload?.json_schema
        && !(Array.isArray(payload?.tools) && payload.tools.length > 0)
        && Array.isArray(payload?.messages)
        && Boolean(getProviderMode(payload?.chat_completion_source, payload?.model));
}

async function generateTwoPassPrefix(payload, settings) {
    const prefix = normalizePrefix(settings?.prefix);
    const prompt = payload.messages.map(message => ({
        ...message,
        content: Array.isArray(message?.content)
            ? message.content.map(part => (part && typeof part === 'object' ? { ...part } : part))
            : message?.content,
    }));
    prompt.push({
        role: 'user',
        content: `The exact required prefix is:\n---BEGIN PREFIX---\n${prefix}\n---END PREFIX---\nGenerate only the text that must immediately follow it.`,
    });

    let data;
    twoPassGeneratorActive = true;
    try {
        data = await SillyTavern.getContext().generateRawData({
            prompt,
            systemPrompt: PREFILL_GENERATOR_SYSTEM_PROMPT,
            responseLength: PREFILL_GENERATOR_TOKENS,
        });
    } finally {
        twoPassGeneratorActive = false;
    }

    const messageContent = data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.text
        ?? '';
    const visibleText = typeof messageContent === 'string'
        ? messageContent
        : Array.isArray(messageContent)
            ? messageContent.map(part => typeof part === 'string' ? part : part?.text ?? '').join('')
            : '';
    const reasoningText = data?.responseContent?.parts
        ?.filter(part => part?.thought && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n\n')
        || data?.choices?.[0]?.message?.reasoning_content
        || data?.choices?.[0]?.message?.reasoning
        || '';

    const openingTag = /<([A-Za-z][\w:-]*)[^>]*>\s*$/.exec(prefix);
    if (openingTag) {
        const closingTag = `</${openingTag[1]}>`;
        let body = String(reasoningText || visibleText || '');
        if (body.startsWith(prefix)) {
            body = body.slice(prefix.length);
        }
        const closingIndex = body.indexOf(closingTag);
        if (closingIndex >= 0) {
            body = body.slice(0, closingIndex);
        }
        body = body.trim();
        return body ? `${prefix}${body}${closingTag}\n` : '';
    }

    const generated = String(reasoningText || visibleText || '');
    return generated.startsWith(prefix) ? generated : prefix + generated;
}

function domContainsStructuredJson(messageId) {
    const textElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    const text = String(textElement?.textContent ?? '');
    return text.includes('{"prefix"') || text.includes('{"response"');
}

function renderDecodedStream() {
    renderFrame = null;
    const snapshot = controller.getSnapshot();
    if (!snapshot.active || !snapshot.latestRaw) {
        return;
    }

    const messageId = controller.getActiveMessageId();
    if (messageId < 0) {
        return;
    }

    const decoded = controller.decode(snapshot.latestRaw);
    if (typeof decoded !== 'string') {
        return;
    }

    const message = SillyTavern.getContext().chat?.[messageId];
    if (message?.mes !== decoded || domContainsStructuredJson(messageId)) {
        controller.applyDecoded(messageId, decoded);
    }
}

function scheduleDecodedRender() {
    if (renderFrame !== null) {
        return;
    }
    const schedule = window.requestAnimationFrame ?? (callback => window.setTimeout(callback, 0));
    renderFrame = schedule(renderDecodedStream);
}

function ensureStreamObserver() {
    const messageId = controller.getActiveMessageId();
    if (messageId < 0 || (streamObserver && observedMessageId === messageId)) {
        return;
    }

    disconnectStreamObserver();
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement || typeof MutationObserver !== 'function') {
        return;
    }

    observedMessageId = messageId;
    streamObserver = new MutationObserver(scheduleDecodedRender);
    streamObserver.observe(messageElement, { childList: true, subtree: true, characterData: true });
}

async function onSettingsReady(payload) {
    if (twoPassGeneratorActive && String(payload?.type ?? '').toLowerCase() === 'quiet') {
        payload.include_reasoning = true;
        return;
    }

    clearStopCleanup();
    disconnectStreamObserver();
    const settings = getSettings();
    let generatedPrefix = '';

    if (shouldGenerateTwoPassPrefix(payload, settings)) {
        try {
            generatedPrefix = await generateTwoPassPrefix(payload, settings);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Two-pass prefill generator failed:`, error);
            toastr.warning('Предварительный CoT не сгенерирован. Используется обычный строгий префилл.', 'Strict Prefill Bridge');
        }
    }

    if (generatedPrefix) {
        payload.include_reasoning = false;
    }

    controller.onSettingsReady(payload, { generatedPrefix });
}

function onStreamToken(rawText) {
    const decoded = controller.onStream(rawText);
    if (decoded === null) {
        return;
    }
    ensureStreamObserver();
    scheduleDecodedRender();
}

function onMessageReceived(messageId) {
    controller.onMessageReceived(messageId);
    clearStopCleanup();
    disconnectStreamObserver();
}

function onGenerationStopped() {
    if (!controller.getSnapshot().active) {
        return;
    }

    scheduleDecodedRender();
    clearStopCleanup();
    stopCleanupTimer = window.setTimeout(() => {
        renderDecodedStream();
        controller.reset();
        disconnectStreamObserver();
        stopCleanupTimer = null;
    }, 250);
}

function resetRuntime() {
    clearStopCleanup();
    disconnectStreamObserver();
    controller.reset();
}

const { eventSource, eventTypes } = SillyTavern.getContext();
eventSource.on(eventTypes.APP_READY, initializeSettingsUi);
eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, onStreamToken);
eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
eventSource.on(eventTypes.CHAT_CHANGED, resetRuntime);
