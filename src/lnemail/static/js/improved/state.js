export const state = {
    accessToken: null,
    accountInfo: null,
    emails: [],
    currentView: 'inbox',
    currentPage: 1,
    autoRefreshTimer: null,
    currentAttachments: [],
    selectedEmailIds: new Set(),
    currentEmail: null,
    currentBodyFormat: 'html',  // 'html' or 'plain'
    // Payment tracking
    currentPayment: null,
    paymentPollTimer: null,
    // Renewal payment tracking
    currentRenewal: null,
    renewalPollTimer: null,
    recentSends: [],
    recentSendsRefreshTimer: null
};
