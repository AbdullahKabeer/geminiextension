/**
 * GeminiPilot 3 - Enhanced Side Panel Brain & State Manager
 * Advanced agent with task planning, memory, and intelligent error recovery
 */

// ==================== STATE ====================
let isRunning = false;
let isPaused = false;
let conversationHistory = [];
let actionHistory = []; // Track all actions taken
let currentTabId = null;
let lastError = null;
let consecutiveErrors = 0;
let currentPlan = []; // Multi-step plan
let collectedItems = []; // Data collection list
let managedTabs = []; // Track all tabs we're working with
let waitingForInput = false;
let inputResolver = null;

// ==================== DOM ELEMENTS ====================
const apiKeyInput = document.getElementById('apiKey');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const chatHistory = document.getElementById('chatHistory');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const logsDiv = document.getElementById('logs');
const clearLogsBtn = document.getElementById('clearLogsBtn');

const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const logCountEl = document.getElementById('logCount');
const screenshotPreview = document.getElementById('screenshotPreview');
const screenshotImg = document.getElementById('screenshotImg');
const toggleScreenshotBtn = document.getElementById('toggleScreenshot');
const exportBtn = document.getElementById('exportBtn');
const templateBtns = document.querySelectorAll('.template-btn');
const logsContainer = document.getElementById('logsContainer');
const logsHeader = document.getElementById('logsHeader');
const screenshotPlaceholder = document.getElementById('screenshotPlaceholder');
const openLogsBtn = document.getElementById('openLogsBtn');
const logsModal = document.getElementById('logsModal');
const closeLogsBtn = document.getElementById('closeLogsBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

// Voice Control Elements
const voiceBtn = document.getElementById('voiceBtn');
const voiceBanner = document.getElementById('voiceBanner');
const voiceStatus = document.getElementById('voiceStatus');
const voiceTranscript = document.getElementById('voiceTranscript');
let voiceControl = null;

// ==================== PERSISTENT STATS ====================
let stats = { sessions: 0, actions: 0, successes: 0, totalTime: 0 };
let sessionStartTime = null;
let timerInterval = null;
let logEntryCount = 0;
let lastScreenshot = null;

// ==================== LOGGING ====================
function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-content">${escapeHtml(message)}</span>`;
    logsDiv.appendChild(entry);
    logsDiv.scrollTop = logsDiv.scrollHeight;
    console.log(`[GeminiPilot][${type}] ${message}`);

    // Update log count
    logEntryCount++;
    if (logCountEl) logCountEl.textContent = logEntryCount;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function clearLogs() {
    logsDiv.innerHTML = '';
    logEntryCount = 0;
    if (logCountEl) logCountEl.textContent = '0';
}

// ==================== UI STATE ====================
function setStatus(status, dotClass = '') {
    statusText.textContent = status;
    statusDot.className = 'status-dot ' + dotClass;
}

function updateUI() {
    if (isRunning && !isPaused) {
        stopBtn.disabled = false;
        stopBtn.classList.add('visible');
        sendBtn.disabled = true;
        setStatus('Running...', 'running');
    } else if (isRunning && isPaused) {
        stopBtn.disabled = false;
        stopBtn.classList.add('visible');
        sendBtn.disabled = false; // Allow input when paused
        setStatus('Paused - Waiting for you', 'paused');
    } else {
        stopBtn.disabled = true;
        stopBtn.classList.remove('visible');
        sendBtn.disabled = false;
        setStatus('Ready for instructions', '');
    }
}



// ==================== STORAGE ====================
async function saveApiKey(key) {
    await chrome.storage.local.set({ geminiApiKey: key });
}

async function loadApiKey() {
    const result = await chrome.storage.local.get('geminiApiKey');
    if (result.geminiApiKey) {
        apiKeyInput.value = result.geminiApiKey;
    }
}

// ==================== JSON SANITIZER ====================
function cleanJson(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Invalid input: expected string');
    }

    let cleaned = text.trim();

    // Remove markdown code blocks
    const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
        cleaned = jsonBlockMatch[1].trim();
    }

    cleaned = cleaned.replace(/^`+|`+$/g, '').trim();

    // Extract FIRST complete JSON object only
    let braceCount = 0;
    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '{') {
            if (startIndex === -1) startIndex = i;
            braceCount++;
        } else if (cleaned[i] === '}') {
            braceCount--;
            if (braceCount === 0 && startIndex !== -1) {
                endIndex = i + 1;
                break;
            }
        }
    }

    if (startIndex !== -1 && endIndex !== -1) {
        cleaned = cleaned.substring(startIndex, endIndex);
    }

    // Fix common JSON issues
    cleaned = cleaned.replace(/'([^']*)':/g, '"$1":');
    cleaned = cleaned.replace(/: '([^']*)'/g, ': "$1"');
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        console.error('[GeminiPilot] JSON parse error:', error);
        console.error('[GeminiPilot] Attempted to parse:', cleaned);
        throw new Error(`Failed to parse JSON: ${error.message}`);
    }
}

