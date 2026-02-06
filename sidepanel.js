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

// ==================== DOM ELEMENTS ====================
const apiKeyInput = document.getElementById('apiKey');
const goalInput = document.getElementById('goal');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resumeBtn = document.getElementById('resumeBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const logsDiv = document.getElementById('logs');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const humanHelpBanner = document.getElementById('humanHelpBanner');
const humanHelpMessage = document.getElementById('humanHelpMessage');
const elapsedTimeEl = document.getElementById('elapsedTime');
const sessionCountEl = document.getElementById('sessionCount');
const actionCountEl = document.getElementById('actionCount');
const successRateEl = document.getElementById('successRate');
const goalHistoryEl = document.getElementById('goalHistory');

// ==================== PERSISTENT STATS ====================
let stats = { sessions: 0, actions: 0, successes: 0 };
let sessionStartTime = null;
let timerInterval = null;

// ==================== LOGGING ====================
function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-content">${escapeHtml(message)}</span>`;
    logsDiv.appendChild(entry);
    logsDiv.scrollTop = logsDiv.scrollHeight;
    console.log(`[GeminiPilot][${type}] ${message}`);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function clearLogs() {
    logsDiv.innerHTML = '';
}

// ==================== UI STATE ====================
function setStatus(status, dotClass = '') {
    statusText.textContent = status;
    statusDot.className = 'status-dot ' + dotClass;
}

function updateUI() {
    if (isRunning && !isPaused) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        resumeBtn.classList.remove('visible');
        setStatus('Running...', 'running');
    } else if (isRunning && isPaused) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        resumeBtn.classList.add('visible');
        setStatus('Paused - Human Help Needed', 'paused');
    } else {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        resumeBtn.classList.remove('visible');
        humanHelpBanner.classList.remove('visible');
        setStatus('Ready');
    }
}

function showHumanHelp(message) {
    humanHelpMessage.textContent = message || 'The agent needs your help!';
    humanHelpBanner.classList.add('visible');
}

function hideHumanHelp() {
    humanHelpBanner.classList.remove('visible');
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

            case 'human_help':
                const helpMessage = agentResponse.message_to_user || 'Please help me with this step.';
                log(`🆘 Human help needed: ${helpMessage}`, 'warning');
                showHumanHelp(helpMessage);
                isPaused = true;
                updateUI();
                result = { success: true, message: 'Waiting for human help' };
                break;

            case 'done':
                log('✅ Goal accomplished!', 'action');
                isRunning = false;
                result = { success: true, message: 'Task completed' };
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

            default:
                result = { success: false, error: `Unknown action: ${action}` };
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

// ==================== MAIN LOOP ====================
async function runAgentLoop() {
    const apiKey = apiKeyInput.value.trim();
    const goal = goalInput.value.trim();

    if (!apiKey) {
        log('Please enter your Gemini API key', 'error');
        return;
    }

    if (!goal) {
        log('Please enter a goal for the agent', 'error');
        return;
    }

    await saveApiKey(apiKey);

    const tab = await getCurrentTab();
    if (!tab) {
        log('No active tab found', 'error');
        return;
    }

    currentTabId = tab.id;

    // Handle Chrome internal pages
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url === 'about:blank') {
        log('On Chrome internal page, navigating to Google...', 'info');
        await chrome.tabs.update(currentTabId, { url: 'https://www.google.com' });
        await waitForPageLoad(currentTabId, 10000);
    }

    // Reset state
    isRunning = true;
    isPaused = false;
    conversationHistory = [];
    actionHistory = [];
    lastError = null;
    consecutiveErrors = 0;

    // Start timer and increment session count
    stats.sessions++;
    saveStats();
    startTimer();
    updateUI();

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
                lastError = error.message;
                consecutiveErrors++;

                if (consecutiveErrors >= 3) {
                    log('Too many consecutive errors, stopping...', 'error');
                    break;
                }
                await sleep(2000);
                continue;
            }

            if (!tagResponse?.success) {
                log('Failed to analyze page', 'error');
                continue;
            }

            const elements = tagResponse.elements || [];
            const pageInfo = tagResponse.pageInfo || {};
            log(`Found ${elements.length} interactive elements`, 'info');

            // Wait for DOM to stabilize
            await sleep(800);

            // Capture screenshot
            const screenshot = await captureScreenshot();

            // Build context
            const elementContext = formatElementContext(elements);

            // Call Gemini
            log('🤔 Thinking...', 'thought');
            let agentResponse;
            try {
                agentResponse = await callGemini(apiKey, goal, screenshot, elementContext, pageInfo);
            } catch (error) {
                log(`AI error: ${error.message}`, 'error');
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
                    lastError = validation.errors.join(', ');
                    consecutiveErrors++;
                    continue;
                }
            }

            // Execute the action
            log(`⚡ Action: ${agentResponse.action}${agentResponse.target_id ? ` → Element ${agentResponse.target_id}` : ''}`, 'action');
            const result = await executeAction(agentResponse);

            if (result.success) {
                log(`✓ ${result.message || 'Action completed'}`, 'action');
                consecutiveErrors = 0;
                recordActionStats(true);
            } else {
                log(`✗ ${result.error}`, 'error');
                lastError = result.error;
                consecutiveErrors++;
                recordActionStats(false);
            }

            // Clear tags after action
            try {
                await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' });
            } catch (e) { }

            // Check for too many errors
            if (consecutiveErrors >= 5) {
                log('Too many consecutive errors, requesting human help...', 'warning');
                showHumanHelp('The agent is having trouble. Please check the page and click Resume.');
                isPaused = true;
                updateUI();
                consecutiveErrors = 0;
            }

            await sleep(300);

        } catch (error) {
            log(`Loop error: ${error.message}`, 'error');
            console.error('[GeminiPilot] Loop error:', error);
            consecutiveErrors++;
            await sleep(2000);
        }
    }

    if (iteration >= maxIterations) {
        log(`Reached maximum iterations (${maxIterations})`, 'warning');
    }

    // Cleanup
    isRunning = false;
    isPaused = false;
    updateUI();

    try {
        if (currentTabId) {
            await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' });
        }
    } catch (e) { }

    log('Agent stopped', 'info');
}

