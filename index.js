const EXTENSION_ID = 'st-stream-helper';
const LEGACY_HISTORY_KEY = `${EXTENSION_ID}:history:v1`;
const SETTINGS_KEY = `${EXTENSION_ID}:settings:v1`;
const DEFAULT_HISTORY_LIMIT = 6;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 1000;
const FALLBACK_COUNT_COLOR = '#4f6bed';
const TARGET_PATH = '/api/backends/chat-completions/generate';
const PATCH_KEY = Symbol.for(`${EXTENSION_ID}:fetch-patch`);

let historyLimit = loadHistoryLimit();
let countColor = loadCountColor();
let history = [];
let panelOpen = false;
// Requests, responses, and their metadata stay in memory for the current page only.
const sessionRaw = new Map();

function normalizeHistoryLimit(value, fallback = DEFAULT_HISTORY_LIMIT) {
    if (value === '' || value === null || value === undefined) return fallback;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return fallback;
    return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, Math.trunc(numericValue)));
}

function loadHistoryLimit() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        return normalizeHistoryLimit(settings?.historyLimit);
    } catch (error) {
        console.warn('[酒馆流式助手] 无法读取自动清理设置。', error);
        return DEFAULT_HISTORY_LIMIT;
    }
}

function normalizeCountColor(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^#([\da-f]{6})$/i);
    return match ? `#${match[1].toLowerCase()}` : null;
}

function loadCountColor() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        return normalizeCountColor(settings?.countColor);
    } catch (error) {
        console.warn('[酒馆流式助手] 无法读取数字圈颜色设置。', error);
        return null;
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ historyLimit, countColor }));
    } catch (error) {
        console.warn('[酒馆流式助手] 无法保存插件设置。', error);
    }
}

