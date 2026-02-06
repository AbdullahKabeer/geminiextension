/**
 * GeminiPilot 3 - Side Panel Brain & State Manager
 * Handles the main AI agent loop, Gemini API calls, and UI interactions
 */

// ==================== STATE ====================
let isRunning = false;
let isPaused = false;
let conversationHistory = [];
let currentTabId = null;

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

// ==================== LOGGING ====================
function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(message)}`;
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
/**
 * Clean and parse JSON from Gemini response
 * Handles markdown code blocks, extra whitespace, and malformed JSON
 */
function cleanJson(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Invalid input: expected string');
    }

    let cleaned = text.trim();

    // Remove markdown code blocks (```json ... ```)
    const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
        cleaned = jsonBlockMatch[1].trim();
    }

    // Remove any leading/trailing backticks that might remain
    cleaned = cleaned.replace(/^`+|`+$/g, '').trim();

    // Try to find JSON object in the text
    const jsonObjectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
        cleaned = jsonObjectMatch[0];
    }

    // Fix common JSON issues
    // Replace single quotes with double quotes (but be careful with apostrophes)
    // This is a simple heuristic that may not work for all cases
    cleaned = cleaned.replace(/'([^']*)':/g, '"$1":');
    cleaned = cleaned.replace(/: '([^']*)'/g, ': "$1"');

    // Remove trailing commas before } or ]
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
        // Try to ping the content script
        const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        if (response && response.success) {
            return true;
        }
    } catch (error) {
        // Content script not loaded, inject it
        log('Injecting content script...', 'info');
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            // Wait a bit for the script to initialize
            await sleep(500);
            return true;
        } catch (injectError) {
            log(`Failed to inject content script: ${injectError.message}`, 'error');
            return false;
        }
    }
    return true;
}

// ==================== SCREENSHOT ====================
async function captureScreenshot() {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, {
            format: 'jpeg',
            quality: 80
        });
        return dataUrl;
    } catch (error) {
        log(`Screenshot error: ${error.message}`, 'error');
        return null;
    }
}

// ==================== GEMINI API ====================
async function callGemini(apiKey, goal, screenshot, elementContext, pageInfo) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `You are a browser automation agent called GeminiPilot. Your goal is to help the user accomplish their task by navigating and interacting with web pages.

USER'S GOAL: ${goal}

CURRENT PAGE: ${pageInfo.title} (${pageInfo.url})
SCROLL POSITION: ${pageInfo.scrollY}px of ${pageInfo.scrollHeight}px total

AVAILABLE ELEMENTS (numbered tags visible in screenshot):
${elementContext}

RULES:
1. Look at the numbered yellow tags in the screenshot - these correspond to interactive elements.
2. If you see a login screen, CAPTCHA, 2FA prompt, or anything requiring human credentials, return action "human_help".
3. Use the numbered tags to specify which element to interact with.
4. If the goal is accomplished, return action "done".
5. If you need to see more content, use action "scroll" with value "down" or "up".
6. Think step by step and explain your reasoning.

