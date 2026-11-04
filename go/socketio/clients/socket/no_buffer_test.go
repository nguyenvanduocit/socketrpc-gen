package socket_test

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// TestNoBufferRefusesWhileDisconnected emits with NoBuffer while the socket is
// disconnected and requires the acknowledgement to settle before Emit returns,
// and the server to receive nothing after the reconnect.
//
// Emit buffers a packet while the socket is disconnected and sends it after
// the next CONNECT. A caller that has already reported the call as failed then
// has it executed anyway, on a connection it never saw; a caller that retries
// executes it twice. The emits below run from the "disconnect" listener: the
// socket is already disconnected while a caller that waits for that event
// still believes it is connected.
func TestNoBufferRefusesWhileDisconnected(t *testing.T) {
	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
	httpServer := types.NewWebServer(nil)
	io := server.NewServer(httpServer, config)
	var held atomic.Int64
	_ = io.On("connection", func(args ...any) {
		socket := args[0].(*server.Socket)
		_ = socket.On("hold", func(...any) { held.Add(1) })
		_ = socket.On("count", func(args ...any) {
			args[len(args)-1].(server.Ack)([]any{held.Load()}, nil)
		})
	})

	addr := allocatePort()
	listening := make(chan struct{})
	httpServer.Listen(addr, func() { close(listening) })
	<-listening
	t.Cleanup(func() { _ = httpServer.Close(nil) })

	opts := client.DefaultOptions()
	opts.SetTransports(types.NewSet(client.WebSocket))
	opts.SetForceNew(true)
	opts.SetReconnectionDelay(10)
	opts.SetRandomizationFactor(0)
	opts.SetAutoConnect(false)
	socket, err := client.Connect(fmt.Sprintf("http://%s/", addr), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()

	refused := make(chan string, 1)
	_ = socket.Once("disconnect", func(...any) {
		settled := make(chan error, 1)
		socket.NoBuffer().EmitWithAck("hold", "call")(func(_ []any, err error) { settled <- err })
		select {
		case err := <-settled:
			refused <- fmt.Sprint(err)
		default:
			refused <- "the acknowledgement was still pending when Emit returned"
		}
		_ = socket.NoBuffer().Emit("hold", "notify")
	})

	var connects atomic.Int64
	counted := make(chan []any, 1)
	_ = socket.On("connect", func(...any) {
		switch connects.Add(1) {
		case 1:
			socket.Io().Engine().Close()
		case 2:
			socket.Timeout(5 * time.Second).EmitWithAck("count")(func(args []any, err error) {
				if err != nil {
					args = []any{err}
				}
				counted <- args
			})
		}
	})
	socket.Connect()

	select {
	case got := <-refused:
		if got != "socket has been disconnected" {
			t.Fatalf("NoBuffer call while disconnected settled with %q, want %q", got, "socket has been disconnected")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never disconnected")
	}
	select {
	case got := <-counted:
		if len(got) != 1 || fmt.Sprint(got[0]) != "0" {
			t.Fatalf("server received %v NoBuffer events after the reconnect, want 0", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never reconnected")
	}
}
