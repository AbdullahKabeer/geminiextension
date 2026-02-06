// Background service worker for GeminiPilot 3
// Handles side panel opening when extension icon is clicked

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Set side panel behavior to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set panel behavior:', error));

// Forward voice messages from content script to side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'VOICE_STATE' || message.type === 'VOICE_RESULT' || message.type === 'VOICE_ERROR') {
    // Forward to all extension pages (including side panel)
    chrome.runtime.sendMessage(message).catch(() => {
      // Side panel might not be open, that's ok
    });
  }
  return true;
});
