import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCotInstruction,
    buildNudgeInstruction,
    buildStructuredSchema,
    deriveEnderTag,
    finalizeThinkBlock,
    getProviderMode,
    isEligibleGenerationType,
    normalizeCotResponseTokens,
    normalizeMode,
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
                        description: 'Continue the response immediately after the required prefix. Inside every <info> HTML tracker, output __SP_DQ__ instead of each double-quote character and preserve existing __SP_DQ__ tokens exactly. Never output a literal double quote inside an <info> tracker.',
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

test('Gemini HTML survives unescaped quotes inside a malformed streamed JSON string', () => {
    const state = { mode: 'split-enum', expectedPrefix: '<think>', baseText: '', generationType: 'normal' };
    const raw = '{"prefix":"<think>","content":"<info><span style="color:#a6b1e1">clock</span> | <span style="color:#fff">next</span>"}';

    assert.equal(
        unwrapStructuredOutput(raw, state),
        '<think><info><span style="color:#a6b1e1">clock</span> | <span style="color:#fff">next</span>',
    );
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

    assert.equal(normalizePrefix('  <thinking>\nплан: 🧠\n'), '  <thinking>\nплан: 🧠\n');
});

test('ender tags are derived only from complete opening tags', () => {
    assert.equal(deriveEnderTag('<think>'), '</think>');
    assert.equal(deriveEnderTag('<thinking>'), '</thinking>');
    assert.equal(deriveEnderTag('<plan attr="x">'), '</plan>');
    assert.equal(deriveEnderTag('Plan: '), '');
    assert.equal(deriveEnderTag(''), '');
});

test('mode and CoT token settings are normalized with safe bounds', () => {
    assert.equal(normalizeMode('two-pass'), 'two-pass');
    assert.equal(normalizeMode('schema-only'), 'schema-only');
    assert.equal(normalizeMode(undefined), 'two-pass');
    assert.equal(normalizeMode('garbage'), 'two-pass');

    assert.equal(normalizeCotResponseTokens('8192'), 8192);
    assert.equal(normalizeCotResponseTokens(512), 1024);
    assert.equal(normalizeCotResponseTokens(1000000), 65536);
    assert.equal(normalizeCotResponseTokens('abc'), 16384);
});

test('pass instructions reference the prefix, the closing tag, and the answer start', () => {
    const cot = buildCotInstruction('<think>');
    assert.match(cot, /<think>/);
    assert.match(cot, /<\/think>/);
    assert.match(cot, /without skipping, merging, or summarizing/i);
    assert.match(cot, /terse one-line fill-ins/i);
    assert.match(cot, /Stop immediately after/);

    const plainNudge = buildNudgeInstruction('');
    assert.match(plainNudge, /\[System\]/);
    assert.doesNotMatch(plainNudge, /Begin the reply with/);

    const forcedNudge = buildNudgeInstruction('npc_list');
    assert.match(forcedNudge, /Begin the reply with: npc_list/);
});

test('finalizeThinkBlock turns pass-one output into a closed thinking block', () => {
    assert.equal(
        finalizeThinkBlock('{"prefix":"<think>","content":"{1} ok\\n{2} ok"}', '<think>'),
        '<think>{1} ok\n{2} ok\n</think>',
    );
    assert.equal(
        finalizeThinkBlock('```json\n{"prefix":"<think>","content":"{1} ok"}\n```', '<think>'),
        '<think>{1} ok\n</think>',
    );
    assert.equal(
        finalizeThinkBlock('<think>{1} surveyed the room', '<think>'),
        '<think>{1} surveyed the room\n</think>',
    );
    assert.equal(
        finalizeThinkBlock('<think>{1} ok</think>\nFinal answer leaks here', '<think>'),
        '<think>{1} ok</think>',
    );
    assert.equal(
        finalizeThinkBlock('{1} ok</think>', '<think>'),
        '<think>\n{1} ok</think>',
    );
    assert.equal(
        finalizeThinkBlock('Plan: inspect the door', 'Plan: '),
        'Plan: inspect the door',
    );
    assert.equal(finalizeThinkBlock('', '<think>'), null);
    assert.equal(finalizeThinkBlock(null, '<think>'), null);
    assert.equal(finalizeThinkBlock('<think>   ', '<think>'), null);
});
