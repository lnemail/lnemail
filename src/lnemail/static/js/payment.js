document.addEventListener('DOMContentLoaded', () => {
    const createInvoiceBtn = document.getElementById('create-invoice');
    const prePaymentDiv = document.getElementById('pre-payment');
    const paymentPendingDiv = document.getElementById('payment-pending');
    const paymentSuccessDiv = document.getElementById('payment-success');
    const statusText = document.querySelector('.status-text');
    const loader = document.querySelector('.loader');
    const copyInvoiceBtn = document.getElementById('copy-invoice');
    const bolt11Invoice = document.getElementById('bolt11-invoice');
    const invoiceAmount = document.getElementById('invoice-amount');
    const qrContainer = document.getElementById('qrcode');
    let paymentHash = '';
    let checkInterval = null;

    // Payment storage key
    const PAYMENT_STORAGE_KEY = 'lnemail_payment_data';

    // Create invoice when button is clicked
    if (createInvoiceBtn) {
        createInvoiceBtn.addEventListener('click', createInvoice);
    }

    // Copy invoice to clipboard
    if (copyInvoiceBtn) {
        copyInvoiceBtn.addEventListener('click', () => {
            copyToClipboard(bolt11Invoice.textContent);
        });
    }

    // Add event listeners to all copy buttons in success view
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const parentWrapper = e.target.closest('.copy-wrapper');
            const textEl = parentWrapper.querySelector('.copy-text');
            copyToClipboard(textEl.textContent);
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
        const statusContainer = document.querySelector('.status-container');
        if (statusContainer) {
            statusContainer.insertAdjacentElement('afterend', cancelBtn);
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
        sessionStorage.removeItem(PAYMENT_STORAGE_KEY);

        // Reset UI
        paymentPendingDiv.classList.add('hidden');
        prePaymentDiv.classList.remove('hidden');

        // Reset button state
        createInvoiceBtn.disabled = false;
        createInvoiceBtn.textContent = 'Create Invoice';

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
            const response = await fetch('/api/v1/email', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    include_email: includeEmail,
                    include_token: includeToken
                })
            });
            if (!response.ok) {
                throw new Error('Failed to create invoice');
            }
            const data = await response.json();

            // Store invoice data in session storage
            const paymentData = {
                payment_hash: data.payment_hash,
                payment_request: data.payment_request,
                price_sats: data.price_sats,
                email_address: data.email_address,
                access_token: data.access_token,
                expires_at: data.expires_at,
                created_at: new Date().toISOString()
            };
            sessionStorage.setItem(PAYMENT_STORAGE_KEY, JSON.stringify(paymentData));

            // Display payment pending screen
            displayPaymentScreen(paymentData);

            const weblnBtn = document.getElementById('webln-pay-btn');
            if (window.webln) {
                weblnBtn.classList.remove('hidden');
                weblnBtn.addEventListener('click', async () => {
                    try {
                        await window.webln.enable();
                        await window.webln.sendPayment(bolt11Invoice.textContent);
                        checkPaymentStatus();
                    } catch (error) {
                        showNotification(`Payment failed: ${error.message}`, 'error');
                    }
                });
            }

            // Start checking payment status
            paymentHash = data.payment_hash;
            checkInterval = setInterval(checkPaymentStatus, 3000);
        } catch (error) {
            console.error('Error creating invoice:', error);
            createInvoiceBtn.disabled = false;
            createInvoiceBtn.textContent = 'Create Invoice';
            showNotification('Error creating invoice. Please try again.', 'error');
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
        qrContainer.appendChild(canvas);

        // Generate QR code
        const qr = new QRious({
            element: canvas,
            value: paymentData.payment_request,
            size: 250,
            level: 'H'
        });

        // Add cancel button
        addCancelButton();
    }

    // Check if payment has been received
    async function checkPaymentStatus() {
        try {
            const response = await fetch(`/api/v1/payment/${paymentHash}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) {
                throw new Error('Failed to check payment status');
            }
            const data = await response.json();
            // Handle payment status
            if (data.payment_status === 'paid') {
                clearInterval(checkInterval);
                // Clear stored payment data
                sessionStorage.removeItem(PAYMENT_STORAGE_KEY);
                handlePaidInvoice(data);
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
    }

    // Check for stored payment data on page load (for refreshes during payment)
    const storedPaymentData = sessionStorage.getItem(PAYMENT_STORAGE_KEY);
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
            sessionStorage.removeItem(PAYMENT_STORAGE_KEY);
        }
    }
});
