const requestBtn = document.getElementById('requestBtn');
const statusDiv = document.getElementById('status');

requestBtn.addEventListener('click', async () => {
    console.log('Requesting permission...');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Error: navigator.mediaDevices.getUserMedia is not supported in this browser version or context.');
        statusDiv.textContent = '❌ API not supported.';
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Permission granted');
        statusDiv.textContent = '✅ Permission granted! You can close this tab now.';
        statusDiv.className = 'status success';
        requestBtn.style.display = 'none';

        // Stop the stream immediately
        stream.getTracks().forEach(track => track.stop());

        // Close after a short delay
        setTimeout(() => window.close(), 2000);
    } catch (err) {
        console.error('Permission error:', err);
        alert(`Error: ${err.name} - ${err.message}`);
        statusDiv.textContent = `❌ Access denied: ${err.message}. Check browser settings.`;
        statusDiv.className = 'status error';
    }
});
