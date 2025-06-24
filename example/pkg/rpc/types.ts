/**
 * Auto-generated types for the RPC package
 */
/** Represents an error that occurred during an RPC call. */
export interface RpcError {
    /** The error message. */
    message: string;
}

/** Type guard to check if an object is an RpcError. */
export function isRpcError(obj: any): obj is RpcError {
    return !!obj && typeof (obj as RpcError).message === 'string';
}
