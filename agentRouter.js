/**
 * GeminiPilot 3 - Agent Router
 * Intelligent routing and task management for better comprehension
 */

// ==================== TASK TYPE DETECTION ====================

/**
 * Analyze the goal and determine the task type
 */
function detectTaskType(goal) {
    const goalLower = goal.toLowerCase();

    // Search patterns
    if (goalLower.includes('search for') ||
        goalLower.includes('find') ||
        goalLower.includes('look up') ||
        goalLower.includes('google')) {
        return 'search';
    }

    // Navigation patterns
    if (goalLower.includes('go to') ||
        goalLower.includes('navigate to') ||
        goalLower.includes('open') ||
        goalLower.match(/visit\s+\w+\.(com|org|net|io)/)) {
        return 'navigation';
    }

    // Shopping patterns
    if (goalLower.includes('buy') ||
        goalLower.includes('price') ||
        goalLower.includes('cheapest') ||
        goalLower.includes('amazon') ||
        goalLower.includes('shop') ||
        goalLower.includes('product')) {
        return 'shopping';
    }

    // Form patterns
    if (goalLower.includes('fill') ||
        goalLower.includes('submit') ||
        goalLower.includes('enter') ||
        goalLower.includes('sign up') ||
        goalLower.includes('register')) {
        return 'form';
    }

    // Extraction patterns
    if (goalLower.includes('extract') ||
        goalLower.includes('get the') ||
        goalLower.includes('what is') ||
        goalLower.includes('read') ||
        goalLower.includes('scrape')) {
        return 'extraction';
    }

    // Default to complex for multi-step tasks
    return 'complex';
}

/**
 * Extract key entities from the goal
 */
