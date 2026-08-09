import { DEFAULT_SETTINGS, normalizeMinimumContentCharacters } from './src/bridge-core.js';
import { createBridgeController } from './src/bridge-controller.js';

const MODULE_NAME = 'strict_prefill_bridge';
const EXTENSION_FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/').filter(Boolean).at(-1));

let streamObserver = null;
let observedMessageId = -1;
let renderFrame = null;
let stopCleanupTimer = null;

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

function onSettingsReady(payload) {
    clearStopCleanup();
    disconnectStreamObserver();
    controller.onSettingsReady(payload);
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