// ==================== RESUME HANDLER ====================
function resumeAgent() {
    if (!isRunning || !isPaused) return;

    log('Resuming agent...', 'info');
    hideHumanHelp();
    isPaused = false;
    lastError = null;
    consecutiveErrors = 0;
    updateUI();
}

// ==================== STOP HANDLER ====================
function stopAgent() {
    log('Stopping agent...', 'warning');
    isRunning = false;
    isPaused = false;
    hideHumanHelp();
    stopTimer();
    updateUI();

    if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' }).catch(() => { });
    }
}

// ==================== EVENT LISTENERS ====================
startBtn.addEventListener('click', () => {
    if (!isRunning) {
        saveGoalHistory(goalInput.value.trim());
        runAgentLoop();
    }
});

stopBtn.addEventListener('click', stopAgent);
resumeBtn.addEventListener('click', resumeAgent);
clearLogsBtn.addEventListener('click', clearLogs);

apiKeyInput.addEventListener('change', () => {
    saveApiKey(apiKeyInput.value.trim());
});

// ==================== KEYBOARD SHORTCUTS ====================
document.addEventListener('keydown', (e) => {
    // Ctrl+Enter or Cmd+Enter to Start
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!isRunning) {
            saveGoalHistory(goalInput.value.trim());
            runAgentLoop();
        }
    }
    // Escape to Stop
    if (e.key === 'Escape' && isRunning) {
        e.preventDefault();
        stopAgent();
    }
    // Space to Resume (only when paused and not focused on input)
    if (e.key === ' ' && isPaused && document.activeElement !== goalInput && document.activeElement !== apiKeyInput) {
        e.preventDefault();
        resumeAgent();
    }
});

// ==================== GOAL HISTORY ====================
let goalHistory = [];

async function loadGoalHistory() {
    const result = await chrome.storage.local.get('goalHistory');
    goalHistory = result.goalHistory || [];
}

async function saveGoalHistory(goal) {
    if (!goal || goal.length < 3) return;

    // Remove duplicates and add to front
    goalHistory = goalHistory.filter(g => g !== goal);
    goalHistory.unshift(goal);

    // Keep only last 10
    goalHistory = goalHistory.slice(0, 10);

    await chrome.storage.local.set({ goalHistory });
    displayGoalChips();
}

function displayGoalChips() {
    if (!goalHistoryEl) return;

    goalHistoryEl.innerHTML = '';
    goalHistory.slice(0, 5).forEach(goal => {
        const chip = document.createElement('div');
        chip.className = 'goal-chip';
        chip.textContent = goal.length > 25 ? goal.substring(0, 25) + '...' : goal;
        chip.title = goal;
        chip.addEventListener('click', () => {
            goalInput.value = goal;
            goalInput.focus();
        });
        goalHistoryEl.appendChild(chip);
    });
}

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

function updateStatsDisplay() {
    if (sessionCountEl) sessionCountEl.textContent = stats.sessions;
    if (actionCountEl) actionCountEl.textContent = stats.actions;
    if (successRateEl) {
        const rate = stats.actions > 0 ? Math.round((stats.successes / stats.actions) * 100) : 0;
        successRateEl.textContent = `${rate}%`;
    }
}

function recordActionStats(success) {
    stats.actions++;
    if (success) stats.successes++;
    saveStats();
}

// ==================== TIMER ====================
function startTimer() {
    sessionStartTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimer() {
    if (!sessionStartTime || !elapsedTimeEl) return;
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    elapsedTimeEl.textContent = `${mins}:${secs}`;
}

// ==================== INITIALIZATION ====================
async function init() {
    await loadApiKey();
    await loadGoalHistory();
    await loadStats();
    displayGoalChips();
    updateUI();

    log('🚀 GeminiPilot 3 ready!', 'info');
    log('⌨️ Ctrl+Enter=Start | Esc=Stop | Space=Resume', 'info');
}

init();
