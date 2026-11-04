package socket_test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// TestConnectNeverStalls opens many fresh connections against one server and
// requires every one of them to reach "connect".
//
// Manager.Open used to create the engine socket, which starts its transport at
// once, and only then subscribe to that socket's "open" event. A transport that
// opened inside that window was never told to send the Socket.IO CONNECT packet,
// so the socket sat disconnected forever — rarely, but often enough under -race
// to stall a process that connects on every start.
func TestConnectNeverStalls(t *testing.T) {
	iterations := 2000
	if testing.Short() {
		iterations = 200
	}

	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
	httpServer := types.NewWebServer(nil)
	server.NewServer(httpServer, config)

	addr := allocatePort()
	listening := make(chan struct{})
	httpServer.Listen(addr, func() { close(listening) })
	<-listening
	t.Cleanup(func() { _ = httpServer.Close(nil) })

	// Connecting from many goroutines at once keeps every CPU busy, which is
	// what widens the window between the transport opening and the manager
	// listening for it; serial connects on an idle machine almost never hit it.
	const workers = 16
	url := fmt.Sprintf("http://%s/", addr)
	var wg sync.WaitGroup
	stalls := make(chan string, iterations)
	for w := range workers {
		wg.Go(func() {
			for i := w; i < iterations; i += workers {
				if msg := connectOnce(url); msg != "" {
					stalls <- fmt.Sprintf("connection %d of %d: %s", i, iterations, msg)
				}
			}
		})
	}
	wg.Wait()
	close(stalls)
	failed := 0
	for msg := range stalls {
		failed++
		if failed <= 5 {
			t.Error(msg)
		}
	}
	if failed > 0 {
		t.Fatalf("%d of %d connections never reached connect", failed, iterations)
	}
}

// connectOnce dials a fresh manager and reports why it did not reach
// "connect", or "" when it did.
func connectOnce(url string) string {
	opts := client.DefaultOptions()
	opts.SetTransports(types.NewSet(client.WebSocket))
	opts.SetForceNew(true)
	opts.SetReconnection(false)
	opts.SetAutoConnect(false)

	socket, err := client.Connect(url, opts)
	if err != nil {
		return err.Error()
	}
	defer socket.Close()

	connected := make(chan struct{})
	_ = socket.Once("connect", func(...any) { close(connected) })
	socket.Connect()

	select {
	case <-connected:
		return ""
	case <-time.After(5 * time.Second):
		return "never connected"
	}
}
