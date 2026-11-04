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

// TestDialWithDefaultTransportsNeverStalls connects many times with the
// client's default transports against a server that speaks HTTP only, and
// requires every connection to connect and answer a call.
//
// The default transports are a set, and the client used to take the order it
// tries them in from the set's map, so about one connection in ten tried
// WebTransport first. Against a server without HTTP/3 that attempt waits for
// the QUIC idle timeout and the connection never arrives in time. The client
// now tries polling, then websocket, then webtransport, as engine.io-client
// does, and upgrades only to what the server offers.
func TestDialWithDefaultTransportsNeverStalls(t *testing.T) {
	iterations := 500
	if testing.Short() {
		iterations = 100
	}

	// The server's default transports are polling and websocket: no HTTP/3.
	httpServer := types.NewWebServer(nil)
	io := server.NewServer(httpServer, nil)
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

	const workers = 8
	url := fmt.Sprintf("http://%s/", addr)
	var wg sync.WaitGroup
	stalls := make(chan string, iterations)
	for w := range workers {
		wg.Go(func() {
			for i := w; i < iterations; i += workers {
				if msg := dialDefaultOnce(url); msg != "" {
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
		t.Fatalf("%d of %d default-transport connections stalled", failed, iterations)
	}
}

// dialDefaultOnce connects a fresh manager with the default transports, makes
// one call, and reports what went wrong, or "" when nothing did.
func dialDefaultOnce(url string) string {
	opts := client.DefaultOptions()
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
	case <-time.After(5 * time.Second):
		return "never connected"
	}

	answered := make(chan error, 1)
	socket.Timeout(5*time.Second).EmitWithAck("echo", "ping")(func(_ []any, err error) {
		answered <- err
	})
	if err := <-answered; err != nil {
		return "call: " + err.Error()
	}
	return ""
}
