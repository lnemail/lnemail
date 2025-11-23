import { showStatus } from './ui.js';

export async function payWithWebLN(paymentRequest) {
    if (!window.webln) {
        showStatus('WebLN not available', 'error');
        return false;
    }
    try {
        await window.webln.enable();
        await window.webln.sendPayment(paymentRequest);
        return true;
    } catch (error) {
        // console.error('WebLN payment failed:', error);
        showStatus(`WebLN Payment failed: ${error.message}`, 'error');
        return false;
    }
}
