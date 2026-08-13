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
        max_tokens: 30000,
        temperature: 1,
        messages,
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.strictEqual(payload.messages, messages);
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.thinkingLevel, 'low');
    assert.equal(payload.max_tokens, 30000);
    assert.deepEqual(payload.json_schema.value.properties.prefix.enum, ['<think>']);
    assert.equal(controller.getSnapshot().mode, 'split-enum');
});

test('Kiro-style emulation sends assistant prefill followed by hidden Continue', () => {
    const { controller } = makeHarness({
        settings: {
            enabled: true,
            prefix: '<think>',
            prefillFirstCot: true,
        },
    });
    const payload = {
        type: 'normal',
        chat_completion_source: 'makersuite',
        model: 'gemini-3.1-pro',
        reasoning_effort: 'max',
        include_reasoning: true,
        thinkingLevel: 'high',
        max_tokens: 30000,
        messages: [{ role: 'user', content: 'hello' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.deepEqual(payload.messages, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '<think>' },
        { role: 'user', content: 'Continue' },
    ]);
    assert.equal(payload.json_schema, undefined);
    assert.equal(controller.getSnapshot().mode, 'history-continue');
    assert.equal(controller.onStream('plan\nstep'), '<think>plan\nstep');
    assert.equal(payload.reasoning_effort, 'max');
    assert.equal(payload.include_reasoning, true);
    assert.equal(payload.thinkingLevel, 'high');
    assert.equal(payload.max_tokens, 30000);
});

test('Kiro-style emulation also works on a direct Claude route unsupported by schema mode', () => {
    const { controller } = makeHarness({
        settings: {
            enabled: true,
            prefix: '<thinking>',
            prefillFirstCot: true,
        },
    });
    const payload = {
        type: 'swipe',
        chat_completion_source: 'claude',
        model: 'claude-opus-4.6',
        assistant_prefill: '<thinking>',
        messages: [{ role: 'user', content: 'hello' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.deepEqual(payload.messages, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '<thinking>' },
        { role: 'user', content: 'Continue' },
    ]);
    assert.equal(payload.assistant_prefill, undefined);
    assert.equal(payload.json_schema, undefined);
    assert.equal(controller.onStream('<thinking>already echoed'), '<thinking>already echoed');
});

test('Kiro-style Continue merges the prefix into trailing assistant history without duplicating chat text', () => {
    const chat = [{
        is_user: false,
        mes: 'The lantern went dark.',
        swipe_id: 0,
        swipes: ['The lantern went dark.'],
    }];
    const { controller } = makeHarness({
        chat,
        settings: {
            enabled: true,
            prefix: '<think>',
            prefillFirstCot: true,
        },
    });
    const payload = {
        type: 'continue',
        chat_completion_source: 'vertexai',
        model: 'gemini-3.6-flash',
        messages: [{ role: 'assistant', content: 'The lantern went dark.' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.deepEqual(payload.messages, [
        { role: 'assistant', content: 'The lantern went dark.<think>' },
        { role: 'user', content: 'Continue' },
    ]);
    assert.equal(
        controller.onStream(' Then footsteps followed.'),
        'The lantern went dark.<think> Then footsteps followed.',
    );
});

test('Gemini can require a configurable minimum content length after the prefix', () => {
    const { controller } = makeHarness({
        settings: {
            enabled: true,
            prefix: '<think>',
            minimumContentCharacters: 16000,
        },
    });
    const payload = {
        type: 'normal',
        chat_completion_source: 'vertexai',
        model: 'gemini-3.6-flash',
        max_tokens: 30000,
        messages: [{ role: 'user', content: 'generate the tracker' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.equal(payload.json_schema.value.properties.content.minLength, 16000);
    assert.equal(payload.max_tokens, 30000);
});

test('Vertex protects HTML tracker quotes on the wire and restores them in the decoded reply', () => {
    const { controller } = makeHarness();
    const messages = [{
        role: 'system',
        content: '<info><span style="font-family: \'Courier New\'; color:#a6b1e1">clock</span></info> Say "hello".',
    }];
    const payload = {
        type: 'normal',
        chat_completion_source: 'vertexai',
        model: 'gemini-3.6-flash',
        messages,
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.equal(
        payload.messages[0].content,
        '<info><span style=__SP_DQ__font-family: \'Courier New\'; color:#a6b1e1__SP_DQ__>clock</span></info> Say "hello".',
    );
    assert.match(payload.json_schema.value.properties.content.description, /__SP_DQ__/);
    assert.equal(
        controller.onStream('{"prefix":"<think>","content":"<info><span style=__SP_DQ__color:#a6b1e1__SP_DQ__>clock</span></info>"}'),
        '<think><info><span style="color:#a6b1e1">clock</span></info>',
    );
});

test('Vertex protects quotes throughout an info tracker without changing surrounding dialogue', () => {
    const { controller } = makeHarness();
    const payload = {
        type: 'normal',
        chat_completion_source: 'vertexai',
        model: 'gemini-3.6-flash',
        messages: [{
            role: 'system',
            content: '<info><style>.label{font-family:"Arial"}</style><div title="status">"ready"</div></info> Dialogue "unchanged".',
        }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.equal(
        payload.messages[0].content,
        '<info><style>.label{font-family:__SP_DQ__Arial__SP_DQ__}</style><div title=__SP_DQ__status__SP_DQ__>__SP_DQ__ready__SP_DQ__</div></info> Dialogue "unchanged".',
    );
});

test('NanoGPT uses an enum prefix schema instead of an unsupported regex pattern', () => {
    const { controller } = makeHarness();
    const payload = {
        type: 'normal',
        chat_completion_source: 'nanogpt',
        model: 'anthropic/claude-opus-4.6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: 'hello' }],
    };

    assert.equal(controller.onSettingsReady(payload), true);
    assert.deepEqual(payload.json_schema.value.properties?.prefix?.enum, ['<think>']);
    assert.equal(payload.json_schema.value.properties?.response, undefined);
    assert.equal(payload.max_tokens, 8000);
    assert.equal(controller.getSnapshot().mode, 'split-enum');
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
