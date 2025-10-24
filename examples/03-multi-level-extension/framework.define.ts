/**
 * Example 03: Multi-Level Extension - Framework Layer
 *
 * This is the lowest level - core framework functionality
 */

/**
 * Framework-level client functions - the most basic functionality
 */
export interface FrameworkClientFunctions {
  /**
   * Log a message on the client
   */
  log: (level: 'info' | 'warn' | 'error', message: string) => void;

  /**
   * Get framework version
   */
  getVersion: () => string;
}

/**
 * Framework-level server functions
 */
export interface FrameworkServerFunctions {
  /**
   * Health check
   */
  healthCheck: () => { status: 'ok' | 'degraded'; timestamp: number };
}