function extractEntities(goal) {
    const entities = {
        urls: [],
        searchTerms: [],
        productNames: [],
        actions: []
    };

    // Extract URLs
    const urlMatches = goal.match(/(?:https?:\/\/)?(?:www\.)?[\w-]+\.[a-z]{2,}(?:\/\S*)?/gi);
    if (urlMatches) {
        entities.urls = urlMatches;
    }

    // Extract quoted text (likely search terms or product names)
    const quotedMatches = goal.match(/["']([^"']+)["']/g);
    if (quotedMatches) {
        entities.searchTerms = quotedMatches.map(m => m.replace(/["']/g, ''));
    }

    // Extract action verbs
    const actionVerbs = ['search', 'find', 'click', 'navigate', 'open', 'buy', 'get', 'extract', 'fill'];
    actionVerbs.forEach(verb => {
        if (goal.toLowerCase().includes(verb)) {
            entities.actions.push(verb);
        }
    });

    return entities;
}

// ==================== PLANNING ====================

/**
 * Create a high-level plan for the goal
 */
async function createPlan(goal, apiKey) {
    const taskType = detectTaskType(goal);
    const entities = extractEntities(goal);

    // Quick plans for simple task types
    const quickPlans = {
        navigation: () => {
            if (entities.urls.length > 0) {
                return {
                    steps: [`Navigate to ${entities.urls[0]}`, 'Wait for page to load', 'Verify destination'],
                    estimatedActions: 2
                };
            }
            return null;
        },
        search: () => {
            const searchTerm = entities.searchTerms[0] || goal.replace(/search for|find|look up/gi, '').trim();
            return {
                steps: [
                    'Navigate to search engine or target site',
                    `Type search query: "${searchTerm}"`,
                    'Submit search',
                    'Review results'
                ],
                estimatedActions: 4
            };
        }
    };

    // Try quick plan first
    if (quickPlans[taskType]) {
        const quickPlan = quickPlans[taskType]();
        if (quickPlan) {
            return {
                taskType,
                entities,
                ...quickPlan
            };
        }
    }

    // For complex tasks, use Gemini to create plan
    if (taskType === 'complex' && apiKey) {
        try {
            const planResponse = await callGeminiForPlanning(apiKey, goal);
            return {
                taskType: planResponse.taskType || taskType,
                entities,
                steps: planResponse.steps || [],
                estimatedActions: planResponse.estimatedActions || 10
            };
        } catch (error) {
            console.error('[AgentRouter] Planning error:', error);
        }
    }

    // Default plan
    return {
        taskType,
        entities,
        steps: ['Analyze the current page', 'Take appropriate action', 'Verify progress'],
        estimatedActions: 5
    };
}

/**
 * Call Gemini specifically for planning
 */
async function callGeminiForPlanning(apiKey, goal) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const planningPrompt = window.GeminiPrompts?.buildPlanningPrompt(goal) ||
        `Create a step-by-step plan for: "${goal}". Return JSON with steps array.`;

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: planningPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
        })
    });

    if (!response.ok) {
        throw new Error(`Planning API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    }

    return { steps: [], estimatedActions: 5 };
}

// ==================== ACTION VALIDATION ====================

/**
 * Validate an action before execution
 */
function validateAction(action, elements) {
    const errors = [];

    // Check required fields
    if (!action.action) {
        errors.push('Missing action type');
    }

    // Actions that require target_id
    const needsTarget = ['click', 'type', 'type_and_enter', 'press_enter', 'extract'];
    if (needsTarget.includes(action.action) && !action.target_id) {
        errors.push(`Action "${action.action}" requires target_id`);
    }

    // Actions that require value
    const needsValue = ['type', 'type_and_enter', 'navigate', 'new_tab'];
    if (needsValue.includes(action.action) && !action.value) {
        errors.push(`Action "${action.action}" requires value`);
    }

    // Validate target exists in elements
    if (action.target_id && elements) {
        const targetExists = elements.some(el => el.id === action.target_id);
        if (!targetExists) {
            errors.push(`Target element ${action.target_id} not found in current page elements`);
        }
    }

    // Validate URL format for navigation
    if (['navigate', 'new_tab'].includes(action.action) && action.value) {
        // Basic URL validation
        if (!action.value.match(/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}/i)) {
            errors.push(`Invalid URL format: ${action.value}`);
        }
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Suggest corrections for an invalid action
 */
function suggestCorrection(action, elements, errors) {
    const suggestions = [];

    // If target not found, suggest similar elements
    if (errors.some(e => e.includes('not found'))) {
        const similarElements = elements
            .filter(el => el.label && el.label.toLowerCase().includes(action.value?.toLowerCase() || ''))
            .slice(0, 3);

        if (similarElements.length > 0) {
            suggestions.push(`Did you mean one of these elements? ${similarElements.map(e => `[${e.id}] ${e.label}`).join(', ')}`);
        }
    }

    // If missing value for type action
    if (errors.some(e => e.includes('requires value')) && action.action === 'type') {
        suggestions.push('Please provide the text to type in the "value" field');
    }

    return suggestions;
}

// ==================== PROGRESS TRACKING ====================

/**
 * Track progress towards goal completion
 */
class ProgressTracker {
    constructor(goal, plan) {
        this.goal = goal;
        this.plan = plan;
        this.completedSteps = [];
        this.currentStepIndex = 0;
        this.startTime = Date.now();
    }

    markStepComplete(step) {
        this.completedSteps.push({
            step,
            timestamp: Date.now()
        });
        this.currentStepIndex++;
    }

    getProgress() {
        const totalSteps = this.plan?.steps?.length || 5;
        const completed = this.completedSteps.length;
        return {
            percentage: Math.round((completed / totalSteps) * 100),
            completed,
            total: totalSteps,
            currentStep: this.plan?.steps?.[this.currentStepIndex] || 'Working...',
            elapsedTime: Date.now() - this.startTime
        };
    }

    estimateRemaining() {
        const progress = this.getProgress();
        if (progress.completed === 0) return null;

        const avgTimePerStep = progress.elapsedTime / progress.completed;
        const remainingSteps = progress.total - progress.completed;
        return Math.round(avgTimePerStep * remainingSteps / 1000); // seconds
    }
}

// ==================== EXPORTS ====================

if (typeof window !== 'undefined') {
    window.AgentRouter = {
        detectTaskType,
        extractEntities,
        createPlan,
        validateAction,
        suggestCorrection,
        ProgressTracker
    };
}
