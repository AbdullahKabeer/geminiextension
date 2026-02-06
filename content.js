/**
 * GeminiPilot 3 - Content Script
 * Set-of-Marks (SoM) Engine for DOM element discovery and interaction
 */

// Global element map for tracking tagged elements
window.geminiElementMap = {};

// Badge container for visual overlays
let badgeContainer = null;

// Counter for element IDs
let elementCounter = 0;

/**
 * Check if an element is truly visible and interactive
 */
function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);

    // Check display and visibility
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;

    // Check dimensions
    const rect = element.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return false;

    // Check if element is in viewport
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    if (rect.bottom < 0 || rect.top > viewportHeight) return false;
    if (rect.right < 0 || rect.left > viewportWidth) return false;

    return true;
}

/**
 * Get a descriptive label for an element
 */
function getElementLabel(element) {
    // Try aria-label first
    if (element.getAttribute('aria-label')) {
        return element.getAttribute('aria-label').substring(0, 30);
    }

    // Try placeholder for inputs
    if (element.placeholder) {
        return element.placeholder.substring(0, 30);
    }

    // Try inner text
    const text = element.innerText || element.textContent;
    if (text && text.trim()) {
        return text.trim().substring(0, 30);
    }

    // Try value for inputs
    if (element.value) {
        return element.value.substring(0, 30);
    }

    // Try title
    if (element.title) {
        return element.title.substring(0, 30);
    }

    // Fall back to tag name
    return element.tagName.toLowerCase();
}

/**
 * Create or get the badge container
 */
