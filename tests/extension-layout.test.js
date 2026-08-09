import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function projectFile(relativePath) {
    return path.join(projectRoot, relativePath);
}

async function readProjectFile(relativePath) {
    return readFile(projectFile(relativePath), 'utf8');
}

function makeControl(initial = {}) {
    const listeners = new Map();
    return {
        checked: initial.checked ?? false,
        value: initial.value ?? '',
        textContent: '',
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        dispatch(type) {
            listeners.get(type)?.({ currentTarget: this });
        },
    };
}

test('manifest installs as an event-driven SillyTavern 1.18 extension', async () => {
    const manifest = JSON.parse(await readProjectFile('manifest.json'));

    assert.equal(manifest.display_name, 'Strict Prefill Bridge');
    assert.equal(manifest.version, '0.5.0');
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.generate_interceptor, undefined);
    assert.equal(manifest.minimum_client_version, '1.18.0');
});

test('settings explain the structured-output mechanism and expose an exact-prefix control', async () => {
    const settingsSource = await readProjectFile('settings.html');

    assert.match(settingsSource, /id="strict-prefill-settings"/);
    assert.match(settingsSource, /id="strict-prefill-enabled"[^>]*type="checkbox"/);
    assert.match(settingsSource, /id="strict-prefill-first-cot"[^>]*type="checkbox"/);
    assert.match(settingsSource, /<label[^>]*for="strict-prefill-prefix"/);
    assert.match(settingsSource, /id="strict-prefill-prefix"[^>]*rows="5"[^>]*spellcheck="false"/);
    assert.match(settingsSource, /id="strict-prefill-minimum-content"[^>]*type="number"/);
    assert.match(settingsSource, /Structured Outputs|JSON Schema/);
    assert.match(settingsSource, /Continue/);
});

test('browser entrypoint injects Gemini schema through the existing SillyTavern connection', async () => {
    const originalGlobals = new Map();
    for (const name of ['SillyTavern', 'window', 'document', 'toastr', 'MutationObserver', 'strictPrefillBridgeInterceptor']) {
        originalGlobals.set(name, {
            exists: Object.hasOwn(globalThis, name),
            value: globalThis[name],
        });
    }

    const eventTypes = {
        APP_READY: 'app-ready',
        CHAT_CHANGED: 'chat-changed',
        CHAT_COMPLETION_SETTINGS_READY: 'settings-ready',
        STREAM_TOKEN_RECEIVED: 'stream-token',
        MESSAGE_RECEIVED: 'message-received',
        GENERATION_STOPPED: 'generation-stopped',
    };
    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const eventHandlers = handlers.get(eventName) ?? [];
            eventHandlers.push(handler);
            handlers.set(eventName, eventHandlers);
        },
    };

    const enabledControl = makeControl();
    const prefixControl = makeControl();
    const minimumContentControl = makeControl();
    const prefillFirstCotControl = makeControl();
    const previewControl = makeControl();
    const statusControl = makeControl();
    const settingsRoot = {};
    let mounted = false;
    const settingsContainer = {
        insertAdjacentHTML() {
            mounted = true;
        },
    };
    const controls = new Map([
        ['strict-prefill-settings', settingsRoot],
        ['strict-prefill-enabled', enabledControl],
        ['strict-prefill-prefix', prefixControl],
        ['strict-prefill-minimum-content', minimumContentControl],
        ['strict-prefill-first-cot', prefillFirstCotControl],
        ['strict-prefill-preview', previewControl],
        ['strict-prefill-status', statusControl],
    ]);

    const document = {
        querySelector(selector) {
            return selector === '#extensions_settings' ? settingsContainer : null;
        },
        getElementById(id) {
            return mounted ? controls.get(id) ?? null : null;
        },
    };
    let savedSettings = 0;
    const context = {
        eventSource,
        eventTypes,
        extensionSettings: {},
        chat: [],
        renderExtensionTemplateAsync: async () => '<div id="strict-prefill-settings"></div>',
        saveSettingsDebounced: () => {
            savedSettings += 1;
        },
        updateMessageBlock: () => undefined,
    };

    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        requestAnimationFrame: callback => globalThis.setTimeout(callback, 0),
        cancelAnimationFrame: handle => globalThis.clearTimeout(handle),
    };
    globalThis.document = document;
    globalThis.toastr = { warning: () => undefined, error: () => undefined };
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
    };

    try {
        const entrypoint = pathToFileURL(projectFile('index.js')).href;
        await import(`${entrypoint}?integration-test=${Date.now()}`);

        assert.equal(globalThis.strictPrefillBridgeInterceptor, undefined);
        for (const eventName of Object.values(eventTypes)) {
            assert.equal(handlers.get(eventName)?.length, 1, `missing handler for ${eventName}`);
        }

        const messages = [{ role: 'user', content: 'hello' }];
        const payload = {
            type: 'normal',
            chat_completion_source: 'vertexai',
            model: 'gemini-3.6-flash',
            reasoning_effort: 'low',
            messages,
        };
        handlers.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY)[0](payload);

        assert.strictEqual(payload.messages, messages);
        assert.equal(payload.reasoning_effort, 'low');
        assert.deepEqual(payload.json_schema.value.properties.prefix.enum, ['<think>']);
        assert.deepEqual(context.extensionSettings.strict_prefill_bridge, {
            enabled: true,
            prefix: '<think>',
            minimumContentCharacters: 0,
            prefillFirstCot: false,
        });

        await handlers.get(eventTypes.APP_READY)[0]();
        assert.equal(enabledControl.checked, true);
        assert.equal(prefixControl.value, '<think>');
        assert.equal(minimumContentControl.value, '0');
        assert.equal(prefillFirstCotControl.checked, false);

        enabledControl.checked = false;
        enabledControl.dispatch('change');
        prefixControl.value = '  <thinking>\nплан: 🧪\n';
        prefixControl.dispatch('input');
        minimumContentControl.value = '16000';
        minimumContentControl.dispatch('input');
        prefillFirstCotControl.checked = true;
        prefillFirstCotControl.dispatch('change');

        assert.equal(context.extensionSettings.strict_prefill_bridge.enabled, false);
        assert.equal(context.extensionSettings.strict_prefill_bridge.prefix, '  <thinking>\nплан: 🧪\n');
        assert.equal(context.extensionSettings.strict_prefill_bridge.minimumContentCharacters, 16000);
        assert.equal(context.extensionSettings.strict_prefill_bridge.prefillFirstCot, true);
        assert.equal(savedSettings, 4);
        assert.equal(previewControl.textContent, '  <thinking>\nплан: 🧪\n');
    } finally {
        for (const [name, original] of originalGlobals) {
            if (original.exists) {
                globalThis[name] = original.value;
            } else {
                delete globalThis[name];
            }
        }
    }
});

test('runtime has no external network or secret-reading capability', async () => {
    const runtimeSource = await Promise.all([
        readProjectFile('index.js'),
        readProjectFile('src/bridge-core.js'),
        readProjectFile('src/bridge-controller.js'),
    ]).then(files => files.join('\n'));

    assert.doesNotMatch(runtimeSource, /fetch\s*\(|XMLHttpRequest|WebSocket|document\.cookie/);
});
