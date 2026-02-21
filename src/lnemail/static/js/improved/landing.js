import { createEmailAccount, checkAccountPaymentStatus } from './api.js';
import { tryAutoPayWebLN } from './webln.js';
import { showStatus, initMobileMenu } from './ui.js';
import { copyToClipboard } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    initMobileMenu();

    // Local storage keys definition
    const STORAGE_KEYS = {
        accessToken: 'lnemail_access_token',
        emailAddress: 'lnemail_email_address',
        paymentData: 'lnemail_payment_data'
    };

    const createInvoiceBtn = document.getElementById('create-invoice');
    const prePaymentDiv = document.getElementById('pre-payment');
    const paymentPendingDiv = document.getElementById('payment-pending');
    const paymentSuccessDiv = document.getElementById('payment-success');
    const copyInvoiceBtn = document.getElementById('copy-invoice');
    const bolt11Invoice = document.getElementById('bolt11-invoice');
    const invoiceAmount = document.getElementById('invoice-amount');
    const qrContainer = document.getElementById('qrcode');
    let paymentHash = '';
    let checkInterval = null;

    // Create invoice when button is clicked
    if (createInvoiceBtn) {
        createInvoiceBtn.addEventListener('click', createInvoice);
    }

    // Copy invoice to clipboard
    if (copyInvoiceBtn) {
        copyInvoiceBtn.addEventListener('click', async () => {
            try {
                await copyToClipboard(bolt11Invoice.textContent);
                showStatus('Copied to clipboard!', 'success');
            } catch (err) {
                console.error('Failed to copy text: ', err);
                showStatus('Failed to copy text.', 'error');
            }
        });
    }

    // Add event listeners to all copy buttons in success view
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const parentWrapper = e.target.closest('.copy-wrapper');
            const textEl = parentWrapper.querySelector('.copy-text');
            try {
                await copyToClipboard(textEl.textContent);
                showStatus('Copied to clipboard!', 'success');
            } catch (err) {
                console.error('Failed to copy text: ', err);
                showStatus('Failed to copy text.', 'error');
            }
        });
    });

    // Create cancel payment button and add functionality
    function addCancelButton() {
        // Check if button already exists
        if (document.getElementById('cancel-payment-btn')) {
            return;
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.id = 'cancel-payment-btn';
        cancelBtn.className = 'btn secondary';
        cancelBtn.textContent = 'Cancel Payment';
        cancelBtn.addEventListener('click', cancelPayment);
        // Add the button after the status container
        const statusContainer = document.querySelector('.status-container-local');
        if (statusContainer) {
            statusContainer.insertAdjacentElement('afterend', cancelBtn);
        } else {
            // Fallback if status container class is different or missing
            const paymentDetails = document.querySelector('.payment-details');
            if (paymentDetails) paymentDetails.appendChild(cancelBtn);
        }
    }

    // Cancel payment and return to pre-payment state
    function cancelPayment() {
        // Clear any checking interval
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        // Clear stored payment data
        sessionStorage.removeItem(STORAGE_KEYS.paymentData);
        // Reset UI
        paymentPendingDiv.classList.add('hidden');
        prePaymentDiv.classList.remove('hidden');
        // Reset button state
        createInvoiceBtn.disabled = false;
        createInvoiceBtn.textContent = 'Create Lightning Invoice';
        // Clear QR code
        if (qrContainer) {
            qrContainer.innerHTML = '';
        }
    }

    // Create a new invoice
    async function createInvoice() {
        const includeEmail = document.getElementById('include-email').checked;
        const includeToken = document.getElementById('include-token').checked;
        try {
            createInvoiceBtn.disabled = true;
            createInvoiceBtn.textContent = 'Creating...';

            const response = await createEmailAccount({
                include_email: includeEmail,
                include_token: includeToken
            });

            if (!response) {
                throw new Error('Failed to create invoice');
            }

            // Store invoice data in session storage
            const paymentData = {
                payment_hash: response.payment_hash,
                payment_request: response.payment_request,
                price_sats: response.price_sats,
                email_address: response.email_address,
                access_token: response.access_token,
                expires_at: response.expires_at,
                created_at: new Date().toISOString()
            };
            sessionStorage.setItem(STORAGE_KEYS.paymentData, JSON.stringify(paymentData));

            // Display payment pending screen
            displayPaymentScreen(paymentData);

            // Silently attempt WebLN auto-pay; QR code is the fallback
            tryAutoPayWebLN(paymentData.payment_request);

            // Start checking payment status
            paymentHash = response.payment_hash;
            checkInterval = setInterval(checkPaymentStatus, 3000);

        } catch (error) {
            console.error('Error creating invoice:', error);
            createInvoiceBtn.disabled = false;
            createInvoiceBtn.textContent = 'Create Lightning Invoice';
            showStatus('Error creating invoice. Please try again.', 'error');
        }
    }

    // Display payment screen with stored invoice data
    function displayPaymentScreen(paymentData) {
        // Show payment screen
        prePaymentDiv.classList.add('hidden');
        paymentPendingDiv.classList.remove('hidden');

        // Set payment details
        bolt11Invoice.textContent = paymentData.payment_request;
        invoiceAmount.textContent = `Amount: ${paymentData.price_sats} sats`;

        const paymentEmailEl = document.getElementById('payment-email');
        const paymentTokenEl = document.getElementById('payment-token');

        if (paymentEmailEl && paymentData.email_address) {
            paymentEmailEl.textContent = paymentData.email_address;
        }
        if (paymentTokenEl && paymentData.access_token) {
            paymentTokenEl.textContent = paymentData.access_token;
        }

        // Clear any previous QR code
        qrContainer.innerHTML = '';

        // Create a canvas element for QRious
        const canvas = document.createElement('canvas');
        canvas.style.maxWidth = '250px';
        canvas.style.height = 'auto';
        qrContainer.appendChild(canvas);

        // Generate QR code with size scaled to data length.
        // Use level 'L' since LN invoices have their own checksums and
        // high error correction inflates the module count, causing the QR
        // to render at a fraction of the canvas for long invoices.
        // Uppercase the invoice: bech32 is case-insensitive and uppercase
        // enables QR alphanumeric mode (~40% more compact).
        if (typeof QRious !== 'undefined') {
            const qrValue = paymentData.payment_request.toUpperCase();
            const dataLength = qrValue.length;
            const minModulePixels = 3;
            let estimatedModules;
            if (dataLength < 200) {
                estimatedModules = 57;
            } else if (dataLength < 400) {
                estimatedModules = 77;
            } else if (dataLength < 700) {
                estimatedModules = 97;
            } else if (dataLength < 1100) {
                estimatedModules = 117;
            } else if (dataLength < 1500) {
                estimatedModules = 137;
            } else {
                estimatedModules = 177;
            }
            const size = Math.max(250, estimatedModules * minModulePixels);
            new QRious({
                element: canvas,
                value: qrValue,
                size: size,
                level: 'L'
            });
        } else {
             // Fallback if QRious is not loaded yet (should be loaded in index.html)
             console.warn("QRious not loaded");
        }

        // Add cancel button
        addCancelButton();
    }

    // Check if payment has been received
    async function checkPaymentStatus() {
        try {
            const response = await checkAccountPaymentStatus(paymentHash);

            if (!response) {
                throw new Error('Failed to check payment status');
            }

            // Handle payment status
            if (response.payment_status === 'paid') {
                if (checkInterval) {
                    clearInterval(checkInterval);
                    checkInterval = null;
                }
                // Clear stored payment data
                sessionStorage.removeItem(STORAGE_KEYS.paymentData);
                handlePaidInvoice(response);
            }
        } catch (error) {
            console.error('Error checking payment status:', error);
        }
    }

    // Process successful payment
    function handlePaidInvoice(data) {
        // Hide payment pending, show success
        paymentPendingDiv.classList.add('hidden');
        paymentSuccessDiv.classList.remove('hidden');

        // Set email data
        const emailAddressEl = document.querySelector('#email-address .copy-text');
        const accessTokenEl = document.querySelector('#access-token .copy-text');
        const expiresAtEl = document.getElementById('expires-at');

        // Fill in the payment success details
        if (emailAddressEl) {
            emailAddressEl.textContent = data.email_address;
        }
        if (accessTokenEl) {
            accessTokenEl.textContent = data.access_token;
        }

        // Format expiry date if available
        if (expiresAtEl && data.expires_at) {
            const expiryDate = new Date(data.expires_at);
            expiresAtEl.textContent = expiryDate.toLocaleDateString();
        } else if (expiresAtEl) {
            // Calculate expiry date (1 year from now) as fallback
            const expiryDate = new Date();
            expiryDate.setFullYear(expiryDate.getFullYear() + 1);
            expiresAtEl.textContent = expiryDate.toLocaleDateString();
        }

        // Save to local storage (for inbox access)
        localStorage.setItem(STORAGE_KEYS.accessToken, data.access_token);
        localStorage.setItem(STORAGE_KEYS.emailAddress, data.email_address);

        showStatus('Payment successful! Account created.', 'success');
    }

    // Check for stored payment data on page load (for refreshes during payment)
    const storedPaymentData = sessionStorage.getItem(STORAGE_KEYS.paymentData);
    if (storedPaymentData) {
        try {
            const paymentData = JSON.parse(storedPaymentData);
            paymentHash = paymentData.payment_hash;
            // Display payment screen with stored data
            displayPaymentScreen(paymentData);
            // Start checking payment status
            checkPaymentStatus();
            checkInterval = setInterval(checkPaymentStatus, 3000);
            // Add cancel button
            addCancelButton();
        } catch (error) {
            console.error('Error parsing stored payment data:', error);
            // Clear invalid data
            sessionStorage.removeItem(STORAGE_KEYS.paymentData);
        }
    }
});
