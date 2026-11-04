package socket_test

import (
	"fmt"
	"testing"
	"time"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// TestRefusalWithoutDataKeepsTheMessage refuses a handshake with an error that
// carries no data, the common case for a middleware, and requires the client's
// connect_error to report the server's message.
//
// The client used to require the CONNECT_ERROR packet's data field to hold a
// value, so the null a data-less refusal encodes as replaced the server's
// message with a parse error.
func TestRefusalWithoutDataKeepsTheMessage(t *testing.T) {
	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
	httpServer := types.NewWebServer(nil)
	io := server.NewServer(httpServer, config)
	io.Use(func(_ *server.Socket, next func(*server.ExtendedError)) {
		next(server.NewExtendedError("unauthorized: token rejected", nil))
	})

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

	refused := make(chan any, 1)
	_ = socket.Once("connect_error", func(args ...any) { refused <- args[0] })
	socket.Connect()

	select {
	case reason := <-refused:
		extended, ok := reason.(*types.ExtendedError)
		if !ok || extended.Message != "unauthorized: token rejected" || extended.Data != nil {
			t.Fatalf("connect_error = %#v, want the server's message with no data", reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no connect_error")
	}
	if socket.Active() {
		t.Fatal("a refused socket is still active, so it would retry")
	}
}
