/**
 * Thin client for the LNemail REST API.
 *
 * All requests go through the extension background context, which has
 * host permissions for the configured API base, so no CORS setup is
 * needed server-side. The fetch implementation is injectable for tests.
 */

export class LnemailApiError extends Error {
  /**
   * @param {string} message Error message.
   * @param {number} status HTTP status code (0 for network errors).
   */
  constructor(message, status) {
    super(message);
    this.name = "LnemailApiError";
    this.status = status;
  }
}

export class LnemailApi {
  /**
   * @param {string} baseUrl API base URL, for example https://lnemail.net
   * @param {typeof fetch} [fetchImpl] Injectable fetch for tests.
   */
  constructor(baseUrl, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  /**
   * Perform a JSON request against the API.
   *
   * @param {string} path Path under /api/v1 (or absolute /api path).
   * @param {{method?: string, token?: string, body?: object}} [options]
   * @returns {Promise<object>} Parsed JSON response.
   * @throws {LnemailApiError} On non-2xx responses or network failures.
   */
  async request(path, { method = "GET", token, body } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new LnemailApiError(`Network error: ${error.message}`, 0);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body; keep payload null.
    }
    if (!response.ok) {
      const detail = payload?.detail ?? `HTTP ${response.status}`;
      throw new LnemailApiError(detail, response.status);
    }
    return payload;
  }

  /** @returns {Promise<object>} Service health, includes reissue_available. */
  health() {
    return this.request("/api/v1/health");
  }

  /**
   * Create a new account and its signup invoice.
   *
   * @returns {Promise<object>} InvoiceResponse payload.
   */
  createAccount() {
    return this.request("/api/v1/email", { method: "POST", body: {} });
  }

  /**
   * Check a signup payment.
   *
   * @param {string} paymentHash Payment hash from the signup invoice.
   * @returns {Promise<object>} PaymentStatusResponse payload.
   */
  checkPayment(paymentHash) {
    return this.request(`/api/v1/payment/${paymentHash}`);
  }

  /**
   * Re-issue a pending signup invoice from a different provider.
   *
   * @param {string} paymentHash Current payment hash.
   * @param {string | null} excludeProvider Provider to avoid.
   * @returns {Promise<object>} InvoiceResponse payload.
   */
  newSignupInvoice(paymentHash, excludeProvider = null) {
    return this.request(`/api/v1/email/${paymentHash}/new-invoice`, {
      method: "POST",
      body: { exclude_provider: excludeProvider },
    });
  }

  /**
   * Fetch account details for a token.
   *
   * @param {string} token Access token.
   * @returns {Promise<object>} AccountResponse payload.
   */
  getAccount(token) {
    return this.request("/api/v1/account", { token });
  }

  /**
   * List email headers for a token (used for unread counts).
   *
   * @param {string} token Access token.
   * @returns {Promise<object>} EmailListResponse payload.
   */
  listEmails(token) {
    return this.request("/api/v1/emails", { token });
  }

  /**
   * Start a renewal and get its invoice.
   *
   * @param {string} token Access token.
   * @param {number} [years] Number of years to renew.
   * @returns {Promise<object>} RenewalInvoiceResponse payload.
   */
  renewAccount(token, years = 1) {
    return this.request("/api/v1/account/renew", {
      method: "POST",
      token,
      body: { years },
    });
  }

  /**
   * Check a renewal payment.
   *
   * @param {string} paymentHash Renewal payment hash.
   * @returns {Promise<object>} RenewalStatusResponse payload.
   */
  renewalStatus(paymentHash) {
    return this.request(`/api/v1/account/renew/status/${paymentHash}`);
  }

  /**
   * Re-issue a pending renewal invoice from a different provider.
   *
   * @param {string} token Access token.
   * @param {string} paymentHash Current renewal payment hash.
   * @param {number} years Years, so the amount matches the original.
   * @param {string | null} excludeProvider Provider to avoid.
   * @returns {Promise<object>} RenewalInvoiceResponse payload.
   */
  newRenewalInvoice(token, paymentHash, years, excludeProvider = null) {
    return this.request(`/api/v1/account/renew/${paymentHash}/new-invoice`, {
      method: "POST",
      token,
      body: { exclude_provider: excludeProvider, years },
    });
  }
}