function computedColorToHex(value) {
    const directHex = normalizeCountColor(value);
    if (directHex) return directHex;
    if (!value || !document.body || !globalThis.CSS?.supports?.('color', value)) return null;

    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = value;
    document.body.append(probe);
    const channels = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    probe.remove();
    if (!channels || channels.length !== 3 || channels.some(channel => !Number.isFinite(channel))) return null;
    return `#${channels.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
}

function themeCountColorForPicker() {
    const themeColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--SmartThemeQuoteColor')
        .trim();
    return computedColorToHex(themeColor) || FALLBACK_COUNT_COLOR;
}

function applyCountColor(button = document.getElementById(`${EXTENSION_ID}-button`)) {
    if (!button) return;
    if (countColor) {
        button.style.setProperty('--stsh-count-color', countColor);
    } else {
        button.style.removeProperty('--stsh-count-color');
    }
}

function clearLegacyHistory() {
    try {
        localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch (error) {
        console.warn('[酒馆流式助手] 无法清理旧版持久化记录。', error);
    }
}

function pruneSessionRaw() {
    const retainedIds = new Set(history.map(item => item.localId));
    for (const localId of sessionRaw.keys()) {
        if (!retainedIds.has(localId)) sessionRaw.delete(localId);
    }
}

function applyRetentionLimit() {
    history = history.slice(0, historyLimit);
    pruneSessionRaw();
}

function isTargetRequest(input) {
    try {
        const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        return new URL(rawUrl, location.href).pathname.endsWith(TARGET_PATH);
    } catch {
        return false;
    }
}

function readRequestedModel(input, init) {
    // SillyTavern 1.18.0 normally passes a JSON string in init.body. This function
    // extracts only its routing field; the separate raw copy is session-memory-only.
    const body = init?.body;
    if (typeof body !== 'string') return null;

    try {
        const data = JSON.parse(body);
        return firstString(data.model, data.custom_model, data.model_id, data.modelId);
    } catch {
        return null;
    }
}

function readRawRequestBody(init) {
    const body = init?.body;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return null;
}

function rawEntry(record) {
    if (!sessionRaw.has(record.localId)) {
        sessionRaw.set(record.localId, { request: null, responseChunks: [] });
    }
    return sessionRaw.get(record.localId);
}

function appendRawResponse(record, text) {
    if (!text) return;
    rawEntry(record).responseChunks.push(text);
}

function getRawResponse(record) {
    return rawEntry(record).responseChunks.join('');
}

function firstString(...values) {
    const value = values.find(item => typeof item === 'string' && item.trim());
    return value ? value.trim() : null;
}

function newRecord(requestedModel) {
    return {
        localId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requestedModel,
        responseId: null,
        contentModelCounts: {},
        streamModelCounts: {},
        finalUsageModel: null,
        usageSource: null,
        systemFingerprint: null,
        responseHeaders: {},
        eventCount: 0,
        parseErrors: 0,
        httpStatus: null,
        responseContentType: null,
        detectedResponseFormat: null,
        sawDoneMarker: false,
        abortRequested: false,
        error: null,
        state: 'running',
    };
}

function incrementCounter(counter, key) {
    if (!key) return;
    counter[key] = (counter[key] || 0) + 1;
}

function modelFromPayload(payload) {
    return firstString(
        payload?.model,
        payload?.message?.model,
        payload?.response?.model,
        payload?.data?.model,
    );
}

function idFromPayload(payload) {
    return firstString(
        payload?.id,
        payload?.message?.id,
        payload?.response?.id,
        payload?.data?.id,
    );
}

function hasGeneratedText(payload) {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    if (choices.some(choice => {
        const delta = choice?.delta || {};
        const message = choice?.message || {};
        return [delta.content, delta.reasoning_content, delta.reasoning, message.content]
            .some(value => typeof value === 'string' && value.length > 0);
    })) return true;

    if (payload?.type === 'content_block_delta') {
        const delta = payload?.delta || {};
        return [delta.text, delta.thinking, delta.partial_json]
            .some(value => typeof value === 'string' && value.length > 0);
    }

    return false;
}

function usageFromPayload(payload) {
    return payload?.usage || payload?.message?.usage || payload?.response?.usage || null;
}

function inspectPayload(record, payload) {
    if (!payload || typeof payload !== 'object') return;

    record.eventCount += 1;
    const model = modelFromPayload(payload);
    const responseId = idFromPayload(payload);
    const usage = usageFromPayload(payload);

    if (responseId) record.responseId = responseId;
    if (model) incrementCounter(record.streamModelCounts, model);
    if (model && hasGeneratedText(payload)) incrementCounter(record.contentModelCounts, model);

    if (usage) {
        if (model) record.finalUsageModel = model;
        record.usageSource = firstString(
            usage.usage_source,
            usage.source,
            usage.billing_usage?.source,
            usage.billing?.source,
        ) || record.usageSource;
    }

    record.systemFingerprint = firstString(
        payload.system_fingerprint,
        payload.message?.system_fingerprint,
        payload.response?.system_fingerprint,
    ) || record.systemFingerprint;
}

function readAllowedHeaders(response) {
    const names = [
        'x-request-id',
        'request-id',
        'cf-ray',
        'x-model',
        'x-model-id',
        'x-upstream-model',
        'x-ratelimit-model',
    ];
    const headers = {};
    for (const name of names) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
    }
    return headers;
}

function parseSseBlock(record, block) {
    const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n')
        .trim();

    if (!data) return;
    if (data === '[DONE]') {
        record.sawDoneMarker = true;
        return;
    }

    try {
        inspectPayload(record, JSON.parse(data));
    } catch {
        record.parseErrors += 1;
    }
}

function drainSseBlocks(record, parserState, flush = false) {
    // Preserve a trailing CR until the next network chunk arrives, because CRLF can
    // itself be split across chunks. Convert lone CR characters only at final flush.
    parserState.buffer = parserState.buffer.replace(/\r\n/g, '\n');
    if (flush) parserState.buffer = parserState.buffer.replace(/\r/g, '\n');

    let boundary;
    while ((boundary = parserState.buffer.indexOf('\n\n')) !== -1) {
        const block = parserState.buffer.slice(0, boundary);
        parserState.buffer = parserState.buffer.slice(boundary + 2);
        if (block.split('\n').some(line => line.startsWith('data:'))) {
            parserState.sawSse = true;
            parseSseBlock(record, block);
        }
    }

    if (flush && parserState.buffer.trim()) {
        const block = parserState.buffer;
        parserState.buffer = '';
        if (block.split('\n').some(line => line.startsWith('data:'))) {
            parserState.sawSse = true;
            parseSseBlock(record, block);
        }
    }
}

function inspectNonSsePayload(record, rawText) {
    const text = rawText.trim();
    if (!text) return 'empty';

    try {
        inspectPayload(record, JSON.parse(text));
        return 'json';
    } catch {
        record.parseErrors += 1;
        return 'unknown';
    }
}

async function inspectResponseBody(record, response) {
    if (!response.body) return { format: 'empty', readError: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parserState = { buffer: '', sawSse: false };
    let readError = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            const decoded = decoder.decode(value || new Uint8Array(), { stream: !done });
            appendRawResponse(record, decoded);
            parserState.buffer += decoded;
            drainSseBlocks(record, parserState);
            if (done) break;
        }
    } catch (error) {
        // An AbortController cancellation rejects the stream reader. The chunks already
        // delivered above remain available and must not be discarded.
        readError = error;
    } finally {
        try {
            const tail = decoder.decode();
            appendRawResponse(record, tail);
            parserState.buffer += tail;
        } catch {
            // No pending decoder bytes.
        }
        drainSseBlocks(record, parserState, true);
        reader.releaseLock();
    }

    const format = parserState.sawSse
        ? 'sse'
        : inspectNonSsePayload(record, getRawResponse(record));
    return { format, readError };
}

function finishRecord(record, state = 'complete') {
    record.finishedAt = new Date().toISOString();
    record.state = state;
    history = [record, ...history.filter(item => item.localId !== record.localId)];
    applyRetentionLimit();
    render();
}

function isAbortError(error, signal, record) {
    return Boolean(
        record.abortRequested
        || signal?.aborted
        || error?.name === 'AbortError'
        || /abort|cancel|终止|取消/i.test(String(error?.message || error || ''))
    );
}

async function inspectResponse(record, response, signal, removeAbortListener) {
    try {
        record.httpStatus = response.status;
        record.responseHeaders = readAllowedHeaders(response);
        record.responseContentType = response.headers.get('content-type') || null;

        const { format, readError } = await inspectResponseBody(record, response);
        record.detectedResponseFormat = format;

        if (readError) {
            throw readError;
        }

        if (format === 'empty') record.error = '响应正文为空';
        if (format === 'unknown') record.error = '响应不是可解析的 SSE 或 JSON';

        const wasAborted = record.abortRequested || signal?.aborted;
        finishRecord(record, wasAborted && !record.sawDoneMarker ? 'aborted' : (response.ok ? 'complete' : 'http-error'));
    } catch (error) {
        const wasAborted = isAbortError(error, signal, record);
        record.error = wasAborted
            ? '用户已终止请求；已保留终止前收到的原始回复'
            : (error instanceof Error ? error.message : String(error));
        finishRecord(record, wasAborted ? 'aborted' : 'inspect-error');
    } finally {
        removeAbortListener?.();
    }
}

function installFetchObserver() {
    if (window[PATCH_KEY]) return;

    const originalFetch = window.fetch.bind(window);
    window[PATCH_KEY] = { originalFetch };

    window.fetch = async function streamHelperFetch(input, init) {
        if (!isTargetRequest(input)) return originalFetch(input, init);

        const rawRequest = readRawRequestBody(init);
        const record = newRecord(readRequestedModel(input, init));
        rawEntry(record).request = rawRequest;
        history = [record, ...history];
        applyRetentionLimit();
        render();

        const signal = init?.signal;
        const onAbort = () => {
            record.abortRequested = true;
            render();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);

        try {
            const response = await originalFetch(input, init);
            void inspectResponse(record, response.clone(), signal, removeAbortListener);
            return response;
        } catch (error) {
            removeAbortListener();
            record.error = error instanceof Error ? error.message : String(error);
            finishRecord(record, isAbortError(error, signal, record) ? 'aborted' : 'request-error');
            throw error;
        }
    };
}

function sortedCounts(counter) {
    return Object.entries(counter || {}).sort((a, b) => b[1] - a[1]);
}

function normalizeModelForComparison(value) {
    const model = firstString(value);
    if (!model) return null;

    // Build a comparison key without changing the raw name shown to the user.
    // Normalize display variants, routing tags, provider paths, case, and separators.
    let candidate = model.normalize('NFKC').trim();
    candidate = candidate.replace(/^(?:\[[^\]\r\n]{1,32}\]\s*)+/, '').trim();

    const pathSegments = candidate.split('/').map(item => item.trim()).filter(Boolean);
    candidate = pathSegments[pathSegments.length - 1] || candidate;
    candidate = candidate.replace(/^(?:\[[^\]\r\n]{1,32}\]\s*)+/, '').trim();

    const tokens = candidate.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return tokens?.join(':') || candidate.toLowerCase() || model.toLowerCase();
}

function comparableModelCounts(counter) {
    const groupedCounts = new Map();
    for (const [model, count] of Object.entries(counter || {})) {
        const comparableModel = normalizeModelForComparison(model);
        if (!comparableModel) continue;
        groupedCounts.set(comparableModel, (groupedCounts.get(comparableModel) || 0) + count);
    }
    return [...groupedCounts.entries()].sort((a, b) => b[1] - a[1]);
}

function modelNamesEqual(left, right) {
    const comparableLeft = normalizeModelForComparison(left);
    const comparableRight = normalizeModelForComparison(right);
    return Boolean(comparableLeft && comparableRight && comparableLeft === comparableRight);
}

function verdictFor(record) {
    if (record.state === 'running') return { key: 'running', label: '接收中' };
    if (record.state === 'aborted') return { key: 'warning', label: '用户中止（已保留接收部分）' };
    if (record.state !== 'complete') return { key: 'error', label: '检查失败' };

    const contentModels = comparableModelCounts(record.contentModelCounts);
    const streamModels = comparableModelCounts(record.streamModelCounts);
    const evidenceModels = contentModels.length ? contentModels : streamModels;
    const primaryModel = evidenceModels[0]?.[0] || null;
    const anomalies = [];

    if (!primaryModel) anomalies.push('响应未报告模型');
    if (contentModels.length > 1) anomalies.push('正文分片模型混杂');
    if (record.requestedModel && primaryModel && !modelNamesEqual(record.requestedModel, primaryModel)) {
        anomalies.push('请求模型与正文模型不同');
    }
    if (record.finalUsageModel && primaryModel && !modelNamesEqual(record.finalUsageModel, primaryModel)) {
        anomalies.push('最终 usage 标记与正文模型不同');
    }

    if (anomalies.length) return { key: 'warning', label: anomalies.join('；') };
    return { key: 'ok', label: '接口报告一致' };
}

function formatTime(value) {
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).format(new Date(value));
    } catch {
        return value || '—';
    }
}

function addText(parent, className, text) {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
}

function countText(counter) {
    const entries = sortedCounts(counter);
    return entries.length ? entries.map(([model, count]) => `${model} × ${count}`).join('，') : '未报告';
}

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('浏览器拒绝了剪贴板操作');
}

function makeCopyButton(label, textProvider, unavailableReason) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stsh-copy-button';
    button.textContent = label;
    const initialText = textProvider();
    button.disabled = typeof initialText !== 'string';
    if (button.disabled && unavailableReason) button.title = unavailableReason;

    button.addEventListener('click', async () => {
        const text = textProvider();
        if (typeof text !== 'string') return;
        const originalLabel = button.textContent;
        try {
            await copyText(text);
            button.textContent = '已复制';
        } catch (error) {
            console.error('[酒馆流式助手] 复制失败。', error);
            button.textContent = '复制失败';
        }
        setTimeout(() => { button.textContent = originalLabel; }, 1400);
    });

    return button;
}

function buildRecordCard(record) {
    const card = document.createElement('article');
    card.className = 'stsh-card';
    const verdict = verdictFor(record);

    const header = document.createElement('div');
    header.className = 'stsh-card-header';
    addText(header, 'stsh-time', formatTime(record.startedAt));
    addText(header, `stsh-status stsh-status-${verdict.key}`, verdict.label);
    card.append(header);

    const rows = [
        ['请求模型', record.requestedModel || '未读取到'],
        ['正文分片报告', countText(record.contentModelCounts)],
        ['全部分片报告', countText(record.streamModelCounts)],
        ['最终 usage 模型', record.finalUsageModel || '未报告'],
        ['回复 ID', record.responseId || '未报告'],
        ['事件数 / 解析错误', `${record.eventCount} / ${record.parseErrors}`],
        ['响应格式', record.detectedResponseFormat || '未确定'],
    ];

    if (record.responseContentType) rows.push(['Content-Type', record.responseContentType]);
    if (record.usageSource) rows.push(['计费来源', record.usageSource]);
    if (record.systemFingerprint) rows.push(['系统指纹', record.systemFingerprint]);
    if (Object.keys(record.responseHeaders || {}).length) {
        rows.push(['响应头', Object.entries(record.responseHeaders).map(([key, value]) => `${key}: ${value}`).join('；')]);
    }
    if (record.error) rows.push(['错误', record.error]);

    const table = document.createElement('dl');
    table.className = 'stsh-rows';
    for (const [label, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        table.append(dt, dd);
    }
    card.append(table);

    const raw = sessionRaw.get(record.localId);
    const copyActions = document.createElement('div');
    copyActions.className = 'stsh-copy-actions';
    const replyButtonLabel = record.state === 'aborted'
        ? '复制已接收原始回复'
        : record.state === 'running'
            ? '复制当前原始回复'
            : '复制完整原始回复';
    copyActions.append(
        makeCopyButton(
            '复制完整原始输入',
            () => raw?.request ?? null,
            '完整输入仅保留在生成发生的当前页面；刷新后不可恢复。',
        ),
        makeCopyButton(
            replyButtonLabel,
            () => raw?.responseChunks?.length ? getRawResponse(record) : null,
            '尚未收到任何响应内容，或内容已随页面刷新清除。',
        ),
    );
    card.append(copyActions);
    return card;
}

function ensureUi() {
    if (document.getElementById(`${EXTENSION_ID}-button`)) return;

    const button = document.createElement('button');
    button.id = `${EXTENSION_ID}-button`;
    button.type = 'button';
    button.title = '查看模型路由记录';
    button.setAttribute('aria-label', '查看模型路由记录');
    button.innerHTML = '<span class="stsh-button-label">流式</span><span class="stsh-button-count">0</span>';
    button.addEventListener('click', () => {
        panelOpen = !panelOpen;
        render();
    });

    const panel = document.createElement('aside');
    panel.id = `${EXTENSION_ID}-panel`;
    panel.setAttribute('aria-label', '酒馆流式助手');

    document.body.append(button, panel);
}

function downloadHistory() {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sillytavern-stream-helper-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function render() {
    ensureUi();
    const button = document.getElementById(`${EXTENSION_ID}-button`);
    const panel = document.getElementById(`${EXTENSION_ID}-panel`);
    if (!button || !panel) return;

    applyCountColor(button);
    button.querySelector('.stsh-button-count').textContent = String(history.length);
    panel.classList.toggle('stsh-open', panelOpen);
    panel.replaceChildren();

    const heading = document.createElement('header');
    heading.className = 'stsh-panel-header';
    const titleWrap = document.createElement('div');
    addText(titleWrap, 'stsh-title', '酒馆流式助手');
    addText(titleWrap, 'stsh-subtitle', 'SillyTavern 1.18.0 · 记录与原文仅存当前页面内存');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stsh-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => {
        panelOpen = false;
        render();
    });
    heading.append(titleWrap, close);

    const actions = document.createElement('div');
    actions.className = 'stsh-actions';
    const retentionControl = document.createElement('label');
    retentionControl.className = 'stsh-retention-control';
    const retentionPrefix = document.createElement('span');
    retentionPrefix.textContent = '保留最近';
    const retentionInput = document.createElement('input');
    retentionInput.type = 'number';
    retentionInput.min = String(MIN_HISTORY_LIMIT);
    retentionInput.max = String(MAX_HISTORY_LIMIT);
    retentionInput.step = '1';
    retentionInput.value = String(historyLimit);
    retentionInput.title = `可设置 ${MIN_HISTORY_LIMIT}–${MAX_HISTORY_LIMIT} 条`;
    retentionInput.setAttribute('aria-label', '自动保留的记录数量');
    retentionInput.addEventListener('change', () => {
        historyLimit = normalizeHistoryLimit(retentionInput.value, historyLimit);
        saveSettings();
        applyRetentionLimit();
        render();
    });
    const retentionSuffix = document.createElement('span');
    retentionSuffix.textContent = '条记录';
    retentionControl.append(retentionPrefix, retentionInput, retentionSuffix);

    const colorControl = document.createElement('label');
    colorControl.className = 'stsh-color-control';
    const colorLabel = document.createElement('span');
    colorLabel.textContent = '数字圈颜色';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = countColor || themeCountColorForPicker();
    colorInput.setAttribute('aria-label', '选择数字圈自定义颜色');
    const colorMode = document.createElement('span');
    colorMode.className = 'stsh-color-mode';
    const resetColorButton = document.createElement('button');
    resetColorButton.type = 'button';
    resetColorButton.className = 'stsh-reset-color';
    resetColorButton.textContent = '恢复主题色';

    const updateColorControl = () => {
        const usingCustomColor = Boolean(countColor);
        colorMode.textContent = usingCustomColor ? '自定义' : '主题';
        colorInput.title = usingCustomColor
            ? `当前自定义颜色：${countColor}`
            : '当前跟随 SillyTavern 主题色';
        resetColorButton.disabled = !usingCustomColor;
        resetColorButton.title = usingCustomColor ? '改回跟随 SillyTavern 主题色' : '当前已跟随主题色';
    };

    const selectCountColor = () => {
        const selectedColor = normalizeCountColor(colorInput.value);
        if (!selectedColor) return;
        countColor = selectedColor;
        applyCountColor(button);
        updateColorControl();
    };

    colorInput.addEventListener('input', selectCountColor);
    colorInput.addEventListener('change', () => {
        selectCountColor();
        saveSettings();
    });
    resetColorButton.addEventListener('click', () => {
        countColor = null;
        saveSettings();
        applyCountColor(button);
        colorInput.value = themeCountColorForPicker();
        updateColorControl();
    });
    updateColorControl();
    colorControl.append(colorLabel, colorInput, colorMode);

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = '导出 JSON';
    exportButton.disabled = history.length === 0;
    exportButton.addEventListener('click', downloadHistory);
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = '清空记录';
    clearButton.disabled = history.length === 0;
    clearButton.addEventListener('click', () => {
        if (!confirm('清空酒馆流式助手的本地记录？')) return;
        history = [];
        sessionRaw.clear();
        render();
    });
    actions.append(retentionControl, colorControl, resetColorButton, exportButton, clearButton);

    const list = document.createElement('div');
    list.className = 'stsh-list';
    if (history.length === 0) {
        addText(list, 'stsh-empty', '尚无记录。下一次聊天补全请求会自动出现在这里。');
    } else {
        history.forEach(record => list.append(buildRecordCard(record)));
    }

    panel.append(heading, actions, list);
}

function init() {
    clearLegacyHistory();
    applyRetentionLimit();
    saveSettings();
    installFetchObserver();
    render();
    console.info('[酒馆流式助手] 已启用；请求记录、完整输入与原始回复仅在当前页面内存中临时保存。');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
