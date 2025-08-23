export const state = {
    accessToken: null,
    accountInfo: null,
    emails: [],
    currentView: 'inbox',
    currentPage: 1,
    autoRefreshTimer: null,
    currentAttachments: [],
    selectedEmailIds: new Set(),
    // Payment tracking
    currentPayment: null,
    paymentPollTimer: null,
    // Account creation payment tracking
    currentAccountCreation: null,
    accountCreationPollTimer: null
};
