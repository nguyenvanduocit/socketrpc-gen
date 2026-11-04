package socket_test

import (
	"testing"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
)

func TestWebSocketOnlyHoldsTheWebSocketTransportAlone(t *testing.T) {
	set := client.WebSocketOnly()
	if set.Len() != 1 || !set.Has(client.WebSocket) {
		t.Fatalf("WebSocketOnly() = %v, want exactly the WebSocket transport", set.Keys())
	}
}