// ==================== TAB MANAGEMENT ====================
async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

async function ensureContentScript(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        if (response && response.success) {
            return true;
        }
    } catch (error) {
        log('Injecting content script...', 'info');
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            await sleep(500);
            return true;
        } catch (injectError) {
            log(`Failed to inject content script: ${injectError.message}`, 'error');
            return false;
        }
    }
    return true;
}

// ==================== PAGE LOAD DETECTION ====================
async function waitForPageLoad(tabId, timeout = 10000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.status === 'complete') {
                // Additional wait for dynamic content
                await sleep(500);
                return true;
            }
        } catch (error) {
            // Tab might not exist anymore
            return false;
        }
        await sleep(200);
    }

    log('Page load timeout, continuing anyway...', 'warning');
    return true;
}

async function waitForNetworkIdle(tabId, timeout = 5000) {
    // Wait for page to stabilize (no new network requests)
    await sleep(Math.min(timeout, 2000));
    return true;
}

// ==================== SCREENSHOT ====================
async function captureScreenshot() {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, {
            format: 'jpeg',
            quality: 95  // High quality for better text recognition
        });
        return dataUrl;
    } catch (error) {
        log(`Screenshot error: ${error.message}`, 'error');
        return null;
    }
}

// ==================== ACTION HISTORY ====================
function recordAction(action, result) {
    actionHistory.push({
        timestamp: new Date().toISOString(),
        action: action,
        success: result.success,
        message: result.message || result.error,
        pageUrl: result.pageUrl
    });

    // Keep only last 20 actions
    if (actionHistory.length > 20) {
        actionHistory = actionHistory.slice(-20);
    }
}

function formatActionHistory() {
    if (actionHistory.length === 0) {
        return 'No previous actions taken.';
    }

    return actionHistory.slice(-5).map((h, i) => {
        const status = h.success ? '✓' : '✗';
        return `${i + 1}. [${status}] ${h.action.type || h.action}: ${h.message || 'completed'}`;
    }).join('\n');
}

