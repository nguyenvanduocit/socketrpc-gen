/**
 * Auto-generated client functions from define.ts
 * These functions allow CLIENT to call SERVER functions (ServerFunctions interface)
 * and set up handlers for CLIENT functions (ClientFunctions interface)
 */

import type { Socket } from "socket.io-client";
import type { RpcError } from "./types.generated";
import type { GetPlanRequest, Plan } from "./define";

// === CLIENT CALLING SERVER FUNCTIONS ===
/**
 * CLIENT calls SERVER: Emits 'generateText' event to server with acknowledgment. Includes built-in error handling.
 * @param {Socket} socket The socket instance for communication.
 * @param {string} prompt
 * @param {number} timeout The timeout for the acknowledgment in milliseconds.
 * @returns {Promise<string | RpcError>} A promise that resolves with the result from the server, or an RpcError if one occurred.
 */
export async function generateText(socket: Socket, prompt: string, timeout: number = 5000): Promise<string | RpcError> {
    try {
        return await socket.timeout(timeout).emitWithAck('generateText', prompt);
    } catch (err) {
        return { message: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR', data: undefined };
    }
}

/**
 * CLIENT calls SERVER: Emits 'getPlan' event to server with acknowledgment. Includes built-in error handling.
 * @param {Socket} socket The socket instance for communication.
 * @param {GetPlanRequest} request
 * @param {number} timeout The timeout for the acknowledgment in milliseconds.
 * @returns {Promise<Plan | RpcError>} A promise that resolves with the result from the server, or an RpcError if one occurred.
 */
export async function getPlan(socket: Socket, request: GetPlanRequest, timeout: number = 5000): Promise<Plan | RpcError> {
    try {
        return await socket.timeout(timeout).emitWithAck('getPlan', request);
    } catch (err) {
        return { message: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR', data: undefined };
    }
}

// === CLIENT HANDLER FUNCTIONS ===
/**
 * Sets up listener for 'showError' events from server
 * @param {Socket} socket The socket instance for communication.
 * @param {(error: Error) => Promise<void>} handler The handler function to process incoming events.
 */
export function handleShowError(socket: Socket, handler: (error: Error) => Promise<void>): void {
    socket.on('showError', async (error) => {
        try {
            await handler(error);
        } catch (error) {
            console.error('[showError] Handler error:', error);
            socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
        }
    });
}

/**
 * Sets up listener for 'updateDiscoveriedUrls' events from server
 * @param {Socket} socket The socket instance for communication.
 * @param {(url: string) => Promise<void>} handler The handler function to process incoming events.
 */
export function handleUpdateDiscoveriedUrls(socket: Socket, handler: (url: string) => Promise<void>): void {
    socket.on('updateDiscoveriedUrls', async (url) => {
        try {
            await handler(url);
        } catch (error) {
            console.error('[updateDiscoveriedUrls] Handler error:', error);
            socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
        }
    });
}

/**
 * Sets up listener for 'getBrowserVersion' events from server with acknowledgment
 * @param {Socket} socket The socket instance for communication.
 * @param {() => Promise<string | RpcError>} handler The handler function to process incoming events.
 */
export function handleGetBrowserVersion(socket: Socket, handler: () => Promise<string | RpcError>): void {
    socket.on('getBrowserVersion', async (callback) => {
        try {
            const result = await handler();
            callback(result);
        } catch (error) {
            console.error('[getBrowserVersion] Handler error:', error);
            socket.emit('rpcError', { message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
            callback({ message: error instanceof Error ? error.message : 'Unknown error' } as RpcError);
        }
    });
}

/**
 * Sets up listener for 'rpcError' events with async/await and try-catch. This handler is called whenever an RPC error occurs during function execution.
 * @param {Socket} socket The socket instance for communication.
 * @param {(error: RpcError) => Promise<void>} handler The handler function to process incoming events.
 */
export function handleRpcError(socket: Socket, handler: (error: RpcError) => Promise<void>): void {
    socket.on('rpcError', async (error: RpcError) => {
        try {
            await handler(error);
        } catch (handlerError) {
            console.error('[handleRpcError] Error in RPC error handler:', handlerError);
        }
    });
}
