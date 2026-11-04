package socket_test

import (
	"fmt"
	"testing"
	"time"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// TestPollingWritesDoNotWaitForThePoll connects over long-polling alone and
// requires an acknowledged event to be answered well inside the server's ping
// interval.
//
// The polling transport ran its long-poll GET and its POST writes through one
// serial queue, so once a GET was pending every write waited for the server to
// answer it, which an idle server does only when it next pings. An event sent
// after connecting reached the server one ping interval late, and a call with
// a shorter timeout never got its answer. engine.io-client keeps one poll in
// flight and writes beside it.
func TestPollingWritesDoNotWaitForThePoll(t *testing.T) {
	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.Polling))
	// A ping answers the pending poll, which used to release the queued write;
	// with the interval far above the ack timeout, only a concurrent write can
	// make the call succeed.
	config.SetPingInterval(30 * time.Second)
	httpServer := types.NewWebServer(nil)
	io := server.NewServer(httpServer, config)
	_ = io.On("connection", func(args ...any) {
		socket := args[0].(*server.Socket)
		_ = socket.On("echo", func(args ...any) {
			ack := args[len(args)-1].(server.Ack)
			ack(args[:len(args)-1], nil)
		})
	})

	addr := allocatePort()
	listening := make(chan struct{})
	httpServer.Listen(addr, func() { close(listening) })
	<-listening
	t.Cleanup(func() { _ = httpServer.Close(nil) })

	opts := client.DefaultOptions()
	opts.SetTransports(types.NewSet(client.Polling))
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
		t.Fatal("never connected over polling")
	}

	// Three calls in a row: each one is written while the poll that the
	// previous answer arrived on has already been replaced by a new one.
	for i := range 3 {
		type answer struct {
			args []any
			err  error
		}
		answered := make(chan answer, 1)
		socket.Timeout(3*time.Second).EmitWithAck("echo", i)(func(args []any, err error) {
			answered <- answer{args, err}
		})
		got := <-answered
		if got.err != nil {
			t.Fatalf("call %d over polling: %v", i, got.err)
		}
		if len(got.args) != 1 || fmt.Sprint(got.args[0]) != fmt.Sprint(i) {
			t.Fatalf("call %d over polling answered %v, want [%d]", i, got.args, i)
		}
	}
}
