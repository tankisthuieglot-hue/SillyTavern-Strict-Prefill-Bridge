import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildStructuredSchema,
    getProviderMode,
    isEligibleGenerationType,
    normalizePrefix,
    unwrapStructuredOutput,
} from '../src/bridge-core.js';

test('Google AI and Vertex force the exact prefix with an enum before content', () => {
    for (const source of ['makersuite', 'vertexai']) {
        const schema = buildStructuredSchema({
            source,
            model: 'gemini-3.6-flash',
            prefix: '  <thinking>\n',
        });

        assert.deepEqual(schema, {
            name: 'strict_prefill_response',
            description: 'A response with an exact required prefix followed by the continuation.',
            strict: true,
            value: {
                type: 'object',
                propertyOrdering: ['prefix', 'content'],
                properties: {
                    prefix: {
                        type: 'string',
                        enum: ['  <thinking>\n'],
                    },
                    content: {
                        type: 'string',
                        description: 'Continue the response immediately after the required prefix.',
                    },
                },
                required: ['prefix', 'content'],
                additionalProperties: false,
            },
        });
        assert.equal(schema.value.properties.prefix.pattern, undefined);
    }
});

test('OpenAI-style providers force the prefix in the generated response string', () => {
    const schema = buildStructuredSchema({
        source: 'openrouter',
        model: 'anthropic/claude-opus-4.6',
        prefix: '<think>\nA+B?',
    });

    assert.equal(schema.value.properties.response.type, 'string');
    assert.equal(schema.value.properties.response.pattern, '^(?:<think>\\nA\\+B\\?)(?:.|\\n)+$');
    assert.deepEqual(schema.value.required, ['response']);
});

test('provider routing uses Gemini enum mode and rejects sources that only fake schemas', () => {
    assert.equal(getProviderMode('makersuite', 'gemini-3.6-flash'), 'split-enum');
    assert.equal(getProviderMode('vertexai', 'gemini-3.6-flash'), 'split-enum');
    assert.equal(getProviderMode('openrouter', 'google/gemini-3.6-flash'), 'split-enum');
    assert.equal(getProviderMode('nanogpt', 'anthropic/claude-opus-4.6'), 'split-enum');
    assert.equal(getProviderMode('openrouter', 'anthropic/claude-opus-4.6'), 'regex');
    assert.equal(getProviderMode('openai', 'gpt-5.4'), 'regex');
    assert.equal(getProviderMode('claude', 'claude-opus-4.6'), null);
    assert.equal(getProviderMode('deepseek', 'deepseek-chat'), null);
});

test('streaming Gemini JSON is unwrapped only after the exact enum prefix is present', () => {
    const state = { mode: 'split-enum', expectedPrefix: '<think>', baseText: '', overlap: '' };

    assert.equal(unwrapStructuredOutput('{"prefix":"<thi', state), null);
    assert.equal(unwrapStructuredOutput('{"prefix":"<think>","content":"plan\\nstep', state), '<think>plan\nstep');
    assert.equal(unwrapStructuredOutput('{"prefix":"wrong","content":"plan"}', state), null);
    assert.equal(unwrapStructuredOutput('{"prefix":"<think>","content":"done"}', state), '<think>done');
});

test('streaming regex JSON never exposes a response that diverges from the prefix', () => {
    const state = { mode: 'regex', expectedPrefix: '<think>', baseText: '', overlap: '' };

    assert.equal(unwrapStructuredOutput('{"response":"<thi', state), '<thi');
    assert.equal(unwrapStructuredOutput('{"response":"<think>work', state), '<think>work');
    assert.equal(unwrapStructuredOutput('{"response":"Sorry', state), null);
});

test('Continue appends a newly prefixed response to the existing message', () => {
    const baseText = 'The lantern went dark.';
    const state = { mode: 'split-enum', expectedPrefix: '<think>', baseText, generationType: 'continue' };
    const raw = '{"prefix":"<think>","content":" Then footsteps followed."}';
    assert.equal(
        unwrapStructuredOutput(raw, state),
        'The lantern went dark.<think> Then footsteps followed.',
    );
});

test('only visible assistant generations are eligible and prefix text stays exact', () => {
    for (const type of ['normal', 'regenerate', 'swipe', 'continue']) {
        assert.equal(isEligibleGenerationType(type), true);
    }
    for (const type of ['quiet', 'impersonate', undefined]) {
        assert.equal(isEligibleGenerationType(type), false);
    }

    assert.equal(normalizePrefix('  <thinking>\nплан: 🧪\n'), '  <thinking>\nплан: 🧪\n');
});
