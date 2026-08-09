import { BASE_URL } from './config.js';
import { state } from './state.js';

async function makeRequest(endpoint, options = {}) {
    const url = `${BASE_URL}${endpoint}`;
    const config = {
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        },
        ...options
    };

    if (state.accessToken) {
        config.headers['Authorization'] = `Bearer ${state.accessToken}`;
    }

    try {
        const response = await fetch(url, config);

        if (!response.ok) {
            let detail = response.statusText;
            try {
                const errorBody = await response.json();
                detail = errorBody.detail || detail;
            } catch (_) {
                // Keep the HTTP status text when the response is not JSON.
            }
            throw new Error(detail || `HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        } else {
            return await response.text();
        }
    } catch (error) {
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            throw new Error('Network error: Please make sure you\'re running this app through a web server (not file://) to avoid CORS issues. Try running: python -m http.server 8000');
        }

        throw error;
    }
}

export async function checkAccountAuthorization() {
    try {
        const response = await makeRequest('/account');

        if (!response || typeof response !== 'object' || !response.email_address || !response.expires_at) {
            return false;
        }

        const expiresAt = new Date(response.expires_at);
        if (isNaN(expiresAt.getTime())) {
            return false;
        }

        const isExpired = response.is_expired === true;
        const daysUntilExpiry = response.days_until_expiry || 0;
        const renewalEligible = response.renewal_eligible !== false;

        // If expired and not eligible for renewal, reject
        if (isExpired && !renewalEligible) {
            return false;
        }

        state.accountInfo = {
            email_address: response.email_address,
            expires_at: response.expires_at,
            expires_date: expiresAt,
            is_expired: isExpired,
            days_until_expiry: daysUntilExpiry,
            renewal_eligible: renewalEligible
        };

        return true;
    } catch (error) {
        return false;
    }
}

export async function fetchEmails() {
    const response = await makeRequest('/emails');
    return response.emails || [];
}

export async function fetchEmailContent(emailId) {
    return await makeRequest(`/emails/${emailId}`);
}

export async function markAllEmailsRead() {
    return await makeRequest('/emails/read-all', { method: 'POST' });
}

export async function fetchPasskeys() {
    return await makeRequest('/passkeys');
}

export async function beginPasskeyRegistration() {
    return await makeRequest('/passkeys/registration/options', { method: 'POST' });
}

export async function finishPasskeyRegistration(ceremonyId, credential, name = 'Passkey') {
    return await makeRequest('/passkeys/registration', {
        method: 'POST',
        body: JSON.stringify({ ceremony_id: ceremonyId, credential, name })
    });
}

export async function beginPasskeyAuthentication() {
    return await makeRequest('/passkeys/authentication/options', { method: 'POST' });
}

export async function finishPasskeyAuthentication(ceremonyId, credential) {
    return await makeRequest('/passkeys/authentication', {
        method: 'POST',
        body: JSON.stringify({ ceremony_id: ceremonyId, credential })
    });
}

export async function removePasskey(credentialId) {
    return await makeRequest(`/passkeys/${encodeURIComponent(credentialId)}`, {
        method: 'DELETE'
    });
}

export async function sendEmail(recipient, subject, body, inReplyTo = null, references = null, attachments = []) {
    const payload = { recipient, subject, body };
    if (inReplyTo) payload.in_reply_to = inReplyTo;
    if (references) payload.references = references;
    if (attachments.length > 0) payload.attachments = attachments;

    return await makeRequest('/email/send', {
        method: 'POST',
        body: JSON.stringify(payload)
    });
}

export async function checkPaymentStatus(paymentHash) {
    return await makeRequest(`/email/send/status/${paymentHash}`, {
        method: 'GET'
    });
}

export async function checkApiHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await makeRequest('/health', { signal: controller.signal });
        clearTimeout(timeoutId);
        return {
            success: true,
            data: response
        };
    } catch (error) {
        return {
            success: false,
            error: error.name === 'AbortError' ? 'Health check timed out after 10 seconds' : error.message
        };
    }
}

export async function deleteEmails(emailIds) {
    try {
        const response = await makeRequest('/emails', {
            method: 'DELETE',
            body: JSON.stringify({ email_ids: emailIds })
        });
        return {
            success: true,
            data: response
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

export async function createEmailAccount(options = {}) {
    return await makeRequest('/email', {
        method: 'POST',
        body: JSON.stringify(options)
    });
}

export async function checkAccountPaymentStatus(paymentHash) {
    return await makeRequest(`/payment/${paymentHash}`, {
        method: 'GET'
    });
}

export async function fetchRecentSends() {
    return await makeRequest('/email/sends/recent');
}

export async function renewAccount(years = 1) {
    return await makeRequest('/account/renew', {
        method: 'POST',
        body: JSON.stringify({ years })
    });
}

export async function checkRenewalStatus(paymentHash) {
    return await makeRequest(`/account/renew/status/${paymentHash}`, {
        method: 'GET'
    });
}

// Re-issue an invoice from a different payment provider (when configured).
// excludeProvider is the provider that issued the current, unpayable invoice.
export async function newAccountInvoice(paymentHash, excludeProvider = null) {
    return await makeRequest(`/email/${paymentHash}/new-invoice`, {
        method: 'POST',
        body: JSON.stringify({ exclude_provider: excludeProvider })
    });
}

export async function newSendInvoice(paymentHash, excludeProvider = null) {
    return await makeRequest(`/email/send/${paymentHash}/new-invoice`, {
        method: 'POST',
        body: JSON.stringify({ exclude_provider: excludeProvider })
    });
}

export async function newRenewalInvoice(paymentHash, excludeProvider = null, years = 1) {
    return await makeRequest(`/account/renew/${paymentHash}/new-invoice`, {
        method: 'POST',
        body: JSON.stringify({ exclude_provider: excludeProvider, years })
    });
}
