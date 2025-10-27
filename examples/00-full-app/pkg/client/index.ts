import { io, Socket } from "socket.io-client";
import { generateText, handleShowError } from "@socket-rpc/rpc/client.generated";
import { isRpcError } from "@socket-rpc/rpc";

/**
 * Socket.IO RPC Client Configuration
 * 
 * This module demonstrates a complete client implementation for connecting to a Socket.IO RPC server
 * and making remote procedure calls. It handles connection management, authentication, and error handling.
 */

// Connection configuration constants
/** Server URL for the Socket.IO connection */
const url = "http://localhost:8080";

/** Authentication token for server connection */
const token = "demo";

/** Preferred transport methods for Socket.IO connection */
const transports = ["websocket"];

/** Connection timeout in milliseconds */
const timeout = 5000;

/**
 * Initialize Socket.IO client with configuration
 * 
 * Creates a Socket.IO client instance with:
 * - WebSocket-only transport for optimal performance
 * - Token-based authentication
 * - 5-second connection timeout
 */
const socket = io(url, {
  transports,
  auth: { token },
  timeout,
});

/**
 * Handle Show Error
 * 
 * Handles errors from the server by logging them to the console.
 */
handleShowError(socket, async (error: Error): Promise<void> => {
  console.error("💥 Test failed:", error);
});

/**
 * Client Promise for Async Connection Management
 * 
 * This promise encapsulates the entire client lifecycle:
 * 1. Connection establishment
 * 2. RPC method execution
 * 3. Graceful disconnection
 * 4. Error handling and cleanup
 */
const clientPromise = new Promise<void>((resolve, reject) => {
  /**
   * Connection Success Handler
   * 
   * Triggered when the socket successfully connects to the server.
   * Executes the main client logic including RPC calls.
   */
  socket.on("connect", async () => {
    console.log("✅ Connected to Socket RPC server");
  /**
   * Connection Success Handler
   *
   * Triggered when the socket successfully connects to the server.
   * Executes the main client logic including RPC calls.
   */
  socket.on("connect", async () => {
    console.log("✅ Connected to Socket RPC server");

    try {
      /**
       * Execute RPC Method Call
       *
       * Calls the 'generateText' method on the server with a test message.
       * The generateText function handles:
       * - Request serialization
       * - Response deserialization
       * - Error propagation
       * - Timeout management
       */
      const text = await generateText(socket, "should be success");
      if (isRpcError(text)) {
        console.error("you should not see this");
      } else {
        console.log("Generated text:", text);
      }

      const text2 = await generateText(socket, "error");
      if (isRpcError(text2)) {
        console.error("Test ok:", text2);
      } else {
        console.log("you should not see this", text2);
      }

      const text3 = await generateText(socket, "throw");
      if (isRpcError(text3)) {
        console.error("Test ok:", text3);
      } else {
        console.log("you should not see this", text3);
      }

      // Wait for generateText to complete before disconnecting
      console.log("🔄 generateText completed, disconnecting...");

      // Signal successful completion
      resolve();
    } catch (error) {
      console.error("💥 Test failed:", error);
      socket.disconnect();
      reject(error);
    }
  });

  /**
   * Disconnection Handler
   *
   * Triggered when the socket disconnects from the server.
   * This can happen due to:
   * - Manual disconnection
   * - Network issues
   * - Server shutdown
   */
  socket.on("disconnect", () => {
    console.log("👋 Disconnected");
  });

  /**
   * Connection Error Handler
   *
   * Handles connection failures including:
   * - Authentication errors
   * - Network connectivity issues
   * - Server unavailability
   * - Timeout errors
   */
  socket.on("connect_error", (error) => {
    console.error("🚫 Connection error:", error.message);
    reject(error);
  });
});

console.log("🚀 Starting Socket RPC client test...");

/**
 * Main Execution Flow
 * 
 * Waits for the client promise to resolve, indicating that:
 * - Connection was established successfully
 * - RPC call completed successfully
 * - Any errors were handled appropriately
 */
await clientPromise;

console.log("✨ Client test completed successfully");

/**
 * Cleanup and Disconnection
 * 
 * Ensures the socket is properly disconnected after successful completion.
 * This prevents hanging connections and allows the process to exit cleanly.
 */
socket.disconnect();