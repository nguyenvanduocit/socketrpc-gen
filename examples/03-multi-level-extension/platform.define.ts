/**
 * Example 03: Multi-Level Extension - Platform Layer
 *
 * This is the middle level - platform-specific functionality that builds on the framework
 */

import { FrameworkClientFunctions, FrameworkServerFunctions } from './framework.define';

export type AuthToken = {
  token: string;
  expiresAt: number;
};

export type User = {
  id: string;
  username: string;
  role: 'admin' | 'user';
};

/**
 * Platform-level client functions
 * Extends framework functions and adds authentication & user management
 */
export interface PlatformClientFunctions extends FrameworkClientFunctions {
  /**
   * Show notification to user
   */
  showNotification: (title: string, message: string) => void;

  /**
   * Request user authentication
   */
  requestAuth: () => AuthToken | null;
}

/**
 * Platform-level server functions
 * Extends framework functions and adds user operations
 */
export interface PlatformServerFunctions extends FrameworkServerFunctions {
  /**
   * Authenticate user
   */
  login: (username: string, password: string) => { user: User; token: AuthToken };

  /**
   * Get current user info
   */
  getCurrentUser: () => User;

  /**
   * Logout user
   */
  logout: () => void;
}
