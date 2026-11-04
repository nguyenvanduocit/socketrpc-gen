package socket_test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/parsers/socket/parser"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// TestCloseAfterADeliveredConnectEndsDisconnected closes the engine while the
// server's CONNECT is being delivered and requires the socket to see connect
// and then disconnect, ending disconnected.
//
// The Manager delivers packets through a queue on its own goroutine but used
// to handle the engine's close on the goroutine that closed it. A CONNECT read
// just before the transport dropped therefore reached the socket after its
// disconnect: the socket reported connected on a dead engine until the next
// reconnect. The close now goes through the same queue, so the socket sees
// events in the order the engine produced them.
func TestCloseAfterADeliveredConnectEndsDisconnected(t *testing.T) {
	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
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

	// Registered before the socket subscribes, so it runs first: the engine
	// closes while the CONNECT is between the decoder and the socket, the
	// window a transport that drops right after the server's CONNECT opens.
	manager := socket.Io()
	var closeOnce sync.Once
	_ = manager.On("packet", func(args ...any) {
		if packet, _ := args[0].(*parser.Packet); packet != nil && packet.Type == parser.CONNECT {
			closeOnce.Do(func() { manager.Engine().Close() })
		}
	})

	events := make(chan string, 4)
	_ = socket.On("connect", func(...any) { events <- "connect" })
	_ = socket.On("disconnect", func(...any) { events <- "disconnect" })
	socket.Connect()

	var seen []string
	for len(seen) < 2 {
		select {
		case event := <-events:
			seen = append(seen, event)
		case <-time.After(5 * time.Second):
			t.Fatalf("events = %v, want [connect disconnect]", seen)
		}
	}
	if seen[0] != "connect" || seen[1] != "disconnect" {
		t.Fatalf("events = %v, want [connect disconnect]", seen)
	}
	if socket.Connected() {
		t.Fatal("socket reports connected on a closed engine")
	}
}
