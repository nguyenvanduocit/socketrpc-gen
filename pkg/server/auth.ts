import { Socket } from "socket.io";
import { RequestedTokenType } from "@shopify/shopify-api";
import type { ExtendedSocket } from "./type";

/**
 * Authentication middleware for Socket.io connections
 *
 * This middleware validates authentication tokens provided during the socket handshake
 * and attaches user identification to the socket instance for subsequent use.
 *
 * @param socket - Extended Socket.io socket instance with additional data properties
 * @param next - Callback function to proceed to next middleware or handle errors
 *
 * @throws {Error} When no authentication token is provided in the handshake
 * @throws {Error} When the provided token is invalid or verification fails
 *
 * @example
 * ```typescript
 * // Usage in Socket.io server setup
 * io.use(authMiddleware);
 * ```
 */
export const authMiddleware = async (
  socket: ExtendedSocket,
  next: (err?: Error) => void
) => {
  // Extract authentication token from socket handshake auth data
  const token = socket.handshake.auth.token;

  // Reject connection if no token is provided
  if (!token) {
    return next(new Error("Authentication error: No token provided"));
  }

  try {
    // TODO: Implement proper token validation logic
    // Currently just storing the token as userId - this should be replaced
    // with actual JWT verification or API token validation
    socket.data.userId = token;

    // Proceed to next middleware or allow connection
    next();
  } catch (error) {
    // Handle any errors during token validation
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Reject connection with descriptive error message
    return next(
      new Error(`Authentication error: Invalid token: ${errorMessage}`)
    );
  }
};
