/**
 * Silently attempt to pay a Lightning invoice via WebLN.
 * Never shows errors or status messages to the user -- the QR code fallback
 * is always displayed alongside this attempt, so failures are invisible.
 *
 * @param {string} paymentRequest - The BOLT11 invoice string
 * @returns {Promise<boolean>} true if sendPayment was called (payment may
 *   still be pending confirmation via polling), false if WebLN is unavailable
 *   or the user rejected the prompt.
 */
export async function tryAutoPayWebLN(paymentRequest) {
    if (!window.webln) return false;
    try {
        await window.webln.enable();
        await window.webln.sendPayment(paymentRequest);
        return true;
    } catch {
        // User rejected, extension not responding, or other error.
        // Silently fall through -- the QR code / manual copy is the fallback.
        return false;
    }
}
