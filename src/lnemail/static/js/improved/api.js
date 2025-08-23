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
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        } else {
            return await response.text();
        }
    } catch (error) {
        // console.error('API Request failed:', error);

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
            // console.error('Invalid response format from /account');
            return false;
        }

        const expiresAt = new Date(response.expires_at);
        if (isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
            // console.error('Token has expired or expiry date is invalid');
            return false;
        }

        state.accountInfo = {
            email_address: response.email_address,
            expires_at: response.expires_at,
            expires_date: expiresAt
        };

        // console.log(`Account authorized for: ${response.email_address}`);
        return true;
    } catch (error) {
        // console.error('Account authorization check failed:', error);
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

export async function sendEmail(recipient, subject, body) {
    return await makeRequest('/email/send', {
        method: 'POST',
        body: JSON.stringify({ recipient, subject, body })
    });
}

export async function checkPaymentStatus(paymentHash) {
    return await makeRequest(`/email/send/status/${paymentHash}`, {
        method: 'GET'
    });
}

export async function checkApiHealth() {
    try {
        const response = await makeRequest('/health');
        return {
            success: true,
            data: response
        };
    } catch (error) {
        // console.error('API health check failed:', error);
        return {
            success: false,
            error: error.message
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
        // console.error('Delete emails failed:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

export async function createEmailAccount() {
    return await makeRequest('/email', {
        method: 'POST'
    });
}

export async function checkAccountPaymentStatus(paymentHash) {
    return await makeRequest(`/payment/${paymentHash}`, {
        method: 'GET'
    });
}