// ==================== ENHANCED GEMINI API ====================
async function callGemini(apiKey, goal, screenshot, elementContext, pageInfo) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    // Use the new prompt system if available
    let systemPrompt;
    if (window.GeminiPrompts && window.AgentRouter) {
        const taskType = window.AgentRouter.detectTaskType(goal);
        systemPrompt = window.GeminiPrompts.buildSystemPrompt(
            goal,
            pageInfo,
            elementContext,
            formatActionHistory(),
            lastError,
            taskType
        );
        log(`📋 Task type detected: ${taskType}`, 'info');
    } else {
        // Fallback to enhanced built-in prompt
        systemPrompt = `You are GeminiPilot, an advanced browser automation agent with deep reasoning capabilities.

## THINKING METHODOLOGY
Before EVERY action, you MUST think through:
1. **OBSERVE**: What do I see on this page? What elements are available?
2. **ORIENT**: Where am I in the overall task? What's been done?
3. **DECIDE**: What's the best next action? Why this over alternatives?
4. **ACT**: Execute precisely with correct parameters

## USER'S GOAL
"${goal}"

## CURRENT PAGE STATE
- **Title**: ${pageInfo.title || 'Unknown'}
- **URL**: ${pageInfo.url || 'Unknown'}
- **Scroll**: ${pageInfo.scrollY || 0}px / ${pageInfo.scrollHeight || 0}px
- **Viewport**: ${pageInfo.viewportHeight || 0}px

## ACTION HISTORY
${formatActionHistory()}

## AVAILABLE ELEMENTS
${elementContext}

## AVAILABLE ACTIONS
| Action | Description | Fields |
|--------|-------------|--------|
| click | Click element | target_id |
| type | Enter text (no submit) | target_id, value |
| type_and_enter | Type + submit (BEST for search!) | target_id, value |
| press_enter | Submit form | target_id |
| scroll | See more content | value: "up"/"down" |
| navigate | Go to URL directly | value: URL |
| new_tab | Open in new tab | value: URL |
| wait | Pause for updates | value: ms |
| go_back | Browser back | - |
| refresh | Reload page | - |
| extract | Read text | target_id |
| human_help | Need human | message_to_user |
| done | Task complete | - |

## CRITICAL RULES
1. Use type_and_enter for ALL search boxes (Google, Amazon, YouTube, etc.)
2. Navigate directly to known URLs instead of searching for them
3. Request human_help for logins, CAPTCHAs, 2FA
4. Only use "done" when goal is FULLY accomplished
5. Think deeply before each action

## RESPONSE FORMAT
{
  "observation": "What I see on this page (specific elements, state)",
  "thought": "My reasoning: what to do and WHY (be detailed)",
  "plan": ["Next step", "Following step", "..."],
  "action": "action_name",
  "target_id": <number or null>,
  "value": "<text/URL or null>",
  "message_to_user": "<for human_help only>",
  "confidence": <1-10>
}`;
    }

    // Build conversation history for context
    const historyParts = conversationHistory.slice(-4).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
    }));

    const currentParts = [];

    if (screenshot) {
        const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
        currentParts.push({
            inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
            }
        });
    }

    currentParts.push({ text: systemPrompt });

    // Add error context if there was a recent error
    if (lastError) {
        currentParts.push({
            text: `\n\n⚠️ PREVIOUS ERROR: ${lastError}\nPlease try a different approach.`
        });
    }

    const requestBody = {
        contents: [
            ...historyParts,
            {
                role: 'user',
                parts: currentParts
            }
        ],
        generationConfig: {
            temperature: 0.2,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 1500
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error ${response.status}: ${errorText}`);
        }

        const data = await response.json();

        if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
            throw new Error('Invalid API response structure');
        }

        const responseText = data.candidates[0].content.parts[0].text;

        // Update conversation history
        conversationHistory.push({
            role: 'user',
            text: `[Page: ${pageInfo.title}] Goal: ${goal}`
        });
        conversationHistory.push({
            role: 'model',
            text: responseText
        });

        if (conversationHistory.length > 20) {
            conversationHistory = conversationHistory.slice(-20);
        }

        // Clear error after successful response
        lastError = null;
        consecutiveErrors = 0;

        return cleanJson(responseText);
    } catch (error) {
        log(`Gemini API error: ${error.message}`, 'error');
        throw error;
    }
}

// ==================== UTILITIES ====================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatElementContext(elements) {
    if (!elements || elements.length === 0) {
        return 'No interactive elements found on this page.';
    }

    return elements.slice(0, 60).map(el => {
        let desc = `[${el.id}] ${el.tag}`;
        if (el.type) desc += `(${el.type})`;
        if (el.label) desc += `: "${el.label.substring(0, 40)}"`;
        if (el.href) desc += ` → ${el.href.substring(0, 60)}`;
        return desc;
    }).join('\n');
}

// ==================== ACTION EXECUTOR ====================
async function executeAction(agentResponse) {
    const action = agentResponse.action;
    const targetId = agentResponse.target_id;
    const value = agentResponse.value;
    let result = { success: false, error: 'Unknown action' };

    try {
        // Action requiring User Feedack
        if (action === 'human_help') {
            waitingForInput = true;
            addChatMessage('agent', `I need your help: ${agentResponse.message_to_user || 'Please provide instructions.'}`, 'system');
            setStatus('Waiting for input...', 'paused');
            isPaused = true;
            updateUI();

            // Wait for user to type in chat
            const userResponse = await new Promise(resolve => {
                inputResolver = resolve;
            });

            // Add response to history
            conversationHistory.push({ role: 'user', text: `User provided help: ${userResponse}` });
            isPaused = false;
            waitingForInput = false;
            inputResolver = null;
            updateUI();
            result = { success: true, message: `Human help received: ${userResponse}` };
        }
        // If Done
        else if (action === 'done') {
            const summary = value || "Task completed.";
            addChatMessage('agent', `✅ ${summary}`);
            log(`Mission Complete: ${summary}`, 'success');
            recordActionStats(true);
            stopAgent();
            result = { success: true, message: summary };
        }
        else {
            switch (action) {
                case 'click':
                    if (!targetId) {
                        result = { success: false, error: 'No target_id for click' };
                    } else {
                        log(`Clicking element ${targetId}...`, 'action');
                        result = await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'click', target_id: targetId }
                        });
                        if (result.success) {
                            await waitForPageLoad(currentTabId, 5000);
                        }
                    }
                    break;

                case 'type':
                    if (!targetId || !value) {
                        result = { success: false, error: 'Missing target_id or value for type' };
                    } else {
                        log(`Typing "${value}" into element ${targetId}...`, 'action');
                        result = await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'type', target_id: targetId, value: value }
                        });
                    }
                    break;

                case 'type_and_enter':
                    if (!targetId || !value) {
                        result = { success: false, error: 'Missing target_id or value for type_and_enter' };
                    } else {
                        log(`Typing "${value}" and pressing Enter on element ${targetId}...`, 'action');
                        result = await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'type_and_enter', target_id: targetId, value: value }
                        });
                        if (result.success) {
                            await waitForPageLoad(currentTabId, 8000);
                        }
                    }
                    break;

                case 'press_enter':
                    if (!targetId) {
                        result = { success: false, error: 'No target_id for press_enter' };
                    } else {
                        log(`Pressing Enter on element ${targetId}...`, 'action');
                        result = await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'submit', target_id: targetId }
                        });
                        await waitForPageLoad(currentTabId, 5000);
                    }
                    break;

                case 'scroll':
                    const direction = value || 'down';
                    log(`Scrolling ${direction}...`, 'action');
                    result = await chrome.tabs.sendMessage(currentTabId, {
                        type: 'EXECUTE_ACTION',
                        action: { type: 'scroll', value: direction }
                    });
                    await sleep(800);
                    break;

                case 'navigate':
                    if (!value) {
                        result = { success: false, error: 'No URL for navigate' };
                    } else {
                        let url = value;
                        if (!url.startsWith('http://') && !url.startsWith('https://')) {
                            url = 'https://' + url;
                        }
                        log(`Navigating to ${url}...`, 'action');
                        await chrome.tabs.update(currentTabId, { url: url });
                        await waitForPageLoad(currentTabId, 10000);
                        result = { success: true, message: `Navigated to ${url}` };
                    }
                    break;

                case 'new_tab':
                    if (!value) {
                        result = { success: false, error: 'No URL for new_tab' };
                    } else {
                        let url = value;
                        if (!url.startsWith('http://') && !url.startsWith('https://')) {
                            url = 'https://' + url;
                        }
                        log(`Opening new tab: ${url}...`, 'action');
                        const newTab = await chrome.tabs.create({ url: url, active: true });
                        currentTabId = newTab.id;
                        await waitForPageLoad(currentTabId, 10000);
                        result = { success: true, message: `Opened new tab: ${url}` };
                    }
                    break;

                case 'wait':
                    const waitMs = Math.min(parseInt(value) || 1000, 5000);
                    log(`Waiting ${waitMs}ms...`, 'action');
                    await sleep(waitMs);
                    result = { success: true, message: `Waited ${waitMs}ms` };
                    break;

                case 'go_back':
                    log('Going back...', 'action');
                    await chrome.tabs.goBack(currentTabId);
                    await waitForPageLoad(currentTabId, 5000);
                    result = { success: true, message: 'Went back' };
                    break;

                case 'refresh':
                    log('Refreshing page...', 'action');
                    await chrome.tabs.reload(currentTabId);
                    await waitForPageLoad(currentTabId, 10000);
                    result = { success: true, message: 'Page refreshed' };
                    break;

                case 'extract':
                    if (!targetId) {
                        result = { success: false, error: 'No target_id for extract' };
                    } else {
                        log(`Extracting data from element ${targetId}...`, 'action');
                        result = await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'extract', target_id: targetId }
                        });
                        if (result.success && result.data) {
                            log(`📋 Extracted: "${result.data.text.substring(0, 100)}..."`, 'info');
                        }
                    }
                    break;

                // ==================== MULTI-TAB ACTIONS ====================
                case 'switch_tab':
                    try {
                        const tabIndex = parseInt(value) || 0;
                        const allTabs = await chrome.tabs.query({ currentWindow: true });
                        if (tabIndex >= 0 && tabIndex < allTabs.length) {
                            const targetTab = allTabs[tabIndex];
                            await chrome.tabs.update(targetTab.id, { active: true });
                            currentTabId = targetTab.id;
                            log(`🔄 Switched to tab ${tabIndex}: ${targetTab.title?.substring(0, 30)}...`, 'action');
                            await sleep(500);
                            result = { success: true, message: `Switched to tab ${tabIndex}` };
                        } else {
                            result = { success: false, error: `Tab index ${tabIndex} out of range (0-${allTabs.length - 1})` };
                        }
                    } catch (e) {
                        result = { success: false, error: e.message };
                    }
                    break;

                case 'close_tab':
                    try {
                        const allTabs = await chrome.tabs.query({ currentWindow: true });
                        if (allTabs.length > 1) {
                            await chrome.tabs.remove(currentTabId);
                            const remainingTabs = await chrome.tabs.query({ currentWindow: true, active: true });
                            currentTabId = remainingTabs[0]?.id;
                            log(`🗑️ Closed tab, now on: ${remainingTabs[0]?.title?.substring(0, 30)}...`, 'action');
                            result = { success: true, message: 'Tab closed' };
                        } else {
                            result = { success: false, error: 'Cannot close the last tab' };
                        }
                    } catch (e) {
                        result = { success: false, error: e.message };
                    }
                    break;

                case 'list_tabs':
                    try {
                        const allTabs = await chrome.tabs.query({ currentWindow: true });
                        const tabList = allTabs.map((t, i) => `[${i}] ${t.title?.substring(0, 40)} ${t.id === currentTabId ? '(current)' : ''}`).join('\n');
                        log(`📑 Open tabs:\n${tabList}`, 'info');
                        result = { success: true, message: `Found ${allTabs.length} tabs`, tabList };
                    } catch (e) {
                        result = { success: false, error: e.message };
                    }
                    break;

                // ==================== DATA COLLECTION ACTIONS ====================
                case 'collect_item':
                    try {
                        let itemData;
                        if (typeof value === 'string') {
                            itemData = JSON.parse(value);
                        } else {
                            itemData = value;
                        }
                        itemData._timestamp = Date.now();
                        itemData._index = collectedItems.length + 1;
                        collectedItems.push(itemData);
                        log(`📦 Collected item #${itemData._index}: ${itemData.name || JSON.stringify(itemData).substring(0, 50)}...`, 'action');
                        result = { success: true, message: `Item collected (${collectedItems.length} total)` };
                    } catch (e) {
                        result = { success: false, error: `Failed to parse item: ${e.message}` };
                    }
                    break;

                case 'show_collection':
                    if (collectedItems.length === 0) {
                        log('📋 Collection is empty', 'info');
                        result = { success: true, message: 'No items collected yet' };
                    } else {
                        log(`📋 COLLECTED ${collectedItems.length} ITEMS:`, 'info');
                        collectedItems.forEach((item, i) => {
                            const display = item.name ? `${item.name} - ${item.price || 'N/A'}` : JSON.stringify(item);
                            log(`  ${i + 1}. ${display}`, 'info');
                        });
                        result = { success: true, message: `Showing ${collectedItems.length} items`, items: collectedItems };
                    }
                    break;

                case 'paste_collection':
                    if (collectedItems.length === 0) {
                        result = { success: false, error: 'No items to paste' };
                    } else {
                        const text = collectedItems.map(item => {
                            return Object.entries(item)
                                .filter(([k]) => !k.startsWith('_'))
                                .map(([k, v]) => `${k}: ${v}`)
                                .join('\n');
                        }).join('\n\n-------------------\n\n');

                        log(`📝 Pasting ${collectedItems.length} items into page...`, 'action');
                        // Use type action mechanism to paste
                        result = await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'type', value: text, target_id: targetId || null } // Use target_id if provided, else active element
                        });
                    }
                    break;

                default:
                    result = { success: false, error: `Unknown action: ${action}` };
            }
        }
    } catch (error) {
        result = { success: false, error: error.message };
    }

    // Record the action
    const tab = await getCurrentTab();
    result.pageUrl = tab?.url;
    recordAction({ type: action, target_id: targetId, value: value }, result);

    return result;
}

