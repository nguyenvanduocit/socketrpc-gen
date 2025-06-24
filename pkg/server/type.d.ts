/**
 * Type definitions for the Socket.IO server
 *
 * This module defines TypeScript interfaces and types used throughout the Socket.IO server
 * implementation, including Shopify integration and extended Socket.IO functionality.
 */

import { Shopify, Session } from "@shopify/shopify-api";
import { Socket } from "socket.io";

/**
 * Extended data structure for Socket.IO connections
 *
 * This interface defines additional data that can be attached to each socket connection
 * beyond the default Socket.IO properties. It's used to store user-specific information
 * that persists throughout the socket's lifecycle.
 *
 * @interface ExtraSocketData
 * @property {string} userId - Unique identifier for the user associated with this socket connection
 */
interface ExtraSocketData {
  /** Unique identifier for the user associated with this socket connection */
  userId: string;
}

/**
 * Extended Socket.IO interface with custom data and event typing
 *
 * This interface extends the base Socket.IO Socket interface to include:
 * - Custom socket data (ExtraSocketData)
 * - Type safety for client-to-server events
 * - Type safety for server-to-client events
 * - Type safety for inter-server events
 *
 * The generic parameters are currently set to 'any' but should be replaced with
 * specific event type definitions as the application grows.
 *
 * @interface ExtendedSocket
 * @extends {Socket<any, any, any, ExtraSocketData>}
 *
 * @example
 * ```typescript
 * // Usage in socket event handlers
 * io.on('connection', (socket: ExtendedSocket) => {
 *   socket.data.userId = 'user123';
 *   console.log(`User ${socket.data.userId} connected`);
 * });
 * ```
 */
export interface ExtendedSocket
  extends Socket<any, any, any, ExtraSocketData> {}
