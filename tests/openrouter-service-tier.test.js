import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: jest.fn(() => 'sk-openrouter-test'),
    SECRET_KEYS: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));
jest.unstable_mockModule('../src/users.js', () => ({
    getCookieSecret: jest.fn(),
}));
jest.unstable_mockModule('../src/endpoints/tokenizers.js', () => ({
    getTokenizerModel: jest.fn(),
    getSentencepiceTokenizer: jest.fn(),
    getTiktokenTokenizer: jest.fn(),
    sentencepieceTokenizers: [],
    TEXT_COMPLETION_MODELS: [],
    webTokenizers: [],
    getWebTokenizer: jest.fn(),
}));
jest.unstable_mockModule('../src/endpoints/google.js', () => ({
    getVertexAIAuth: jest.fn(),
    getProjectIdFromServiceAccount: jest.fn(),
}));
jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    tryParse: (str) => { try { return JSON.parse(str); } catch { return undefined; } },
    uuidv4: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
    forwardFetchResponse: jest.fn(),
    mergeObjectWithYaml: jest.fn(),
    excludeKeysByYaml: jest.fn(),
    color: new Proxy({}, { get: () => (value) => value }),
    trimTrailingSlash: (value) => String(value ?? '').replace(/\/+$/, ''),
    flattenSchema: jest.fn((value) => value),
}));
jest.unstable_mockModule('../src/endpoints/backends/google-models.js', () => {
    class GoogleModelsHttpError extends Error { }
    return {
        fetchGoogleModels: jest.fn(),
        GoogleModelsHttpError,
    };
});

/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {() => any} */
let getOpenRouterServiceTier;

beforeAll(async () => {
    const express = (await import('express')).default;
    const backends = await import('../src/endpoints/backends/chat-completions.js');
    getOpenRouterServiceTier = backends.getOpenRouterServiceTier;

    const app = express();
    app.use(express.json());
    app.use('/api/backends/chat-completions', (request, _response, next) => {
        // The real server injects the user via middleware; emulate it here
        request.user = { directories: 'test' };
        next();
    }, backends.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

/**
 * Sends a chat completion generate request to the OpenRouter backend.
 * @param {object} extraFields Additional request body fields
 * @returns {Promise<{status: number, body: any, upstreamBody: any}>} Response and captured upstream body
 */
async function generateWith(extraFields) {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ choices: [{ message: { content: 'ok' } }], service_tier: 'flex' }),
        text: async () => '',
    }));

    const responseBody = await fetch(`${baseUrl}/api/backends/chat-completions/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_completion_source: 'openrouter',
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'openai/gpt-5',
            temperature: 1,
            max_tokens: 100,
            stream: false,
            ...extraFields,
        }),
    });
    const body = await responseBody.json();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, config] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const upstreamBody = JSON.parse(config.body);

    return { status: responseBody.status, body, upstreamBody };
}

describe('OpenRouter service tier', () => {
    describe('getOpenRouterServiceTier validation', () => {
        test('accepts supported tiers', () => {
            expect(getOpenRouterServiceTier('flex')).toBe('flex');
            expect(getOpenRouterServiceTier('priority')).toBe('priority');
            expect(getOpenRouterServiceTier('fast')).toBe('fast');
            expect(getOpenRouterServiceTier('default')).toBe('default');
        });

        test('normalizes casing and whitespace', () => {
            expect(getOpenRouterServiceTier(' FLEX ')).toBe('flex');
            expect(getOpenRouterServiceTier('Priority')).toBe('priority');
        });

        test('rejects unknown tiers', () => {
            expect(getOpenRouterServiceTier('super-tier')).toBeNull();
            expect(getOpenRouterServiceTier('standard')).toBeNull();
        });

        test('rejects empty and missing values', () => {
            expect(getOpenRouterServiceTier('')).toBeNull();
            expect(getOpenRouterServiceTier(null)).toBeNull();
            expect(getOpenRouterServiceTier(undefined)).toBeNull();
        });
    });

    describe('generate passthrough', () => {
        test('forwards a valid service tier to the upstream request', async () => {
            const { status, upstreamBody } = await generateWith({ service_tier: 'flex' });

            expect(status).toBe(200);
            expect(upstreamBody.service_tier).toBe('flex');
        });

        test('normalizes casing of the service tier', async () => {
            const { upstreamBody } = await generateWith({ service_tier: 'FLEX' });

            expect(upstreamBody.service_tier).toBe('flex');
        });

        test('accepts the priority and fast tiers', async () => {
            const { upstreamBody: priorityBody } = await generateWith({ service_tier: 'priority' });
            const { upstreamBody: fastBody } = await generateWith({ service_tier: 'fast' });

            expect(priorityBody.service_tier).toBe('priority');
            expect(fastBody.service_tier).toBe('fast');
        });

        test('omits the service tier when not requested', async () => {
            const { upstreamBody } = await generateWith({});

            expect(Object.hasOwn(upstreamBody, 'service_tier')).toBe(false);
        });

        test('omits the service tier when the value is invalid', async () => {
            const { upstreamBody } = await generateWith({ service_tier: 'super-tier' });

            expect(Object.hasOwn(upstreamBody, 'service_tier')).toBe(false);
        });
    });
});
