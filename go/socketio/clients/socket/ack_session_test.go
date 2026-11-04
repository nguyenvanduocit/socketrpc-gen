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

// TestAnAckIsWrittenOnlyOnItsOwnSession answers a server call after the
// connection it arrived on has been replaced, and requires that answer to
// never reach the new connection.
//
// A server numbers its calls per namespace from zero, so after a restart (a
// deploy, a crash) its first call has the same id as the one the client still
// holds from before. The ack callback used to write to whatever engine the
// Manager held when it ran, which settled the new server's call with the old
// call's answer.
func TestAnAckIsWrittenOnlyOnItsOwnSession(t *testing.T) {
	addr := allocatePort()
	first := startAskServer(t, addr, "first")

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

	held := make(chan server.Ack, 1)
	checked := make(chan []any, 1)
	_ = socket.On("ask", func(args ...any) {
		ack := args[len(args)-1].(server.Ack)
		switch args[0] {
		case "first":
			held <- ack
		case "second":
			// The first server's call is answered only now, on the second
			// server's connection.
			(<-held)([]any{"stale"}, nil)
			socket.Timeout(5 * time.Second).EmitWithAck("check")(func(args []any, err error) {
				if err != nil {
					args = []any{err}
				}
				checked <- args
			})
		}
	})
	socket.Connect()

	// Wait until the first call is held, then restart the server.
	select {
	case ack := <-held:
		held <- ack
	case <-time.After(5 * time.Second):
		t.Fatal("the first server's call never arrived")
	}
	closed := make(chan struct{})
	first.Close(func(error) { close(closed) })
	<-closed
	startAskServer(t, addr, "second")

	select {
	case got := <-checked:
		if len(got) != 1 || got[0] != "" {
			t.Fatalf("the restarted server's call was answered with %v, want no answer", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never reached the restarted server")
	}
}

// startAskServer serves addr with a server that calls "ask" with name on every
// connection, and answers "check" with the answer that call got, or "".
func startAskServer(t *testing.T, addr string, name string) *server.Server {
	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
	httpServer := types.NewWebServer(nil)
	io := server.NewServer(httpServer, config)
	_ = io.On("connection", func(args ...any) {
		socket := args[0].(*server.Socket)
		var answered atomic.Value
		socket.EmitWithAck("ask", name)(func(args []any, _ error) {
			answered.Store(fmt.Sprint(args))
		})
		// Packets from one connection are handled in order, so an ACK the
		// client wrote before "check" has been applied by the time it runs.
		_ = socket.On("check", func(args ...any) {
			answer, _ := answered.Load().(string)
			args[len(args)-1].(server.Ack)([]any{answer}, nil)
		})
	})

	listening := make(chan struct{})
	httpServer.Listen(addr, func() { close(listening) })
	<-listening
	t.Cleanup(func() { io.Close(nil) })
	return io
}
