/**
 * Auto-generated server functions from define.ts
 * These functions allow SERVER to call CLIENT functions (ClientFunctions interface)
 * and set up handlers for SERVER functions (ServerFunctions interface)
 */

import type { Socket } from "socket.io";
import type { RpcError } from "./types.generated";
import type { Plan } from "./define";

// === SERVER CALLING CLIENT FUNCTIONS ===
/**
 * SERVER calls CLIENT: Emits 'showError' event to client without acknowledgment. Includes built-in error handling.
 * @param {Socket} socket The socket instance for communication.
 * @param {Error} error
 */
export function showError(socket: Socket, error: Error): void {
    socket.emit('showError', error);
}

/**
 * SERVER calls CLIENT: Emits 'updateDiscoveriedUrls' event to client without acknowledgment. Includes built-in error handling.
 * @param {Socket} socket The socket instance for communication.
 * @param {string} url
 */
export function updateDiscoveriedUrls(socket: Socket, url: string): void {
    socket.emit('updateDiscoveriedUrls', url);
}

/**
 * SERVER calls CLIENT: Emits 'getBrowserVersion' event to client with acknowledgment. Includes built-in error handling.
 * @param {Socket} socket The socket instance for communication.
 * @param {number} timeout The timeout for the acknowledgment in milliseconds.
 * @returns {Promise<string | RpcError>} A promise that resolves with the result from the client, or an RpcError if one occurred.
 */
export async function getBrowserVersion(socket: Socket, timeout: number = 5000): Promise<string | RpcError> {
    try {
        return await socket.timeout(timeout).emitWithAck('getBrowserVersion');
    } catch (err) {
        return { message: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR', data: undefined };
    }
}

// === SERVER HANDLER FUNCTIONS ===
/**
 * Sets up listener for 'generateText' events from client with acknowledgment
 * @param {Socket} socket The socket instance for communication.
 * @param {(prompt: string) => Promise<string | RpcError>} handler The handler function to process incoming events.
 */
export function handleGenerateText(socket: Socket, handler: (prompt: string) => Promise<string | RpcError>): void {
    socket.on('generateText', async (prompt, callback) => {
        try {
            const result = await handler(prompt);
            callback(result);
        } catch (error) {
            console.error('[generateText] Handler error:', error);
            socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
            callback({ message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
        }
    });
}

/**
 * Sets up listener for 'getPlan' events from client with acknowledgment
 * @param {Socket} socket The socket instance for communication.
 * @param {(planId: string) => Promise<Plan | RpcError>} handler The handler function to process incoming events.
 */
export function handleGetPlan(socket: Socket, handler: (planId: string) => Promise<Plan | RpcError>): void {
    socket.on('getPlan', async (planId, callback) => {
        try {
            const result = await handler(planId);
            callback(result);
        } catch (error) {
            console.error('[getPlan] Handler error:', error);
            socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
            callback({ message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
        }
    });
}

/**
 * Sets up listener for 'rpcError' events. This handler is called whenever an RPC error occurs during function execution.
 * @param {Socket} socket The socket instance for communication.
 * @param {(error: RpcError) => void} handler The handler function to process incoming events.
 */
export function handleRpcError(socket: Socket, handler: (error: RpcError) => void): void {
    socket.on('rpcError', (error: RpcError) => {
        handler(error);
    });
}