function getBadgeContainer() {
    if (badgeContainer && document.body.contains(badgeContainer)) {
        return badgeContainer;
    }

    badgeContainer = document.createElement('div');
    badgeContainer.id = 'gemini-pilot-badge-container';
    badgeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 2147483647;
  `;
    document.body.appendChild(badgeContainer);
    return badgeContainer;
}

/**
 * Create a visual badge for an element
 */
function createBadge(id, element) {
    const rect = element.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    const badge = document.createElement('div');
    badge.className = 'gemini-pilot-badge';
    badge.textContent = id;
    badge.style.cssText = `
    position: absolute;
    left: ${rect.left + scrollX}px;
    top: ${rect.top + scrollY}px;
    background-color: #FFFF00;
    border: 2px solid #FF0000;
    color: #000000;
    font-weight: bold;
    font-size: 12px;
    font-family: Arial, sans-serif;
    padding: 2px 6px;
    border-radius: 4px;
    z-index: 2147483647;
    pointer-events: none;
    box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    min-width: 20px;
    text-align: center;
  `;

    return badge;
}

/**
 * Clear all existing badges
 */
function clearBadges() {
    const container = document.getElementById('gemini-pilot-badge-container');
    if (container) {
        container.remove();
    }
    badgeContainer = null;
    window.geminiElementMap = {};
    elementCounter = 0;
}

/**
 * Scan the page and tag interactive elements
 */
function scanPage() {
    // Clear previous badges
    clearBadges();

    // Selectors for interactive elements
    const selectors = [
        'a',
        'button',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])'
    ];

    const allElements = document.querySelectorAll(selectors.join(', '));
    const container = getBadgeContainer();
    const taggedElements = [];

    allElements.forEach(element => {
        // Skip if not visible
        if (!isElementVisible(element)) return;

        // Skip if already tagged (nested elements)
        if (element.closest('[data-gemini-id]')) return;

        elementCounter++;
        const id = elementCounter;

        // Mark the element
        element.setAttribute('data-gemini-id', id);

        // Store in global map
        window.geminiElementMap[id] = element;

        // Create visual badge
        const badge = createBadge(id, element);
        container.appendChild(badge);

        // Collect element info
        const rect = element.getBoundingClientRect();
        taggedElements.push({
            id: id,
            tag: element.tagName.toLowerCase(),
            type: element.type || null,
            label: getElementLabel(element),
            role: element.getAttribute('role') || null,
            href: element.href || null,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        });
    });

    console.log(`[GeminiPilot] Tagged ${taggedElements.length} elements`);
    return taggedElements;
}

/**
 * Simulate a complete click event sequence
 */
function simulateClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y
    };

    // Dispatch complete event sequence
    element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    element.dispatchEvent(new MouseEvent('click', eventOptions));

    // Also try native click as fallback
    if (typeof element.click === 'function') {
        element.click();
    }
}

/**
 * React-proof typing function
 */
function simulateTyping(element, text, keepFocus = true) {
    // Focus the element
    element.focus();

    // Clear existing value
    element.value = '';

    // Set the native value setter (for React controlled inputs)
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
    )?.set;

    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (element.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
        nativeTextAreaValueSetter.call(element, text);
    } else if (nativeInputValueSetter) {
        nativeInputValueSetter.call(element, text);
    } else {
        element.value = text;
    }

    // Dispatch input event (for React and autocomplete)
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));

    // Dispatch change event
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    // Dispatch keyup for good measure
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    // Keep focus for potential Enter key press
    if (keepFocus) {
        element.focus();
    }
}

/**
 * Simulate pressing Enter key on an element
 */
function simulateEnterKey(element) {
    element.focus();

    const enterKeyOptions = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
    };

    // Dispatch keyboard events
    element.dispatchEvent(new KeyboardEvent('keydown', enterKeyOptions));
    element.dispatchEvent(new KeyboardEvent('keypress', enterKeyOptions));
    element.dispatchEvent(new KeyboardEvent('keyup', enterKeyOptions));

    // Try to submit the form if exists
    const form = element.closest('form');
    if (form) {
        // Try clicking submit button first
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])') ||
            form.querySelector('[role="button"]');
        if (submitBtn) {
            simulateClick(submitBtn);
        } else {
            // Fallback to form submit
            form.requestSubmit ? form.requestSubmit() : form.submit();
        }
    }
}

/**
 * Highlight an element with a pulsing border before action
 */
function highlightElement(element, duration = 800) {
    return new Promise((resolve) => {
        if (!element) {
            resolve();
            return;
        }

        // Store original styles
        const originalOutline = element.style.outline;
        const originalOutlineOffset = element.style.outlineOffset;
        const originalTransition = element.style.transition;

        // Create highlight animation
        element.style.transition = 'outline 0.15s ease-in-out';
        element.style.outline = '3px solid #ff0000';
        element.style.outlineOffset = '2px';

        // Pulse effect
        let pulseCount = 0;
        const pulseInterval = setInterval(() => {
            pulseCount++;
            if (pulseCount % 2 === 0) {
                element.style.outline = '3px solid #ff0000';
            } else {
                element.style.outline = '3px solid #ffff00';
            }
        }, 150);

        // Restore original styles after duration
        setTimeout(() => {
            clearInterval(pulseInterval);
            element.style.outline = originalOutline;
            element.style.outlineOffset = originalOutlineOffset;
            element.style.transition = originalTransition;
            resolve();
        }, duration);
    });
}

/**
 * Wait for significant DOM changes
 */
function waitForPageChange(timeout = 5000, minChanges = 5) {
    return new Promise((resolve) => {
        let changeCount = 0;
        let resolved = false;

        const observer = new MutationObserver((mutations) => {
            changeCount += mutations.length;
            if (changeCount >= minChanges && !resolved) {
                resolved = true;
                observer.disconnect();
                resolve({ changed: true, mutations: changeCount });
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });

        // Timeout fallback
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                observer.disconnect();
                resolve({ changed: changeCount > 0, mutations: changeCount });
            }
        }, timeout);
    });
}

/**
 * Find element by ID with retry logic
 */
async function findElementWithRetry(id, maxRetries = 3, delay = 100) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const element = window.geminiElementMap[id];

        if (element && document.body.contains(element)) {
            return element;
        }

        // Also try by data attribute
        const byAttr = document.querySelector(`[data-gemini-id="${id}"]`);
        if (byAttr) {
            window.geminiElementMap[id] = byAttr;
            return byAttr;
        }

        if (attempt < maxRetries - 1) {
            console.log(`[GeminiPilot] Element ${id} not found, retrying... (${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    return null;
}

/**
 * Execute an action on the page
 */
async function executeAction(action) {
    const { type, target_id, value } = action;

    console.log(`[GeminiPilot] Executing action: ${type}`, action);

    try {
        switch (type) {
            case 'click': {
                const element = await findElementWithRetry(target_id);
                if (!element) {
                    return { success: false, error: `Element ${target_id} not found after retries` };
                }

                // Scroll element into view if needed
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(resolve => setTimeout(resolve, 300));

                // Highlight before clicking
                await highlightElement(element, 600);

                simulateClick(element);
                return { success: true, message: `Clicked element ${target_id}` };
            }

            case 'type': {
                const element = await findElementWithRetry(target_id);
                if (!element) {
                    return { success: false, error: `Element ${target_id} not found after retries` };
                }

                // Scroll element into view if needed
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(resolve => setTimeout(resolve, 300));

                // Highlight before typing
                await highlightElement(element, 400);

                simulateTyping(element, value || '');
                return { success: true, message: `Typed into element ${target_id}` };
            }

            case 'scroll': {
                const direction = value || 'down';
                const amount = direction === 'up' ? -500 : 500;
                window.scrollBy({ top: amount, behavior: 'smooth' });
                return { success: true, message: `Scrolled ${direction}` };
            }

            case 'scroll_to': {
                const element = await findElementWithRetry(target_id);
                if (!element) {
                    return { success: false, error: `Element ${target_id} not found after retries` };
                }
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return { success: true, message: `Scrolled to element ${target_id}` };
            }

            case 'wait': {
                const ms = parseInt(value) || 1000;
                await new Promise(resolve => setTimeout(resolve, ms));
                return { success: true, message: `Waited ${ms}ms` };
            }

            case 'submit': {
                const element = await findElementWithRetry(target_id);
                if (!element) {
                    return { success: false, error: `Element ${target_id} not found after retries` };
                }

                simulateEnterKey(element);
                return { success: true, message: `Pressed Enter on element ${target_id}` };
            }

            case 'type_and_enter': {
                const element = await findElementWithRetry(target_id);
                if (!element) {
                    return { success: false, error: `Element ${target_id} not found after retries` };
                }

                // Scroll element into view
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(resolve => setTimeout(resolve, 300));

                // Highlight before typing
                await highlightElement(element, 400);

                // Type the text
                simulateTyping(element, value || '', true);

                // Wait a moment for any autocomplete to settle
                await new Promise(resolve => setTimeout(resolve, 500));

                // Press Enter
                simulateEnterKey(element);

                return { success: true, message: `Typed and submitted: ${value}` };
            }

            case 'extract': {
                const element = await findElementWithRetry(target_id);
                if (!element) {
                    return { success: false, error: `Element ${target_id} not found after retries` };
                }

                // Highlight the element being extracted from
                await highlightElement(element, 400);

                // Extract text content
                const text = element.innerText || element.textContent || '';
                const value_attr = element.value || '';
                const href = element.href || '';

                return {
                    success: true,
                    message: `Extracted from element ${target_id}`,
                    data: {
                        text: text.trim().substring(0, 1000),
                        value: value_attr,
                        href: href
                    }
                };
            }

            default:
                return { success: false, error: `Unknown action type: ${type}` };
        }
    } catch (error) {
        console.error('[GeminiPilot] Action execution error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get the current page URL and title
 */
function getPageInfo() {
    return {
        url: window.location.href,
        title: document.title,
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight
    };
}

/**
 * Message listener for communication with sidepanel
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[GeminiPilot] Received message:', message.type);

    switch (message.type) {
        case 'TAG_PAGE': {
            const elements = scanPage();
            const pageInfo = getPageInfo();
            sendResponse({
                success: true,
                elements: elements,
                pageInfo: pageInfo
            });
            break;
        }

        case 'CLEAR_TAGS': {
            clearBadges();
            sendResponse({ success: true });
            break;
        }

        case 'EXECUTE_ACTION': {
            // Handle async action execution
            (async () => {
                const result = await executeAction(message.action);
                sendResponse(result);
            })();
            return true; // Keep message channel open for async response
        }

        case 'GET_PAGE_INFO': {
            const pageInfo = getPageInfo();
            sendResponse({ success: true, pageInfo: pageInfo });
            break;
        }

        case 'PING': {
            sendResponse({ success: true, message: 'Content script is alive' });
            break;
        }

        case 'HIGHLIGHT_ELEMENT': {
            (async () => {
                const element = await findElementWithRetry(message.target_id);
                if (element) {
                    await highlightElement(element, message.duration || 800);
                    sendResponse({ success: true });
                } else {
                    sendResponse({ success: false, error: 'Element not found' });
                }
            })();
            return true;
        }

        case 'WAIT_FOR_CHANGE': {
            (async () => {
                const result = await waitForPageChange(message.timeout || 5000);
                sendResponse({ success: true, ...result });
            })();
            return true;
        }

        default:
            sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
    }

    return true; // Keep message channel open
});

// Log that content script is loaded
console.log('[GeminiPilot] Content script loaded');
