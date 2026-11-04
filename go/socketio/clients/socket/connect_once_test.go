package socket_test

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/engine"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/engine/transports"
	client "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/clients/socket"
	"github.com/nguyenvanduocit/socketrpc-gen/go/socketio/pkg/types"
	server "github.com/nguyenvanduocit/socketrpc-gen/go/socketio/servers/socket"
)

// openedBuilder builds the WebSocket transport, except that Open returns only
// once the Manager has opened. That is the order a busy machine produces now
// and then: the transport opens on its own goroutine before Socket.Connect,
// which started the open, has run its next statement.
type openedBuilder struct {
	managerOpened <-chan struct{}
}

func (openedBuilder) Name() string { return transports.WebSocket.Name() }

func (b openedBuilder) New(socket engine.Socket, opts engine.SocketOptionsInterface) engine.Transport {
	return &openedTransport{Transport: transports.WebSocket.New(socket, opts), managerOpened: b.managerOpened}
}

type openedTransport struct {
	engine.Transport
	managerOpened <-chan struct{}
}

func (t *openedTransport) Open() engine.Transport {
	t.Transport.Open()
	select {
	case <-t.managerOpened:
	case <-time.After(5 * time.Second):
	}
	return t
}

// TestConnectSendsOneConnectPacket connects a socket whose Manager opens while
// Socket.Connect is still running, and requires the server to see exactly one
// connection, which stays usable.
//
// Socket.Connect subscribed to the Manager's "open", started the open, and then
// sent CONNECT itself if the Manager was already open. On one goroutine, as in
// the JavaScript client it was ported from, "already open" can only mean open
// before Connect began. Here the open runs elsewhere and can land in between, so
// the socket sent CONNECT from the "open" event and again from that check. What
// the server made of the second depended on timing: decoded after it had
// registered the first, it closed the whole connection ("invalid state"), so the
// socket reported connect and was dropped at once, about once in 30,000
// connections under load; decoded before, it accepted a second connection for
// the same client.
func TestConnectSendsOneConnectPacket(t *testing.T) {
	config := server.DefaultServerOptions()
	config.SetTransports(types.NewSet(server.WebSocket))
	httpServer := types.NewWebServer(nil)
	io := server.NewServer(httpServer, config)
	var accepted atomic.Int32
	_ = io.On("connection", func(args ...any) {
		accepted.Add(1)
		raw := args[0].(*server.Socket)
		_ = raw.On("echo", func(args ...any) {
			ack := args[len(args)-1].(server.Ack)
			ack(args[:len(args)-1], nil)
		})
	})

	addr := allocatePort()
	listening := make(chan struct{})
	httpServer.Listen(addr, func() { close(listening) })
	<-listening
	t.Cleanup(func() { _ = httpServer.Close(nil) })

	managerOpened := make(chan struct{})
	opts := client.DefaultOptions()
	opts.SetTransports(types.NewSet[engine.TransportCtor](openedBuilder{managerOpened: managerOpened}))
	opts.SetForceNew(true)
	opts.SetReconnection(false)
	opts.SetAutoConnect(false)
	socket, err := client.Connect(fmt.Sprintf("http://%s/", addr), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()

	// Registered before Connect subscribes the socket, so it runs first and the
	// Manager is open by the time the transport's Open returns.
	_ = socket.Io().Once("open", func(...any) { close(managerOpened) })
	connected := make(chan struct{})
	_ = socket.Once("connect", func(...any) { close(connected) })
	disconnected := make(chan string, 1)
	_ = socket.Once("disconnect", func(args ...any) { disconnected <- fmt.Sprint(args...) })

	socket.Connect()
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("never connected")
	}

	answered := make(chan error, 1)
	socket.Timeout(2*time.Second).EmitWithAck("echo", "ping")(func(_ []any, err error) { answered <- err })
	if err := <-answered; err != nil {
		t.Fatalf("echo after connect: %v", err)
	}
	select {
	case reason := <-disconnected:
		t.Fatalf("connection dropped after connect: %s", reason)
	case <-time.After(200 * time.Millisecond):
	}
	if got := accepted.Load(); got != 1 {
		t.Fatalf("server accepted %d connections for one Connect, want 1", got)
	}
}
