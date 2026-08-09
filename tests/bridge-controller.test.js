import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeController } from '../src/bridge-controller.js';

function makeHarness(overrides = {}) {
    const calls = { warnings: [], renders: [] };
    const settings = overrides.settings ?? {
        enabled: true,
        prefix: '<think>',
    };
    const context = {
        chat: overrides.chat ?? [],
        updateMessageBlock: (messageId, message) => calls.renders.push({ messageId, text: message.mes }),
    };
    const controller = createBridgeController({
        getContext: () => context,
        getSettings: () => settings,
        notifyWarning: message => calls.warnings.push(message),
    });

    return { calls, context, controller, settings };
}

test('Gemini normal generation receives enum schema without changing prompt or thinking settings', () => {
    const { controller } = makeHarness();
    const messages = [{ role: 'user', content: 'hello' }];
    const payload = {
        type: 'normal',
        chat_completion_source: 'makersuite',
        model: 'gemini-3.6-flash',
        reasoning_effort: 'low',
        thinkingLevel: 'low',
        temperature: 1,
        messages,
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.strictEqual(payload.messages, messages);
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.thinkingLevel, 'low');
    assert.deepEqual(payload.json_schema.value.properties.prefix.enum, ['<think>']);
    assert.equal(controller.getSnapshot().mode, 'gemini-enum');
});

test('OpenRouter swipe uses regex schema and does not append a hidden user message', () => {
    const { controller } = makeHarness();
    const payload = {
        type: 'swipe',
        chat_completion_source: 'openrouter',
        model: 'anthropic/claude-opus-4.6',
        messages: [{ role: 'user', content: 'hello' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
    assert.match(payload.json_schema.value.properties.response.pattern, /^\^\(\?:<think>/);
});

test('Continue requires a fresh prefix and appends it to the current message', () => {
    const chat = [{
        is_user: false,
        mes: 'The lantern went dark.',
        swipe_id: 0,
        swipes: ['The lantern went dark.'],
    }];
    const { controller } = makeHarness({ chat });
    const payload = {
        type: 'continue',
        chat_completion_source: 'vertexai',
        model: 'gemini-3.6-flash',
        messages: [{ role: 'assistant', content: 'The lantern went dark.' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.deepEqual(payload.json_schema.value.properties.prefix.enum, ['<think>']);
    assert.equal(
        controller.onStream('{"prefix":"<think>","content":" Then footsteps followed."}'),
        'The lantern went dark.<think> Then footsteps followed.',
    );
});

test('unsupported, conflicting, disabled, and background requests remain untouched', () => {
    const unsupported = makeHarness();
    const directClaude = {
        type: 'normal',
        chat_completion_source: 'claude',
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'hello' }],
    };
    assert.equal(unsupported.controller.onSettingsReady(directClaude), false);
    assert.equal(directClaude.json_schema, undefined);
    assert.equal(unsupported.calls.warnings.length, 1);

    const conflict = makeHarness();
    const existingSchema = { name: 'existing' };
    const conflictPayload = {
        type: 'normal',
        chat_completion_source: 'openai',
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hello' }],
        json_schema: existingSchema,
    };
    assert.equal(conflict.controller.onSettingsReady(conflictPayload), false);
    assert.strictEqual(conflictPayload.json_schema, existingSchema);

    const disabled = makeHarness({ settings: { enabled: false, prefix: '<think>' } });
    const disabledPayload = { type: 'normal', chat_completion_source: 'openai', model: 'gpt-5.4', messages: [] };
    assert.equal(disabled.controller.onSettingsReady(disabledPayload), false);

    const quiet = makeHarness();
    const quietPayload = { type: 'quiet', chat_completion_source: 'openai', model: 'gpt-5.4', messages: [] };
    assert.equal(quiet.controller.onSettingsReady(quietPayload), false);
});

test('final decoded text replaces raw JSON in message and active swipe', () => {
    const chat = [{
        is_user: false,
        mes: '{"prefix":"<think>","content":"answer"}',
        swipe_id: 1,
        swipes: ['old', '{"prefix":"<think>","content":"answer"}'],
    }];
    const { calls, controller } = makeHarness({ chat });
    controller.onSettingsReady({
        type: 'regenerate',
        chat_completion_source: 'makersuite',
        model: 'gemini-3.6-flash',
        messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(controller.onMessageReceived(0), '<think>answer');
    assert.equal(chat[0].mes, '<think>answer');
    assert.equal(chat[0].swipes[1], '<think>answer');
    assert.deepEqual(calls.renders, [{ messageId: 0, text: '<think>answer' }]);
    assert.equal(controller.getSnapshot().active, false);
});

test('a malformed or prefix-violating response is never applied as chat text', () => {
    const chat = [{
        is_user: false,
        mes: '{"prefix":"wrong","content":"answer"}',
        swipe_id: 0,
        swipes: ['{"prefix":"wrong","content":"answer"}'],
    }];
    const { calls, controller } = makeHarness({ chat });
    controller.onSettingsReady({
        type: 'normal',
        chat_completion_source: 'makersuite',
        model: 'gemini-3.6-flash',
        messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(controller.onMessageReceived(0), null);
    assert.deepEqual(calls.renders, []);
});
