package socket_test

import (
	"fmt"
	"testing"
	"time"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// TestMaxPayloadReportsTheHandshake requires the engine socket to expose the
// maxPayload the server advertised, so a caller can refuse an oversized packet
// itself instead of having the server close the connection over it.
func TestMaxPayloadReportsTheHandshake(t *testing.T) {
	const limit = 4096

	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
	config.SetMaxHttpBufferSize(limit)
	httpServer := types.NewWebServer(nil)
	server.NewServer(httpServer, config)

	addr := allocatePort()
	listening := make(chan struct{})
	httpServer.Listen(addr, func() { close(listening) })
	<-listening
	t.Cleanup(func() { _ = httpServer.Close(nil) })

	opts := client.DefaultOptions()
	opts.SetTransports(types.NewSet(client.WebSocket))
	opts.SetForceNew(true)
	opts.SetReconnection(false)
	opts.SetAutoConnect(false)
	socket, err := client.Connect(fmt.Sprintf("http://%s/", addr), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()

	connected := make(chan struct{})
	_ = socket.Once("connect", func(...any) { close(connected) })
	socket.Connect()
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("never connected")
	}

	if got := socket.Io().Engine().MaxPayload(); got != limit {
		t.Fatalf("MaxPayload() = %d, want the advertised %d", got, limit)
	}
}
