import { io } from "socket.io-client";
import { createRpcClient } from "@socket-rpc/rpc/client.generated";
import { isRpcError } from "@socket-rpc/rpc/types.generated";

/**
 * Socket.IO RPC Client Configuration
 *
 * This module demonstrates a complete client implementation for connecting to a Socket.IO RPC server
 * and making remote procedure calls. It handles connection management, authentication, and error handling.
 */

// Connection configuration constants
const url = "http://localhost:8080";
const token = "demo";
const transports = ["websocket"];
const timeout = 5000;

/**
 * Initialize Socket.IO client with configuration
 */
const socket = io(url, {
  transports,
  auth: { token },
  timeout,
});

// Create RPC client using factory pattern
const rpc = createRpcClient(socket);

/**
 * Handle errors from server
 */
rpc.handle.showError(async (error: Error) => {
  console.error("💥 Server error:", error);
});

/**
 * Client Promise for Async Connection Management
 */
const clientPromise = new Promise<void>((resolve, reject) => {
  socket.on("connect", async () => {
    console.log("✅ Connected to Socket RPC server");

    try {
      // Test successful call
      const text = await rpc.server.generateText("should be success");
      if (isRpcError(text)) {
        console.error("you should not see this");
      } else {
        console.log("Generated text:", text);
      }

      // Test error response
      const text2 = await rpc.server.generateText("error");
      if (isRpcError(text2)) {
        console.error("Test ok:", text2);
      } else {
        console.log("you should not see this", text2);
      }

      // Test thrown error
      const text3 = await rpc.server.generateText("throw");
      if (isRpcError(text3)) {
        console.error("Test ok:", text3);
      } else {
        console.log("you should not see this", text3);
      }

      console.log("🔄 generateText completed, disconnecting...");
      resolve();
    } catch (error) {
      console.error("💥 Test failed:", error);
      socket.disconnect();
      reject(error);
    }
  });

  socket.on("disconnect", () => {
    console.log("👋 Disconnected");
  });

  socket.on("connect_error", (error) => {
    console.error("🚫 Connection error:", error.message);
    reject(error);
  });
});

console.log("🚀 Starting Socket RPC client test...");

await clientPromise;

console.log("✨ Client test completed successfully");

// Cleanup
rpc.dispose();
socket.disconnect();
