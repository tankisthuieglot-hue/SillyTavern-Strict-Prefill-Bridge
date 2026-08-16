import {
    DEFAULT_SETTINGS,
    HTML_QUOTE_TOKEN,
    buildCotInstruction,
    buildStructuredSchema,
    finalizeThinkBlock,
    getProviderMode,
    isEligibleGenerationType,
    normalizeCotResponseTokens,
    normalizeMinimumContentCharacters,
    normalizeMode,
    normalizePrefix,
} from './src/bridge-core.js';
import { createBridgeController } from './src/bridge-controller.js';

const MODULE_NAME = 'strict_prefill_bridge';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
const COT_ENGINE_SYSTEM_PROMPT = 'You are a reasoning engine for a roleplay assistant. Your only job is to complete the required thinking template from the conversation instructions: fill every numbered step in order, one step at a time, without skipping, merging, or summarizing steps — and at the depth each step demands. Where the template requires detailed analysis, multi-paragraph reasoning, or verbose checks, you produce them in full; terse one-line fill-ins are a failure mode, not compliance. The thinking must be concrete and specific to the current scene: names, positions, motivations, knowledge states, sensory details, causes. You never write the final reply itself and never add commentary outside the required block.';

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
    if (extensionSettings[MODULE_NAME].prefillFirstCot === true && extensionSettings[MODULE_NAME].mode === undefined) {
        extensionSettings[MODULE_NAME].mode = 'two-pass';
    }
    extensionSettings[MODULE_NAME].mode = normalizeMode(extensionSettings[MODULE_NAME].mode);

    return extensionSettings[MODULE_NAME];
}

function updatePreview(enabledControl, modeControl, prefixControl, previewControl, statusControl) {
    previewControl.textContent = prefixControl.value || '∅';

    if (!enabledControl.checked) {
        statusControl.textContent = 'Выключен';
    } else if (prefixControl.value.length === 0) {
        statusControl.textContent = 'Пустой префилл';
    } else if (modeControl.value === 'two-pass') {
        statusControl.textContent = 'Двухпроходный CoT';
    } else {
        statusControl.textContent = 'Только префилл';
    }
}

export function updateSettingsFromControls(settings, controls, saveSettings) {
    settings.enabled = controls.enabledControl.checked;
    settings.mode = normalizeMode(controls.modeControl.value);
    settings.prefix = controls.prefixControl.value;
    settings.minimumContentCharacters = normalizeMinimumContentCharacters(controls.minimumContentControl.value);
    settings.cotResponseTokens = normalizeCotResponseTokens(controls.cotTokensControl.value);
    settings.answerPrefix = controls.answerPrefixControl.value;
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

    const controls = {
        enabledControl: document.getElementById('strict-prefill-enabled'),
        modeControl: document.getElementById('strict-prefill-mode'),
        prefixControl: document.getElementById('strict-prefill-prefix'),
        minimumContentControl: document.getElementById('strict-prefill-minimum-content'),
        cotTokensControl: document.getElementById('strict-prefill-cot-tokens'),
        answerPrefixControl: document.getElementById('strict-prefill-answer-prefix'),
        previewControl: document.getElementById('strict-prefill-preview'),
        statusControl: document.getElementById('strict-prefill-status'),
    };
    for (const control of Object.values(controls)) {
        if (!control) {
            return;
        }
    }

    const settings = getSettings();
    controls.enabledControl.checked = settings.enabled === true;
    controls.modeControl.value = normalizeMode(settings.mode);
    controls.prefixControl.value = typeof settings.prefix === 'string'
        ? settings.prefix
        : String(settings.prefix ?? '');
    controls.minimumContentControl.value = String(normalizeMinimumContentCharacters(settings.minimumContentCharacters));
    controls.cotTokensControl.value = String(normalizeCotResponseTokens(settings.cotResponseTokens));
    controls.answerPrefixControl.value = typeof settings.answerPrefix === 'string'
        ? settings.answerPrefix
        : '';
    updatePreview(controls.enabledControl, controls.modeControl, controls.prefixControl, controls.previewControl, controls.statusControl);

    const persist = () => {
        updateSettingsFromControls(settings, controls, context.saveSettingsDebounced);
        updatePreview(controls.enabledControl, controls.modeControl, controls.prefixControl, controls.previewControl, controls.statusControl);
    };

    controls.enabledControl.addEventListener('change', persist);
    controls.modeControl.addEventListener('change', persist);
    controls.prefixControl.addEventListener('input', persist);
    controls.minimumContentControl.addEventListener('input', persist);
    controls.cotTokensControl.addEventListener('input', persist);
    controls.answerPrefixControl.addEventListener('input', persist);
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

function shouldRunTwoPassCoT(payload, settings) {
    const generationType = String(payload?.type ?? '').toLowerCase();
    return settings?.enabled === true
        && normalizeMode(settings?.mode) === 'two-pass'
        && normalizePrefix(settings?.prefix).length > 0
        && ['normal', 'regenerate', 'swipe'].includes(generationType)
        && !payload?.json_schema
        && !(Array.isArray(payload?.tools) && payload.tools.length > 0)
        && Array.isArray(payload?.messages)
        && Boolean(getProviderMode(payload?.chat_completion_source, payload?.model));
}

async function runTwoPassCoT(payload, settings) {
    const prefix = normalizePrefix(settings.prefix);
    const prompt = payload.messages.map(message => ({
        ...message,
        content: Array.isArray(message?.content)
            ? message.content.map(part => (part && typeof part === 'object' ? { ...part } : part))
            : message?.content,
    }));
    prompt.push({
        role: 'user',
        content: buildCotInstruction(prefix),
    });

    const schema = buildStructuredSchema({
        source: payload.chat_completion_source,
        model: payload.model,
        prefix,
        minimumContentCharacters: settings?.minimumContentCharacters,
    });
    const baseOptions = {
        prompt,
        systemPrompt: COT_ENGINE_SYSTEM_PROMPT,
        responseLength: normalizeCotResponseTokens(settings.cotResponseTokens),
    };

    const finalize = data => {
        const rawText = typeof data === 'string'
            ? data
            : data?.choices?.[0]?.message?.content
                ?? data?.choices?.[0]?.text
                ?? data?.text
                ?? '';
        const thinkBlock = finalizeThinkBlock(visibleTextOf(rawText), prefix);
        return thinkBlock ? thinkBlock.replaceAll(HTML_QUOTE_TOKEN, '"') : '';
    };

    twoPassGeneratorActive = true;
    try {
        // Some providers (e.g. NanoGPT with thinking models) return an empty
        // structured object; retry the same prompt once without the schema.
        let thinkBlock = await SillyTavern.getContext().generateRawData({ ...baseOptions, jsonSchema: schema }).then(finalize);
        if (!thinkBlock) {
            thinkBlock = await SillyTavern.getContext().generateRawData(baseOptions).then(finalize);
        }
        return thinkBlock;
    } finally {
        twoPassGeneratorActive = false;
    }
}

function visibleTextOf(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(part => typeof part === 'string' ? part : part?.text ?? '').join('');
    }
    return String(value ?? '');
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
    let generatedThinkBlock = '';

    if (shouldRunTwoPassCoT(payload, settings)) {
        try {
            generatedThinkBlock = await runTwoPassCoT(payload, settings);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Two-pass CoT generator failed:`, error);
        }
        if (!generatedThinkBlock) {
            toastr.warning('CoT-запрос не удался. Ответ будет сгенерирован с обычным строгим префиллом.', 'Strict Prefill Bridge');
        }
    }

    controller.onSettingsReady(payload, { generatedThinkBlock });
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
