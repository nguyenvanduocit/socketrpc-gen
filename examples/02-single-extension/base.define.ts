/**
 * Example 02: Single-Level Extension - Base Definitions
 *
 * This file contains base/framework-level RPC functions that are common
 * across your application. Your application-specific interfaces can extend these.
 */

/**
 * Base client functions - common functionality for all clients
 */
export interface BaseClientFunctions {
  /**
   * Show an error message to the user
   */
  showError: (error: Error) => void;

  /**
   * Show a success notification
   */
  showSuccess: (message: string) => void;

  /**
   * Get client environment info
   */
  getClientInfo: () => {
    userAgent: string;
    language: string;
  };
}

/**
 * Base server functions - common functionality for all servers
 */
export interface BaseServerFunctions {
  /**
   * Health check endpoint
   */
  ping: () => string;

  /**
   * Get server time
   */
  getServerTime: () => number;
}