// ==================== CHAT UI ====================
function addChatMessage(role, text, type = 'text') {
    if (!chatHistory) return;

    const div = document.createElement('div');
    div.className = `chat-message ${role} ${type}`;

    // Convert newlines to breaks
    const formattedText = escapeHtml(text).replace(/\n/g, '<br>');
    div.innerHTML = formattedText;

    const time = document.createElement('span');
    time.className = 'chat-timestamp';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.appendChild(time);

    chatHistory.appendChild(div);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

async function handleUserMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    addChatMessage('user', text);
    chatInput.value = '';

    // Auto-resize reset
    chatInput.style.height = 'auto';

    if (waitingForInput && inputResolver) {
        inputResolver(text);
        waitingForInput = false;
        inputResolver = null;
        setStatus('Resuming...', 'running');
        return;
    }

    if (!isRunning) {
        await startAgent(text);
    }
}

// ==================== AGENT CORE ====================
async function startAgent(goal) {
    if (isRunning) return;
    if (!goal) {
        addChatMessage('system', 'Please enter a goal first.');
        return;
    }

    await saveApiKey(apiKeyInput.value.trim());
    await saveApiKey(apiKeyInput.value.trim());
    // saveGoalHistory(goal); // History removed

    const tab = await getCurrentTab();
    if (!tab) {
        log('No active tab found', 'error');
        addChatMessage('agent', 'Error: No active tab found. Please open a tab and try again.');
        return;
    }

    currentTabId = tab.id;

    // Handle Chrome internal pages
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url === 'about:blank') {
        log('On Chrome internal page, navigating to Google...', 'info');
        addChatMessage('agent', 'Navigating to Google.com as current tab is an internal Chrome page.');
        await chrome.tabs.update(currentTabId, { url: 'https://www.google.com' });
        await waitForPageLoad(currentTabId, 10000);
    }

    // Reset state
    isRunning = true;
    isPaused = false;
    conversationHistory = [];
    actionHistory = [];
    collectedItems = []; // Reset collection for new task
    lastError = null;
    consecutiveErrors = 0;

    // Start timer and increment session count
    stats.sessions++;
    saveStats();
    startTimer();
    setProgressActive(true);
    updateUI();

    addChatMessage('agent', `🚀 Starting agent with goal: "${goal}"`);
    log(`🚀 Starting agent with goal: "${goal}"`, 'info');

    let iteration = 0;
    const maxIterations = 100;

    while (isRunning && iteration < maxIterations) {
        if (!isRunning) break;

        if (isPaused) {
            await sleep(500);
            continue;
        }

        iteration++;
        log(`━━━ Step ${iteration} ━━━`, 'info');

        try {
            // Ensure content script is loaded
            const scriptReady = await ensureContentScript(currentTabId);
            if (!scriptReady) {
                log('Content script not available, retrying...', 'warning');
                addChatMessage('agent', 'Warning: Content script not available, retrying...');
                await sleep(2000);
                continue;
            }

            // Tag the page
            log('Analyzing page...', 'info');
            let tagResponse;
            try {
                tagResponse = await chrome.tabs.sendMessage(currentTabId, { type: 'TAG_PAGE' });
            } catch (error) {
                log(`Page communication failed: ${error.message}`, 'error');
                addChatMessage('agent', `Error: Page communication failed. ${error.message}`);
                lastError = error.message;
                consecutiveErrors++;

                if (consecutiveErrors >= 3) {
                    log('Too many consecutive errors, stopping...', 'error');
                    addChatMessage('agent', 'Error: Too many consecutive page communication errors, stopping.');
                    break;
                }
                await sleep(2000);
                continue;
            }

            if (!tagResponse?.success) {
                log('Failed to analyze page', 'error');
                addChatMessage('agent', 'Error: Failed to analyze page content.');
                continue;
            }

            const elements = tagResponse.elements || [];
            const pageInfo = tagResponse.pageInfo || {};
            log(`Found ${elements.length} interactive elements`, 'info');

            // Wait for DOM to stabilize
            await sleep(800);

            // Capture screenshot
            const screenshot = await captureScreenshot();
            if (screenshot) updateScreenshotPreview(screenshot);

            // Build context
            const elementContext = formatElementContext(elements);

            // Call Gemini
            log('🤔 Thinking...', 'thought');
            addChatMessage('agent', 'Thinking about the next step...');
            let agentResponse;
            try {
                agentResponse = await callGemini(apiKeyInput.value.trim(), goal, screenshot, elementContext, pageInfo);
            } catch (error) {
                log(`AI error: ${error.message}`, 'error');
                addChatMessage('agent', `AI Error: ${error.message}`);
                lastError = error.message;
                consecutiveErrors++;
                await sleep(2000);
                continue;
            }

            // Log the agent's observation and thoughts
            if (agentResponse.observation) {
                log(`👁️ ${agentResponse.observation.substring(0, 150)}...`, 'info');
            }

            if (agentResponse.thought) {
                log(`💭 ${agentResponse.thought}`, 'thought');
                addChatMessage('agent', `Thought: ${agentResponse.thought}`);
            }

            if (agentResponse.plan && agentResponse.plan.length > 0) {
                log(`📋 Plan: ${agentResponse.plan.slice(0, 3).join(' → ')}`, 'info');
            }

            if (agentResponse.confidence) {
                const confidenceEmoji = agentResponse.confidence >= 7 ? '🟢' : agentResponse.confidence >= 4 ? '🟡' : '🔴';
                log(`${confidenceEmoji} Confidence: ${agentResponse.confidence}/10`, 'info');
            }

            // Validate action before execution
            if (window.AgentRouter) {
                const validation = window.AgentRouter.validateAction(agentResponse, elements);
                if (!validation.isValid) {
                    log(`⚠️ Action validation failed: ${validation.errors.join(', ')}`, 'warning');
                    addChatMessage('agent', `Warning: Action validation failed: ${validation.errors.join(', ')}`);
                    lastError = validation.errors.join(', ');
                    consecutiveErrors++;
                    continue;
                }
            }

            // Execute the action
            log(`⚡ Action: ${agentResponse.action}${agentResponse.target_id ? ` → Element ${agentResponse.target_id}` : ''}`, 'action');
            addChatMessage('agent', `Executing: ${agentResponse.action}${agentResponse.target_id ? ` on element ${agentResponse.target_id}` : ''}`);
            const result = await executeAction(agentResponse);

            if (result.success) {
                log(`✓ ${result.message || 'Action completed'}`, 'action');
                consecutiveErrors = 0;
                recordActionStats(true);
            } else {
                log(`✗ ${result.error}`, 'error');
                addChatMessage('agent', `Action failed: ${result.error}`);
                lastError = result.error;
                consecutiveErrors++;
            }

            // Clear tags after action
            try {
                await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' });
            } catch (e) { /* ignore */ }

            // Check for too many errors
            if (consecutiveErrors >= 5) {
                log('Too many consecutive errors, requesting human help...', 'warning');
                addChatMessage('agent', 'Too many consecutive errors. I need human help to proceed.');
                showHumanHelp('The agent is having trouble. Please check the page and click Resume.');
                isPaused = true;
                updateUI();
                consecutiveErrors = 0;
            }

            await sleep(300);

        } catch (error) {
            log(`Loop error: ${error.message}`, 'error');
            console.error('[GeminiPilot] Loop error:', error);
            addChatMessage('agent', `Critical Error: ${error.message}`);
            consecutiveErrors++;
            await sleep(2000);
        }
    }

    if (iteration >= maxIterations) {
        log(`Reached maximum iterations (${maxIterations})`, 'warning');
        addChatMessage('agent', `Warning: Reached maximum iterations (${maxIterations}). Stopping.`);
    }

    // Cleanup
    isRunning = false;
    isPaused = false;
    updateUI();

    try {
        if (currentTabId) {
            await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' });
        }
    } catch (e) { /* ignore */ }

    log('Agent stopped', 'info');
    addChatMessage('agent', 'Agent stopped.');
}

