# GeminiPilot 3 (Gemini Extension)

GeminiPilot 3 is a Chrome Extension (Manifest V3) that turns Gemini into a browser automation copilot.  
You describe a goal in natural language, and the extension:

1. Scans and labels interactive elements on the current page
2. Sends page context + screenshot to Gemini
3. Receives a single structured action decision
4. Executes that action in the page
5. Repeats until done (or asks for human help)

It includes:
- A modern side panel chat UI
- Action planning/routing logic
- Page-level automation primitives (click, type, extract, etc.)
- Voice input (Web Speech API from page context)
- Multi-tab and collection workflows

---

## Table of Contents

- [Project Overview](#project-overview)
- [Core Features](#core-features)
- [How It Works (End-to-End)](#how-it-works-end-to-end)
- [Repository Structure](#repository-structure)
- [Architecture Deep Dive](#architecture-deep-dive)
- [Installation & Setup](#installation--setup)
- [Usage Guide](#usage-guide)
- [Supported Agent Actions](#supported-agent-actions)
- [Voice Control](#voice-control)
- [Prompting & Planning System](#prompting--planning-system)
- [Data Flow & Message Protocol](#data-flow--message-protocol)
- [Configuration & Storage](#configuration--storage)
- [Security & Privacy Notes](#security--privacy-notes)
- [Troubleshooting](#troubleshooting)
- [Development Notes](#development-notes)
- [Limitations](#limitations)
- [Roadmap Ideas](#roadmap-ideas)

---

## Project Overview

**Extension name (manifest):** `GeminiPilot 3`  
**Manifest version:** 3  
**Current extension version:** `1.0.0`  
**Primary AI model endpoint used in code:** `gemini-2.0-flash` via Google Generative Language API

GeminiPilot is designed as an **AI browser driver**.  
Instead of using fixed workflows, it iteratively reasons on:
- Current URL/title/scroll
- A numbered list of visible interactive DOM elements
- Recent action history
- Optional screenshot context

Then it executes exactly one action each step.

---

## Core Features

### 1) Side Panel Command Center
- Chat-style interface for goals and agent feedback
- Real-time logs with severity types (`info`, `action`, `thought`, `warning`, `error`)
- Status indicator (ready/running/paused)
- Screenshot preview
- Exportable log sessions
- Settings modal for API key storage

### 2) Visual DOM Tagging (Set-of-Marks style)
- The content script scans interactive elements
- Each element receives a unique numeric ID
- Yellow/red badges are overlaid on page elements
- Agent actions target these stable IDs

### 3) Multi-Step Agent Loop
- Repeatedly:
  - Analyze page
  - Ask Gemini for next action JSON
  - Validate action
  - Execute action
  - Track success/failure
- Stops on explicit `done`, user stop, or max iteration/error limits

### 4) Intelligent Task Routing
- Task type detection (search/navigation/form/extraction/shopping/collection/multi-tab/complex)
- Entity extraction from goal text (URLs, quoted phrases, verbs)
- Planning assistance for complex tasks
- Action validation guardrails before execution

### 5) Voice Input
- Voice recognition runs in page context for reliability
- Voice transcript can auto-populate and auto-send to chat
- Permission fallback page for microphone access (`permissions.html`)

### 6) Collection + Multi-Tab Workflows
- Collect structured items across pages/tabs (`collect_item`)
- Show or paste collected dataset (`show_collection`, `paste_collection`)
- Tab management actions (`new_tab`, `switch_tab`, `close_tab`, `list_tabs`)

---

## How It Works (End-to-End)

1. User opens side panel and enters API key in Settings.
2. User enters a goal (e.g., “Find 5 budget laptops and list prices”).
3. Side panel ensures content script is available on active tab.
4. Content script scans page and returns:
   - Numbered interactive elements
   - Page metadata
5. Side panel captures screenshot of visible tab.
6. Side panel builds a rich system prompt + context and calls Gemini API.
7. Gemini returns one JSON action object.
8. Side panel validates action and dispatches it to content script or tab APIs.
9. Result is logged, stored in action history, and loop continues.
10. Loop ends on `done`, stop, repeated failures, or iteration cap.

---

## Repository Structure

```text
geminiextension/
├── manifest.json          # MV3 configuration, permissions, scripts, side panel
├── background.js          # Service worker; opens side panel; relays voice events
├── sidepanel.html         # Main UI
├── sidepanel.js           # Agent orchestration, Gemini calls, UI state, execution loop
├── content.js             # DOM scanning, element tagging, in-page action execution, voice bridge
├── agentRouter.js         # Task detection, planning, action validation, progress helpers
├── prompts.js             # Central prompt templates/builders
├── voiceControl.js        # Voice control class (extension-side support)
├── permissions.html       # Microphone permission helper page
├── permissions.js         # Permission request logic
└── icons/                 # Extension icons
```

---

## Architecture Deep Dive

### `manifest.json`
- Declares:
  - Side panel entry (`sidepanel.html`)
  - Background service worker (`background.js`)
  - Content script (`content.js`) on `<all_urls>`
  - Permissions: `sidePanel`, `activeTab`, `scripting`, `storage`, `tabs`
  - Host permission: `<all_urls>`

### `background.js`
- Opens side panel when extension action icon is clicked
- Sets side panel behavior for action click
- Forwards voice events (`VOICE_STATE`, `VOICE_RESULT`, `VOICE_ERROR`) so side panel can update UI

### `sidepanel.js` (main brain/orchestrator)
- Maintains runtime state:
  - run/pause flags
  - action + conversation history
  - current tab id
  - error counters
  - collected items
- Handles:
  - API key persistence
  - Page analysis cycle
  - Gemini API request/response
  - Action validation + execution dispatch
  - Human-help pause/resume flow
  - Logs, screenshot preview, voice UI integration

### `content.js` (page runtime)
- Scans and labels interactive elements
- Maintains `geminiElementMap` for ID → DOM element mapping
- Executes low-level actions:
  - click/type/type+enter/submit/scroll/extract/etc.
- Sends page info and action results back via runtime messaging
- Runs page-context speech recognition and sends events back to extension

### `agentRouter.js`
- Detects task type from goal text heuristics
- Extracts entities (URLs, quoted terms, action verbs)
- Builds simple quick plans or calls Gemini planning prompt for complex tasks
- Validates action structure and target consistency before execution

### `prompts.js`
- Centralized prompts:
  - Core agent behavior prompt
  - Reasoning instructions
  - Action documentation
  - Strict JSON output format
  - Task-specific strategy inserts
- Prompt builder combines runtime context into final instruction payload

---

## Installation & Setup

### Requirements
- Google Chrome 88+ (Manifest V3 support; latest stable recommended)
- Gemini API key (Google Generative Language API)

### Load extension locally
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select:
   - The local `geminiextension` project folder (the folder containing `manifest.json`)
5. Pin the extension if desired

### Configure API key
1. Open the side panel from extension icon
2. Click **Settings** (⚙️)
3. Paste your Gemini API key
4. Save

---

## Usage Guide

### Basic usage
1. Navigate to any regular webpage (not `chrome://`)
2. Open GeminiPilot side panel
3. Enter a goal in chat input
4. Press Send (or Enter in input)
5. Watch:
   - Element tags on page
   - Agent thought/action logs
   - Screenshot preview

### Example goal types
- “Search YouTube for React performance tips and open the best video”
- “Go to amazon.com and find wireless mouse under $30”
- “Collect 5 laptop options and prepare a list”
- “Open docs.new and paste the collected data”

### Runtime controls
- **Stop Agent** button or **Esc** key to halt run
- If agent requests help, send a clarifying message in chat to resume
- Open logs modal for full trace and export

---

## Supported Agent Actions

Actions recognized and executed by the extension include:

- `click` — click a tagged element
- `type` — type text into target element
- `type_and_enter` — type then submit via Enter
- `press_enter` / `submit` — submit focused/target input context
- `scroll` — scroll up/down
- `navigate` — navigate current tab to URL
- `new_tab` — open URL in new tab
- `switch_tab` — activate tab by index
- `close_tab` — close current tab (if not last)
- `list_tabs` — list open tabs in current window
- `wait` — wait for specified milliseconds (capped)
- `go_back` — browser back
- `refresh` — reload current tab
- `extract` — extract text/value/href from element
- `collect_item` — append structured item into session collection
- `show_collection` — print current collected items
- `paste_collection` — paste collection text into page/target
- `human_help` — pause and request user intervention
- `done` — mark task complete and stop loop

---

## Voice Control

Voice control is implemented primarily in page context (`content.js`) because speech APIs are more reliable there.

Flow:
1. User taps 🎤 in side panel
2. Side panel sends `START_VOICE` to active tab
3. Content script starts speech recognition
4. Interim/final results emitted as runtime messages
5. Final transcript auto-fills chat and auto-sends

If microphone permission fails:
- Permission helper page can be opened (`permissions.html`)
- User grants mic access manually and retries

---

## Prompting & Planning System

Prompt architecture is split into reusable blocks:
- Agent operating rules
- Reasoning steps
- Action catalog
- JSON output schema
- Task strategies by type

The side panel builds prompt context with:
- Goal
- Page URL/title/scroll metrics
- Recent action history
- Visible element summaries
- Previous error context (if any)

For complex goals, planner support can generate a multi-step outline with estimated action count.

---

## Data Flow & Message Protocol

### Side panel → Content script
- `PING`
- `TAG_PAGE`
- `CLEAR_TAGS`
- `EXECUTE_ACTION`
- `START_VOICE`
- `STOP_VOICE`

### Content script → Side panel/background
- Tag/page responses
- Action execution results
- Voice events:
  - `VOICE_STATE`
  - `VOICE_RESULT`
  - `VOICE_ERROR`

### Side panel → Gemini API
- Endpoint: `v1beta/models/gemini-2.0-flash:generateContent`
- Includes text prompt and optional screenshot inline data
- Expects machine-readable JSON action response

---

## Configuration & Storage

Stored in `chrome.storage.local`:
- `geminiApiKey` — API key from settings
- `agentStats` — basic run/action success counters

Session-only runtime memory (in JS state):
- Conversation history
- Action history
- Current tab id
- Collected items
- Error state/counters

---

## Security & Privacy Notes

- The extension has broad host access (`<all_urls>`) to automate across sites.
- API key is stored locally in extension storage (not encrypted by custom code).
- Page screenshots and extracted content may be sent to Gemini API when running.
- Do not use on pages with highly sensitive data unless this behavior is acceptable in your threat model.
- Avoid entering secrets into automation goals/logs.

---

## Troubleshooting

### “No active tab found” or no page interaction
- Ensure a normal webpage tab is active (not Chrome internal pages)
- Refresh page and retry

### Agent keeps failing actions
- Check logs modal for error details
- Provide clearer goal with constraints
- Manually navigate close to target state, then retry
- Use human help when authentication/CAPTCHA is involved

### Voice input not working
- Ensure browser supports SpeechRecognition API
- Grant microphone access
- Retry from a regular HTTPS page

### API errors
- Verify key is valid and saved in settings
- Confirm API quota/billing and model access
- Inspect status/error logs in the side panel

---

## Development Notes

- This repo is a direct Chrome extension codebase (no build pipeline required to run).
- Load unpacked extension after changes to test.
- If content script updates do not appear, reload extension from `chrome://extensions`.

Suggested manual verification after changes:
1. Load extension
2. Save API key
3. Run a simple navigation goal
4. Run a search goal with `type_and_enter`
5. Test one extract action
6. Test voice start/stop
7. Export logs

---

## Limitations

- Relies on model returning valid JSON (with local sanitization fallback)
- Dynamic sites can invalidate element IDs between steps
- CAPTCHA, MFA, and auth walls still require human intervention
- Voice support depends on browser/page capabilities and permissions
- No formal automated test suite in this repository yet

---

## Roadmap Ideas

- Add explicit allowlist/denylist controls per domain
- Add structured schemas per task type for safer extraction
- Add deterministic recovery strategies for stale element IDs
- Add integration tests for action execution protocol
- Add optional local model abstraction/provider switching

---

If you want, I can also generate:
- a contributor-focused `CONTRIBUTING.md`
- an end-user quick-start one-pager
- an architecture diagram (Mermaid) added to this README
