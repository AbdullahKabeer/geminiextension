/**
 * GeminiPilot 3 - Voice Control Module
 * Hands-free voice input using Web Speech API
 */

// ==================== VOICE CONTROL CLASS ====================

class VoiceControl {
    constructor(options = {}) {
        this.isListening = false;
        this.recognition = null;
        this.isSupported = false;

        // Callbacks
        this.onResult = options.onResult || (() => { });
        this.onError = options.onError || (() => { });
        this.onStateChange = options.onStateChange || (() => { });
        this.onInterimResult = options.onInterimResult || (() => { });
        this.lastPermissionRequest = 0;

        // Initialize
        this.init();
    }

    init() {
        // Check for browser support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.warn('VoiceControl: Speech recognition not supported in this browser');
            this.isSupported = false;
            return;
        }

        this.isSupported = true;
        this.recognition = new SpeechRecognition();

        // Configure recognition
        this.recognition.continuous = false; // Stop after one result
        this.recognition.interimResults = true; // Show partial results
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        // Event handlers
        this.recognition.onstart = () => {
            this.isListening = true;
            this.onStateChange('listening');
            console.log('🎤 Voice recognition started');
        };

        this.recognition.onend = () => {
            this.isListening = false;
            this.onStateChange('idle');
            console.log('🎤 Voice recognition ended');
        };

        this.recognition.onresult = (event) => {
            const result = event.results[event.results.length - 1];
            const transcript = result[0].transcript.trim();

            if (result.isFinal) {
                console.log('🎤 Final result:', transcript);
                this.onResult(transcript);
            } else {
                this.onInterimResult(transcript);
            }
        };

        this.recognition.onerror = (event) => {
            console.error('🎤 Voice recognition error:', event.error);
            this.isListening = false;

            let errorMessage = 'Voice recognition error';
            switch (event.error) {
                case 'not-allowed':
                case 'permission-denied':
                    errorMessage = 'Microphone access denied. Please click the microphone icon in the address bar and allow access.';
                    // Try to show the permission page if we haven't already
                    this.requestPermission();
                    break;
                case 'no-speech':
                    errorMessage = 'No speech detected. Please try again.';
                    break;
                case 'audio-capture':
                    errorMessage = 'No microphone found. Please connect a microphone.';
                    break;
                case 'network':
                    errorMessage = 'Network error. Please check your connection.';
                    break;
                case 'aborted':
                    // User cancelled, not really an error
                    this.onStateChange('idle');
                    return;
            }

            this.onError(errorMessage);
            this.onStateChange('error');
        };

        this.recognition.onnomatch = () => {
            this.onError('Could not understand. Please speak clearly.');
            this.onStateChange('idle');
        };
    }

    async requestPermission() {
        try {
            // This is a dummy request to trigger the microphone permission prompt
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
        } catch (error) {
            console.error('🎤 Permission request failed:', error);

            // Fallback: Open a dedicated tab for permission request
            // Throttled to once every 10 seconds to avoid spamming tabs
            const now = Date.now();
            if (now - this.lastPermissionRequest > 10000) {
                console.log('🎤 Opening permissions page fallback...');
                chrome.tabs.create({ url: 'permissions.html' });
                this.lastPermissionRequest = now;
            }
            return false;
        }
    }

    async start() {
        if (!this.isSupported) {
            this.onError('Voice control is not supported in this browser. Please use Chrome.');
            return false;
        }

        if (this.isListening) {
            return false;
        }

        try {
            this.recognition.start();
            return true;
        } catch (error) {
            console.error('Failed to start voice recognition:', error);

            // If it failed because of permission, try requesting it explicitly
            if (error.name === 'NotAllowedError' || error.message.includes('permission')) {
                const granted = await this.requestPermission();
                if (granted) {
                    try {
                        this.recognition.start();
                        return true;
                    } catch (retryError) {
                        this.onError('Microphone access denied. Please click the microphone icon in the address bar and allow access.');
                    }
                } else {
                    this.onError('Microphone access denied. Please allow microphone permissions in extension settings.');
                }
            } else {
                this.onError('Failed to start voice recognition');
            }
            return false;
        }
    }

    stop() {
        if (!this.isSupported || !this.isListening) {
            return;
        }

        try {
            this.recognition.stop();
        } catch (error) {
            console.error('Failed to stop voice recognition:', error);
        }
    }

    async toggle() {
        if (this.isListening) {
            this.stop();
        } else {
            await this.start();
        }
    }
}

// ==================== EXPORT ====================

if (typeof window !== 'undefined') {
    window.VoiceControl = VoiceControl;
}
