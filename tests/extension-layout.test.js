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
    const packageJson = JSON.parse(await readProjectFile('package.json'));

    assert.equal(manifest.display_name, 'Strict Prefill Bridge');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.version, packageJson.version);
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.generate_interceptor, undefined);
    assert.equal(manifest.minimum_client_version, '1.18.0');
});

test('settings explain the structured-output mechanism and expose mode and CoT controls', async () => {
    const settingsSource = await readProjectFile('settings.html');

    assert.match(settingsSource, /id="strict-prefill-settings"/);
    assert.match(settingsSource, /id="strict-prefill-enabled"[^>]*type="checkbox"/);
    assert.match(settingsSource, /<select id="strict-prefill-mode"[^>]*>/);
    assert.match(settingsSource, /<\/select>/);
    assert.match(settingsSource, /value="two-pass"/);
    assert.match(settingsSource, /value="schema-only"/);
    assert.match(settingsSource, /<label[^>]*for="strict-prefill-prefix"/);
    assert.match(settingsSource, /id="strict-prefill-prefix"[^>]*rows="5"[^>]*spellcheck="false"/);
    assert.match(settingsSource, /id="strict-prefill-cot-tokens"[^>]*type="number"/);
    assert.match(settingsSource, /id="strict-prefill-answer-prefix"/);
    assert.match(settingsSource, /id="strict-prefill-minimum-content"[^>]*type="number"/);
    assert.match(settingsSource, /Structured Outputs|JSON Schema/);
    assert.match(settingsSource, /Двухпроходный CoT/);
    assert.match(settingsSource, /два API-запроса/i);
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
    const modeControl = makeControl();
    const prefixControl = makeControl();
    const minimumContentControl = makeControl();
    const cotTokensControl = makeControl();
    const answerPrefixControl = makeControl();
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
        ['strict-prefill-mode', modeControl],
        ['strict-prefill-prefix', prefixControl],
        ['strict-prefill-minimum-content', minimumContentControl],
        ['strict-prefill-cot-tokens', cotTokensControl],
        ['strict-prefill-answer-prefix', answerPrefixControl],
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
    const generateRawCalls = [];
    const scriptedResponses = [];
    const renderedMessages = [];
    const context = {
        eventSource,
        eventTypes,
        extensionSettings: {
            strict_prefill_bridge: {
                enabled: true,
                mode: 'schema-only',
                prefix: '<think>',
            },
        },
        chat: [{
            is_user: false,
            mes: 'She turned to the door.',
            swipe_id: 0,
            swipes: ['She turned to the door.'],
        }],
        renderExtensionTemplateAsync: async () => '<div id="strict-prefill-settings"></div>',
        saveSettingsDebounced: () => {
            savedSettings += 1;
        },
        updateMessageBlock: (messageId, message) => {
            renderedMessages.push({ messageId, text: message.mes });
        },
        generateRawData: async options => {
            generateRawCalls.push(structuredClone(options));
            const quietPayload = {
                type: 'quiet',
                chat_completion_source: 'vertexai',
                model: 'gemini-3.6-flash',
                messages: options.prompt,
                include_reasoning: false,
            };
            await handlers.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY)[0](quietPayload);
            assert.equal(quietPayload.include_reasoning, true);
            return scriptedResponses.length > 0
                ? scriptedResponses.shift()
                : '{"prefix":"<think>","content":"{1} surveyed the silent room\\n{2} counted the exits"}';
        },
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
        await handlers.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY)[0](payload);

        assert.strictEqual(payload.messages, messages);
        assert.equal(payload.reasoning_effort, 'low');
        assert.deepEqual(payload.json_schema.value.properties.prefix.enum, ['<think>']);
        assert.deepEqual(context.extensionSettings.strict_prefill_bridge, {
            enabled: true,
            mode: 'schema-only',
            prefix: '<think>',
            minimumContentCharacters: 0,
            cotResponseTokens: 16384,
            answerPrefix: '',
        });

        await handlers.get(eventTypes.APP_READY)[0]();
        assert.equal(enabledControl.checked, true);
        assert.equal(modeControl.value, 'schema-only');
        assert.equal(prefixControl.value, '<think>');
        assert.equal(minimumContentControl.value, '0');
        assert.equal(cotTokensControl.value, '16384');
        assert.equal(answerPrefixControl.value, '');

        enabledControl.checked = false;
        enabledControl.dispatch('change');
        enabledControl.checked = true;
        enabledControl.dispatch('change');
        modeControl.value = 'two-pass';
        modeControl.dispatch('change');
        prefixControl.value = '  <thinking>\nплан: 🧪\n';
        prefixControl.dispatch('input');
        minimumContentControl.value = '16000';
        minimumContentControl.dispatch('input');
        cotTokensControl.value = '8192';
        cotTokensControl.dispatch('input');
        answerPrefixControl.value = 'npc_list';
        answerPrefixControl.dispatch('input');

        assert.equal(context.extensionSettings.strict_prefill_bridge.enabled, true);
        assert.equal(context.extensionSettings.strict_prefill_bridge.mode, 'two-pass');
        assert.equal(context.extensionSettings.strict_prefill_bridge.prefix, '  <thinking>\nплан: 🧪\n');
        assert.equal(context.extensionSettings.strict_prefill_bridge.minimumContentCharacters, 16000);
        assert.equal(context.extensionSettings.strict_prefill_bridge.cotResponseTokens, 8192);
        assert.equal(context.extensionSettings.strict_prefill_bridge.answerPrefix, 'npc_list');
        assert.equal(savedSettings, 7);
        assert.equal(previewControl.textContent, '  <thinking>\nплан: 🧪\n');

        context.extensionSettings.strict_prefill_bridge.enabled = true;
        context.extensionSettings.strict_prefill_bridge.prefix = '<think>';
        context.extensionSettings.strict_prefill_bridge.answerPrefix = '';
        const twoPassMessages = [{ role: 'user', content: 'continue the scene' }];
        const twoPassPayload = {
            type: 'normal',
            chat_completion_source: 'vertexai',
            model: 'gemini-3.6-flash',
            messages: twoPassMessages,
        };

        await handlers.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY)[0](twoPassPayload);

        assert.equal(generateRawCalls.length, 1);
        assert.equal(generateRawCalls[0].responseLength, 8192);
        assert.match(generateRawCalls[0].systemPrompt, /reasoning engine/i);
        assert.match(generateRawCalls[0].prompt.at(-1).content, /Complete the thinking template/);
        assert.deepEqual(generateRawCalls[0].jsonSchema.value.properties.prefix.enum, ['<think>']);

        assert.equal(twoPassPayload.messages.length, 3);
        assert.deepEqual(twoPassMessages, twoPassPayload.messages);
        assert.equal(twoPassPayload.messages[1].role, 'assistant');
        assert.equal(twoPassPayload.messages[1].content, '<think>{1} surveyed the silent room\n{2} counted the exits\n</think>');
        assert.equal(twoPassPayload.messages[2].role, 'user');
        assert.equal(twoPassPayload.json_schema, undefined);
        assert.equal(twoPassPayload.include_reasoning, false);

        await handlers.get(eventTypes.MESSAGE_RECEIVED)[0](0);
        assert.equal(
            context.chat[0].mes,
            '<think>{1} surveyed the silent room\n{2} counted the exits\n</think>\nShe turned to the door.',
        );
        assert.equal(renderedMessages.at(-1).text, context.chat[0].mes);

        // Provider returns an empty structured object on the first attempt:
        // the extension retries once without the schema and still assembles the block.
        scriptedResponses.push('{}');
        const retryMessages = [{ role: 'user', content: 'retry the scene' }];
        const retryPayload = {
            type: 'normal',
            chat_completion_source: 'vertexai',
            model: 'gemini-3.6-flash',
            messages: retryMessages,
        };

        await handlers.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY)[0](retryPayload);

        assert.equal(generateRawCalls.length, 3);
        assert.notEqual(generateRawCalls[1].jsonSchema, undefined);
        assert.equal(generateRawCalls[2].jsonSchema, undefined);
        assert.equal(retryPayload.messages.length, 3);
        assert.equal(
            retryPayload.messages[1].content,
            '<think>{1} surveyed the silent room\n{2} counted the exits\n</think>',
        );
        assert.equal(retryPayload.json_schema, undefined);
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