// ==================== RESUME HANDLER ====================
function resumeAgent() {
    if (!isRunning || !isPaused) return;

    log('Resuming agent...', 'info');
    addChatMessage('agent', 'Resuming operation.');
    hideHumanHelp();
    isPaused = false;
    lastError = null;
    consecutiveErrors = 0;
    updateUI();
}

// ==================== STOP HANDLER ====================
function stopAgent() {
    log('Stopping agent...', 'warning');
    addChatMessage('agent', 'Agent stopped by user.');
    isRunning = false;
    isPaused = false;
    hideHumanHelp();
    stopTimer();
    setProgressActive(false);
    updateUI();

    if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' }).catch(() => { });
    }
}

// ==================== EVENT LISTENERS ====================
// Removed old startBtn listener, now handled by handleUserMessage
// startBtn.addEventListener('click', () => {
//     if (!isRunning) {
//         saveGoalHistory(goalInput.value.trim());
//         runAgentLoop();
//     }
// });

// stopBtn.addEventListener('click', stopAgent); // Replaced in init
// resumeBtn.addEventListener('click', resumeAgent);
clearLogsBtn.addEventListener('click', clearLogs);

apiKeyInput.addEventListener('change', () => {
    saveApiKey(apiKeyInput.value.trim());
});

// ==================== KEYBOARD SHORTCUTS ====================
document.addEventListener('keydown', (e) => {
    // Ctrl+Enter or Cmd+Enter to Start (if chatInput is focused)
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement === chatInput) {
        e.preventDefault();
        handleUserMessage();
    }
    // Escape to Stop
    if (e.key === 'Escape' && isRunning) {
        e.preventDefault();
        stopAgent();
    }
    // Space to Resume (only when paused and not focused on input)
    if (e.key === ' ' && isPaused && document.activeElement !== chatInput && document.activeElement !== apiKeyInput) {
        e.preventDefault();
        resumeAgent();
    }
});

