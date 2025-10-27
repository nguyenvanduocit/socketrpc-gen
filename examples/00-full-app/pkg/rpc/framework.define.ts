/**
 * Base framework interfaces that can be extended by application-specific interfaces
 */

/**
 * Framework-level client functions
 */
export interface FrameworkClientFunctions {
  /**
   * Displays an error to the client user interface
   */
  showError: (error: Error) => void;
  /**
   * Get browser version
   */
  getBrowserVersion: () => string;
}

/**
 * Framework-level server functions
 */
export interface FrameworkServerFunctions {
  /**
   * Health check endpoint
   */
  ping: () => string;
}