You MUST respond with valid JSON in exactly this format:
{
  "thought": "Your step-by-step reasoning about what you see and what to do next",
  "action": "click" | "type" | "scroll" | "human_help" | "done",
  "target_id": <number of the element to interact with, or null for scroll/done>,
  "value": "<text to type, or 'up'/'down' for scroll, or null>",
  "message_to_user": "<message explaining what you need if action is human_help, otherwise null>"
}`;

    // Build conversation history for context (without images to save tokens)
    const historyParts = conversationHistory.slice(-6).map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
    }));

    // Build current request
    const currentParts = [];

    // Add screenshot if available
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

    const requestBody = {
        contents: [
            ...historyParts,
            {
                role: 'user',
                parts: currentParts
            }
        ],
        generationConfig: {
            temperature: 0.1,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 1024
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

        // Add to conversation history (text only)
        conversationHistory.push({
            role: 'user',
            text: `[Screenshot captured] Goal: ${goal}`
        });
        conversationHistory.push({
            role: 'model',
            text: responseText
        });

        // Keep history manageable
        if (conversationHistory.length > 20) {
            conversationHistory = conversationHistory.slice(-20);
        }

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

    return elements.slice(0, 50).map(el => {
        let desc = `[${el.id}] ${el.tag}`;
        if (el.type) desc += ` (type=${el.type})`;
        if (el.label) desc += `: "${el.label}"`;
        if (el.href) desc += ` -> ${el.href.substring(0, 50)}`;
        return desc;
    }).join('\n');
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

    // Save API key for future sessions
    await saveApiKey(apiKey);

    // Get current tab
    const tab = await getCurrentTab();
    if (!tab) {
        log('No active tab found', 'error');
        return;
    }

    currentTabId = tab.id;

    // Check if we can access the tab
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        log('Cannot run on Chrome internal pages', 'error');
        return;
    }

    // Reset state
    isRunning = true;
    isPaused = false;
    conversationHistory = [];
    updateUI();

    log(`Starting agent with goal: "${goal}"`, 'info');
    log(`Current page: ${tab.title}`, 'info');

    // Main loop
    let iteration = 0;
    const maxIterations = 50; // Safety limit

    while (isRunning && iteration < maxIterations) {
        // Check if we should stop
        if (!isRunning) {
            log('Agent stopped by user', 'warning');
            break;
        }

        // Check if paused (human help needed)
        if (isPaused) {
            await sleep(500);
            continue;
        }

        iteration++;
        log(`--- Iteration ${iteration} ---`, 'info');

        try {
            // Ensure content script is loaded
            const scriptReady = await ensureContentScript(currentTabId);
            if (!scriptReady) {
                log('Content script not available', 'error');
                break;
            }

            // Step 1: Tag the page
            log('Scanning page for interactive elements...', 'info');
            let tagResponse;
            try {
                tagResponse = await chrome.tabs.sendMessage(currentTabId, { type: 'TAG_PAGE' });
            } catch (error) {
                log(`Failed to communicate with page: ${error.message}`, 'error');
                await sleep(2000);
                continue;
            }

            if (!tagResponse || !tagResponse.success) {
                log('Failed to tag page elements', 'error');
                continue;
            }

            const elements = tagResponse.elements || [];
            const pageInfo = tagResponse.pageInfo || {};
            log(`Found ${elements.length} interactive elements`, 'info');

            // Step 2: Wait for DOM to stabilize
            await sleep(1500);

            // Step 3: Capture screenshot
            log('Capturing screenshot...', 'info');
            const screenshot = await captureScreenshot();
            if (!screenshot) {
                log('Failed to capture screenshot, continuing anyway...', 'warning');
            }

            // Step 4: Build element context
            const elementContext = formatElementContext(elements);

            // Step 5: Call Gemini
            log('Thinking...', 'thought');
            let agentResponse;
            try {
                agentResponse = await callGemini(apiKey, goal, screenshot, elementContext, pageInfo);
            } catch (error) {
                log(`AI error: ${error.message}`, 'error');
                // Don't crash, just continue
                await sleep(2000);
                continue;
            }

            // Log the agent's thought
            if (agentResponse.thought) {
                log(`💭 ${agentResponse.thought}`, 'thought');
            }

            // Step 6: Handle the action
            const action = agentResponse.action;
            log(`Action: ${action}`, 'action');

            switch (action) {
                case 'done':
                    log('✅ Goal accomplished!', 'action');
                    isRunning = false;
                    break;

                case 'human_help':
                    const helpMessage = agentResponse.message_to_user || 'Please help me with this step.';
                    log(`🆘 Human help needed: ${helpMessage}`, 'warning');
                    showHumanHelp(helpMessage);
                    isPaused = true;
                    updateUI();
                    break;

                case 'click':
                    if (agentResponse.target_id) {
                        log(`Clicking element ${agentResponse.target_id}...`, 'action');
                        try {
                            const clickResult = await chrome.tabs.sendMessage(currentTabId, {
                                type: 'EXECUTE_ACTION',
                                action: { type: 'click', target_id: agentResponse.target_id }
                            });
                            if (clickResult.success) {
                                log(`✓ ${clickResult.message}`, 'action');
                            } else {
                                log(`✗ Click failed: ${clickResult.error}`, 'error');
                            }
                        } catch (error) {
                            log(`Click error: ${error.message}`, 'error');
                        }
                    } else {
                        log('No target_id provided for click', 'error');
                    }
                    // Wait for page to update
                    await sleep(2000);
                    break;

                case 'type':
                    if (agentResponse.target_id && agentResponse.value) {
                        log(`Typing into element ${agentResponse.target_id}...`, 'action');
                        try {
                            const typeResult = await chrome.tabs.sendMessage(currentTabId, {
                                type: 'EXECUTE_ACTION',
                                action: {
                                    type: 'type',
                                    target_id: agentResponse.target_id,
                                    value: agentResponse.value
                                }
                            });
                            if (typeResult.success) {
                                log(`✓ ${typeResult.message}`, 'action');
                            } else {
                                log(`✗ Type failed: ${typeResult.error}`, 'error');
                            }
                        } catch (error) {
                            log(`Type error: ${error.message}`, 'error');
                        }
                    } else {
                        log('Missing target_id or value for type action', 'error');
                    }
                    await sleep(1000);
                    break;

                case 'scroll':
                    const direction = agentResponse.value || 'down';
                    log(`Scrolling ${direction}...`, 'action');
                    try {
                        await chrome.tabs.sendMessage(currentTabId, {
                            type: 'EXECUTE_ACTION',
                            action: { type: 'scroll', value: direction }
                        });
                        log(`✓ Scrolled ${direction}`, 'action');
                    } catch (error) {
                        log(`Scroll error: ${error.message}`, 'error');
                    }
                    await sleep(1000);
                    break;

                default:
                    log(`Unknown action: ${action}`, 'error');
            }

            // Clear tags after action
            try {
                await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' });
            } catch (e) {
                // Ignore errors when clearing tags
            }

            // Brief pause between iterations
            await sleep(500);

        } catch (error) {
            log(`Loop error: ${error.message}`, 'error');
            console.error('[GeminiPilot] Loop error:', error);
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

    // Clear any remaining tags
    try {
        if (currentTabId) {
            await chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' });
        }
    } catch (e) {
        // Ignore
    }

    log('Agent stopped', 'info');
}

// ==================== RESUME HANDLER ====================
function resumeAgent() {
    if (!isRunning || !isPaused) return;

    log('Resuming agent...', 'info');
    hideHumanHelp();
    isPaused = false;
    updateUI();
}

// ==================== STOP HANDLER ====================
function stopAgent() {
    log('Stopping agent...', 'warning');
    isRunning = false;
    isPaused = false;
    hideHumanHelp();
    updateUI();

    // Clear tags
    if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_TAGS' }).catch(() => { });
    }
}

// ==================== EVENT LISTENERS ====================
startBtn.addEventListener('click', () => {
    if (!isRunning) {
        runAgentLoop();
    }
});

stopBtn.addEventListener('click', stopAgent);
resumeBtn.addEventListener('click', resumeAgent);
clearLogsBtn.addEventListener('click', clearLogs);

// Save API key on change
apiKeyInput.addEventListener('change', () => {
    saveApiKey(apiKeyInput.value.trim());
});

// ==================== INITIALIZATION ====================
async function init() {
    // Load saved API key
    await loadApiKey();

    // Set initial UI state
    updateUI();

    log('GeminiPilot 3 ready!', 'info');
    log('Enter your Gemini API key and a goal, then click Start.', 'info');
}

// Start initialization
init();