// Goal History Removed

// ==================== STATS ====================
async function loadStats() {
    const result = await chrome.storage.local.get('agentStats');
    stats = result.agentStats || { sessions: 0, actions: 0, successes: 0 };
    updateStatsDisplay();
}

async function saveStats() {
    await chrome.storage.local.set({ agentStats: stats });
    updateStatsDisplay();
}

function recordActionStats(success) {
    stats.actions++;
    if (success) stats.successes++;
    saveStats();
}

// ==================== TIMER ====================
function startTimer() {
    // Timer removed from UI
}

function stopTimer() {
    // Timer removed from UI
}

function updateTimer() {
}


// ==================== PROGRESS BAR ====================
function setProgressActive(active) {
    if (!progressBar) return;
    if (active) {
        progressBar.classList.add('active');
        progressFill.style.width = '30%';
    } else {
        progressBar.classList.remove('active');
        progressFill.style.width = '0%';
    }
}

// ==================== SCREENSHOT PREVIEW ====================
function updateScreenshotPreview(dataUrl) {
    lastScreenshot = dataUrl;
    if (screenshotImg) {
        screenshotImg.src = dataUrl;
        screenshotImg.style.display = 'block';
    }
    if (screenshotPlaceholder) {
        screenshotPlaceholder.style.display = 'none';
    }
}

function toggleScreenshotPreview() {
    if (!screenshotPreview) return;
    screenshotPreview.classList.toggle('visible');
    if (screenshotPreview.classList.contains('visible') && lastScreenshot) {
        screenshotImg.src = lastScreenshot;
        screenshotImg.style.display = 'block';
        if (screenshotPlaceholder) screenshotPlaceholder.style.display = 'none';
    }
}

// ==================== SETTINGS MODAL ====================
function toggleSettings() {
    if (!settingsModal) return;
    settingsModal.classList.toggle('visible');
    if (settingsModal.classList.contains('visible')) {
        // Populate key when opening
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            if (result.geminiApiKey && apiKeyInput) {
                apiKeyInput.value = result.geminiApiKey;
            }
        });
    }
}

async function saveSettings() {
    const key = apiKeyInput.value.trim();
    if (key) {
        await saveApiKey(key);
        log('Settings saved', 'info');
        toggleSettings();
    } else {
        log('Please enter a valid API key', 'warning');
    }
}

// ==================== LOGS MODAL ====================
function toggleLogs() {
    if (!logsModal) return;
    logsModal.classList.toggle('visible');

    // Auto-scroll to bottom of logs when opening
    if (logsModal.classList.contains('visible') && logsDiv) {
        logsDiv.scrollTop = logsDiv.scrollHeight;
    }
}

// ==================== EXPORT LOGS ====================
function exportLogs() {
    const logEntries = logsDiv.querySelectorAll('.log-entry');
    let logText = `GeminiPilot 3 - Session Log\nExported: ${new Date().toISOString()}\n\n`;

    logEntries.forEach(entry => {
        const time = entry.querySelector('.log-time')?.textContent || '';
        const content = entry.querySelector('.log-content')?.textContent || '';
        const type = entry.className.replace('log-entry ', '').toUpperCase();
        logText += `[${time}] [${type}] ${content}\n`;
    });

    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `geminipilot-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    log('📥 Logs exported!', 'info');
}

// ==================== TEMPLATE HANDLERS ====================
function setupTemplates() {
    templateBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const template = btn.dataset.template;
            if (template) {
                chatInput.value = template;
                chatInput.focus();
                // Optional: Auto-send? No, let user confirm
            }
        });
    });
}

// ==================== ENHANCED STATS ====================
// ==================== ENHANCED STATS ====================
function updateStatsDisplay() {
    // Stats UI removed
}

// ==================== INITIALIZATION ====================
async function init() {
    await loadApiKey();
    await loadStats();
    setupTemplates();

    // Setup event listeners for new features
    if (sendBtn) {
        sendBtn.addEventListener('click', handleUserMessage);
    }
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleUserMessage();
            }
        });
    }

    if (toggleScreenshotBtn) {
        toggleScreenshotBtn.addEventListener('click', toggleScreenshotPreview);
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', exportLogs);
    }
    if (openLogsBtn) {
        openLogsBtn.addEventListener('click', toggleLogs);
    }
    if (closeLogsBtn) {
        closeLogsBtn.addEventListener('click', toggleLogs);
    }
    if (settingsBtn) {
        settingsBtn.addEventListener('click', toggleSettings);
    }
    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', toggleSettings);
    }
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', saveSettings);
    }

    updateUI();

    log('🚀 GeminiPilot 3 ready!', 'info');
    log('⌨️ Ctrl+Enter=Start | Esc=Stop | 🎤 Voice', 'info');

    // Initialize Voice Control
    initVoiceControl();
}

// ==================== VOICE CONTROL ====================
function initVoiceControl() {
    if (!window.VoiceControl) {
        console.warn('VoiceControl module not loaded');
        if (voiceBtn) voiceBtn.style.display = 'none';
        return;
    }

    voiceControl = new VoiceControl({
        onResult: (transcript) => {
            // Put the transcript in the chat input and send
            if (chatInput) {
                chatInput.value = transcript;
            }
            if (voiceTranscript) {
                voiceTranscript.textContent = transcript;
            }
            // Auto-send after a brief delay to show the transcript
            setTimeout(() => {
                handleUserMessage();
            }, 300);
        },
        onInterimResult: (transcript) => {
            // Show live transcription
            if (voiceTranscript) {
                voiceTranscript.textContent = transcript;
            }
            if (voiceStatus) {
                voiceStatus.textContent = 'Listening...';
            }
        },
        onError: (errorMessage) => {
            log(`🎤 ${errorMessage}`, 'warning');
            addChatMessage('system', `Voice: ${errorMessage}`, 'error');
        },
        onStateChange: (state) => {
            updateVoiceUI(state);
        }
    });

    // Setup voice button click handler
    if (voiceBtn) {
        voiceBtn.addEventListener('click', () => {
            if (voiceControl) {
                voiceControl.toggle();
            }
        });

        // Show/hide based on support
        if (!voiceControl.isSupported) {
            voiceBtn.disabled = true;
            voiceBtn.title = 'Voice not supported in this browser';
        }
    }

    log('🎤 Voice control ready', 'info');
}

function updateVoiceUI(state) {
    if (!voiceBtn || !voiceBanner) return;

    switch (state) {
        case 'listening':
            voiceBtn.classList.add('listening');
            voiceBanner.classList.add('visible');
            if (voiceStatus) voiceStatus.textContent = 'Listening...';
            if (voiceTranscript) voiceTranscript.textContent = '';
            break;
        case 'idle':
        case 'error':
        default:
            voiceBtn.classList.remove('listening');
            voiceBanner.classList.remove('visible');
            break;
    }
}

init();
